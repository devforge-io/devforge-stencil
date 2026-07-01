import { Form, Link, redirect, useNavigate, useNavigation } from "react-router";
import { useState, useMemo, useCallback, useReducer, useEffect, lazy, Suspense } from "react";
import { getComponent, listComponents, saveComponent, deleteComponent } from "~/lib/component.server";
import { emptySpec, type ConditionalSpec } from "~/lib/conditional/types";
import {
  specToBranches,
  branchesToSpec,
  type ComponentChoice,
  type EditBranch,
} from "~/lib/page-builder/conditional-model";
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
  buildCompiledCss,
  collectClassesFromTree,
} from "~/lib/page-builder";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Card, CardContent } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { twMerge } from "tailwind-merge";
import { getSettings } from "~/lib/settings.server";
import type { PBNode, PBBlock } from "~/lib/page-builder/types";
import type { PBStore } from "~/lib/page-builder/store";
import type { Route } from "./+types/route";

// React Flow is client-only — load the flow canvas on demand so it never enters
// the server bundle's import graph.
const ConditionalFlowModal = lazy(() => import("~/lib/page-builder/conditional-flow"));

export async function loader({ params }: Route.LoaderArgs) {
  const component = await getComponent(params.slug);
  if (!component) throw new Response("Not Found", { status: 404 });
  const { settings } = await getSettings();
  const defaultBodyClasses = [...settings.bodyClasses, ...settings.darkBodyClasses];
  const editorDarkMode = settings.editorDarkMode ?? false;
  // Conditional components compose other components — provide the pickable list
  // (excluding self to avoid an obvious cycle). Static components don't need it.
  const components: ComponentChoice[] =
    component.type === "conditional"
      ? (await listComponents())
          .filter((c) => c.slug !== params.slug)
          .map((c) => ({ slug: c.slug, name: c.name, type: c.type }))
      : [];
  return { component, defaultBodyClasses, editorDarkMode, components };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const sha = formData.get("sha") as string;
    await deleteComponent(params.slug, sha);
    return redirect("/components");
  }

  const name = (formData.get("name") as string)?.trim();
  const category = (formData.get("category") as string)?.trim() || "Custom";
  const description = (formData.get("description") as string)?.trim();
  const html = (formData.get("html") as string) ?? "";
  const css = (formData.get("css") as string) ?? "";
  const projectData = (formData.get("projectData") as string) || undefined;
  const sha = (formData.get("sha") as string) || undefined;

  if (!name) return { error: "Name is required" };
  await saveComponent(params.slug, { name, category, description, html, css, projectData }, sha);
  return redirect(`/components/${params.slug}`);
}

type SidebarTab = "blocks" | "layers" | "properties" | "body";

/**
 * A conditional component has no markup of its own — it just chooses which other
 * component to render. So it opens straight into the flow editor rather than the
 * visual page-builder canvas. Static components get the canvas (below).
 */
export default function ComponentEditorRoute({ loaderData }: Route.ComponentProps) {
  if (loaderData.component.type === "conditional") {
    return (
      <ConditionalComponentEditor
        slug={loaderData.component.slug}
        spec={loaderData.component.spec}
        components={loaderData.components}
      />
    );
  }
  return <StaticComponentEditor loaderData={loaderData} />;
}

function ConditionalComponentEditor({
  slug,
  spec,
  components,
}: {
  slug: string;
  spec: ConditionalSpec | undefined;
  components: ComponentChoice[];
}) {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const initialBranches = useMemo(() => specToBranches(spec ?? emptySpec()), [spec]);
  const [branches, setBranches] = useState<EditBranch[]>(initialBranches);
  const [fallback, setFallback] = useState<"none" | "empty">(spec?.fallback ?? "none");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const save = useCallback(
    async (b: EditBranch[], fb: "none" | "empty", layout?: Record<string, { x: number; y: number }>) => {
      setSaving(true);
      setError(null);
      try {
        // Re-read for a fresh sha to avoid clobbering concurrent edits.
        const { component: comp } = await fetch(`/api/components/${slug}`).then((r) => r.json());
        if (!comp) throw new Error("Component not found");
        const res = await fetch(`/api/components/${slug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: comp.name,
            category: comp.category,
            icon: comp.icon,
            description: comp.description,
            type: "conditional",
            spec: branchesToSpec(b, fb, layout),
            sha: comp.sha,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Save failed");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setSaving(false);
      }
    },
    [slug]
  );

  if (!mounted) return null;

  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading flow editor…</div>}>
      <ConditionalFlowModal
        slug={slug}
        branches={branches}
        fallback={fallback}
        components={components}
        dirty={false}
        saving={saving}
        error={error}
        layout={spec?.layout}
        onChange={(b, fb) => {
          setBranches(b);
          setFallback(fb);
        }}
        onSave={(b, fb, layout) => save(b, fb, layout)}
        onClose={() => navigate("/components")}
      />
    </Suspense>
  );
}

function StaticComponentEditor({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
  const { component, editorDarkMode } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [showDelete, setShowDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<SidebarTab>("blocks");
  const [mounted, setMounted] = useState(false);
  const [darkPreview, setDarkPreview] = useState(editorDarkMode);

  useEffect(() => { setMounted(true); }, []);

  const store = useMemo(() => {
    // A component is a fragment, not a page body — don't apply the site's page
    // body classes (min-h-screen, bg, text color, …) to its editing root.
    const s = createStore(undefined, []);
    if (component.html && typeof window !== "undefined") {
      const root = parseHtml(component.html);
      root.classes = [];
      s.setRoot(root);
    }
    return s;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { const unsub = store.subscribe(forceUpdate); return () => { unsub(); }; }, [store]);

  // Load other components (incl. conditionals) so they're draggable into this one,
  // matching the page editor's palette. Self is excluded to avoid nesting a
  // component inside itself. Conditionals keep their data-pb-conditional marker;
  // static components get data-pb-component injected on their root.
  const [customComponents, setCustomComponents] = useState<PBBlock[]>([]);
  useEffect(() => {
    fetch("/api/components")
      .then((r) => r.json())
      .then((data) => {
        if (!data.components) return;
        Promise.all(
          (data.components as { slug: string; name: string; category: string; icon?: string; type?: string }[])
            .filter((c) => c.slug !== component.slug)
            .map((c) =>
              fetch(`/api/components/${c.slug}`)
                .then((r) => r.json())
                .then((d) => {
                  let html: string = d.component?.html ?? "";
                  if (html && c.type !== "conditional") {
                    html = html.replace(/^(<\w+)/, `$1 data-pb-component="${c.slug}"`);
                  }
                  return {
                    id: `custom-${c.slug}`,
                    label: c.name,
                    category: c.type === "conditional" ? "Conditionals" : (c.category || "Custom"),
                    icon: c.icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12h6M12 9v6"/></svg>`,
                    content: html,
                  } as PBBlock;
                })
                .catch(() => null)
            )
        ).then((blocks) => setCustomComponents(blocks.filter(Boolean) as PBBlock[]));
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blocks = useMemo(() => [...DEFAULT_BLOCKS, ...customComponents], [customComponents]);

  const state = store.getState();
  const selectedNode = state.selection.nodeId ? findNode(state.root, state.selection.nodeId) : null;

  useEffect(() => {
    if (selectedNode && activeTab === "blocks") setActiveTab("properties");
    else if (!selectedNode && activeTab === "properties") setActiveTab("blocks");
  }, [selectedNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); store.undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); store.redo(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (state.selection.nodeId && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
          e.preventDefault(); store.removeNode(state.selection.nodeId);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "d") { e.preventDefault(); if (state.selection.nodeId) store.duplicateNode(state.selection.nodeId); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [store, state.selection.nodeId]);

  const [compilingCss, setCompilingCss] = useState(false);

  const handleSave = useCallback(async () => {
    const root = store.getRoot();
    const html = root.children.map(renderToHtml).join("");
    const project = store.getProject();

    setCompilingCss(true);
    // Scope component CSS to only the classes used inside the component:
    // skip preflight (host page provides it) and drop unrelated utilities.
    const componentClasses = new Set<string>();
    for (const child of root.children) {
      for (const c of collectClassesFromTree(child)) componentClasses.add(c);
    }
    const css = await buildCompiledCss(html, root, project.canvasStyles ?? [], {
      disablePreflight: true,
      scopeToClasses: componentClasses,
    });

    // Fill the form imperatively after compilation. Hidden inputs use
    // defaultValue, so React re-renders won't reset these.
    const form = document.getElementById("component-form") as HTMLFormElement;
    const htmlInput = form.querySelector('input[name="html"]') as HTMLInputElement;
    const projectInput = form.querySelector('input[name="projectData"]') as HTMLInputElement;
    const cssInput = form.querySelector('input[name="css"]') as HTMLInputElement;
    if (htmlInput) htmlInput.value = html;
    if (projectInput) projectInput.value = JSON.stringify(project);
    if (cssInput) cssInput.value = css;

    setCompilingCss(false);
    form.requestSubmit();
  }, [store]);

  if (!mounted) return null;

  return (
    <div className="flex flex-col bg-background" style={{ height: "calc(100vh - 57px)" }}>
      {/* Toolbar — same as page-editor-v2.tsx line 277 */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" render={<Link to="/components" />} className="h-7 text-xs">&larr; Back</Button>
          <Separator orientation="vertical" className="h-5 mx-1" />
          <Button variant="ghost" size="sm" onClick={() => store.undo()} title="Undo (Ctrl+Z)" className="h-7 w-7 p-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h13a4 4 0 010 8H7"/><path d="M3 10l4-4M3 10l4 4"/></svg>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => store.redo()} title="Redo (Ctrl+Y)" className="h-7 w-7 p-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H8a4 4 0 000 8h10"/><path d="M21 10l-4-4M21 10l-4 4"/></svg>
          </Button>
          <Separator orientation="vertical" className="h-5 mx-1" />
          {selectedNode && (
            <>
              <Button variant="ghost" size="sm" onClick={() => store.duplicateNode(selectedNode.id)} title="Duplicate (Ctrl+D)" className="h-7 text-xs">Duplicate</Button>
              <Button variant="ghost" size="sm" onClick={() => store.removeNode(selectedNode.id)} title="Delete (Del)" className="h-7 text-xs text-destructive">Delete</Button>
              <Separator orientation="vertical" className="h-5 mx-1" />
            </>
          )}
          <span className="text-xs text-muted-foreground">{selectedNode ? `${selectedNode.name ?? selectedNode.tag}` : component.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => {
            const iframe = document.querySelector<HTMLIFrameElement>('[title="Page Builder Canvas"]');
            if (!iframe?.contentDocument) return;
            const html = iframe.contentDocument.documentElement;
            html.classList.toggle("dark"); html.dataset.pbDarkManual = html.classList.contains("dark") ? "true" : "";
            const isDark = html.classList.contains("dark");
            setDarkPreview(isDark);
            fetch("/api/settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ patch: { editorDarkMode: isDark } }),
            }).catch((err) => console.error("Failed to persist editorDarkMode:", err));
          }} className="h-7 w-7 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors" title={darkPreview ? "Light" : "Dark"}>
            {darkPreview ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
          <Button variant="destructive" size="sm" onClick={() => setShowDelete(true)}>Delete</Button>
          <Button size="sm" onClick={handleSave} disabled={isSubmitting || compilingCss}>{compilingCss ? "Compiling CSS..." : isSubmitting ? "Saving..." : "Save"}</Button>
        </div>
      </div>

      <Form method="post" id="component-form" className="hidden">
        <input type="hidden" name="sha" value={component.sha} />
        <input type="hidden" name="name" value={component.name} />
        <input type="hidden" name="category" value={component.category} />
        <input type="hidden" name="description" value={component.description ?? ""} />
        <input type="hidden" name="html" defaultValue="" />
        <input type="hidden" name="projectData" defaultValue="" />
        <input type="hidden" name="css" defaultValue="" />
      </Form>

      {/* Main: sidebar + canvas */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 shrink-0 border-r flex flex-col bg-muted/20 overflow-hidden">
          <div className="flex border-b px-1 py-1 gap-0.5">
            {(["blocks", "layers", "properties", "body"] as const).map((tab) => (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                className={cn("flex-1 px-2 py-1.5 text-[10px] font-medium rounded transition-colors capitalize",
                  activeTab === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                {tab}
              </button>
            ))}
          </div>
          <ScrollArea className="flex-1 p-2">
            {activeTab === "blocks" && <BlockPanel blocks={blocks} />}
            {activeTab === "layers" && <Layers store={store} root={state.root} selectedId={state.selection.nodeId} />}
            {activeTab === "properties" && selectedNode && <PropertiesPanel store={store} node={selectedNode} slug={component.slug} />}
            {activeTab === "properties" && !selectedNode && <p className="text-xs text-muted-foreground py-4 text-center">Select an element</p>}
            {activeTab === "body" && <BodySettingsPanel store={store} root={state.root} />}
          </ScrollArea>
        </div>
        <div className="flex-1 bg-white dark:bg-gray-950 overflow-auto">
          <Canvas store={store} initialDarkMode={editorDarkMode} />
        </div>
      </div>

      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="max-w-sm w-full mx-4"><CardContent className="pt-6 space-y-4">
            <h2 className="text-lg font-semibold">Delete "{component.name}"?</h2>
            <p className="text-sm text-muted-foreground">This will permanently remove this component.</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowDelete(false)}>Cancel</Button>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="sha" value={component.sha} />
                <Button type="submit" variant="destructive" size="sm" disabled={isSubmitting}>{isSubmitting ? "Deleting..." : "Delete"}</Button>
              </Form>
            </div>
          </CardContent></Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body Settings Panel — background, text color, font for the root node
// ---------------------------------------------------------------------------

const BODY_CLASS_GROUPS = [
  {
    group: "Background",
    options: [
      "bg-white", "bg-gray-50", "bg-gray-100", "bg-gray-200",
      "bg-gray-900", "bg-gray-950", "bg-slate-900", "bg-black",
    ],
  },
  {
    group: "Dark Background",
    options: [
      "dark:bg-white", "dark:bg-gray-50", "dark:bg-gray-900",
      "dark:bg-gray-950", "dark:bg-slate-900", "dark:bg-black",
    ],
  },
  {
    group: "Text Color",
    options: [
      "text-gray-900", "text-gray-800", "text-gray-700",
      "text-gray-100", "text-white", "text-slate-100",
    ],
  },
  {
    group: "Dark Text",
    options: [
      "dark:text-gray-900", "dark:text-gray-100",
      "dark:text-white", "dark:text-slate-100",
    ],
  },
  {
    group: "Font",
    options: ["font-sans", "font-serif", "font-mono"],
  },
  {
    group: "Other",
    options: ["antialiased", "subpixel-antialiased", "min-h-screen"],
  },
];

function BodySettingsPanel({ store, root }: { store: PBStore; root: PBNode }) {
  const classes = root.classes;
  const [input, setInput] = useState("");

  const handleAddClass = useCallback(() => {
    const newClasses = input.trim().split(/\s+/).filter(Boolean);
    if (newClasses.length === 0) return;
    const merged = twMerge(classes.join(" "), newClasses.join(" "));
    store.updateNode(root.id, { classes: merged.split(" ").filter(Boolean) });
    setInput("");
  }, [store, root.id, classes, input]);

  const handleRemoveClass = useCallback(
    (cls: string) => {
      store.updateNode(root.id, { classes: classes.filter((c) => c !== cls) });
    },
    [store, root.id, classes]
  );

  const handleToggle = useCallback(
    (cls: string) => {
      if (classes.includes(cls)) {
        handleRemoveClass(cls);
      } else {
        const merged = twMerge(classes.join(" "), cls);
        store.updateNode(root.id, { classes: merged.split(" ").filter(Boolean) });
      }
    },
    [store, root.id, classes, handleRemoveClass]
  );

  return (
    <div className="space-y-3">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Body Settings</Label>

      {/* Current classes */}
      {classes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {classes.map((cls) => (
            <Badge key={cls} variant="secondary" className="text-[10px] font-mono px-1.5 py-0 h-5 gap-0.5">
              {cls}
              <button type="button" onClick={() => handleRemoveClass(cls)}
                className="text-muted-foreground hover:text-destructive ml-0.5">x</button>
            </Badge>
          ))}
        </div>
      )}

      {/* Add custom class */}
      <div className="flex gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddClass())}
          placeholder="bg-blue-500 dark:bg-blue-900..."
          className="h-7 text-[11px]"
        />
        <Button size="sm" variant="outline" className="h-7 text-[10px] px-2" onClick={handleAddClass}>
          Add
        </Button>
      </div>

      <Separator />

      {/* Preset groups */}
      {BODY_CLASS_GROUPS.map(({ group, options }) => (
        <div key={group}>
          <p className="text-[9px] text-muted-foreground mb-1">{group}</p>
          <div className="flex flex-wrap gap-0.5">
            {options.map((cls) => (
              <button
                key={cls}
                type="button"
                onClick={() => handleToggle(cls)}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] transition-colors font-mono",
                  classes.includes(cls)
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {cls}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
