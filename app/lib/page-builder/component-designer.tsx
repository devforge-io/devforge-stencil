import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Canvas } from "./canvas";
import { BlockPanel } from "./block-panel";
import { Layers } from "./layers";
import { PropertiesPanel } from "./properties-panel";
import { createStore } from "./store";
import { parseHtml, renderToHtml } from "./serializer";
import { buildCompiledCss, collectClassesFromTree } from "./css-compile";
import { DEFAULT_BLOCKS } from "./blocks";
import { findNode } from "./utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

export interface ComponentDesignerModalProps {
  title?: string;
  initialHtml?: string;
  initialCss?: string;
  /** Label for the primary apply button (default "Apply to outcome"). */
  applyLabel?: string;
  /**
   * Apply the design. `projectData` is the serialized editor project (root tree
   * + canvas styles) so callers that write back to a real component can keep its
   * `projectData` (used for cross-page propagation). Inline-target callers can
   * ignore it.
   */
  onApply: (html: string, css: string, projectData: string) => void | Promise<void>;
  /** Promote the design to a reusable component (optional). */
  onSaveAsComponent?: (name: string, html: string, css: string, projectData: string) => Promise<void> | void;
  onClose: () => void;
}

type Tab = "blocks" | "layers" | "properties";

/**
 * A self-contained visual page-builder in a modal — the same Canvas / blocks /
 * properties machinery as the full editor, scoped to designing a single branch
 * outcome. "Apply" serializes the subtree to HTML + compiled (scoped) CSS and
 * hands it back as an inline target; "Save as component" promotes it to a real
 * reusable component.
 */
export default function ComponentDesignerModal({
  title = "Design outcome",
  initialHtml,
  initialCss,
  applyLabel = "Apply to outcome",
  onApply,
  onSaveAsComponent,
  onClose,
}: ComponentDesignerModalProps) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("blocks");
  const [busy, setBusy] = useState<null | "apply" | "save">(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const store = useMemo(() => {
    const s = createStore();
    if (initialHtml && typeof window !== "undefined") {
      s.setRoot(parseHtml(initialHtml));
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsub = store.subscribe(forceUpdate);
    return () => {
      unsub();
    };
  }, [store]);

  const state = store.getState();
  const selectedNode = state.selection.nodeId ? findNode(state.root, state.selection.nodeId) : null;

  // Auto-switch to properties when something is selected (mirrors the editors).
  useEffect(() => {
    if (selectedNode && tab === "blocks") setTab("properties");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode?.id]);

  const serialize = useCallback(async (): Promise<{ html: string; css: string; projectData: string }> => {
    const root = store.getRoot();
    const html = root.children.map(renderToHtml).join("");
    const project = store.getProject();
    const classes = new Set<string>();
    for (const child of root.children) {
      for (const c of collectClassesFromTree(child)) classes.add(c);
    }
    const css = await buildCompiledCss(html, root, project.canvasStyles ?? [], {
      disablePreflight: true,
      scopeToClasses: classes,
    });
    return { html, css, projectData: JSON.stringify(project) };
  }, [store]);

  const handleApply = useCallback(async () => {
    setBusy("apply");
    setError(null);
    try {
      const { html, css, projectData } = await serialize();
      await onApply(html, css, projectData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compile");
    } finally {
      setBusy(null);
    }
  }, [serialize, onApply]);

  const handleSaveComponent = useCallback(async () => {
    if (!onSaveAsComponent) return;
    if (!name.trim()) {
      setError("Enter a name to save as a component");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const { html, css, projectData } = await serialize();
      await onSaveAsComponent(name.trim(), html, css, projectData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save component");
    } finally {
      setBusy(null);
    }
  }, [serialize, onSaveAsComponent, name]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-[110] flex flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-[11px] text-muted-foreground">drag blocks in, then apply</span>
        </div>
        <div className="flex items-center gap-2">
          {onSaveAsComponent && (
            <>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Component name"
                className="h-7 w-40 text-[11px]"
              />
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy !== null} onClick={handleSaveComponent}>
                {busy === "save" ? "Saving…" : "Save as component"}
              </Button>
            </>
          )}
          {error && <span className="max-w-[240px] truncate text-[11px] text-destructive">{error}</span>}
          <Button size="sm" className="h-7 text-[11px]" disabled={busy !== null} onClick={handleApply}>
            {busy === "apply" ? "Saving…" : applyLabel}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r bg-muted/20">
          <div className="flex gap-0.5 border-b px-1 py-1">
            {(["blocks", "layers", "properties"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-[10px] font-medium capitalize transition-colors",
                  tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <ScrollArea className="flex-1 p-2">
            {tab === "blocks" && <BlockPanel blocks={DEFAULT_BLOCKS} />}
            {tab === "layers" && <Layers store={store} root={state.root} selectedId={state.selection.nodeId} />}
            {tab === "properties" && selectedNode && <PropertiesPanel store={store} node={selectedNode} />}
            {tab === "properties" && !selectedNode && (
              <p className="py-4 text-center text-xs text-muted-foreground">Select an element</p>
            )}
          </ScrollArea>
        </div>

        <div className="flex-1 overflow-auto bg-white dark:bg-gray-950">
          <Canvas store={store} />
        </div>
      </div>
    </div>
  );
}
