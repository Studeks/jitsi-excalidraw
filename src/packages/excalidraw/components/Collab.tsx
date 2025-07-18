import throttle from "lodash.throttle";
import { PureComponent } from "react";
import { ErrorDialog } from "../../../components/ErrorDialog";
import { APP_NAME, EVENT } from "../../../constants";
import { ImportedDataState } from "../../../data/types";
import {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
} from "../../../element/types";
import { getSceneVersion, restoreElements } from "../../excalidraw/index";
import {
  BinaryFileData,
  Collaborator,
  CollabProps,
  DataURL,
  FileId,
  Gesture,
  UserIdleState,
} from "../../../types";
import {
  preventUnload,
  resolvablePromise,
  withBatchedUpdates,
} from "../../../utils";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SCENE_EVENT_TYPES,
  STORAGE_KEYS,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../../../excalidraw-app/app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getCollabServer,
  getSyncableElements,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../../../excalidraw-app/data";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../../../excalidraw-app/data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../../../excalidraw-app/data/localStorage";
import Portal from "../../../excalidraw-app/collab/Portal";
import RoomDialog from "../../../excalidraw-app/collab/RoomDialog";
import { t } from "../../../i18n";
import { IDLE_THRESHOLD, ACTIVE_THRESHOLD } from "../../../constants";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../../../excalidraw-app/data/FileManager";
import { AbortError } from "../../../errors";
import {
  isImageElement,
  isInitializedImageElement,
} from "../../../element/typeChecks";
import { newElementWith } from "../../../element/mutateElement";
import {
  ReconciledElements,
  reconcileElements as _reconcileElements,
} from "../../../excalidraw-app/collab/reconciliation";
import { decryptData } from "../../../data/encryption";
import { resetBrowserStateVersions } from "../../../excalidraw-app/data/tabSync";
import { LocalData } from "../../../excalidraw-app/data/LocalData";
import { atom, useAtom } from "jotai";
import { jotaiStore } from "../../../jotai";

let isUsingTestingEnv;
export const collabAPIAtom = atom<CollabAPI | null>(null);
export const collabDialogShownAtom = atom(false);
export const isCollaboratingAtom = atom(false);

interface CollabState {
  errorMessage: string;
  username: string;
  activeRoomLink: string;
}

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: (username: string) => void;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;
  periodicImageCheck: number | null = null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<string, Collaborator>();

  constructor(props: CollabProps) {
    super(props);
    console.log("🚀 Collab component initialized", {
      hasOnFileFetch: !!props.onFileFetch,
      collabServerUrl: props.collabServerUrl,
    });

    this.state = {
      errorMessage: "",
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: "",
    };

    // @ts-ignore
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
    isUsingTestingEnv = props.useTestEnv;
    props.collabDetails && this.startCollaboration(props.collabDetails);
  }

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
    };

    jotaiStore.set(collabAPIAtom, collabAPI);

    // Periodic image loading check for collaboration
    if (this.props.onFileFetch) {
      this.periodicImageCheck = window.setInterval(() => {
        if (this.isCollaborating()) {
          const currentFiles = this.excalidrawAPI.getFiles();
          const elements =
            this.excalidrawAPI.getSceneElementsIncludingDeleted();
          const imageElements = elements.filter(
            (el) => isInitializedImageElement(el) && !el.isDeleted,
          );
          const missingFileIds = imageElements
            .map((el) => (el as any).fileId)
            .filter((fileId) => !currentFiles[fileId]);

          if (missingFileIds.length > 0) {
            console.log(
              "🔄 Periodic check found missing images:",
              missingFileIds,
            );
            this.props.onFileFetch!(missingFileIds)
              .then((response) => {
                console.log("✅ Periodic load response:", response);
                this.excalidrawAPI.addFiles(response.loadedFiles);
              })
              .catch((error) => {
                console.error("❌ Periodic load failed:", error);
              });
          }
        }
      }, 3000); // Check every 3 seconds
    }

    if (this.props.useTestEnv) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  componentWillUnmount() {
    this.stopCollaboration(false);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.periodicImageCheck) {
      window.clearInterval(this.periodicImageCheck);
      this.periodicImageCheck = null;
    }
  }

  isCollaborating = () => jotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    console.log("🔄 Collaboration status changed:", isCollaborating);
    jotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      preventUnload(event);
    }

    if (this.isCollaborating() || this.portal.roomId) {
      try {
        localStorage?.setItem(
          STORAGE_KEYS.LOCAL_STORAGE_KEY_COLLAB_FORCE_FLAG,
          JSON.stringify({
            timestamp: Date.now(),
            room: this.portal.roomId,
          }),
        );
      } catch {}
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    try {
      const savedData = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      if (this.isCollaborating() && savedData && savedData.reconciledElements) {
        this.handleRemoteSceneUpdate(
          this.reconcileElements(savedData.reconciledElements),
        );
      }
    } catch (error: any) {
      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        commitToHistory: false,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setState({
        activeRoomLink: "",
      });
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromFirebase = async (
    scene: {
      elements: readonly ExcalidrawElement[];
    } | null,
  ) => {
    if (!scene) {
      return;
    }
    const unfetchedImages = scene.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileHandled(element.fileId) &&
          !element.isDeleted &&
          element.status === "saved"
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ) => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: "INVALID_RESPONSE",
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ): Promise<ImportedDataState | null> => {
    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    const scenePromise = resolvablePromise<ImportedDataState | null>();

    console.log("🤝 Starting collaboration", {
      roomId,
      existingRoomLinkData: !!existingRoomLinkData,
    });
    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      const socketServerData = await getCollabServer(
        this.props.collabServerUrl,
      );

      this.portal.socket = this.portal.open(
        socketIOClient(socketServerData.url, {
          transports: socketServerData.polling
            ? ["websocket", "polling"]
            : ["websocket"],
          query: {
            roomId,
          },
        }),
        roomId,
        roomKey,
      );

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setState({ errorMessage: error.message });
      return null;
    }

    if (!existingRoomLinkData) {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array & history to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.history.clear();
      this.excalidrawAPI.updateScene({
        elements,
        commitToHistory: true,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case "INVALID_RESPONSE":
            return;
          case WS_SCENE_EVENT_TYPES.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const remoteElements = decryptedData.payload.elements;
              const reconciledElements = this.reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements, {
                init: true,
              });
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SCENE_EVENT_TYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this.reconcileElements(decryptedData.payload.elements),
            );
            break;
          case "MOUSE_LOCATION": {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;
            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            const collaborators = new Map(this.collaborators);
            const user = collaborators.get(socketId) || {}!;
            user.pointer = pointer;
            user.button = button;
            user.selectedElementIds = selectedElementIds;
            user.username = username;
            collaborators.set(socketId, user);
            this.excalidrawAPI.updateScene({
              collaborators,
            });
            break;
          }
          case "IDLE_STATUS": {
            const { userState, socketId, username } = decryptedData.payload;
            const collaborators = new Map(this.collaborators);
            const user = collaborators.get(socketId) || {}!;
            user.userState = userState;
            user.username = username;
            this.excalidrawAPI.updateScene({
              collaborators,
            });
            break;
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    this.initializeIdleDetector();

    this.setState({
      activeRoomLink: window.location.href,
    });

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );

          return {
            elements,
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  private reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledElements => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();

    remoteElements = restoreElements(remoteElements, null);

    const reconciledElements = _reconcileElements(
      localElements,
      remoteElements,
      appState,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private fetchImages = async (fileIds: string[]) => {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<string, true>();

    await Promise.all(
      fileIds.map(async (fileId) => {
        try {
          const imageUrl = fileId.startsWith("http")
            ? fileId
            : `${this.props.collabServerUrl}/api/images/${fileId}`;

          const response = await fetch(imageUrl);

          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.statusText}`);
          }

          const blob = await response.blob();
          const reader = new FileReader();

          return new Promise<void>((resolve) => {
            reader.onload = () => {
              const dataURL = reader.result as string;
              const mimeType =
                (blob.type as
                  | "image/png"
                  | "image/jpeg"
                  | "image/svg+xml"
                  | "image/gif"
                  | "application/octet-stream") || "image/png";
              loadedFiles.push({
                id: fileId as FileId,
                dataURL: dataURL as DataURL,
                mimeType: mimeType,
                created: Date.now(),
              });
              resolve();
            };
            reader.onerror = () => {
              erroredFiles.set(fileId, true as true);
              resolve();
            };
            reader.readAsDataURL(blob);
          });
        } catch (error) {
          console.error(`Failed to fetch image ${fileId}:`, error);
          erroredFiles.set(fileId, true as true);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  };

  private loadImageFiles = throttle(async () => {
    console.log(
      "🔍 loadImageFiles called, onFileFetch available:",
      !!this.props.onFileFetch,
    );

    // Try custom file fetch first if available
    console.log("🚀 Using custom onFileFetch");

    const elements = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    console.log("📊 Total elements:", elements.length);

    // Get current files to avoid re-fetching already loaded files
    const currentFiles = this.excalidrawAPI.getFiles();

    const unfetchedImages = elements
      .filter((element) => {
        const isImage = isInitializedImageElement(element);
        const notDeleted = !element.isDeleted;
        const fileId = (element as any).fileId;
        // Check if file is already loaded in excalidraw
        const notAlreadyLoaded = !currentFiles[fileId];

        console.log("🔍 Element filter check:", {
          fileId,
          isImage,
          notDeleted,
          notAlreadyLoaded,
          elementStatus: (element as any).status,
          currentFilesKeys: Object.keys(currentFiles),
        });

        // Much more aggressive filtering - only check if it's an image, not deleted, and not already loaded
        return isImage && notDeleted && notAlreadyLoaded;
      })
      .map((element) => (element as any).fileId);

    console.log("📥 Unfetched image fileIds:", unfetchedImages);

    if (unfetchedImages.length > 0) {
      try {
        console.log("🚀 Calling onFileFetch with fileIds:", unfetchedImages);
        const response = await this.fetchImages(unfetchedImages);
        console.log("✅ onFileFetch response:", response);

        const { loadedFiles, erroredFiles } = response;

        this.excalidrawAPI.addFiles(loadedFiles);

        updateStaleImageStatuses({
          excalidrawAPI: this.excalidrawAPI,
          erroredFiles: erroredFiles as any,
          elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
        });
      } catch (error) {
        console.error("❌ Custom file fetch failed:", error);
      }
    } else {
      console.log("⏭️ No unfetched images to load");
    }
    return;
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledElements,
    { init = false }: { init?: boolean } = {},
  ) => {
    console.log("🌐 handleRemoteSceneUpdate called", {
      elementsCount: elements.length,
      init,
      imageElements: elements.filter((el) => isInitializedImageElement(el))
        .length,
    });

    this.excalidrawAPI.updateScene({
      elements,
      commitToHistory: !!init,
    });

    // We haven't yet implemented multiplayer undo functionality, so we clear the undo stack
    // when we receive any messages from another peer. This UX can be pretty rough -- if you
    // undo, a user makes a change, and then try to redo, your element(s) will be lost. However,
    // right now we think this is the right tradeoff.
    this.excalidrawAPI.history.clear();

    console.log("🔄 About to call loadImageFiles");
    this.loadImageFiles();

    // Additional aggressive image loading for collaboration
    if (this.props.onFileFetch) {
      console.log("🚀 Additional aggressive image loading triggered");
      setTimeout(() => {
        const currentFiles = this.excalidrawAPI.getFiles();
        const imageElements = elements.filter(
          (el) => isInitializedImageElement(el) && !el.isDeleted,
        );
        const missingFileIds = imageElements
          .map((el) => (el as any).fileId)
          .filter((fileId) => !currentFiles[fileId]);

        console.log("🔍 Missing files check:", {
          totalImages: imageElements.length,
          currentFilesCount: Object.keys(currentFiles).length,
          missingFileIds,
        });

        if (missingFileIds.length > 0) {
          console.log("🚀 Force loading missing images:", missingFileIds);
          this.props.onFileFetch!(missingFileIds)
            .then((response) => {
              console.log("✅ Force load response:", response);
              this.excalidrawAPI.addFiles(response.loadedFiles);
            })
            .catch((error) => {
              console.error("❌ Force load failed:", error);
            });
        }
      }, 100); // Small delay to ensure scene is updated
    }
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: string[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      if (this.collaborators.has(socketId)) {
        collaborators.set(socketId, this.collaborators.get(socketId)!);
      } else {
        collaborators.set(socketId, {});
      }
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly ExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SCENE_EVENT_TYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly ExcalidrawElement[]) => {
    this.broadcastElements(elements);
    this.queueSaveToFirebase();
  };

  queueBroadcastAllElements = throttle(async () => {
    await this.portal.broadcastScene(
      WS_SCENE_EVENT_TYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  handleClose = () => {
    jotaiStore.set(collabDialogShownAtom, false);
  };

  setUsername = (username: string) => {
    this.setState({ username });
  };

  onUsernameChange = (username: string) => {
    this.setUsername(username);
    saveUsernameToLocalStorage(username);
  };

  render() {
    const { username, errorMessage, activeRoomLink } = this.state;

    const { modalIsShown } = this.props;

    return (
      <>
        {modalIsShown && (
          <RoomDialog
            handleClose={this.handleClose}
            activeRoomLink={activeRoomLink}
            username={username}
            onUsernameChange={this.onUsernameChange}
            onRoomCreate={() => this.startCollaboration(null)}
            onRoomDestroy={this.stopCollaboration}
            setErrorMessage={(errorMessage) => {
              this.setState({ errorMessage });
            }}
            theme={this.excalidrawAPI.getAppState().theme}
          />
        )}
        {errorMessage && (
          <ErrorDialog
            message={errorMessage}
            onClose={() => this.setState({ errorMessage: "" })}
          />
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    // @ts-ignoreQ
    collab: InstanceType<typeof Collab>;
  }
}

if (isUsingTestingEnv) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export const _Collab: React.FC<CollabProps> = (props) => {
  const [collabDialogShown] = useAtom(collabDialogShownAtom);
  return <Collab {...props} modalIsShown={collabDialogShown} />;
};

export type TCollabClass = Collab;
