import { useState, useEffect, useRef, useCallback } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

interface WhiteboardEditorProps {
  initialScene?: unknown;
  onSave: (scene: unknown, imageDataUrl: string | null) => Promise<void>;
  saving?: boolean;
}

// Excalidraw accesses `window` at import time, so we must load it on the client.
// We store the imports in module-level refs once loaded.
let excalidrawModule: typeof import("@excalidraw/excalidraw") | null = null;

async function loadExcalidraw() {
  if (excalidrawModule) return excalidrawModule;
  excalidrawModule = await import("@excalidraw/excalidraw");
  await import("@excalidraw/excalidraw/index.css");
  return excalidrawModule;
}

export function WhiteboardEditor({
  initialScene,
  onSave,
  saving = false,
}: WhiteboardEditorProps) {
  const [Component, setComponent] = useState<
    typeof import("@excalidraw/excalidraw").Excalidraw | null
  >(null);
  const [exportFn, setExportFn] = useState<
    typeof import("@excalidraw/excalidraw").exportToBlob | null
  >(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    loadExcalidraw().then((mod) => {
      setComponent(() => mod.Excalidraw);
      setExportFn(() => mod.exportToBlob);
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiRef.current || !exportFn) return;

    const elements = apiRef.current.getSceneElements();
    const appState = apiRef.current.getAppState();
    const files = apiRef.current.getFiles();

    // Build the scene JSON (Excalidraw's save format)
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "stencil-cms",
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
      },
      files,
    };

    // Export to PNG blob
    let imageDataUrl: string | null = null;
    if (elements.length > 0) {
      try {
        const blob = await exportFn({
          elements,
          appState: {
            ...appState,
            exportBackground: true,
            exportWithDarkMode: false,
          },
          files,
          mimeType: "image/png",
          quality: 0.92,
        });
        imageDataUrl = await blobToDataUrl(blob);
      } catch (e) {
        console.error("Failed to export whiteboard image:", e);
      }
    }

    await onSave(scene, imageDataUrl);
  }, [exportFn, onSave]);

  if (!Component) {
    return (
      <div className="h-[600px] flex items-center justify-center border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900">
        <p className="text-sm text-gray-400">Loading whiteboard...</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute -top-10 right-2 z-10">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-50 shadow-md"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div className="h-[700px] border border-gray-300 dark:border-gray-700 rounded-lg overflow-hidden">
        <Component
          excalidrawAPI={(api) => {
            apiRef.current = api;
          }}
          initialData={
            initialScene
              ? (initialScene as Parameters<
                  typeof import("@excalidraw/excalidraw").Excalidraw
                >[0]["initialData"])
              : undefined
          }
        />
      </div>
    </div>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
