import LanguageDetector from "i18next-browser-languagedetector";
import { useEffect, useRef, useState, useCallback } from "react";
import { trackEvent } from "../../../analytics";
import { ErrorDialog } from "../../../components/ErrorDialog";
import { TopErrorBoundary } from "../../../components/TopErrorBoundary";
import { APP_NAME, EVENT, VERSION_TIMEOUT } from "../../../constants";
import { ExcalidrawElement, FileId } from "../../../element/types";
import { useCallbackRefState } from "../../../hooks/useCallbackRefState";
import { Excalidraw, defaultLang, loadFromBlob } from "../index";
import {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ExcalidrawAppProps,
} from "../../../types";
import {
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  ResolvablePromise,
  resolvablePromise,
} from "../../../utils";
import {
  FIREBASE_STORAGE_PREFIXES,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "../../../excalidraw-app/app_constants";
import {
  _Collab as Collab,
  collabAPIAtom,
  collabDialogShownAtom,
  isCollaboratingAtom,
  CollabAPI,
} from "./Collab";
import {
  getCollaborationLinkData,
  isCollaborationLink,
  loadScene,
} from "../../../excalidraw-app/data";
import {
  getLibraryItemsFromStorage,
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "../../../excalidraw-app/data/localStorage";
import {
  restore,
  restoreAppState,
  RestoredDataState,
} from "../../../data/restore";

import "../../../excalidraw-app/index.scss";

import { updateStaleImageStatuses } from "../../../excalidraw-app/data/FileManager";
import { newElementWith } from "../../../element/mutateElement";
import { isInitializedImageElement } from "../../../element/typeChecks";
import { loadFilesFromFirebase } from "../../../excalidraw-app/data/firebase";
import { LocalData } from "../../../excalidraw-app/data/LocalData";
import { isBrowserStorageStateNewer } from "../../../excalidraw-app/data/tabSync";
import clsx from "clsx";
import { Provider, useAtom } from "jotai";
import { jotaiStore, useAtomWithInitialValue } from "../../../jotai";
import { reconcileElements } from "../../../excalidraw-app/collab/reconciliation";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "../../../data/library";
import { t } from "../../../i18n";

window.EXCALIDRAW_THROTTLE_RENDER = true;

const languageDetector = new LanguageDetector();
languageDetector.init({
  languageUtils: {},
});

export const initializeScene = async (opts: {
  collabAPI: CollabAPI;
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  console.log("🎬 initializeScene started with opts:", opts);

  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);

  const localDataState = importFromLocalStorage();

  let scene: RestoredDataState & {
    scrollToContent?: boolean;
  } = await loadScene(null, null, localDataState);

  let roomLinkData = getCollaborationLinkData(window.location.href);
  console.log("🔗 roomLinkData:", roomLinkData);

  const isExternalScene = !!(id || jsonBackendMatch || roomLinkData);
  console.log("🌍 isExternalScene:", isExternalScene);

  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      window.confirm(t("alerts.loadSceneOverridePrompt"))
    ) {
      if (jsonBackendMatch) {
        scene = await loadScene(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
          localDataState,
        );
      }
      scene.scrollToContent = true;
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !scene.elements.length ||
        window.confirm(t("alerts.loadSceneOverridePrompt"))
      ) {
        return { scene: data, isExternalScene };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData) {
    console.log("🤝 Starting collaboration with roomLinkData:", roomLinkData);
    const collabScene = await opts.collabAPI.startCollaboration(roomLinkData);
    console.log("🤝 Collaboration scene loaded:", {
      hasElements: !!collabScene?.elements?.length,
      elementCount: collabScene?.elements?.length,
      elements: collabScene?.elements?.map((el) => ({
        type: el.type,
        id: el.id,
        fileId: isInitializedImageElement(el) ? (el as any).fileId : null,
      })),
    });
    return {
      scene: collabScene,
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
    };
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false };
  }
  return { scene: null, isExternalScene: false };
};

const ExcalidrawWrapper = (props: ExcalidrawAppProps) => {
  console.log("🚀 ExcalidrawWrapper initialized with props:", {
    hasOnFileUpload: !!props.onFileUpload,
    hasOnFileFetch: !!props.onFileFetch,
    collabServerUrl: props.collabServerUrl,
    collabDetails: props.collabDetails,
    onFileFetchType: typeof props.onFileFetch,
  });

  const [errorMessage, setErrorMessage] = useState("");
  let currentLangCode = languageDetector.detect() || defaultLang.code;
  if (Array.isArray(currentLangCode)) {
    currentLangCode = currentLangCode[0];
  }
  const [langCode, setLangCode] = useState(currentLangCode);

  // Custom file upload handling
  const handleGenerateIdForFile = useCallback(
    async (file: File): Promise<string> => {
      console.log(
        "📁 handleGenerateIdForFile called with file:",
        file.name,
        file.type,
      );

      if (props.onFileUpload) {
        try {
          // Use custom upload handler
          const fileId = await props.onFileUpload(file);
          console.log("✅ Custom file upload successful, fileId:", fileId);
          return fileId;
        } catch (error) {
          console.error("❌ Custom file upload failed:", error);
          throw error;
        }
      }

      // Fall back to default behavior if no custom handler
      if (props.excalidraw.generateIdForFile) {
        const fileId = await props.excalidraw.generateIdForFile(file);
        console.log("✅ Default generateIdForFile successful, fileId:", fileId);
        return fileId;
      }

      // Default ID generation
      const fileId = (await import("../../../data/blob")).generateIdFromFile(
        file,
      );
      console.log(
        "✅ Default blob generateIdFromFile successful, fileId:",
        fileId,
      );
      return fileId;
    },
    [props.onFileUpload, props.excalidraw.generateIdForFile],
  );

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [excalidrawAPI, excalidrawRefCallback] =
    useCallbackRefState<ExcalidrawImperativeAPI>();

  // Custom image fetching for collaboration
  const handleFileFetch = async (fileIds: string[]) => {
    console.log("🔄 handleFileFetch called with fileIds:", fileIds);
    console.log("🔄 props.onFileFetch available:", !!props.onFileFetch);

    if (props.onFileFetch) {
      try {
        console.log("🚀 Calling props.onFileFetch with:", fileIds);
        const result = await props.onFileFetch(fileIds);
        console.log("✅ props.onFileFetch returned:", result);
        return result;
      } catch (error) {
        console.error("❌ Custom file fetch failed in handleFileFetch:", error);
        return {
          loadedFiles: [],
          erroredFiles: new Map(fileIds.map((id) => [id, true as const])),
        };
      }
    }
    console.log("⚠️ No onFileFetch prop available, returning null");
    return null;
  };

  const handlePaste = useCallback(
    async (data: any, event: ClipboardEvent | null): Promise<boolean> => {
      console.log("📋 handlePaste called with data:", data);

      // If user provided custom paste handler, use it first
      if (props.excalidraw.onPaste) {
        const result = await props.excalidraw.onPaste(data, event);
        if (result === true) {
          console.log("✅ Custom paste handler processed the paste");
          return true; // Custom handler processed the paste
        }
      }

      // Handle image files if custom upload is available
      if (props.onFileUpload && data.files && data.files.length > 0) {
        console.log("📋 Found files in paste data:", data.files.length);
        const imageFiles = data.files.filter((file: File) =>
          file.type.startsWith("image/"),
        );
        console.log("🖼️ Image files in paste:", imageFiles.length);

        if (imageFiles.length > 0) {
          try {
            for (const file of imageFiles) {
              console.log(
                "📋 Processing pasted image file:",
                file.name,
                file.type,
              );
              const fileId = await props.onFileUpload(file);
              console.log("📋 Pasted image uploaded, fileId:", fileId);

              if (excalidrawAPI) {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataURL = reader.result as string;
                  console.log(
                    "📋 Adding pasted image file to excalidraw:",
                    fileId,
                  );
                  excalidrawAPI.addFiles([
                    {
                      id: fileId as any,
                      dataURL: dataURL as any,
                      mimeType: file.type,
                      created: Date.now(),
                    },
                  ]);
                };
                reader.readAsDataURL(file);
              }
            }
            return true;
          } catch (error) {
            console.error("❌ Failed to upload pasted images:", error);
            return false;
          }
        }
      }

      console.log("📋 No files processed in paste");
      return false;
    },
    [props.excalidraw.onPaste, props.onFileUpload],
  );

  const [collabAPI] = useAtom(collabAPIAtom);
  const [, setCollabDialogShown] = useAtom(collabDialogShownAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    const collaborating = isCollaborationLink(window.location.href);
    console.log("🤝 isCollaborating initial value:", collaborating);
    return collaborating;
  });

  console.log("🤝 Current collaboration state:", {
    isCollaborating,
    hasCollabAPI: !!collabAPI,
    hasExcalidrawAPI: !!excalidrawAPI,
  });

  useHandleLibrary({
    excalidrawAPI,
    getInitialLibraryItems: getLibraryItemsFromStorage,
  });

  useEffect(() => {
    console.log("🔄 Main useEffect triggered with:", {
      hasCollabAPI: !!collabAPI,
      hasExcalidrawAPI: !!excalidrawAPI,
      isCollaborating,
    });

    if (!collabAPI || !excalidrawAPI) {
      console.log("⏭️ Skipping useEffect - missing APIs");
      return;
    }

    const loadImages = (
      data: ResolutionType<typeof initializeScene>,
      isInitialLoad = false,
    ) => {
      console.log("🖼️ loadImages called with:", {
        hasScene: !!data.scene,
        isInitialLoad,
        isCollaborating: collabAPI.isCollaborating(),
        hasElements: !!data.scene?.elements?.length,
        elementCount: data.scene?.elements?.length,
      });

      if (!data.scene) {
        console.log("⏭️ No scene data, skipping loadImages");
        return;
      }

      if (collabAPI.isCollaborating()) {
        console.log("🤝 In collaboration mode, processing images...");

        if (data.scene.elements) {
          console.log(
            "📊 Scene elements:",
            data.scene.elements.map((el) => ({
              type: el.type,
              id: el.id,
              isDeleted: el.isDeleted,
              isImage: isInitializedImageElement(el),
              fileId: isInitializedImageElement(el) ? (el as any).fileId : null,
              status: isInitializedImageElement(el) ? (el as any).status : null,
            })),
          );

          // Try custom file fetch first if available
          if (props.onFileFetch) {
            console.log(
              "🔄 Custom onFileFetch available, filtering elements...",
            );

            const fileIds = data.scene.elements
              .filter((element) => {
                const isImage = isInitializedImageElement(element);
                const notDeleted = !element.isDeleted;
                const hasStatus = isImage
                  ? (element as any).status === "saved"
                  : false;

                console.log("🔍 Element filter check:", {
                  elementId: element.id,
                  type: element.type,
                  isImage,
                  notDeleted,
                  hasStatus,
                  fileId: isImage ? (element as any).fileId : null,
                });

                return isImage && notDeleted && hasStatus;
              })
              .map((element) => (element as any).fileId);

            console.log("📥 FileIds to fetch in loadImages:", fileIds);

            if (fileIds.length > 0) {
              console.log("🚀 Calling handleFileFetch from loadImages");
              handleFileFetch(fileIds)
                .then((response) => {
                  console.log(
                    "✅ handleFileFetch response in loadImages:",
                    response,
                  );
                  if (response) {
                    const { loadedFiles, erroredFiles } = response;
                    console.log("📁 Adding files to excalidraw:", {
                      loadedFilesCount: loadedFiles.length,
                      erroredFilesCount: erroredFiles.size,
                    });
                    excalidrawAPI.addFiles(loadedFiles);
                    updateStaleImageStatuses({
                      excalidrawAPI,
                      erroredFiles: erroredFiles as any,
                      elements:
                        excalidrawAPI.getSceneElementsIncludingDeleted(),
                    });
                  }
                })
                .catch((error) => {
                  console.error(
                    "❌ handleFileFetch failed in loadImages:",
                    error,
                  );
                });
            } else {
              console.log("⏭️ No fileIds to fetch in loadImages");
            }
          } else {
            console.log("🔄 No custom onFileFetch, falling back to Firebase");
            // Fall back to Firebase if no custom fetch
            collabAPI
              .fetchImageFilesFromFirebase({
                elements: data.scene.elements,
              })
              .then((response) => {
                console.log("🔥 Firebase fetch response:", response);
                if (!response) {
                  return;
                }

                const { loadedFiles, erroredFiles } = response;
                excalidrawAPI.addFiles(loadedFiles);
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        } else {
          console.log("⚠️ No elements in scene data");
        }
      } else {
        console.log("🏠 Not in collaboration mode, handling local files...");
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isExternalScene) {
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then((response) => {
            if (!response) {
              return;
            }
            const { loadedFiles, erroredFiles } = response;
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
          });
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage.getFiles(fileIds).then((response) => {
              if (!response) {
                return;
              }
              const { loadedFiles, erroredFiles } = response;
              if (loadedFiles.length) {
                excalidrawAPI.addFiles(loadedFiles);
              }
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
          }
          // on fresh load, clear unused files from IDB (from previous
          // session)
          LocalData.fileStorage.clearObsoleteFiles({ currentFileIds: fileIds });
        }
      }
    };

    console.log("🎬 Calling initializeScene...");
    initializeScene({ collabAPI }).then(async (data) => {
      console.log("🎬 initializeScene completed with data:", {
        hasScene: !!data.scene,
        isExternalScene: data.isExternalScene,
        sceneElementCount: data.scene?.elements?.length,
      });

      loadImages(data, /* isInitialLoad */ true);

      initialStatePromiseRef.current.promise.resolve({
        ...data.scene,
        // at this point the state may have already been updated (e.g. when
        // collaborating, we may have received updates from other clients)
        appState: restoreAppState(
          data.scene?.appState,
          excalidrawAPI.getAppState(),
        ),
        elements: reconcileElements(
          data.scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(),
        ),
        // collaborationLink
      });
    });

    const onHashChange = async (event: HashChangeEvent) => {
      console.log("🔗 Hash change event:", event);
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          console.log("🛑 Stopping collaboration due to hash change");
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        console.log("🎬 Re-initializing scene due to hash change...");
        initializeScene({ collabAPI }).then((data) => {
          console.log("🎬 Re-initialization completed:", data);
          loadImages(data);
          if (data.scene) {
            excalidrawAPI.updateScene({
              ...data.scene,
              ...restore(data.scene, null, null),
              commitToHistory: true,
            });
          }
        });
      }
    };

    // const titleTimeout = setTimeout(
    //   () => (document.title = APP_NAME),
    //   TITLE_TIMEOUT,
    // );

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (!document.hidden && !collabAPI.isCollaborating()) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          let langCode = languageDetector.detect() || defaultLang.code;
          if (Array.isArray(langCode)) {
            langCode = langCode[0];
          }
          setLangCode(langCode);
          excalidrawAPI.updateScene({
            ...localDataState,
          });
          excalidrawAPI.updateLibrary({
            libraryItems: getLibraryItemsFromStorage(),
          });
          collabAPI.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage.getFiles(fileIds).then((response) => {
              if (!response) {
                return;
              }
              const { loadedFiles, erroredFiles } = response;
              if (loadedFiles.length) {
                excalidrawAPI.addFiles(loadedFiles);
              }
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const onUnload = () => {
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
      // clearTimeout(titleTimeout);
    };
  }, [
    collabAPI,
    excalidrawAPI,
    handleFileFetch,
    props.onFileFetch,
    isCollaborating,
  ]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        preventUnload(event);
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    languageDetector.cacheUserLanguage(langCode);
  }, [langCode]);

  useEffect(() => {
    if (!excalidrawAPI || !props.getExcalidrawAPI) {
      return;
    }

    console.log("🔌 Calling getExcalidrawAPI callback");
    props.getExcalidrawAPI(excalidrawAPI);
  }, [excalidrawAPI, props]);

  useEffect(() => {
    if (!collabAPI || !props.getCollabAPI) {
      return;
    }

    console.log("🔌 Calling getCollabAPI callback");
    props.getCollabAPI(collabAPI);
  }, [collabAPI, props]);

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    console.log("🔄 onChange called with:", {
      elementCount: elements.length,
      fileCount: Object.keys(files).length,
      isCollaborating: collabAPI?.isCollaborating(),
      imageElements: elements
        .filter((el) => isInitializedImageElement(el))
        .map((el) => ({
          id: el.id,
          type: el.type,
          fileId: (el as any).fileId,
        })),
    });

    if (collabAPI?.isCollaborating()) {
      console.log("🤝 Syncing elements to collaboration");
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            console.log("💾 Updating scene with saved status");
            excalidrawAPI.updateScene({
              elements,
            });
          }
        }
      });
    }

    // Notify parent of file changes if callback provided
    if (props.onFilesChange) {
      console.log("📁 Calling onFilesChange callback");
      props.onFilesChange(files);
    }
  };

  console.log("🎨 Rendering ExcalidrawWrapper with:", {
    hasOnFileFetch: !!props.onFileFetch,
    isCollaborating,
    hasExcalidrawAPI: !!excalidrawAPI,
  });

  return (
    <div
      style={{ height: "100%" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
      })}
    >
      <Excalidraw
        {...props.excalidraw}
        ref={excalidrawRefCallback}
        onChange={onChange}
        initialData={initialStatePromiseRef.current.promise}
        generateIdForFile={handleGenerateIdForFile}
        onPaste={handlePaste}
        {...(!props.collabDetails && {
          onCollabButtonClick: () => setCollabDialogShown(true),
        })}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        renderTopRightUI={props.excalidraw.renderTopRightUI}
        renderFooter={props.excalidraw.renderFooter}
        langCode={langCode}
        renderCustomStats={props.excalidraw.renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
      />
      {excalidrawAPI && (
        <Collab
          collabServerUrl={props.collabServerUrl}
          collabDetails={props.collabDetails}
          excalidrawAPI={excalidrawAPI}
          onFileFetch={props.onFileFetch}
        />
      )}
      {errorMessage && (
        <ErrorDialog
          message={errorMessage}
          onClose={() => setErrorMessage("")}
        />
      )}
    </div>
  );
};

export const ExcalidrawApp = (props: ExcalidrawAppProps) => {
  console.log("🎯 ExcalidrawApp root called with props:", {
    hasOnFileUpload: !!props.onFileUpload,
    hasOnFileFetch: !!props.onFileFetch,
    collabServerUrl: props.collabServerUrl,
  });

  return (
    <TopErrorBoundary>
      <Provider unstable_createStore={() => jotaiStore}>
        <ExcalidrawWrapper {...props} />
      </Provider>
    </TopErrorBoundary>
  );
};
