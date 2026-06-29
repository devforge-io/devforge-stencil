import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";
import { ConditionGroupEditor } from "./condition-group-editor";
import { TargetEditor } from "./target-editor";
import { ComponentDesignerSurface, serializeStore } from "./component-designer";
import { createStore, type PBStore } from "./store";
import { parseHtml } from "./serializer";
import { generateId } from "./utils";
import {
  CONDITION_TEMPLATES,
  DEFAULT_SAMPLE,
  OTHERWISE_TEMPLATE,
  SELECT_CLS,
  activeBranchId,
  cloneGroup,
  emptyTarget,
  sampleToContext,
  summarizeGroup,
  summarizeTarget,
  type ComponentChoice,
  type ConditionTemplate,
  type EditBranch,
  type Group,
  type SampleInputs,
  type TargetDraft,
} from "./conditional-model";

export interface ConditionalFlowModalProps {
  slug: string;
  branches: EditBranch[];
  fallback: "none" | "empty";
  components: ComponentChoice[];
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange: (branches: EditBranch[], fallback: "none" | "empty") => void;
  onSave: (branches: EditBranch[], fallback: "none" | "empty") => void;
  onClose: () => void;
}

// --- node payloads ---------------------------------------------------------

interface ConditionData {
  label: string;
  group: Group;
  onGroupChange: (g: Group) => void;
  onRemove: () => void;
  active: boolean;
}
interface ElseData {
  onRemove: () => void;
  active: boolean;
}
interface TargetNodeData {
  target: TargetDraft;
  components: ComponentChoice[];
  onPick: (t: TargetDraft) => void;
  onEdit: () => void;
  previewRefresh: number;
  active: boolean;
  width: number;
  height: number;
  onPreset: (w: number, h: number) => void;
  onResizeBy: (dx: number, dy: number) => void;
}

const RING = "ring-2 ring-green-500";

function StartNode() {
  return (
    <div className="rounded-md border bg-primary px-3 py-2 text-[11px] font-medium text-primary-foreground shadow">
      ▶ Evaluate top → bottom
      <Handle type="source" position={Position.Bottom} id="out" />
    </div>
  );
}

function ConditionNode({ data }: NodeProps) {
  const d = data as unknown as ConditionData;
  return (
    <div className={cn("w-[300px] rounded-md border bg-card text-card-foreground shadow", d.active && RING)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1">
        <span className="text-[10px] font-semibold">{d.label}</span>
        <button type="button" onClick={d.onRemove} className="nodrag text-muted-foreground hover:text-destructive">×</button>
      </div>
      <div className="p-2">
        <ConditionGroupEditor group={d.group} onChange={d.onGroupChange} />
      </div>
      <Handle type="source" position={Position.Right} id="then" style={{ top: 18 }} />
      <Handle type="source" position={Position.Bottom} id="else" />
    </div>
  );
}

function ElseNode({ data }: NodeProps) {
  const d = data as unknown as ElseData;
  return (
    <div className={cn("w-[300px] rounded-md border bg-card text-card-foreground shadow", d.active && RING)}>
      <Handle type="target" position={Position.Top} id="in" />
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[10px] font-semibold">Otherwise (default)</span>
        <button type="button" onClick={d.onRemove} className="nodrag text-muted-foreground hover:text-destructive">×</button>
      </div>
      <Handle type="source" position={Position.Right} id="then" />
    </div>
  );
}

// Common viewports to snap the preview to — the iframe is a real viewport, so the
// component's responsive layout (media queries / `sm:`/`md:`/`lg:` utilities)
// actually reflows at the chosen width.
const DEVICE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Compact", w: 280, h: 170 },
  { label: "Mobile", w: 375, h: 667 },
  { label: "Tablet", w: 768, h: 1024 },
  { label: "Laptop", w: 1280, h: 800 },
  { label: "Desktop", w: 1440, h: 900 },
];
const MIN_W = 240;
const MIN_H = 120;
const MAX_W = 1600;
const MAX_H = 1200;
const clampW = (n: number) => Math.min(MAX_W, Math.max(MIN_W, n));
const clampH = (n: number) => Math.min(MAX_H, Math.max(MIN_H, n));

function TargetNode({ data }: NodeProps) {
  const d = data as unknown as TargetNodeData;
  const slug = d.target.kind === "component" ? d.target.slug : null;
  const nested = slug !== null && d.components.find((c) => c.slug === slug)?.type === "conditional";
  // Conditionals have no markup of their own, so they can't be edited in place.
  const canEdit = d.target.kind === "inline" || (!!slug && !nested);
  const { getZoom } = useReactFlow();

  return (
    // Width fills the React Flow node wrapper, which carries the real width (set on
    // the node's `style` so React Flow knows the size and reflows edges).
    <div className={cn("w-full rounded-md border bg-card text-card-foreground shadow", d.active && RING)}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="flex items-center justify-between border-b bg-muted/40 px-2 py-1">
        <span className="text-[10px] font-semibold">Show</span>
        {canEdit && (
          <button type="button" onClick={d.onEdit} className="nodrag text-[9px] font-medium text-primary hover:underline">
            ✏️ edit
          </button>
        )}
      </div>

      {!nested && (
        <div className="nodrag flex flex-wrap items-center gap-0.5 border-b bg-muted/10 px-1.5 py-1">
          {DEVICE_PRESETS.map((p) => {
            const on = Math.round(d.width) === p.w && Math.round(d.height) === p.h;
            return (
              <button
                key={p.label}
                type="button"
                title={`${p.w} × ${p.h}`}
                onClick={() => d.onPreset(p.w, p.h)}
                className={cn(
                  "rounded px-1 py-0.5 text-[9px] transition-colors",
                  on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {p.label}
              </button>
            );
          })}
          <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground">
            {Math.round(d.width)}×{Math.round(d.height)}
          </span>
        </div>
      )}

      <ErrorBoundary
        label="preview"
        fallback={
          <div className="flex min-h-[120px] items-center justify-center px-2 text-center text-[10px] text-destructive">
            preview unavailable
          </div>
        }
      >
        <TargetPreview
          target={d.target}
          nested={nested}
          height={d.height}
          refreshKey={d.previewRefresh}
          onResize={nested ? undefined : d.onResizeBy}
          getZoom={getZoom}
        />
      </ErrorBoundary>

      <div className="space-y-1 p-2">
        <TargetEditor target={d.target} components={d.components} onChange={d.onPick} onEdit={canEdit ? d.onEdit : undefined} />
        {nested && <p className="text-[9px] text-indigo-500">↳ nested conditional — resolved recursively</p>}
      </div>
    </div>
  );
}

// --- live outcome preview --------------------------------------------------

/** dedupe + cache component markup fetches; keyed by slug + a refresh counter. */
const previewCache = new Map<string, Promise<{ html: string; css: string }>>();
function loadComponentPreview(slug: string, refreshKey: number): Promise<{ html: string; css: string }> {
  const key = `${slug}@${refreshKey}`;
  let p = previewCache.get(key);
  if (!p) {
    p = fetch(`/api/components/${slug}`)
      .then((r) => r.json())
      .then((d) => ({ html: d.component?.html ?? "", css: d.component?.css ?? "" }));
    p.catch(() => previewCache.delete(key)); // let a failed load retry next time
    previewCache.set(key, p);
  }
  return p;
}

function previewDoc(html: string, css: string): string {
  // Inner HTML for a *shadow root* (not an iframe): a scoped <style> + the markup.
  // Shadow DOM isolates these styles from the editor and vice-versa, so we get the
  // same encapsulation an iframe gave — but as normal composited DOM that moves
  // with the canvas without repainting, which is what kills the drag/pan flash.
  return `<style>:host{display:block;background:#fff;color:#111;font-family:system-ui,-apple-system,sans-serif}*,*::before,*::after{box-sizing:border-box}.pb-pad{padding:8px}${css}</style><div class="pb-pad">${html}</div>`;
}

/**
 * The outcome preview, rendered into a Shadow DOM host instead of an iframe.
 * Memoized on `doc` so node re-renders during a drag skip it entirely; because it's
 * ordinary DOM (not an iframe), moving its ancestor composites rather than
 * repaints — no flash. Scripts never run (innerHTML doesn't execute them) and link
 * clicks are swallowed so a stray click can't navigate away from the editor.
 */
const ShadowPreview = memo(function ShadowPreview({ doc }: { doc: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      if (!shadowRef.current) {
        // Reuse an existing shadow root if the host element was recycled —
        // attachShadow() throws if called twice on the same element, and an
        // uncaught throw here would unmount the whole editor.
        let root = host.shadowRoot;
        if (!root) {
          root = host.attachShadow({ mode: "open" });
          root.addEventListener("click", (e) => {
            if (e.composedPath().some((el) => (el as HTMLElement).tagName === "A")) e.preventDefault();
          });
        }
        shadowRef.current = root;
      }
      shadowRef.current.innerHTML = doc;
    } catch (err) {
      // A broken preview must never take down the editor.
      console.error("[conditional-flow] preview render failed:", err);
    }
  }, [doc]);
  return <div ref={hostRef} className="h-full w-full overflow-auto bg-white" />;
});

/**
 * Renders the *actual* outcome inside the node — the chosen component's compiled
 * HTML+CSS (or the inline subtree) in a sandboxed iframe — so the graph shows what
 * each branch produces, not just its name. The iframe is a real viewport, so the
 * preview is interactive (hover, scroll) and reflows responsively as it's resized;
 * drag the corner grip or use the device presets above to test screen sizes.
 */
function TargetPreview({
  target,
  nested,
  height,
  refreshKey,
  onResize,
  getZoom,
}: {
  target: TargetDraft;
  nested: boolean;
  height: number;
  refreshKey: number;
  onResize?: (dx: number, dy: number) => void;
  getZoom?: () => number;
}) {
  const slug = target.kind === "component" ? target.slug : "";
  const inlineHtml = target.kind === "inline" ? target.html : "";
  const inlineCss = target.kind === "inline" ? target.css : "";
  const [doc, setDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (target.kind === "inline") {
      setDoc(inlineHtml.trim() ? previewDoc(inlineHtml, inlineCss) : "");
      return;
    }
    if (nested || !slug) {
      setDoc(null);
      return;
    }
    setLoading(true);
    loadComponentPreview(slug, refreshKey)
      .then((c) => !cancelled && setDoc(c.html.trim() ? previewDoc(c.html, c.css) : ""))
      .catch(() => !cancelled && setDoc(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target.kind, slug, inlineHtml, inlineCss, nested, refreshKey]);

  let body: React.ReactNode;
  if (nested) {
    body = <Placeholder>↳ nested conditional</Placeholder>;
  } else if (target.kind === "component" && !slug) {
    body = <Placeholder>No component selected</Placeholder>;
  } else if (doc) {
    // Keep showing the current preview even while a refresh is in flight.
    body = <ShadowPreview doc={doc} />;
  } else if (loading) {
    body = <Placeholder>Loading preview…</Placeholder>;
  } else if (doc === "") {
    body = <Placeholder>{target.kind === "inline" ? "Empty — use ✏️ edit to design" : "Component is empty"}</Placeholder>;
  } else {
    body = <Placeholder>Preview unavailable</Placeholder>;
  }

  return (
    <div className="nodrag nowheel relative overflow-hidden border-b bg-white" style={{ height }}>
      {body}
      {onResize && <ResizeGrip onResize={onResize} getZoom={getZoom} />}
    </div>
  );
}

/**
 * Bottom-right drag grip that resizes the preview. Captures the pointer so the
 * drag keeps tracking even over the iframe, and divides screen-space deltas by the
 * canvas zoom so a 1px drag is 1 preview-px regardless of how far you've zoomed.
 */
function ResizeGrip({ onResize, getZoom }: { onResize: (dx: number, dy: number) => void; getZoom?: () => number }) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget as HTMLElement;
      grip.setPointerCapture(e.pointerId);
      let lastX = e.clientX;
      let lastY = e.clientY;
      const move = (ev: PointerEvent) => {
        const z = getZoom?.() ?? 1;
        const dx = (ev.clientX - lastX) / z;
        const dy = (ev.clientY - lastY) / z;
        lastX = ev.clientX;
        lastY = ev.clientY;
        onResize(dx, dy);
      };
      const up = () => {
        grip.releasePointerCapture?.(e.pointerId);
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    },
    [onResize, getZoom]
  );

  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      className="nodrag absolute bottom-0 right-0 z-10 flex h-4 w-4 cursor-nwse-resize items-end justify-end bg-white/70"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted-foreground">
        <path d="M9 2 L9 9 L2 9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Contains render/effect errors to a subtree instead of letting them propagate to
 * the React root and unmount the entire editor ("the UI disappears"). Used around
 * each preview and around the whole canvas, so a thrown error degrades to a local
 * fallback and is logged rather than blanking everything.
 */
class ErrorBoundary extends Component<
  { children: React.ReactNode; fallback: React.ReactNode; label?: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[conditional-flow] ${this.props.label ?? "render"} crashed:`, error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const NODE_TYPES: NodeTypes = {
  start: StartNode,
  condition: ConditionNode,
  else: ElseNode,
  component: TargetNode,
};

const COND_Y = (i: number) => 110 + i * 210;

/**
 * Full-screen flow canvas (React Flow) for editing a conditional's rule set.
 *
 * Condition nodes are wired to the component nodes they render; the vertical
 * order of condition nodes is the evaluation order ("first match wins"), so
 * dragging a node up/down re-prioritises its branch. The graph reads from and
 * writes to the same `EditBranch[]` model as the simple list editor, so neither
 * view loses data when you switch.
 */
export default function ConditionalFlowModal({
  slug,
  branches: initialBranches,
  fallback: initialFallback,
  components,
  saving,
  error,
  onChange,
  onSave,
  onClose,
}: ConditionalFlowModalProps) {
  const [branches, setBranches] = useState<EditBranch[]>(initialBranches);
  const [fallback, setFallback] = useState<"none" | "empty">(initialFallback);
  // React Flow owns the live node array (positions, measured size, drag state) via
  // this hook — passing its `onNodesChange` straight through keeps every node
  // "initialized", which is what dragging requires (RF error #015). We sync our
  // derived structure/data into it below without clobbering RF-managed fields.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  // Initial positions for nodes RF hasn't seen yet (newly added / dropped).
  const pendingPosRef = useRef<Record<string, XYPosition>>({});
  const [sample, setSample] = useState<SampleInputs>(DEFAULT_SAMPLE);
  // The branch whose outcome is being edited in the docked builder (flow hidden).
  const [editingId, setEditingId] = useState<string | null>(null);
  // Bumped after a component is saved so node previews refetch fresh markup.
  const [previewRefresh, setPreviewRefresh] = useState(0);
  // Components created via "save as component" before the route's list refreshes.
  const [extraComponents, setExtraComponents] = useState<ComponentChoice[]>([]);
  const allComponents = useMemo(() => {
    const seen = new Set<string>();
    return [...components, ...extraComponents].filter((c) => !seen.has(c.slug) && seen.add(c.slug));
  }, [components, extraComponents]);
  // Per-outcome-node preview viewport (width × height). Applied to the node's
  // `style.width` so React Flow owns the real size and reflows edges; the preview
  // iframe is a real viewport, so the component reflows responsively as it grows.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const setPreset = useCallback((id: string, w: number, h: number) => {
    setSizes((s) => ({ ...s, [id]: { width: clampW(w), height: clampH(h) } }));
  }, []);
  const resizeBy = useCallback((id: string, dx: number, dy: number) => {
    setSizes((s) => {
      const cur = s[id] ?? { width: DEVICE_PRESETS[0].w, height: DEVICE_PRESETS[0].h };
      return { ...s, [id]: { width: clampW(cur.width + dx), height: clampH(cur.height + dy) } };
    });
  }, []);

  const commit = useCallback(
    (b: EditBranch[], fb: "none" | "empty") => {
      setBranches(b);
      setFallback(fb);
      onChange(b, fb);
    },
    [onChange]
  );

  const active = useMemo(
    () => activeBranchId(branches, sampleToContext(sample)),
    [branches, sample]
  );

  const patchGroup = useCallback(
    (id: string, group: Group) =>
      commit(branches.map((b) => (b.id === id ? { ...b, group } : b)), fallback),
    [branches, fallback, commit]
  );
  const patchTarget = useCallback(
    (id: string, target: TargetDraft) =>
      commit(branches.map((b) => (b.id === id ? { ...b, target } : b)), fallback),
    [branches, fallback, commit]
  );
  const removeBranch = useCallback(
    (id: string) => {
      // The sync effect drops nodes whose branch no longer exists.
      commit(branches.filter((b) => b.id !== id), fallback);
    },
    [branches, fallback, commit]
  );
  const addBranch = useCallback(
    (isElse: boolean) => {
      const id = generateId();
      const next = [...branches, { id, isElse, group: { mode: "all", leaves: [] }, target: emptyTarget() } as EditBranch];
      pendingPosRef.current[id] = { x: 90, y: COND_Y(next.length - 1) };
      pendingPosRef.current[`tgt:${id}`] = { x: 470, y: COND_Y(next.length - 1) };
      commit(next, fallback);
    },
    [branches, fallback, commit]
  );

  // Drop a palette template onto the canvas → a new branch, inserted in
  // precedence order at the drop height.
  const addBranchFromTemplate = useCallback(
    (tpl: ConditionTemplate, pos: XYPosition) => {
      if (tpl.isElse && branches.some((b) => b.isElse)) return; // at most one else
      const id = generateId();
      const nb: EditBranch = { id, isElse: !!tpl.isElse, group: cloneGroup(tpl.group), target: emptyTarget() };
      let index = branches.length;
      if (!tpl.isElse) {
        const yById = new Map(rfNodes.map((n) => [n.id, n.position.y]));
        index = branches.filter((b, i) => (yById.get(b.id) ?? COND_Y(i)) < pos.y).length;
      }
      const next = [...branches];
      next.splice(index, 0, nb);
      pendingPosRef.current[id] = { x: pos.x, y: pos.y };
      pendingPosRef.current[`tgt:${id}`] = { x: pos.x + 360, y: pos.y };
      commit(next, fallback);
    },
    [branches, rfNodes, fallback, commit]
  );

  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("application/pb-condition") || e.dataTransfer.getData("text/plain");
      if (!id) return;
      const tpl = id === OTHERWISE_TEMPLATE.id ? OTHERWISE_TEMPLATE : CONDITION_TEMPLATES.find((t) => t.id === id);
      if (!tpl) return;
      let pos: XYPosition = { x: 90, y: COND_Y(branches.length) };
      try {
        if (rfInstance.current) pos = rfInstance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      } catch {
        // fall back to the default stacked position
      }
      addBranchFromTemplate(tpl, pos);
    },
    [addBranchFromTemplate, branches.length]
  );

  // On drag end, re-derive branch precedence from the nodes' vertical positions
  // (React Flow owns those now).
  const reorderByY = useCallback(() => {
    const yById = new Map(rfNodes.map((n) => [n.id, n.position.y]));
    const sorted = [...branches].sort((a, b) => (yById.get(a.id) ?? 0) - (yById.get(b.id) ?? 0));
    if (!sorted.every((b, i) => b.id === branches[i].id)) {
      commit(sorted, fallback);
    }
  }, [branches, rfNodes, fallback, commit]);

  // Derive each node's structure/data/style from the rule set (no dependency on
  // live positions — React Flow owns those). This only recomputes when the rules,
  // sizes, or active branch change, so it never runs mid-drag.
  const nodeBases = useMemo(() => {
    const bases: { id: string; type: string; data: Record<string, unknown>; style?: { width: number }; defaultPos: XYPosition }[] = [
      { id: "start", type: "start", data: {}, defaultPos: { x: 90, y: 0 } },
    ];
    branches.forEach((b, i) => {
      if (b.isElse) {
        bases.push({
          id: b.id,
          type: "else",
          data: { onRemove: () => removeBranch(b.id), active: b.id === active } satisfies ElseData,
          defaultPos: { x: 90, y: COND_Y(i) },
        });
      } else {
        bases.push({
          id: b.id,
          type: "condition",
          data: {
            label: i === 0 ? "If" : "Else if",
            group: b.group,
            onGroupChange: (g: Group) => patchGroup(b.id, g),
            onRemove: () => removeBranch(b.id),
            active: b.id === active,
          } satisfies ConditionData,
          defaultPos: { x: 90, y: COND_Y(i) },
        });
      }
      const size = sizes[b.id] ?? { width: DEVICE_PRESETS[0].w, height: DEVICE_PRESETS[0].h };
      bases.push({
        id: `tgt:${b.id}`,
        type: "component",
        style: { width: size.width },
        data: {
          target: b.target,
          components: allComponents,
          onPick: (t: TargetDraft) => patchTarget(b.id, t),
          onEdit: () => setEditingId(b.id),
          previewRefresh,
          active: b.id === active,
          width: size.width,
          height: size.height,
          onPreset: (w: number, h: number) => setPreset(b.id, w, h),
          onResizeBy: (dx: number, dy: number) => resizeBy(b.id, dx, dy),
        } satisfies TargetNodeData,
        defaultPos: { x: 470, y: COND_Y(i) },
      });
    });
    return bases;
  }, [branches, sizes, allComponents, active, previewRefresh, removeBranch, patchGroup, patchTarget, setPreset, resizeBy]);

  // Sync the derived structure/data into React Flow's owned node state, preserving
  // the fields RF manages (position, measured size, drag/selection state) so nodes
  // stay initialized and draggable. A pure node drag doesn't change `nodeBases`, so
  // this doesn't run mid-drag — RF handles the move via `onNodesChange`.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return nodeBases.map((base) => {
        const existing = prevById.get(base.id);
        if (existing) {
          return { ...existing, type: base.type, data: base.data, ...(base.style ? { style: base.style } : {}) };
        }
        const pos = pendingPosRef.current[base.id] ?? base.defaultPos;
        delete pendingPosRef.current[base.id];
        return {
          id: base.id,
          type: base.type,
          position: pos,
          data: base.data,
          ...(base.style ? { style: base.style } : {}),
        } as Node;
      });
    });
  }, [nodeBases, setRfNodes]);

  // The hook seeds nodes after mount, so the initial `fitView` runs on an empty
  // graph — fit once the nodes first appear (and are measured).
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current || rfNodes.length === 0) return;
    didFitRef.current = true;
    const raf = requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2, duration: 0 }));
    return () => cancelAnimationFrame(raf);
  }, [rfNodes]);

  const edges: Edge[] = useMemo(() => {
    const es: Edge[] = [];
    if (branches.length > 0) {
      es.push({ id: "e-start", source: "start", sourceHandle: "out", target: branches[0].id, targetHandle: "in" });
    }
    branches.forEach((b, i) => {
      const isActive = b.id === active;
      es.push({
        id: `e-then-${b.id}`,
        source: b.id,
        sourceHandle: "then",
        target: `tgt:${b.id}`,
        targetHandle: "in",
        label: "then",
        animated: isActive,
        style: isActive ? { stroke: "#22c55e", strokeWidth: 2 } : undefined,
      });
      if (i < branches.length - 1) {
        es.push({
          id: `e-else-${b.id}`,
          source: b.id,
          sourceHandle: "else",
          target: branches[i + 1].id,
          targetHandle: "in",
          label: "else",
        });
      }
    });
    return es;
  }, [branches, active]);

  const hasElse = branches.some((b) => b.isElse);
  const activeBranch = branches.find((b) => b.id === active) ?? null;
  const editingBranch = editingId ? branches.find((b) => b.id === editingId) ?? null : null;

  // Selecting a component node hands the whole surface to the full page-builder,
  // editing that outcome in place. The flow graph is hidden until "Back to flow".
  if (editingBranch) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-background">
        <DockedTargetEditor
          key={editingBranch.id}
          branch={editingBranch}
          onApplyInline={(t) => {
            patchTarget(editingBranch.id, t);
            setEditingId(null);
          }}
          onPickComponent={(componentSlug, componentName) => {
            setExtraComponents((prev) =>
              prev.some((c) => c.slug === componentSlug)
                ? prev
                : [...prev, { slug: componentSlug, name: componentName, type: "static" }]
            );
            patchTarget(editingBranch.id, { kind: "component", slug: componentSlug });
            setPreviewRefresh((x) => x + 1);
            setEditingId(null);
          }}
          onSaved={() => setPreviewRefresh((x) => x + 1)}
          onClose={() => setEditingId(null)}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      {/* Toolbar */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Flow editor</span>
          <code className="text-[11px] text-muted-foreground">{slug}</code>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => addBranch(false)}>
            + Condition
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={hasElse} onClick={() => addBranch(true)}>
            + Otherwise
          </Button>
          {error && <span className="text-[11px] text-destructive">{error}</span>}
          <Button size="sm" className="h-7 text-[11px]" disabled={saving} onClick={() => onSave(branches, fallback)}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Preview / sample-context panel */}
        <aside className="w-64 shrink-0 space-y-3 overflow-y-auto border-r p-3">
          <ConditionPalette onAdd={(tpl) => addBranchFromTemplate(tpl, { x: 90, y: COND_Y(branches.length) })} />
          <Separator2 />
          <PreviewPanel
            sample={sample}
            setSample={setSample}
            active={activeBranch}
            hasNoMatch={active === null}
            fallback={fallback}
            setFallback={(fb) => commit(branches, fb)}
          />
        </aside>

        {/* Canvas */}
        <div className="h-full min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <ErrorBoundary
            label="canvas"
            fallback={
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                The flow canvas hit an error — close and reopen the editor. Your saved rules are unaffected.
              </div>
            }
          >
            <ReactFlow
              nodes={rfNodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onNodeDragStop={reorderByY}
              onInit={(instance) => (rfInstance.current = instance)}
              deleteKeyCode={null}
              nodesConnectable={false}
              fitView
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

function PreviewPanel({
  sample,
  setSample,
  active,
  hasNoMatch,
  fallback,
  setFallback,
}: {
  sample: SampleInputs;
  setSample: (s: SampleInputs) => void;
  active: EditBranch | null;
  hasNoMatch: boolean;
  fallback: "none" | "empty";
  setFallback: (fb: "none" | "empty") => void;
}) {
  const set = (patch: Partial<SampleInputs>) => setSample({ ...sample, ...patch });

  return (
    <div className="space-y-3">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Live preview</Label>

      {/* Active branch readout */}
      <div className="rounded-md border bg-muted/30 p-2 text-[11px]">
        <p className="text-muted-foreground">Under this sample context:</p>
        {active ? (
          <p className="font-medium text-green-600">
            {active.isElse ? "Otherwise" : summarizeGroup(active.group)} → {summarizeTarget(active.target)}
          </p>
        ) : (
          <p className="font-medium text-amber-600">
            No branch matches → {fallback === "empty" ? "empty box" : "nothing"}
          </p>
        )}
      </div>

      <Separator2 />

      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Sample signals</Label>

      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={sample.loggedIn}
          onChange={(e) => set({ loggedIn: e.target.checked })}
        />
        auth.loggedIn
      </label>

      {sample.loggedIn && (
        <>
          <div className="space-y-1">
            <Label className="text-[9px] text-muted-foreground">auth.username</Label>
            <Input className="h-7 text-[11px]" value={sample.username} onChange={(e) => set({ username: e.target.value })} placeholder="ben" />
          </div>
          <div className="space-y-1">
            <Label className="text-[9px] text-muted-foreground">auth.roles (comma-separated)</Label>
            <Input className="h-7 text-[11px]" value={sample.roles} onChange={(e) => set({ roles: e.target.value })} placeholder="member,admin" />
          </div>
        </>
      )}

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">device</Label>
        <select className={SELECT_CLS} value={sample.device} onChange={(e) => set({ device: e.target.value as "mobile" | "desktop" })}>
          <option value="desktop">desktop</option>
          <option value="mobile">mobile</option>
        </select>
      </div>

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">geo.country</Label>
        <Input className="h-7 text-[11px]" value={sample.country} onChange={(e) => set({ country: e.target.value })} placeholder="GB" />
      </div>

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">ab.group</Label>
        <select className={SELECT_CLS} value={sample.abGroup} onChange={(e) => set({ abGroup: e.target.value as "a" | "b" })}>
          <option value="a">a</option>
          <option value="b">b</option>
        </select>
      </div>

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">query (a=1&b=2)</Label>
        <Input className="h-7 text-[11px]" value={sample.query} onChange={(e) => set({ query: e.target.value })} placeholder="plan=7&tab=billing" />
      </div>

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">data + auth.attributes (JSON)</Label>
        <textarea
          className="h-16 w-full rounded-md border border-input bg-transparent px-2 py-1 text-[10px] font-mono shadow-sm"
          value={sample.data}
          onChange={(e) => set({ data: e.target.value })}
          placeholder={'{ "plan": 7 }'}
        />
      </div>

      <Separator2 />

      <div className="space-y-1">
        <Label className="text-[9px] text-muted-foreground">If nothing matches</Label>
        <select className={SELECT_CLS} value={fallback} onChange={(e) => setFallback(e.target.value as "none" | "empty")}>
          <option value="none">Render nothing</option>
          <option value="empty">Render an empty box</option>
        </select>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Drag a condition node up or down to change which branch wins first. The green
        highlight shows the branch active under the sample above.
      </p>
    </div>
  );
}

function Separator2() {
  return <div className="h-px bg-border" />;
}

function ConditionPalette({ onAdd }: { onAdd: (t: ConditionTemplate) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Add a condition</Label>
      <div className="flex flex-wrap gap-1">
        {CONDITION_TEMPLATES.map((t) => (
          <PaletteChip key={t.id} template={t} onAdd={onAdd} />
        ))}
        <PaletteChip template={OTHERWISE_TEMPLATE} onAdd={onAdd} accent />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Click to add, or drag onto the canvas (drop height sets precedence). Then wire its outcome.
      </p>
    </div>
  );
}

function PaletteChip({
  template,
  onAdd,
  accent,
}: {
  template: ConditionTemplate;
  onAdd: (t: ConditionTemplate) => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      draggable
      onClick={() => onAdd(template)}
      onDragStart={(e) => {
        // Set both a custom type and text/plain — some browsers/embeds don't
        // round-trip custom MIME types reliably.
        e.dataTransfer.setData("application/pb-condition", template.id);
        e.dataTransfer.setData("text/plain", template.id);
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      className={cn(
        "cursor-grab rounded border px-1.5 py-1 text-[10px] active:cursor-grabbing",
        accent
          ? "border-amber-400 text-amber-600 hover:bg-amber-50"
          : "border-border text-foreground hover:border-primary hover:bg-muted"
      )}
    >
      {template.label}
    </button>
  );
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface LoadedComponent {
  slug: string;
  name: string;
  category?: string;
  icon?: string;
  description?: string;
}

/**
 * The full page-builder, docked into the flow editor to edit a branch's outcome
 * in place. Two modes by target kind:
 *   - **component** — loads the shared component's saved project (full fidelity)
 *     and writes back to it on Save (affects every page that uses it).
 *   - **inline** — seeds from the branch's inline markup; "Apply outcome" writes
 *     the compiled HTML/CSS back to the branch, or "Save as component" promotes it
 *     to a reusable component and points the branch at it.
 */
function DockedTargetEditor({
  branch,
  onApplyInline,
  onPickComponent,
  onSaved,
  onClose,
}: {
  branch: EditBranch;
  onApplyInline: (t: TargetDraft) => void;
  onPickComponent: (slug: string, name: string) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isComponent = branch.target.kind === "component" && !!branch.target.slug;
  const [store, setStore] = useState<PBStore | null>(null);
  const [meta, setMeta] = useState<LoadedComponent | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed a fresh store from the target. Runs once — the parent remounts this with
  // a new `key` when a different node is opened.
  useEffect(() => {
    let cancelled = false;
    const s = createStore();
    (async () => {
      try {
        if (branch.target.kind === "component" && branch.target.slug) {
          const { component } = await fetch(`/api/components/${branch.target.slug}`).then((r) => r.json());
          if (!component) throw new Error("Component not found");
          if (cancelled) return;
          if (component.projectData) {
            try {
              s.loadProject(JSON.parse(component.projectData));
            } catch {
              s.setRoot(parseHtml(component.html ?? ""));
            }
          } else if (component.html) {
            s.setRoot(parseHtml(component.html));
          }
          setMeta({
            slug: component.slug,
            name: component.name,
            category: component.category,
            icon: component.icon,
            description: component.description,
          });
        } else if (branch.target.kind === "inline" && branch.target.html.trim()) {
          s.setRoot(parseHtml(branch.target.html));
        }
        if (!cancelled) setStore(s);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load outcome");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveComponentBack = useCallback(async () => {
    if (!store || !meta) return;
    setSaving(true);
    setError(null);
    try {
      const { html, css, projectData } = await serializeStore(store);
      // Re-read for a fresh sha to avoid clobbering concurrent edits.
      const { component: fresh } = await fetch(`/api/components/${meta.slug}`).then((r) => r.json());
      if (!fresh) throw new Error("Component not found");
      const res = await fetch(`/api/components/${meta.slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fresh.name,
          category: fresh.category,
          icon: fresh.icon,
          description: fresh.description,
          html,
          css,
          projectData,
          sha: fresh.sha,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Save failed");
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }, [store, meta, onSaved, onClose]);

  const applyInline = useCallback(async () => {
    if (!store) return;
    setSaving(true);
    setError(null);
    try {
      const { html, css } = await serializeStore(store);
      onApplyInline({ kind: "inline", html, css });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compile");
      setSaving(false);
    }
  }, [store, onApplyInline]);

  const saveAsComponent = useCallback(async () => {
    if (!store) return;
    const slug = slugify(name);
    if (!slug) {
      setError("Enter a name to save as a component");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { html, css, projectData } = await serializeStore(store);
      const res = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: name.trim(), category: "Custom", html, css, projectData }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not save component");
      }
      onPickComponent(slug, name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save component");
      setSaving(false);
    }
  }, [store, name, onPickComponent]);

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onClose}>
            ← Back to flow
          </Button>
          <span className="text-sm font-semibold">
            {isComponent ? `Editing ${meta?.name ?? "component"}` : "Designing inline outcome"}
          </span>
          {isComponent && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
              ⚠ edits this component everywhere it’s used
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isComponent && (
            <>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Save as component…"
                className="h-7 w-40 text-[11px]"
              />
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={saving || !store} onClick={saveAsComponent}>
                Save as component
              </Button>
            </>
          )}
          {error && <span className="max-w-[220px] truncate text-[11px] text-destructive">{error}</span>}
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={saving || !store}
            onClick={isComponent ? saveComponentBack : applyInline}
          >
            {saving ? "Saving…" : isComponent ? "Save component" : "Apply outcome"}
          </Button>
        </div>
      </header>

      {store ? (
        <ComponentDesignerSurface store={store} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : "Loading editor…"}
        </div>
      )}
    </>
  );
}
