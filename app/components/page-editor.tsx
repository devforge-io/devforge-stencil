import { useState, useEffect, useRef, useCallback } from "react";
import { twMerge } from "tailwind-merge";
import type { Editor as GrapesEditor } from "grapesjs";

interface PageEditorProps {
  projectData?: string;
  onSave: (projectData: string, html: string, css: string) => void;
  saving?: boolean;
}

type SidebarTab = "blocks" | "layers" | "classes" | "styles" | "traits";

let grapejsModule: typeof import("grapesjs") | null = null;
let blocksModule: typeof import("grapesjs-blocks-basic") | null = null;

async function loadGrapes() {
  if (grapejsModule) return { grapesjs: grapejsModule, blocks: blocksModule! };
  const [gjs, blocks] = await Promise.all([
    import("grapesjs"),
    import("grapesjs-blocks-basic"),
  ]);
  await import("grapesjs/dist/css/grapes.min.css");
  grapejsModule = gjs;
  blocksModule = blocks;
  return { grapesjs: gjs, blocks };
}

function isGradientClass(c: string): boolean {
  return (
    c.startsWith("bg-gradient-") ||
    c.startsWith("from-") ||
    c.startsWith("via-") ||
    c.startsWith("to-") ||
    c === "bg-clip-text" ||
    c === "text-transparent"
  );
}

export function PageEditor({
  projectData,
  onSave,
  saving = false,
}: PageEditorProps) {
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>("blocks");
  const [device, setDevice] = useState("Desktop");
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [classInput, setClassInput] = useState("");

  // GrapesJS mount targets
  const canvasRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const selectorsRef = useRef<HTMLDivElement>(null);
  const stylesRef = useRef<HTMLDivElement>(null);
  const traitsRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<GrapesEditor | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    let destroyed = false;

    loadGrapes().then(({ grapesjs, blocks }) => {
      if (destroyed || !canvasRef.current) return;

      const editor = grapesjs.default.init({
        container: canvasRef.current,
        height: "100%",
        width: "auto",
        fromElement: false,
        storageManager: false,

        canvas: {
          scripts: ["https://cdn.tailwindcss.com"],
          styles: [],
          frameStyle: `
            .gjs-selected.text-center {
              display: inherit !important;
              justify-content: inherit !important;
              align-items: inherit !important;
            }
          `,
        },

        // Force plain text paste in the rich text editor
        richTextEditor: {
          actions: ["bold", "italic", "underline", "strikethrough", "link"],
          custom: {
            parseContent: true,
          },
        },

        // Disable all default panels — we render our own React UI
        panels: { defaults: [] },

        // Mount manager UIs into our React refs
        selectorManager: {
          appendTo: selectorsRef.current!,
          componentFirst: true,
        },
        blockManager: {
          appendTo: blocksRef.current!,
        },
        layerManager: {
          appendTo: layersRef.current!,
        },
        styleManager: {
          appendTo: stylesRef.current!,
          sectors: [
            {
              name: "Layout",
              open: true,
              properties: [
                "display",
                "flex-direction",
                "justify-content",
                "align-items",
                "flex-wrap",
                "gap",
                "float",
                "position",
                "top",
                "right",
                "bottom",
                "left",
                "overflow",
              ],
            },
            {
              name: "Size",
              properties: [
                "width",
                "min-width",
                "max-width",
                "height",
                "min-height",
                "max-height",
                "margin",
                "padding",
              ],
            },
            {
              name: "Typography",
              properties: [
                "font-family",
                "font-size",
                "font-weight",
                "letter-spacing",
                "color",
                "line-height",
                "text-align",
                "text-decoration",
                "text-transform",
                "text-shadow",
              ],
            },
            {
              name: "Background",
              properties: [
                "background-color",
                "background-image",
                "background-repeat",
                "background-position",
                "background-size",
              ],
            },
            {
              name: "Border",
              properties: [
                "border",
                "border-radius",
                "box-shadow",
              ],
            },
            {
              name: "Effects",
              properties: ["opacity", "transition", "transform", "cursor"],
            },
          ],
        },
        traitManager: {
          appendTo: traitsRef.current!,
        },

        plugins: [blocks.default],
        pluginsOpts: {
          [blocks.default as unknown as string]: {
            flexGrid: true,
          },
        },

        deviceManager: {
          devices: [
            { name: "Desktop", width: "" },
            { name: "Tablet", width: "768px", widthMedia: "992px" },
            { name: "Mobile", width: "375px", widthMedia: "480px" },
          ],
        },

        assetManager: {
          assets: [], // loaded after init
          uploadFile: async (e: Event) => {
            const input = e.target as HTMLInputElement;
            const files = input?.files ?? (e as unknown as { dataTransfer?: { files: FileList } }).dataTransfer?.files;
            if (!files) return;
            for (const file of Array.from(files)) {
              const formData = new FormData();
              formData.append("file", file);
              try {
                const res = await fetch("/api/assets/upload", {
                  method: "POST",
                  body: formData,
                });
                if (res.ok) {
                  const { url, filename } = await res.json();
                  editor.AssetManager.add({
                    src: url,
                    name: filename,
                    type: "image",
                  });
                  // Auto-select the newly uploaded image
                  const asset = editor.AssetManager.getAll().find(
                    (a: { get: (k: string) => string }) => a.get("src") === url
                  );
                  if (asset) {
                    editor.AssetManager.getAll().trigger("select", asset);
                  }
                }
              } catch {
                // ignore
              }
            }
          },
        },
      });

      // Load existing assets from the API
      fetch("/api/assets")
        .then((r) => r.json())
        .then(({ assets }) => {
          if (assets?.length) {
            editor.AssetManager.add(
              assets.map((a: { url: string; name: string }) => ({
                src: a.url,
                name: a.name,
                type: "image",
              }))
            );
          }
        })
        .catch(() => {});

      // Custom blocks
      const bm = editor.BlockManager;

      bm.add("section", {
        label: "Section",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/></svg>`,
        content: `<section class="py-12 px-8"><h2 class="text-2xl font-bold mb-4">Section Title</h2><p class="text-gray-600">Section content goes here.</p></section>`,
      });

      bm.add("hero", {
        label: "Hero",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="6" y1="13" x2="18" y2="13"/><rect x="9" y="16" width="6" height="2" rx="1"/></svg>`,
        content: `<section class="py-16 px-8 text-center bg-gray-50">
          <h1 class="text-4xl font-bold mb-4">Hero Title</h1>
          <p class="text-lg text-gray-500 max-w-xl mx-auto mb-8">A compelling description that draws readers in.</p>
          <a href="#" class="inline-block px-6 py-3 bg-indigo-500 text-white rounded-lg font-medium hover:bg-indigo-600">Get Started</a>
        </section>`,
      });

      bm.add("two-cols", {
        label: "2 Columns",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="9" height="16" rx="1"/><rect x="13" y="4" width="9" height="16" rx="1"/></svg>`,
        content: `<div class="flex gap-8 p-8"><div class="flex-1"><h3 class="text-xl font-semibold mb-2">Column 1</h3><p class="text-gray-600">Content here.</p></div><div class="flex-1"><h3 class="text-xl font-semibold mb-2">Column 2</h3><p class="text-gray-600">Content here.</p></div></div>`,
      });

      bm.add("three-cols", {
        label: "3 Columns",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="4" width="6" height="16" rx="1"/><rect x="9" y="4" width="6" height="16" rx="1"/><rect x="17" y="4" width="6" height="16" rx="1"/></svg>`,
        content: `<div class="flex gap-8 p-8"><div class="flex-1"><h3 class="text-xl font-semibold mb-2">Col 1</h3><p class="text-gray-600">Content.</p></div><div class="flex-1"><h3 class="text-xl font-semibold mb-2">Col 2</h3><p class="text-gray-600">Content.</p></div><div class="flex-1"><h3 class="text-xl font-semibold mb-2">Col 3</h3><p class="text-gray-600">Content.</p></div></div>`,
      });

      bm.add("card", {
        label: "Card",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
        content: `<div class="border border-gray-200 rounded-lg overflow-hidden max-w-sm"><div class="h-44 bg-gray-100"></div><div class="p-5"><h3 class="font-semibold mb-2">Card Title</h3><p class="text-gray-500 text-sm">Card description goes here.</p></div></div>`,
      });

      bm.add("btn", {
        label: "Button",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="8" width="18" height="8" rx="4"/></svg>`,
        content: `<a href="#" class="inline-block px-6 py-3 bg-indigo-500 text-white rounded-lg font-medium hover:bg-indigo-600 no-underline">Button</a>`,
      });

      bm.add("testimonial", {
        label: "Testimonial",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7.5 8.5h-4a1 1 0 00-1 1v4a1 1 0 001 1h2l-1 3 3-3h0a1 1 0 001-1v-4a1 1 0 00-1-1z"/><path d="M18.5 8.5h-4a1 1 0 00-1 1v4a1 1 0 001 1h2l-1 3 3-3h0a1 1 0 001-1v-4a1 1 0 00-1-1z"/></svg>`,
        content: `<div class="bg-gray-50 rounded-xl p-8 max-w-lg mx-auto text-center">
          <p class="text-gray-600 italic mb-4">"This is an amazing product that changed how we work."</p>
          <p class="font-semibold text-sm">Jane Doe</p>
          <p class="text-gray-400 text-xs">CEO, Company</p>
        </div>`,
      });

      bm.add("pricing", {
        label: "Pricing Card",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="10" y1="6" x2="14" y2="6"/></svg>`,
        content: `<div class="border border-gray-200 rounded-xl p-8 max-w-xs text-center">
          <h3 class="text-lg font-semibold mb-1">Pro Plan</h3>
          <p class="text-gray-400 text-sm mb-4">For growing teams</p>
          <p class="text-4xl font-bold mb-6">$49<span class="text-base font-normal text-gray-400">/mo</span></p>
          <ul class="text-sm text-gray-600 space-y-2 mb-8 text-left">
            <li>Unlimited projects</li>
            <li>Priority support</li>
            <li>Advanced analytics</li>
          </ul>
          <a href="#" class="block w-full py-2.5 bg-indigo-500 text-white rounded-lg font-medium hover:bg-indigo-600 no-underline">Get Started</a>
        </div>`,
      });

      bm.add("nav", {
        label: "Navbar",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="4" rx="1"/><line x1="6" y1="6" x2="10" y2="6"/><line x1="14" y1="6" x2="18" y2="6"/></svg>`,
        content: `<nav class="flex items-center justify-between px-8 py-4 border-b border-gray-200">
          <span class="text-xl font-bold">Brand</span>
          <div class="flex gap-6">
            <a href="#" class="text-gray-600 hover:text-gray-900 no-underline text-sm">Features</a>
            <a href="#" class="text-gray-600 hover:text-gray-900 no-underline text-sm">Pricing</a>
            <a href="#" class="text-gray-600 hover:text-gray-900 no-underline text-sm">About</a>
            <a href="#" class="px-4 py-1.5 bg-indigo-500 text-white rounded-lg text-sm no-underline hover:bg-indigo-600">Sign Up</a>
          </div>
        </nav>`,
      });

      bm.add("footer", {
        label: "Footer",
        category: "Layout",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="16" width="20" height="4" rx="1"/><line x1="6" y1="18" x2="18" y2="18"/></svg>`,
        content: `<footer class="bg-gray-900 text-gray-400 py-12 px-8">
          <div class="flex gap-12 mb-8">
            <div><h4 class="text-white font-semibold mb-3 text-sm">Product</h4><ul class="space-y-2 text-sm"><li><a href="#" class="hover:text-white no-underline text-gray-400">Features</a></li><li><a href="#" class="hover:text-white no-underline text-gray-400">Pricing</a></li></ul></div>
            <div><h4 class="text-white font-semibold mb-3 text-sm">Company</h4><ul class="space-y-2 text-sm"><li><a href="#" class="hover:text-white no-underline text-gray-400">About</a></li><li><a href="#" class="hover:text-white no-underline text-gray-400">Contact</a></li></ul></div>
          </div>
          <p class="text-sm border-t border-gray-800 pt-6">Made with Stencil CMS</p>
        </footer>`,
      });

      bm.add("divider", {
        label: "Divider",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="12" x2="22" y2="12"/></svg>`,
        content: `<hr class="border-t border-gray-200 my-8" />`,
      });

      bm.add("spacer", {
        label: "Spacer",
        category: "Components",
        media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="4" x2="12" y2="20" stroke-dasharray="2 2"/><line x1="4" y1="4" x2="20" y2="4"/><line x1="4" y1="20" x2="20" y2="20"/></svg>`,
        content: `<div class="h-12"></div>`,
      });


      // Force plain text paste inside the canvas
      editor.on("rte:enable", () => {
        const canvasDoc = editor.Canvas.getDocument();
        if (canvasDoc) {
          canvasDoc.addEventListener("paste", (e: ClipboardEvent) => {
            const text = e.clipboardData?.getData("text/plain");
            if (text) {
              e.preventDefault();
              canvasDoc.execCommand("insertText", false, text);
            }
          }, true);
        }
      });

      // Listen for device changes
      editor.on("change:device", () => {
        setDevice(editor.getDevice());
      });

      // Sync selected component's classes to React state
      const syncClasses = () => {
        const selected = editor.getSelected();
        if (selected) {
          const el = selected.getEl();
          if (el) {
            setSelectedClasses(Array.from(el.classList));
          } else {
            setSelectedClasses([]);
          }
        } else {
          setSelectedClasses([]);
        }
      };
      editor.on("component:selected", syncClasses);
      editor.on("component:deselected", () => setSelectedClasses([]));

      // Load existing project
      if (projectData) {
        try {
          const data = JSON.parse(projectData);
          if (data.pages || data.styles || data.assets) {
            editor.loadProjectData(data);
          }
        } catch {
          // invalid
        }
      }

      editorRef.current = editor;
      setLoaded(true);
    });

    return () => {
      destroyed = true;
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setClassesOnSelected = useCallback((newClasses: string[]) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selected = editor.getSelected();
    if (!selected) return;

    // Remove all existing classes, then add new set
    const existing = selected.getClasses();
    if (existing.length > 0) {
      selected.removeClass(existing);
    }
    if (newClasses.length > 0) {
      selected.addClass(newClasses);
    }
    setSelectedClasses(newClasses);
  }, []);

  const removeClassFromSelected = useCallback((cls: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selected = editor.getSelected();
    if (!selected) return;
    selected.removeClass(cls);
    setSelectedClasses((prev) => prev.filter((c) => c !== cls));
  }, []);

  const toggleClassOnSelected = useCallback((cls: string) => {
    const classesToAdd = cls.split(/\s+/).filter(Boolean);

    // "None" option — remove all gradient-related classes
    if (classesToAdd.length === 0) {
      const remaining = selectedClasses.filter((c) => !isGradientClass(c));
      setClassesOnSelected(remaining);
      return;
    }

    const allApplied = classesToAdd.every((c) => selectedClasses.includes(c));
    if (allApplied) {
      // Toggle off — remove these classes
      const remaining = selectedClasses.filter((c) => !classesToAdd.includes(c));
      setClassesOnSelected(remaining);
    } else {
      // Use twMerge to resolve conflicts: merging new classes with existing
      // twMerge will remove conflicting classes automatically
      const merged = twMerge(selectedClasses.join(" "), classesToAdd.join(" "));
      const mergedList = merged.split(/\s+/).filter(Boolean);
      setClassesOnSelected(mergedList);
    }
  }, [selectedClasses, setClassesOnSelected]);

  const handleAddClass = useCallback(() => {
    const classes = classInput.trim().split(/\s+/).filter(Boolean);
    if (classes.length === 0) return;
    const merged = twMerge(selectedClasses.join(" "), classes.join(" "));
    const mergedList = merged.split(/\s+/).filter(Boolean);
    setClassesOnSelected(mergedList);
    setClassInput("");
  }, [classInput, selectedClasses, setClassesOnSelected]);

  const handleSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const projectJson = JSON.stringify(editor.getProjectData());

    // Clean GrapesJS internals from exported HTML and CSS
    let html = editor.getHtml();
    let css = editor.getCss() ?? "";

    // Strip gjs- classes from HTML
    html = html.replace(/\s*gjs-[a-z-]+/g, "");
    // Remove inline style attributes (styles live in CSS via #id selectors now)
    html = html.replace(/\s*style="[^"]*"/g, "");
    // Clean up empty class attributes left behind
    html = html.replace(/\s*class="\s*"/g, "");

    // Remove CSS rules that target gjs- selectors
    css = css.replace(/[^{}]*\.gjs-[^{}]*\{[^}]*\}/g, "");
    // Remove CSS rules with gjs- in the selector
    css = css.replace(/[^{}]*\[data-gjs[^\]]*\][^{}]*\{[^}]*\}/g, "");

    onSave(projectJson, html, css);
  }, [onSave]);

  const handleDeviceChange = useCallback((d: string) => {
    editorRef.current?.setDevice(d);
    setDevice(d);
  }, []);

  const handleUndo = useCallback(() => editorRef.current?.UndoManager.undo(), []);
  const handleRedo = useCallback(() => editorRef.current?.UndoManager.redo(), []);
  const handlePreview = useCallback(() => {
    editorRef.current?.runCommand("preview");
  }, []);
  const handleCode = useCallback(() => {
    editorRef.current?.runCommand("export-template");
  }, []);
  const handleClear = useCallback(() => {
    if (window.confirm("Clear the entire canvas?")) {
      editorRef.current?.DomComponents.clear();
    }
  }, []);

  const sidebarTabs: { id: SidebarTab; label: string }[] = [
    { id: "blocks", label: "Blocks" },
    { id: "layers", label: "Layers" },
    { id: "classes", label: "Classes" },
    { id: "styles", label: "Styles" },
    { id: "traits", label: "Settings" },
  ];

  return (
    <div className="rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center gap-1">
          {/* Device switcher */}
          {[
            ["Desktop", "Desktop"],
            ["Tablet", "Tablet"],
            ["Mobile", "Mobile"],
          ].map(([d, label]) => (
            <button
              key={d}
              type="button"
              onClick={() => handleDeviceChange(d)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                device === d
                  ? "bg-brand-600 text-white"
                  : "text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
          <div className="w-px h-5 bg-gray-300 dark:bg-gray-700 mx-1" />
          <button type="button" onClick={handleUndo} className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors" title="Undo">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h13a4 4 0 010 8H7"/><path d="M3 10l4-4M3 10l4 4"/></svg>
          </button>
          <button type="button" onClick={handleRedo} className="p-1.5 rounded text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors" title="Redo">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H8a4 4 0 000 8h10"/><path d="M21 10l-4-4M21 10l-4 4"/></svg>
          </button>
          <div className="w-px h-5 bg-gray-300 dark:bg-gray-700 mx-1" />
          <button type="button" onClick={handlePreview} className="px-2.5 py-1 rounded text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors" title="Preview">
            Preview
          </button>
          <button type="button" onClick={handleCode} className="px-2.5 py-1 rounded text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors" title="View code">
            Code
          </button>
          <button type="button" onClick={handleClear} className="px-2.5 py-1 rounded text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors" title="Clear canvas">
            Clear
          </button>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {/* Main layout: sidebar + canvas */}
      <div className="flex" style={{ height: "calc(100vh - 200px)", minHeight: "600px" }}>
        {/* Left sidebar */}
        <div className="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col">
          {/* Sidebar tabs */}
          <div className="flex border-b border-gray-200 dark:border-gray-800">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 px-2 py-2 text-[11px] font-medium transition-colors ${
                  activeTab === tab.id
                    ? "text-brand-600 dark:text-brand-200 border-b-2 border-brand-600 dark:border-brand-200"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Sidebar content — GrapesJS mounts into these */}
          <div className="flex-1 overflow-y-auto [&_.sp-container]:!fixed [&_.sp-container]:!z-[9999]">
            <div ref={blocksRef} className={activeTab === "blocks" ? "p-2 [&_.gjs-block]:!w-[calc(50%-4px)] [&_.gjs-block]:!min-h-[60px] [&_.gjs-block]:!border-gray-200 [&_.gjs-block]:dark:!border-gray-700 [&_.gjs-block]:!rounded-lg [&_.gjs-block]:!bg-white [&_.gjs-block]:dark:!bg-gray-800 [&_.gjs-block]:hover:!border-brand-500 [&_.gjs-block-label]:!text-[10px] [&_.gjs-block-label]:!font-medium [&_.gjs-block-category]:!bg-transparent [&_.gjs-title]:!bg-transparent [&_.gjs-title]:!border-0 [&_.gjs-title]:!text-xs [&_.gjs-title]:!font-semibold [&_.gjs-title]:!text-gray-600 [&_.gjs-title]:dark:!text-gray-400 [&_.gjs-title]:!pl-0 [&_.gjs-title]:!pt-3" : "hidden"} />
            <div ref={layersRef} className={activeTab === "layers" ? "p-2 [&_.gjs-layer]:!bg-transparent [&_.gjs-layer-title]:!text-xs [&_.gjs-layer-title-inn]:!text-xs" : "hidden"} />
            <div ref={selectorsRef} className="hidden" />
            <div className={activeTab === "classes" ? "p-2" : "hidden"}>
              {/* Current classes on selected element */}
              {selectedClasses.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Active Classes</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedClasses.map((cls) => (
                      <span key={cls} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded">
                        {cls}
                        <button type="button" onClick={() => removeClassFromSelected(cls)} className="ml-0.5 text-indigo-400 hover:text-red-500">&times;</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Add class input */}
              <div className="mb-3">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Add Classes</p>
                <div className="flex gap-1">
                  <input
                    value={classInput}
                    onChange={(e) => setClassInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddClass(); } }}
                    placeholder="e.g. text-xl font-bold text-blue-500"
                    className="flex-1 px-2 py-1 border border-gray-300 dark:border-gray-700 rounded text-[11px] bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button type="button" onClick={handleAddClass} className="px-2 py-1 bg-brand-600 text-white rounded text-[10px] font-medium hover:bg-brand-700">Add</button>
                </div>
              </div>

              {/* Quick-apply panels */}
              <TailwindQuickStyles
                selectedClasses={selectedClasses}
                onToggle={toggleClassOnSelected}
              />
            </div>
            <div ref={stylesRef} className={activeTab === "styles" ? "p-2 [&_.gjs-sector-title]:!text-xs [&_.gjs-sector-title]:!font-semibold [&_.gjs-sector-title]:!bg-transparent [&_.gjs-sector-title]:!border-0 [&_.gjs-sector-title]:!text-gray-600 [&_.gjs-sector-title]:dark:!text-gray-400 [&_.gjs-field]:!text-xs [&_.gjs-label-wrp]:!text-[10px]" : "hidden"} />
            <div ref={traitsRef} className={activeTab === "traits" ? "p-2 [&_.gjs-trt-trait]:!text-xs [&_.gjs-label-wrp]:!text-[10px]" : "hidden"} />
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50 dark:bg-gray-900 z-10">
              <p className="text-sm text-gray-400">Loading page builder...</p>
            </div>
          )}
          <div
            ref={canvasRef}
            style={{
              "--gjs-left-width": "0px",
              "--gjs-canvas-top": "0px",
            } as React.CSSProperties}
            className="h-full [&_.gjs-cv-canvas]:!w-full [&_.gjs-cv-canvas]:!h-full [&_.gjs-cv-canvas]:!top-0 [&_.gjs-cv-canvas]:!left-0 [&_.gjs-cv-canvas]:!bg-gray-100 [&_.gjs-cv-canvas]:dark:!bg-gray-950 [&_.gjs-frame-wrapper]:!rounded-none"
          />
        </div>
      </div>
    </div>
  );
}

// --- Quick-apply Tailwind class panels ---

const TAILWIND_GROUPS: {
  label: string;
  classes: { label: string; value: string }[];
}[] = [
  {
    label: "Text Size",
    classes: [
      { label: "xs", value: "text-xs" },
      { label: "sm", value: "text-sm" },
      { label: "base", value: "text-base" },
      { label: "lg", value: "text-lg" },
      { label: "xl", value: "text-xl" },
      { label: "2xl", value: "text-2xl" },
      { label: "3xl", value: "text-3xl" },
      { label: "4xl", value: "text-4xl" },
      { label: "5xl", value: "text-5xl" },
      { label: "6xl", value: "text-6xl" },
    ],
  },
  {
    label: "Font Weight",
    classes: [
      { label: "Light", value: "font-light" },
      { label: "Normal", value: "font-normal" },
      { label: "Medium", value: "font-medium" },
      { label: "Semi", value: "font-semibold" },
      { label: "Bold", value: "font-bold" },
      { label: "Extra", value: "font-extrabold" },
    ],
  },
  {
    label: "Text Gradients",
    classes: [
      { label: "Purple→Pink", value: "bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent" },
      { label: "Blue→Cyan", value: "bg-gradient-to-r from-blue-500 to-cyan-400 bg-clip-text text-transparent" },
      { label: "Green→Teal", value: "bg-gradient-to-r from-green-500 to-teal-400 bg-clip-text text-transparent" },
      { label: "Red→Orange", value: "bg-gradient-to-r from-red-500 to-orange-400 bg-clip-text text-transparent" },
      { label: "Indigo→Purple", value: "bg-gradient-to-r from-indigo-500 to-purple-500 bg-clip-text text-transparent" },
      { label: "Pink→Rose", value: "bg-gradient-to-r from-pink-500 to-rose-400 bg-clip-text text-transparent" },
      { label: "Sky→Blue", value: "bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent" },
      { label: "Yellow→Red", value: "bg-gradient-to-r from-yellow-400 to-red-500 bg-clip-text text-transparent" },
      { label: "Fuchsia→Violet", value: "bg-gradient-to-r from-fuchsia-500 to-violet-500 bg-clip-text text-transparent" },
      { label: "Sunset", value: "bg-gradient-to-r from-orange-400 via-pink-500 to-purple-500 bg-clip-text text-transparent" },
      { label: "Ocean", value: "bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 bg-clip-text text-transparent" },
      { label: "Forest", value: "bg-gradient-to-r from-green-400 via-emerald-500 to-teal-600 bg-clip-text text-transparent" },
      { label: "None", value: "" },
    ],
  },
  {
    label: "Text Color",
    classes: [
      { label: "Black", value: "text-black" },
      { label: "White", value: "text-white" },
      { label: "Gray", value: "text-gray-600" },
      { label: "Red", value: "text-red-500" },
      { label: "Orange", value: "text-orange-500" },
      { label: "Yellow", value: "text-yellow-500" },
      { label: "Green", value: "text-green-500" },
      { label: "Blue", value: "text-blue-500" },
      { label: "Indigo", value: "text-indigo-500" },
      { label: "Purple", value: "text-purple-500" },
      { label: "Pink", value: "text-pink-500" },
    ],
  },
  {
    label: "Text Align",
    classes: [
      { label: "Left", value: "text-left" },
      { label: "Center", value: "text-center" },
      { label: "Right", value: "text-right" },
      { label: "Justify", value: "text-justify" },
    ],
  },
  {
    label: "Background",
    classes: [
      { label: "White", value: "bg-white" },
      { label: "Gray 50", value: "bg-gray-50" },
      { label: "Gray 100", value: "bg-gray-100" },
      { label: "Gray 900", value: "bg-gray-900" },
      { label: "Black", value: "bg-black" },
      { label: "Red", value: "bg-red-500" },
      { label: "Orange", value: "bg-orange-500" },
      { label: "Yellow", value: "bg-yellow-500" },
      { label: "Green", value: "bg-green-500" },
      { label: "Blue", value: "bg-blue-500" },
      { label: "Indigo", value: "bg-indigo-500" },
      { label: "Purple", value: "bg-purple-500" },
      { label: "Pink", value: "bg-pink-500" },
    ],
  },
  {
    label: "Gradients",
    classes: [
      { label: "To Right", value: "bg-gradient-to-r" },
      { label: "To Left", value: "bg-gradient-to-l" },
      { label: "To Bottom", value: "bg-gradient-to-b" },
      { label: "To Top", value: "bg-gradient-to-t" },
      { label: "To BR", value: "bg-gradient-to-br" },
      { label: "To BL", value: "bg-gradient-to-bl" },
      { label: "To TR", value: "bg-gradient-to-tr" },
      { label: "To TL", value: "bg-gradient-to-tl" },
    ],
  },
  {
    label: "Gradient From",
    classes: [
      { label: "Red", value: "from-red-500" },
      { label: "Orange", value: "from-orange-500" },
      { label: "Yellow", value: "from-yellow-400" },
      { label: "Green", value: "from-green-500" },
      { label: "Teal", value: "from-teal-500" },
      { label: "Blue", value: "from-blue-500" },
      { label: "Indigo", value: "from-indigo-500" },
      { label: "Purple", value: "from-purple-500" },
      { label: "Pink", value: "from-pink-500" },
      { label: "Rose", value: "from-rose-500" },
      { label: "Sky", value: "from-sky-400" },
      { label: "Cyan", value: "from-cyan-500" },
      { label: "Violet", value: "from-violet-500" },
      { label: "Fuchsia", value: "from-fuchsia-500" },
      { label: "Black", value: "from-black" },
      { label: "White", value: "from-white" },
      { label: "Transparent", value: "from-transparent" },
    ],
  },
  {
    label: "Gradient Via",
    classes: [
      { label: "Red", value: "via-red-500" },
      { label: "Orange", value: "via-orange-500" },
      { label: "Yellow", value: "via-yellow-400" },
      { label: "Green", value: "via-green-500" },
      { label: "Blue", value: "via-blue-500" },
      { label: "Indigo", value: "via-indigo-500" },
      { label: "Purple", value: "via-purple-500" },
      { label: "Pink", value: "via-pink-500" },
      { label: "Sky", value: "via-sky-400" },
      { label: "Cyan", value: "via-cyan-500" },
      { label: "Transparent", value: "via-transparent" },
    ],
  },
  {
    label: "Gradient To",
    classes: [
      { label: "Red", value: "to-red-500" },
      { label: "Orange", value: "to-orange-500" },
      { label: "Yellow", value: "to-yellow-400" },
      { label: "Green", value: "to-green-500" },
      { label: "Blue", value: "to-blue-500" },
      { label: "Indigo", value: "to-indigo-500" },
      { label: "Purple", value: "to-purple-500" },
      { label: "Pink", value: "to-pink-500" },
      { label: "Sky", value: "to-sky-400" },
      { label: "Cyan", value: "to-cyan-500" },
      { label: "Transparent", value: "to-transparent" },
      { label: "Black", value: "to-black" },
      { label: "White", value: "to-white" },
    ],
  },
  {
    label: "Text Gradient",
    classes: [
      { label: "Clip Text", value: "bg-clip-text" },
      { label: "Transparent Text", value: "text-transparent" },
    ],
  },
  {
    label: "Spacing",
    classes: [
      { label: "p-2", value: "p-2" },
      { label: "p-4", value: "p-4" },
      { label: "p-6", value: "p-6" },
      { label: "p-8", value: "p-8" },
      { label: "px-4", value: "px-4" },
      { label: "px-8", value: "px-8" },
      { label: "py-4", value: "py-4" },
      { label: "py-8", value: "py-8" },
      { label: "py-12", value: "py-12" },
      { label: "py-16", value: "py-16" },
      { label: "m-auto", value: "mx-auto" },
    ],
  },
  {
    label: "Border & Radius",
    classes: [
      { label: "border", value: "border" },
      { label: "border-0", value: "border-0" },
      { label: "rounded", value: "rounded" },
      { label: "rounded-lg", value: "rounded-lg" },
      { label: "rounded-xl", value: "rounded-xl" },
      { label: "rounded-full", value: "rounded-full" },
      { label: "shadow-sm", value: "shadow-sm" },
      { label: "shadow", value: "shadow" },
      { label: "shadow-lg", value: "shadow-lg" },
      { label: "shadow-xl", value: "shadow-xl" },
    ],
  },
  {
    label: "Layout",
    classes: [
      { label: "block", value: "block" },
      { label: "inline", value: "inline-block" },
      { label: "flex", value: "flex" },
      { label: "grid", value: "grid" },
      { label: "hidden", value: "hidden" },
      { label: "flex-col", value: "flex-col" },
      { label: "items-center", value: "items-center" },
      { label: "justify-center", value: "justify-center" },
      { label: "justify-between", value: "justify-between" },
      { label: "gap-2", value: "gap-2" },
      { label: "gap-4", value: "gap-4" },
      { label: "gap-8", value: "gap-8" },
      { label: "mx-auto", value: "mx-auto" },
      { label: "ml-auto", value: "ml-auto" },
      { label: "mr-auto", value: "mr-auto" },
    ],
  },
  {
    label: "Width",
    classes: [
      { label: "w-full", value: "w-full" },
      { label: "w-1/2", value: "w-1/2" },
      { label: "w-1/3", value: "w-1/3" },
      { label: "w-2/3", value: "w-2/3" },
      { label: "max-w-sm", value: "max-w-sm" },
      { label: "max-w-md", value: "max-w-md" },
      { label: "max-w-lg", value: "max-w-lg" },
      { label: "max-w-xl", value: "max-w-xl" },
      { label: "max-w-2xl", value: "max-w-2xl" },
      { label: "max-w-4xl", value: "max-w-4xl" },
    ],
  },
];

function TailwindQuickStyles({
  selectedClasses,
  onToggle,
}: {
  selectedClasses: string[];
  onToggle: (cls: string) => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>("Text Size");

  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Quick Styles</p>
      {TAILWIND_GROUPS.map((group) => (
        <div key={group.label} className="mb-1">
          <button
            type="button"
            onClick={() => setOpenGroup(openGroup === group.label ? null : group.label)}
            className="w-full flex items-center justify-between text-[11px] font-medium text-gray-600 dark:text-gray-400 py-1 hover:text-gray-900 dark:hover:text-gray-200"
          >
            {group.label}
            <span className="text-[9px]">{openGroup === group.label ? "\u25B2" : "\u25BC"}</span>
          </button>
          {openGroup === group.label && (
            <div className="flex flex-wrap gap-1 pb-2">
              {group.classes.map((cls) => {
                const parts = cls.value.split(/\s+/).filter(Boolean);
                const isActive = parts.length > 0 && parts.every((p) => selectedClasses.includes(p));
                return (
                  <button
                    key={cls.value || "none"}
                    type="button"
                    onClick={() => onToggle(cls.value)}
                    className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                      isActive
                        ? "bg-indigo-500 text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                    }`}
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
