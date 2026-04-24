import { useState, useEffect, useMemo, useCallback, useReducer } from "react";
import {
  createStore,
  Canvas,
  Layers,
  BlockPanel,
  PropertiesPanel,
  DEFAULT_BLOCKS,
  renderToHtml,
  parseHtml,
  findNode,
  type PBStore,
  type PBBlock,
  type PBProject,
} from "~/lib/page-builder";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

interface PageEditorProps {
  projectData?: string;
  onSave: (projectData: string, html: string, css: string) => void;
  saving?: boolean;
}

type SidebarTab = "blocks" | "layers" | "properties" | "classes" | "resources";

export function PageEditor({ projectData, onSave, saving = false }: PageEditorProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>("blocks");
  const [externalStyles, setExternalStyles] = useState<string[]>([]);
  const [newResourceUrl, setNewResourceUrl] = useState("");

  useEffect(() => setMounted(true), []);

  // Create store once
  const store = useMemo(() => {
    const s = createStore();
    if (projectData) {
      try {
        const data = JSON.parse(projectData);

        if (data.root) {
          // New PBProject format
          s.loadProject(data as PBProject);
          if (data.canvasStyles) {
            setExternalStyles(data.canvasStyles);
          }
        } else if (data.html) {
          // Legacy GrapesJS format — parse HTML into PBNode tree
          if (typeof window !== "undefined") {
            const root = parseHtml(data.html);
            s.setRoot(root);
          }
          if (data._externalStyles) {
            setExternalStyles(data._externalStyles);
          }
        }
      } catch {
        // invalid project
      }
    }
    return s;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to store state via useReducer force-update
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(forceUpdate), [store]);
  const state = store.getState();

  const selectedNode = state.selection.nodeId
    ? findNode(state.root, state.selection.nodeId)
    : null;

  // Auto-switch to properties when something is selected
  useEffect(() => {
    if (selectedNode && activeTab !== "properties") {
      setActiveTab("properties");
    }
  }, [selectedNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save handler
  const handleSave = useCallback(() => {
    const project = store.getProject();
    project.canvasStyles = externalStyles;
    const projectJson = JSON.stringify(project);
    const html = renderToHtml(state.root);
    // CSS is compiled Tailwind + external imports
    const cssImports = externalStyles.map((u) => `@import url('${u}');`).join("\n");
    onSave(projectJson, html, cssImports);
  }, [store, state.root, externalStyles, onSave]);

  // Resource management
  const addResource = useCallback((url: string) => {
    if (!url || externalStyles.includes(url)) return;
    setExternalStyles((prev) => [...prev, url]);
    store.setCanvasStyles([...externalStyles, url]);
  }, [externalStyles, store]);

  const removeResource = useCallback((url: string) => {
    setExternalStyles((prev) => prev.filter((u) => u !== url));
    store.setCanvasStyles(externalStyles.filter((u) => u !== url));
  }, [externalStyles, store]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        store.redo();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (state.selection.nodeId && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
          e.preventDefault();
          store.removeNode(state.selection.nodeId);
        }
      }
      if (e.key === "Escape") {
        store.select(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "d") {
        e.preventDefault();
        if (state.selection.nodeId) {
          store.duplicateNode(state.selection.nodeId);
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [store, state.selection.nodeId]);

  if (!mounted) {
    return (
      <div className="rounded-lg border overflow-hidden bg-background flex items-center justify-center" style={{ height: "calc(100vh - 200px)", minHeight: "600px" }}>
        <p className="text-sm text-muted-foreground">Loading page builder...</p>
      </div>
    );
  }

  const sidebarTabs: { id: SidebarTab; label: string }[] = [
    { id: "blocks", label: "Blocks" },
    { id: "layers", label: "Layers" },
    { id: "properties", label: "Props" },
    { id: "classes", label: "Classes" },
    { id: "resources", label: "Fonts" },
  ];

  return (
    <div className="rounded-lg border overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => store.undo()}
            title="Undo (Ctrl+Z)"
            className="h-7 w-7 p-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h13a4 4 0 010 8H7"/><path d="M3 10l4-4M3 10l4 4"/></svg>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => store.redo()}
            title="Redo (Ctrl+Y)"
            className="h-7 w-7 p-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H8a4 4 0 000 8h10"/><path d="M21 10l-4-4M21 10l-4 4"/></svg>
          </Button>
          <Separator orientation="vertical" className="h-5 mx-1" />
          {selectedNode && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => store.duplicateNode(selectedNode.id)}
                title="Duplicate (Ctrl+D)"
                className="h-7 text-xs"
              >
                Duplicate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => store.removeNode(selectedNode.id)}
                title="Delete (Del)"
                className="h-7 text-xs text-destructive"
              >
                Delete
              </Button>
              <Separator orientation="vertical" className="h-5 mx-1" />
            </>
          )}
          <span className="text-xs text-muted-foreground">
            {selectedNode ? `${selectedNode.name ?? selectedNode.tag}` : "No selection"}
          </span>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {/* Main layout */}
      <div className="flex" style={{ height: "calc(100vh - 200px)", minHeight: "600px" }}>
        {/* Sidebar */}
        <div className="w-64 shrink-0 border-r flex flex-col bg-muted/20">
          {/* Tabs */}
          <div className="flex overflow-x-auto border-b scrollbar-none">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "px-2 py-2 text-[10px] font-medium whitespace-nowrap shrink-0 transition-colors",
                  activeTab === tab.id
                    ? "text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <ScrollArea className="flex-1">
            <div className="p-2">
              {activeTab === "blocks" && (
                <BlockPanel blocks={DEFAULT_BLOCKS} />
              )}

              {activeTab === "layers" && (
                <Layers
                  store={store}
                  root={state.root}
                  selectedId={state.selection.nodeId}
                />
              )}

              {activeTab === "properties" && selectedNode && (
                <PropertiesPanel store={store} node={selectedNode} />
              )}

              {activeTab === "properties" && !selectedNode && (
                <p className="text-xs text-muted-foreground text-center py-8">
                  Select an element to edit its properties
                </p>
              )}

              {activeTab === "classes" && selectedNode && (
                <TailwindClassesPanel store={store} node={selectedNode} loadedFontUrls={externalStyles} />
              )}

              {activeTab === "classes" && !selectedNode && (
                <p className="text-xs text-muted-foreground text-center py-8">
                  Select an element to manage classes
                </p>
              )}

              {activeTab === "resources" && (
                <ResourcesPanel
                  styles={externalStyles}
                  onAdd={addResource}
                  onRemove={removeResource}
                  newUrl={newResourceUrl}
                  setNewUrl={setNewResourceUrl}
                />
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Canvas */}
        <div className="flex-1 bg-white dark:bg-gray-950 overflow-auto">
          <Canvas store={store} />
        </div>
      </div>
    </div>
  );
}

// --- Resources panel ---

const GOOGLE_FONTS = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins",
  "Raleway", "Nunito", "Playfair Display", "Merriweather", "Oswald",
  "DM Sans", "Space Grotesk", "Sora", "Outfit", "Manrope",
  "Plus Jakarta Sans", "Geist",
];

const ICON_LIBS = [
  { label: "Font Awesome 6", url: "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" },
  { label: "Material Icons", url: "https://fonts.googleapis.com/icon?family=Material+Icons" },
  { label: "Bootstrap Icons", url: "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" },
];

function ResourcesPanel({
  styles,
  onAdd,
  onRemove,
  newUrl,
  setNewUrl,
}: {
  styles: string[];
  onAdd: (url: string) => void;
  onRemove: (url: string) => void;
  newUrl: string;
  setNewUrl: (v: string) => void;
}) {
  const [fontInput, setFontInput] = useState("");

  const addFont = (family: string) => {
    onAdd(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}&display=swap`);
  };

  return (
    <div className="space-y-4">
      {/* Google Fonts */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Google Fonts</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {GOOGLE_FONTS.map((font) => {
            const url = `https://fonts.googleapis.com/css2?family=${font.replace(/ /g, "+")}&display=swap`;
            const isActive = styles.includes(url);
            return (
              <button
                key={font}
                type="button"
                onClick={() => isActive ? onRemove(url) : addFont(font)}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80"
                )}
              >
                {font}
              </button>
            );
          })}
        </div>
        <div className="flex gap-1">
          <Input
            value={fontInput}
            onChange={(e) => setFontInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && fontInput.trim()) {
                addFont(fontInput.trim());
                setFontInput("");
              }
            }}
            placeholder="Custom font name..."
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            onClick={() => {
              if (fontInput.trim()) {
                addFont(fontInput.trim());
                setFontInput("");
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>

      {/* Icon libraries */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Icon Libraries</p>
        <div className="flex flex-wrap gap-1">
          {ICON_LIBS.map((lib) => {
            const isActive = styles.includes(lib.url);
            return (
              <button
                key={lib.label}
                type="button"
                onClick={() => isActive ? onRemove(lib.url) : onAdd(lib.url)}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {lib.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active resources */}
      {styles.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Active ({styles.length})</p>
          <div className="space-y-1">
            {styles.map((url) => (
              <div key={url} className="flex items-center gap-1 text-[10px] group">
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">CSS</Badge>
                <span className="truncate flex-1 text-muted-foreground" title={url}>
                  {url.includes("googleapis") ? url.match(/family=([^&]+)/)?.[1]?.replace(/\+/g, " ") ?? url : url.split("/").pop()}
                </span>
                <button type="button" onClick={() => onRemove(url)} className="text-destructive opacity-0 group-hover:opacity-100">×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom URL */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Custom URL</p>
        <div className="flex gap-1">
          <Input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newUrl.trim()) {
                onAdd(newUrl.trim());
                setNewUrl("");
              }
            }}
            placeholder="https://cdn.example.com/style.css"
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            onClick={() => {
              if (newUrl.trim()) {
                onAdd(newUrl.trim());
                setNewUrl("");
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Tailwind Classes Panel ---

import { twMerge } from "tailwind-merge";
import type { PBNode } from "~/lib/page-builder";

const TW_GROUPS: { label: string; classes: { label: string; value: string }[] }[] = [
  { label: "Align Items", classes: [{ label: "start", value: "items-start" }, { label: "end", value: "items-end" }, { label: "center", value: "items-center" }, { label: "baseline", value: "items-baseline" }, { label: "stretch", value: "items-stretch" }] },
  { label: "Align Self", classes: [{ label: "auto", value: "self-auto" }, { label: "start", value: "self-start" }, { label: "end", value: "self-end" }, { label: "center", value: "self-center" }, { label: "stretch", value: "self-stretch" }] },
  { label: "Auto Margins", classes: [{ label: "mx-auto", value: "mx-auto" }, { label: "ml-auto", value: "ml-auto" }, { label: "mr-auto", value: "mr-auto" }, { label: "my-auto", value: "my-auto" }, { label: "mt-auto", value: "mt-auto" }, { label: "mb-auto", value: "mb-auto" }] },
  { label: "Background", classes: [
    { label: "Transparent", value: "bg-transparent" }, { label: "White", value: "bg-white" }, { label: "Black", value: "bg-black" },
    { label: "Slate 50", value: "bg-slate-50" }, { label: "Slate 100", value: "bg-slate-100" }, { label: "Slate 200", value: "bg-slate-200" }, { label: "Slate 300", value: "bg-slate-300" }, { label: "Slate 400", value: "bg-slate-400" }, { label: "Slate 500", value: "bg-slate-500" }, { label: "Slate 600", value: "bg-slate-600" }, { label: "Slate 700", value: "bg-slate-700" }, { label: "Slate 800", value: "bg-slate-800" }, { label: "Slate 900", value: "bg-slate-900" }, { label: "Slate 950", value: "bg-slate-950" },
    { label: "Gray 50", value: "bg-gray-50" }, { label: "Gray 100", value: "bg-gray-100" }, { label: "Gray 200", value: "bg-gray-200" }, { label: "Gray 300", value: "bg-gray-300" }, { label: "Gray 400", value: "bg-gray-400" }, { label: "Gray 500", value: "bg-gray-500" }, { label: "Gray 600", value: "bg-gray-600" }, { label: "Gray 700", value: "bg-gray-700" }, { label: "Gray 800", value: "bg-gray-800" }, { label: "Gray 900", value: "bg-gray-900" }, { label: "Gray 950", value: "bg-gray-950" },
    { label: "Red 50", value: "bg-red-50" }, { label: "Red 100", value: "bg-red-100" }, { label: "Red 200", value: "bg-red-200" }, { label: "Red 300", value: "bg-red-300" }, { label: "Red 400", value: "bg-red-400" }, { label: "Red 500", value: "bg-red-500" }, { label: "Red 600", value: "bg-red-600" }, { label: "Red 700", value: "bg-red-700" }, { label: "Red 800", value: "bg-red-800" }, { label: "Red 900", value: "bg-red-900" },
    { label: "Orange 50", value: "bg-orange-50" }, { label: "Orange 100", value: "bg-orange-100" }, { label: "Orange 300", value: "bg-orange-300" }, { label: "Orange 500", value: "bg-orange-500" }, { label: "Orange 700", value: "bg-orange-700" }, { label: "Orange 900", value: "bg-orange-900" },
    { label: "Amber 50", value: "bg-amber-50" }, { label: "Amber 100", value: "bg-amber-100" }, { label: "Amber 300", value: "bg-amber-300" }, { label: "Amber 500", value: "bg-amber-500" }, { label: "Amber 700", value: "bg-amber-700" },
    { label: "Yellow 50", value: "bg-yellow-50" }, { label: "Yellow 100", value: "bg-yellow-100" }, { label: "Yellow 300", value: "bg-yellow-300" }, { label: "Yellow 400", value: "bg-yellow-400" }, { label: "Yellow 500", value: "bg-yellow-500" },
    { label: "Lime 300", value: "bg-lime-300" }, { label: "Lime 500", value: "bg-lime-500" }, { label: "Lime 700", value: "bg-lime-700" },
    { label: "Green 50", value: "bg-green-50" }, { label: "Green 100", value: "bg-green-100" }, { label: "Green 300", value: "bg-green-300" }, { label: "Green 500", value: "bg-green-500" }, { label: "Green 600", value: "bg-green-600" }, { label: "Green 700", value: "bg-green-700" }, { label: "Green 900", value: "bg-green-900" },
    { label: "Emerald 300", value: "bg-emerald-300" }, { label: "Emerald 500", value: "bg-emerald-500" }, { label: "Emerald 700", value: "bg-emerald-700" },
    { label: "Teal 300", value: "bg-teal-300" }, { label: "Teal 500", value: "bg-teal-500" }, { label: "Teal 700", value: "bg-teal-700" },
    { label: "Cyan 300", value: "bg-cyan-300" }, { label: "Cyan 500", value: "bg-cyan-500" }, { label: "Cyan 700", value: "bg-cyan-700" },
    { label: "Sky 100", value: "bg-sky-100" }, { label: "Sky 300", value: "bg-sky-300" }, { label: "Sky 400", value: "bg-sky-400" }, { label: "Sky 500", value: "bg-sky-500" }, { label: "Sky 700", value: "bg-sky-700" },
    { label: "Blue 50", value: "bg-blue-50" }, { label: "Blue 100", value: "bg-blue-100" }, { label: "Blue 300", value: "bg-blue-300" }, { label: "Blue 500", value: "bg-blue-500" }, { label: "Blue 600", value: "bg-blue-600" }, { label: "Blue 700", value: "bg-blue-700" }, { label: "Blue 900", value: "bg-blue-900" },
    { label: "Indigo 50", value: "bg-indigo-50" }, { label: "Indigo 100", value: "bg-indigo-100" }, { label: "Indigo 300", value: "bg-indigo-300" }, { label: "Indigo 500", value: "bg-indigo-500" }, { label: "Indigo 600", value: "bg-indigo-600" }, { label: "Indigo 700", value: "bg-indigo-700" }, { label: "Indigo 900", value: "bg-indigo-900" },
    { label: "Violet 300", value: "bg-violet-300" }, { label: "Violet 500", value: "bg-violet-500" }, { label: "Violet 700", value: "bg-violet-700" },
    { label: "Purple 50", value: "bg-purple-50" }, { label: "Purple 100", value: "bg-purple-100" }, { label: "Purple 300", value: "bg-purple-300" }, { label: "Purple 500", value: "bg-purple-500" }, { label: "Purple 700", value: "bg-purple-700" }, { label: "Purple 900", value: "bg-purple-900" },
    { label: "Fuchsia 300", value: "bg-fuchsia-300" }, { label: "Fuchsia 500", value: "bg-fuchsia-500" }, { label: "Fuchsia 700", value: "bg-fuchsia-700" },
    { label: "Pink 50", value: "bg-pink-50" }, { label: "Pink 100", value: "bg-pink-100" }, { label: "Pink 300", value: "bg-pink-300" }, { label: "Pink 500", value: "bg-pink-500" }, { label: "Pink 700", value: "bg-pink-700" },
    { label: "Rose 300", value: "bg-rose-300" }, { label: "Rose 500", value: "bg-rose-500" }, { label: "Rose 700", value: "bg-rose-700" },
  ] },
  { label: "Border", classes: [
    { label: "border", value: "border" }, { label: "border-0", value: "border-0" }, { label: "border-2", value: "border-2" }, { label: "border-4", value: "border-4" },
    { label: "border-t", value: "border-t" }, { label: "border-b", value: "border-b" }, { label: "border-l", value: "border-l" }, { label: "border-r", value: "border-r" },
    { label: "border-transparent", value: "border-transparent" }, { label: "border-black", value: "border-black" }, { label: "border-white", value: "border-white" },
    { label: "border-gray-200", value: "border-gray-200" }, { label: "border-gray-300", value: "border-gray-300" }, { label: "border-gray-400", value: "border-gray-400" }, { label: "border-gray-700", value: "border-gray-700" },
    { label: "border-red-500", value: "border-red-500" }, { label: "border-orange-500", value: "border-orange-500" }, { label: "border-yellow-500", value: "border-yellow-500" },
    { label: "border-green-500", value: "border-green-500" }, { label: "border-blue-500", value: "border-blue-500" }, { label: "border-indigo-500", value: "border-indigo-500" },
    { label: "border-purple-500", value: "border-purple-500" }, { label: "border-pink-500", value: "border-pink-500" },
  ] },
  { label: "Radius", classes: [
    { label: "none", value: "rounded-none" }, { label: "sm", value: "rounded-sm" }, { label: "rounded", value: "rounded" }, { label: "md", value: "rounded-md" }, { label: "lg", value: "rounded-lg" }, { label: "xl", value: "rounded-xl" }, { label: "2xl", value: "rounded-2xl" }, { label: "3xl", value: "rounded-3xl" }, { label: "full", value: "rounded-full" },
    { label: "t-lg", value: "rounded-t-lg" }, { label: "b-lg", value: "rounded-b-lg" }, { label: "l-lg", value: "rounded-l-lg" }, { label: "r-lg", value: "rounded-r-lg" },
  ] },
  { label: "Shadow", classes: [
    { label: "none", value: "shadow-none" }, { label: "sm", value: "shadow-sm" }, { label: "shadow", value: "shadow" }, { label: "md", value: "shadow-md" }, { label: "lg", value: "shadow-lg" }, { label: "xl", value: "shadow-xl" }, { label: "2xl", value: "shadow-2xl" }, { label: "inner", value: "shadow-inner" },
  ] },
  { label: "Display", classes: [{ label: "block", value: "block" }, { label: "inline-block", value: "inline-block" }, { label: "inline", value: "inline" }, { label: "flex", value: "flex" }, { label: "inline-flex", value: "inline-flex" }, { label: "grid", value: "grid" }, { label: "hidden", value: "hidden" }] },
  { label: "Flex Direction", classes: [{ label: "row", value: "flex-row" }, { label: "row-reverse", value: "flex-row-reverse" }, { label: "col", value: "flex-col" }, { label: "col-reverse", value: "flex-col-reverse" }] },
  { label: "Flex Grow/Shrink", classes: [{ label: "grow", value: "grow" }, { label: "grow-0", value: "grow-0" }, { label: "shrink", value: "shrink" }, { label: "shrink-0", value: "shrink-0" }, { label: "flex-1", value: "flex-1" }, { label: "flex-auto", value: "flex-auto" }, { label: "flex-none", value: "flex-none" }] },
  { label: "Flex Wrap", classes: [{ label: "wrap", value: "flex-wrap" }, { label: "wrap-reverse", value: "flex-wrap-reverse" }, { label: "nowrap", value: "flex-nowrap" }] },
  { label: "Font Weight", classes: [{ label: "Light", value: "font-light" }, { label: "Normal", value: "font-normal" }, { label: "Medium", value: "font-medium" }, { label: "Semi", value: "font-semibold" }, { label: "Bold", value: "font-bold" }, { label: "Extra", value: "font-extrabold" }] },
  { label: "Gap", classes: [{ label: "0", value: "gap-0" }, { label: "1", value: "gap-1" }, { label: "2", value: "gap-2" }, { label: "3", value: "gap-3" }, { label: "4", value: "gap-4" }, { label: "6", value: "gap-6" }, { label: "8", value: "gap-8" }, { label: "12", value: "gap-12" }] },
  { label: "Height", classes: [{ label: "auto", value: "h-auto" }, { label: "full", value: "h-full" }, { label: "screen", value: "h-screen" }, { label: "12", value: "h-12" }, { label: "24", value: "h-24" }, { label: "48", value: "h-48" }, { label: "64", value: "h-64" }] },
  { label: "Justify Content", classes: [{ label: "start", value: "justify-start" }, { label: "end", value: "justify-end" }, { label: "center", value: "justify-center" }, { label: "between", value: "justify-between" }, { label: "around", value: "justify-around" }, { label: "evenly", value: "justify-evenly" }] },
  { label: "Opacity", classes: [{ label: "0", value: "opacity-0" }, { label: "25", value: "opacity-25" }, { label: "50", value: "opacity-50" }, { label: "75", value: "opacity-75" }, { label: "100", value: "opacity-100" }] },
  { label: "Overflow", classes: [{ label: "hidden", value: "overflow-hidden" }, { label: "auto", value: "overflow-auto" }, { label: "scroll", value: "overflow-scroll" }, { label: "visible", value: "overflow-visible" }] },
  { label: "Position", classes: [{ label: "static", value: "static" }, { label: "relative", value: "relative" }, { label: "absolute", value: "absolute" }, { label: "fixed", value: "fixed" }, { label: "sticky", value: "sticky" }] },
  { label: "Padding", classes: [
    { label: "p-0", value: "p-0" }, { label: "p-1", value: "p-1" }, { label: "p-2", value: "p-2" }, { label: "p-3", value: "p-3" }, { label: "p-4", value: "p-4" }, { label: "p-5", value: "p-5" }, { label: "p-6", value: "p-6" }, { label: "p-8", value: "p-8" }, { label: "p-10", value: "p-10" }, { label: "p-12", value: "p-12" }, { label: "p-16", value: "p-16" }, { label: "p-20", value: "p-20" },
    { label: "px-0", value: "px-0" }, { label: "px-2", value: "px-2" }, { label: "px-4", value: "px-4" }, { label: "px-6", value: "px-6" }, { label: "px-8", value: "px-8" }, { label: "px-10", value: "px-10" }, { label: "px-12", value: "px-12" },
    { label: "py-0", value: "py-0" }, { label: "py-2", value: "py-2" }, { label: "py-4", value: "py-4" }, { label: "py-6", value: "py-6" }, { label: "py-8", value: "py-8" }, { label: "py-10", value: "py-10" }, { label: "py-12", value: "py-12" }, { label: "py-16", value: "py-16" }, { label: "py-20", value: "py-20" },
    { label: "pt-0", value: "pt-0" }, { label: "pt-4", value: "pt-4" }, { label: "pt-8", value: "pt-8" },
    { label: "pb-0", value: "pb-0" }, { label: "pb-4", value: "pb-4" }, { label: "pb-8", value: "pb-8" },
    { label: "pl-0", value: "pl-0" }, { label: "pl-4", value: "pl-4" }, { label: "pl-8", value: "pl-8" },
    { label: "pr-0", value: "pr-0" }, { label: "pr-4", value: "pr-4" }, { label: "pr-8", value: "pr-8" },
  ] },
  { label: "Margin", classes: [
    { label: "m-0", value: "m-0" }, { label: "m-1", value: "m-1" }, { label: "m-2", value: "m-2" }, { label: "m-4", value: "m-4" }, { label: "m-6", value: "m-6" }, { label: "m-8", value: "m-8" }, { label: "m-auto", value: "m-auto" },
    { label: "mx-0", value: "mx-0" }, { label: "mx-2", value: "mx-2" }, { label: "mx-4", value: "mx-4" }, { label: "mx-6", value: "mx-6" }, { label: "mx-8", value: "mx-8" }, { label: "mx-auto", value: "mx-auto" },
    { label: "my-0", value: "my-0" }, { label: "my-2", value: "my-2" }, { label: "my-4", value: "my-4" }, { label: "my-6", value: "my-6" }, { label: "my-8", value: "my-8" },
    { label: "mt-0", value: "mt-0" }, { label: "mt-1", value: "mt-1" }, { label: "mt-2", value: "mt-2" }, { label: "mt-4", value: "mt-4" }, { label: "mt-8", value: "mt-8" }, { label: "mt-auto", value: "mt-auto" },
    { label: "mb-0", value: "mb-0" }, { label: "mb-1", value: "mb-1" }, { label: "mb-2", value: "mb-2" }, { label: "mb-4", value: "mb-4" }, { label: "mb-6", value: "mb-6" }, { label: "mb-8", value: "mb-8" },
    { label: "ml-0", value: "ml-0" }, { label: "ml-2", value: "ml-2" }, { label: "ml-4", value: "ml-4" }, { label: "ml-auto", value: "ml-auto" },
    { label: "mr-0", value: "mr-0" }, { label: "mr-2", value: "mr-2" }, { label: "mr-4", value: "mr-4" }, { label: "mr-auto", value: "mr-auto" },
    { label: "-mt-1", value: "-mt-1" }, { label: "-mt-2", value: "-mt-2" }, { label: "-mt-4", value: "-mt-4" },
    { label: "-mb-1", value: "-mb-1" }, { label: "-mb-2", value: "-mb-2" },
  ] },
  { label: "Text Align", classes: [{ label: "Left", value: "text-left" }, { label: "Center", value: "text-center" }, { label: "Right", value: "text-right" }, { label: "Justify", value: "text-justify" }] },
  { label: "Text Color", classes: [
    { label: "Black", value: "text-black" }, { label: "White", value: "text-white" }, { label: "Transparent", value: "text-transparent" },
    { label: "Slate 400", value: "text-slate-400" }, { label: "Slate 500", value: "text-slate-500" }, { label: "Slate 600", value: "text-slate-600" }, { label: "Slate 700", value: "text-slate-700" }, { label: "Slate 900", value: "text-slate-900" },
    { label: "Gray 300", value: "text-gray-300" }, { label: "Gray 400", value: "text-gray-400" }, { label: "Gray 500", value: "text-gray-500" }, { label: "Gray 600", value: "text-gray-600" }, { label: "Gray 700", value: "text-gray-700" }, { label: "Gray 800", value: "text-gray-800" }, { label: "Gray 900", value: "text-gray-900" },
    { label: "Red 400", value: "text-red-400" }, { label: "Red 500", value: "text-red-500" }, { label: "Red 600", value: "text-red-600" }, { label: "Red 700", value: "text-red-700" },
    { label: "Orange 400", value: "text-orange-400" }, { label: "Orange 500", value: "text-orange-500" }, { label: "Orange 600", value: "text-orange-600" },
    { label: "Amber 500", value: "text-amber-500" }, { label: "Amber 600", value: "text-amber-600" },
    { label: "Yellow 400", value: "text-yellow-400" }, { label: "Yellow 500", value: "text-yellow-500" }, { label: "Yellow 600", value: "text-yellow-600" },
    { label: "Lime 500", value: "text-lime-500" }, { label: "Lime 600", value: "text-lime-600" },
    { label: "Green 400", value: "text-green-400" }, { label: "Green 500", value: "text-green-500" }, { label: "Green 600", value: "text-green-600" }, { label: "Green 700", value: "text-green-700" },
    { label: "Emerald 400", value: "text-emerald-400" }, { label: "Emerald 500", value: "text-emerald-500" }, { label: "Emerald 600", value: "text-emerald-600" },
    { label: "Teal 400", value: "text-teal-400" }, { label: "Teal 500", value: "text-teal-500" }, { label: "Teal 600", value: "text-teal-600" },
    { label: "Cyan 400", value: "text-cyan-400" }, { label: "Cyan 500", value: "text-cyan-500" },
    { label: "Sky 400", value: "text-sky-400" }, { label: "Sky 500", value: "text-sky-500" }, { label: "Sky 600", value: "text-sky-600" },
    { label: "Blue 400", value: "text-blue-400" }, { label: "Blue 500", value: "text-blue-500" }, { label: "Blue 600", value: "text-blue-600" }, { label: "Blue 700", value: "text-blue-700" },
    { label: "Indigo 400", value: "text-indigo-400" }, { label: "Indigo 500", value: "text-indigo-500" }, { label: "Indigo 600", value: "text-indigo-600" }, { label: "Indigo 700", value: "text-indigo-700" },
    { label: "Violet 400", value: "text-violet-400" }, { label: "Violet 500", value: "text-violet-500" }, { label: "Violet 600", value: "text-violet-600" },
    { label: "Purple 400", value: "text-purple-400" }, { label: "Purple 500", value: "text-purple-500" }, { label: "Purple 600", value: "text-purple-600" }, { label: "Purple 700", value: "text-purple-700" },
    { label: "Fuchsia 400", value: "text-fuchsia-400" }, { label: "Fuchsia 500", value: "text-fuchsia-500" },
    { label: "Pink 400", value: "text-pink-400" }, { label: "Pink 500", value: "text-pink-500" }, { label: "Pink 600", value: "text-pink-600" },
    { label: "Rose 400", value: "text-rose-400" }, { label: "Rose 500", value: "text-rose-500" }, { label: "Rose 600", value: "text-rose-600" },
  ] },
  { label: "Text Size", classes: [{ label: "xs", value: "text-xs" }, { label: "sm", value: "text-sm" }, { label: "base", value: "text-base" }, { label: "lg", value: "text-lg" }, { label: "xl", value: "text-xl" }, { label: "2xl", value: "text-2xl" }, { label: "3xl", value: "text-3xl" }, { label: "4xl", value: "text-4xl" }, { label: "5xl", value: "text-5xl" }] },
  { label: "Text Style", classes: [{ label: "italic", value: "italic" }, { label: "underline", value: "underline" }, { label: "line-through", value: "line-through" }, { label: "uppercase", value: "uppercase" }, { label: "lowercase", value: "lowercase" }, { label: "capitalize", value: "capitalize" }, { label: "normal-case", value: "normal-case" }] },
  { label: "Width", classes: [{ label: "full", value: "w-full" }, { label: "1/2", value: "w-1/2" }, { label: "1/3", value: "w-1/3" }, { label: "2/3", value: "w-2/3" }, { label: "max-w-sm", value: "max-w-sm" }, { label: "max-w-md", value: "max-w-md" }, { label: "max-w-lg", value: "max-w-lg" }, { label: "max-w-xl", value: "max-w-xl" }, { label: "max-w-2xl", value: "max-w-2xl" }, { label: "max-w-4xl", value: "max-w-4xl" }] },
  { label: "Aspect Ratio", classes: [{ label: "auto", value: "aspect-auto" }, { label: "square", value: "aspect-square" }, { label: "video", value: "aspect-video" }] },
  { label: "Cursor", classes: [{ label: "default", value: "cursor-default" }, { label: "pointer", value: "cursor-pointer" }, { label: "text", value: "cursor-text" }, { label: "move", value: "cursor-move" }, { label: "not-allowed", value: "cursor-not-allowed" }, { label: "grab", value: "cursor-grab" }] },
  { label: "Gradients", classes: [{ label: "To Right", value: "bg-gradient-to-r" }, { label: "To Left", value: "bg-gradient-to-l" }, { label: "To Bottom", value: "bg-gradient-to-b" }, { label: "To Top", value: "bg-gradient-to-t" }, { label: "To BR", value: "bg-gradient-to-br" }, { label: "To BL", value: "bg-gradient-to-bl" }] },
  { label: "Gradient From", classes: [
    { label: "Black", value: "from-black" }, { label: "White", value: "from-white" }, { label: "Transparent", value: "from-transparent" },
    { label: "Slate 500", value: "from-slate-500" }, { label: "Gray 500", value: "from-gray-500" },
    { label: "Red 400", value: "from-red-400" }, { label: "Red 500", value: "from-red-500" }, { label: "Red 600", value: "from-red-600" },
    { label: "Orange 400", value: "from-orange-400" }, { label: "Orange 500", value: "from-orange-500" },
    { label: "Amber 400", value: "from-amber-400" }, { label: "Yellow 400", value: "from-yellow-400" },
    { label: "Lime 400", value: "from-lime-400" }, { label: "Green 400", value: "from-green-400" }, { label: "Green 500", value: "from-green-500" },
    { label: "Emerald 400", value: "from-emerald-400" }, { label: "Emerald 500", value: "from-emerald-500" },
    { label: "Teal 400", value: "from-teal-400" }, { label: "Teal 500", value: "from-teal-500" },
    { label: "Cyan 400", value: "from-cyan-400" }, { label: "Cyan 500", value: "from-cyan-500" },
    { label: "Sky 400", value: "from-sky-400" }, { label: "Sky 500", value: "from-sky-500" },
    { label: "Blue 400", value: "from-blue-400" }, { label: "Blue 500", value: "from-blue-500" }, { label: "Blue 600", value: "from-blue-600" },
    { label: "Indigo 400", value: "from-indigo-400" }, { label: "Indigo 500", value: "from-indigo-500" }, { label: "Indigo 600", value: "from-indigo-600" },
    { label: "Violet 400", value: "from-violet-400" }, { label: "Violet 500", value: "from-violet-500" },
    { label: "Purple 400", value: "from-purple-400" }, { label: "Purple 500", value: "from-purple-500" }, { label: "Purple 600", value: "from-purple-600" },
    { label: "Fuchsia 400", value: "from-fuchsia-400" }, { label: "Fuchsia 500", value: "from-fuchsia-500" },
    { label: "Pink 400", value: "from-pink-400" }, { label: "Pink 500", value: "from-pink-500" },
    { label: "Rose 400", value: "from-rose-400" }, { label: "Rose 500", value: "from-rose-500" },
  ] },
  { label: "Gradient Via", classes: [
    { label: "Transparent", value: "via-transparent" },
    { label: "Red 500", value: "via-red-500" }, { label: "Orange 500", value: "via-orange-500" }, { label: "Yellow 400", value: "via-yellow-400" },
    { label: "Green 500", value: "via-green-500" }, { label: "Emerald 500", value: "via-emerald-500" }, { label: "Teal 500", value: "via-teal-500" },
    { label: "Cyan 500", value: "via-cyan-500" }, { label: "Sky 500", value: "via-sky-500" },
    { label: "Blue 500", value: "via-blue-500" }, { label: "Indigo 500", value: "via-indigo-500" },
    { label: "Violet 500", value: "via-violet-500" }, { label: "Purple 500", value: "via-purple-500" },
    { label: "Fuchsia 500", value: "via-fuchsia-500" }, { label: "Pink 500", value: "via-pink-500" }, { label: "Rose 500", value: "via-rose-500" },
  ] },
  { label: "Gradient To", classes: [
    { label: "Black", value: "to-black" }, { label: "White", value: "to-white" }, { label: "Transparent", value: "to-transparent" },
    { label: "Red 400", value: "to-red-400" }, { label: "Red 500", value: "to-red-500" },
    { label: "Orange 400", value: "to-orange-400" }, { label: "Orange 500", value: "to-orange-500" },
    { label: "Yellow 400", value: "to-yellow-400" },
    { label: "Green 400", value: "to-green-400" }, { label: "Green 500", value: "to-green-500" },
    { label: "Emerald 400", value: "to-emerald-400" }, { label: "Teal 400", value: "to-teal-400" },
    { label: "Cyan 400", value: "to-cyan-400" }, { label: "Sky 400", value: "to-sky-400" },
    { label: "Blue 400", value: "to-blue-400" }, { label: "Blue 500", value: "to-blue-500" },
    { label: "Indigo 500", value: "to-indigo-500" }, { label: "Indigo 600", value: "to-indigo-600" },
    { label: "Violet 500", value: "to-violet-500" }, { label: "Purple 500", value: "to-purple-500" }, { label: "Purple 600", value: "to-purple-600" },
    { label: "Fuchsia 500", value: "to-fuchsia-500" }, { label: "Pink 500", value: "to-pink-500" },
    { label: "Rose 500", value: "to-rose-500" },
  ] },
  { label: "Text Gradients", classes: [{ label: "Purple→Pink", value: "bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent" }, { label: "Blue→Cyan", value: "bg-gradient-to-r from-blue-500 to-cyan-400 bg-clip-text text-transparent" }, { label: "Green→Teal", value: "bg-gradient-to-r from-green-500 to-teal-400 bg-clip-text text-transparent" }, { label: "Red→Orange", value: "bg-gradient-to-r from-red-500 to-orange-400 bg-clip-text text-transparent" }, { label: "Sunset", value: "bg-gradient-to-r from-orange-400 via-pink-500 to-purple-500 bg-clip-text text-transparent" }, { label: "Ocean", value: "bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 bg-clip-text text-transparent" }, { label: "None", value: "" }] },
  { label: "Grid", classes: [{ label: "cols-1", value: "grid-cols-1" }, { label: "cols-2", value: "grid-cols-2" }, { label: "cols-3", value: "grid-cols-3" }, { label: "cols-4", value: "grid-cols-4" }, { label: "cols-6", value: "grid-cols-6" }, { label: "cols-12", value: "grid-cols-12" }, { label: "span-1", value: "col-span-1" }, { label: "span-2", value: "col-span-2" }, { label: "span-3", value: "col-span-3" }, { label: "span-4", value: "col-span-4" }, { label: "span-6", value: "col-span-6" }, { label: "span-full", value: "col-span-full" }] },
  { label: "Order", classes: [{ label: "first", value: "order-first" }, { label: "last", value: "order-last" }, { label: "none", value: "order-none" }, { label: "1", value: "order-1" }, { label: "2", value: "order-2" }, { label: "3", value: "order-3" }, { label: "4", value: "order-4" }, { label: "5", value: "order-5" }] },
  { label: "Hover States", classes: [{ label: "hover:opacity-80", value: "hover:opacity-80" }, { label: "hover:opacity-90", value: "hover:opacity-90" }, { label: "hover:scale-105", value: "hover:scale-105" }, { label: "hover:scale-110", value: "hover:scale-110" }, { label: "hover:underline", value: "hover:underline" }, { label: "hover:no-underline", value: "hover:no-underline" }, { label: "hover:shadow-lg", value: "hover:shadow-lg" }, { label: "hover:shadow-xl", value: "hover:shadow-xl" }] },
  { label: "Transition", classes: [{ label: "all", value: "transition-all" }, { label: "default", value: "transition" }, { label: "colors", value: "transition-colors" }, { label: "transform", value: "transition-transform" }, { label: "opacity", value: "transition-opacity" }, { label: "none", value: "transition-none" }, { label: "fast (150)", value: "duration-150" }, { label: "normal (300)", value: "duration-300" }, { label: "slow (500)", value: "duration-500" }, { label: "slower (700)", value: "duration-700" }] },
  { label: "Transform", classes: [{ label: "scale-90", value: "scale-90" }, { label: "scale-95", value: "scale-95" }, { label: "scale-100", value: "scale-100" }, { label: "scale-105", value: "scale-105" }, { label: "scale-110", value: "scale-110" }, { label: "rotate-0", value: "rotate-0" }, { label: "rotate-45", value: "rotate-45" }, { label: "rotate-90", value: "rotate-90" }, { label: "rotate-180", value: "rotate-180" }, { label: "-rotate-45", value: "-rotate-45" }, { label: "-rotate-90", value: "-rotate-90" }] },
  { label: "Object Fit", classes: [{ label: "contain", value: "object-contain" }, { label: "cover", value: "object-cover" }, { label: "fill", value: "object-fill" }, { label: "none", value: "object-none" }, { label: "scale-down", value: "object-scale-down" }] },
  { label: "Visibility", classes: [{ label: "visible", value: "visible" }, { label: "invisible", value: "invisible" }, { label: "sr-only", value: "sr-only" }] },
  { label: "Line Clamp", classes: [{ label: "1 line", value: "line-clamp-1" }, { label: "2 lines", value: "line-clamp-2" }, { label: "3 lines", value: "line-clamp-3" }, { label: "none", value: "line-clamp-none" }, { label: "truncate", value: "truncate" }] },
  { label: "Line Height", classes: [{ label: "none", value: "leading-none" }, { label: "tight", value: "leading-tight" }, { label: "snug", value: "leading-snug" }, { label: "normal", value: "leading-normal" }, { label: "relaxed", value: "leading-relaxed" }, { label: "loose", value: "leading-loose" }] },
  { label: "Letter Spacing", classes: [{ label: "tighter", value: "tracking-tighter" }, { label: "tight", value: "tracking-tight" }, { label: "normal", value: "tracking-normal" }, { label: "wide", value: "tracking-wide" }, { label: "wider", value: "tracking-wider" }, { label: "widest", value: "tracking-widest" }] },
  { label: "List Style", classes: [{ label: "none", value: "list-none" }, { label: "disc", value: "list-disc" }, { label: "decimal", value: "list-decimal" }, { label: "inside", value: "list-inside" }, { label: "outside", value: "list-outside" }] },
];

const BREAKPOINTS = [
  { label: "All", value: "" },
  { label: "sm", value: "sm:" },
  { label: "md", value: "md:" },
  { label: "lg", value: "lg:" },
  { label: "xl", value: "xl:" },
  { label: "2xl", value: "2xl:" },
];

function TailwindClassesPanel({
  store,
  node,
  loadedFontUrls,
}: {
  store: PBStore;
  node: PBNode;
  loadedFontUrls: string[];
}) {
  const [classInput, setClassInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const classes = node.classes;

  // Build font family group from loaded fonts
  const fontClasses: { label: string; value: string }[] = [
    { label: "Sans", value: "font-sans" },
    { label: "Serif", value: "font-serif" },
    { label: "Mono", value: "font-mono" },
  ];
  for (const url of loadedFontUrls) {
    if (!url.includes("fonts.googleapis.com")) continue;
    const match = url.match(/family=([^&:]+)/);
    if (match) {
      const family = match[1].replace(/\+/g, " ");
      const key = family.toLowerCase().replace(/\s+/g, "-");
      fontClasses.push({ label: family, value: `font-${key}` });
    }
  }

  const allGroups = [
    { label: "Font Family", classes: fontClasses },
    ...TW_GROUPS,
  ].sort((a, b) => a.label.localeCompare(b.label));

  const handleAddClass = useCallback(() => {
    const newClasses = classInput.trim().split(/\s+/).filter(Boolean);
    if (newClasses.length === 0) return;
    const merged = twMerge(classes.join(" "), newClasses.join(" "));
    store.updateNode(node.id, { classes: merged.split(" ").filter(Boolean) });
    setClassInput("");
  }, [store, node.id, classes, classInput]);

  const handleRemoveClass = useCallback(
    (cls: string) => {
      store.updateNode(node.id, { classes: classes.filter((c) => c !== cls) });
    },
    [store, node.id, classes]
  );

  const handleToggle = useCallback(
    (value: string) => {
      const toAdd = value.split(/\s+/).map((c) => prefix + c).filter(Boolean);
      if (toAdd.length === 0) return;

      const allApplied = toAdd.every((c) => classes.includes(c));
      if (allApplied) {
        store.updateNode(node.id, { classes: classes.filter((c) => !toAdd.includes(c)) });
      } else {
        const merged = twMerge(classes.join(" "), toAdd.join(" "));
        store.updateNode(node.id, { classes: merged.split(" ").filter(Boolean) });
      }
    },
    [store, node.id, classes, prefix]
  );

  return (
    <div className="space-y-3">
      {/* Responsive breakpoint */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Breakpoint</p>
        <div className="flex gap-0.5">
          {BREAKPOINTS.map((bp) => (
            <button
              key={bp.value}
              type="button"
              onClick={() => setPrefix(bp.value)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                prefix === bp.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              )}
            >
              {bp.label}
            </button>
          ))}
        </div>
        {prefix && (
          <p className="text-[9px] text-muted-foreground mt-1">
            Classes will be prefixed with <code className="text-[9px]">{prefix}</code>
          </p>
        )}
      </div>

      <Separator />

      {/* Active classes */}
      {classes.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
            Active ({classes.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {classes.map((cls) => (
              <Badge key={cls} variant="secondary" className="text-[10px] font-mono px-1.5 py-0 h-5 gap-0.5">
                {cls}
                <button
                  type="button"
                  onClick={() => handleRemoveClass(cls)}
                  className="text-muted-foreground hover:text-destructive ml-0.5"
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Add class input */}
      <div className="flex gap-1">
        <Input
          value={classInput}
          onChange={(e) => setClassInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddClass(); } }}
          placeholder="text-xl font-bold..."
          className="h-7 text-xs"
        />
        <Button size="sm" variant="outline" className="h-7 text-[10px] px-2" onClick={handleAddClass}>
          Add
        </Button>
      </div>

      <Separator />

      {/* Quick styles */}
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
        Quick Styles {prefix && <span className="text-primary">({prefix.replace(":", "")})</span>}
      </p>
      {allGroups.map((group) => (
        <div key={group.label}>
          <button
            type="button"
            onClick={() => setOpenGroup(openGroup === group.label ? null : group.label)}
            className="w-full flex items-center justify-between text-[11px] font-medium text-muted-foreground py-0.5 hover:text-foreground"
          >
            {group.label}
            <span className="text-[9px]">{openGroup === group.label ? "▲" : "▼"}</span>
          </button>
          {openGroup === group.label && (
            <div className="flex flex-wrap gap-1 pb-2">
              {group.classes.map((cls) => {
                const prefixed = cls.value.split(/\s+/).map((c) => prefix + c).join(" ");
                const parts = prefixed.split(/\s+/).filter(Boolean);
                const isActive = parts.length > 0 && parts.every((p) => classes.includes(p));
                return (
                  <button
                    key={cls.value}
                    type="button"
                    onClick={() => handleToggle(cls.value)}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] transition-colors",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {cls.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
