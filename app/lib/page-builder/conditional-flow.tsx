import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeChange,
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
  active: boolean;
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

function TargetNode({ data }: NodeProps) {
  const d = data as unknown as TargetNodeData;
  const slug = d.target.kind === "component" ? d.target.slug : null;
  const nested = slug !== null && d.components.find((c) => c.slug === slug)?.type === "conditional";
  return (
    <div className={cn("w-[260px] rounded-md border bg-card text-card-foreground shadow", d.active && RING)}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="border-b bg-muted/40 px-2 py-1 text-[10px] font-semibold">Show</div>
      <div className="space-y-1 p-2">
        <TargetEditor target={d.target} components={d.components} onChange={d.onPick} />
        {nested && <p className="text-[9px] text-indigo-500">↳ nested conditional — resolved recursively</p>}
      </div>
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  start: StartNode,
  condition: ConditionNode,
  else: ElseNode,
  component: TargetNode,
};

const COND_Y = (i: number) => 110 + i * 210;

function initialLayout(branches: EditBranch[]): Record<string, XYPosition> {
  const pos: Record<string, XYPosition> = { start: { x: 90, y: 0 } };
  branches.forEach((b, i) => {
    pos[b.id] = { x: 90, y: COND_Y(i) };
    pos[`tgt:${b.id}`] = { x: 470, y: COND_Y(i) };
  });
  return pos;
}

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
  const [positions, setPositions] = useState<Record<string, XYPosition>>(() => initialLayout(initialBranches));
  const [sample, setSample] = useState<SampleInputs>(DEFAULT_SAMPLE);

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
      commit(branches.filter((b) => b.id !== id), fallback);
      setPositions((p) => {
        const next = { ...p };
        delete next[id];
        delete next[`tgt:${id}`];
        return next;
      });
    },
    [branches, fallback, commit]
  );
  const addBranch = useCallback(
    (isElse: boolean) => {
      const id = generateId();
      const next = [...branches, { id, isElse, group: { mode: "all", leaves: [] }, target: emptyTarget() } as EditBranch];
      commit(next, fallback);
      setPositions((p) => ({
        ...p,
        [id]: { x: 90, y: COND_Y(next.length - 1) },
        [`tgt:${id}`]: { x: 470, y: COND_Y(next.length - 1) },
      }));
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
        index = branches.filter((b, i) => (positions[b.id]?.y ?? COND_Y(i)) < pos.y).length;
      }
      const next = [...branches];
      next.splice(index, 0, nb);
      commit(next, fallback);
      setPositions((p) => ({
        ...p,
        [id]: { x: pos.x, y: pos.y },
        [`tgt:${id}`]: { x: pos.x + 360, y: pos.y },
      }));
    },
    [branches, positions, fallback, commit]
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

  // Live drag: keep our own position map (fully-controlled nodes).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPositions((prev) => {
      let next = prev;
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          next = { ...next, [ch.id]: ch.position };
        }
      }
      return next;
    });
  }, []);

  // On drag end, re-derive branch precedence from vertical position.
  const reorderByY = useCallback(() => {
    const sorted = [...branches].sort(
      (a, b) => (positions[a.id]?.y ?? 0) - (positions[b.id]?.y ?? 0)
    );
    if (!sorted.every((b, i) => b.id === branches[i].id)) {
      commit(sorted, fallback);
    }
  }, [branches, positions, fallback, commit]);

  const nodes: Node[] = useMemo(() => {
    const list: Node[] = [
      { id: "start", type: "start", position: positions.start ?? { x: 90, y: 0 }, data: {} },
    ];
    branches.forEach((b, i) => {
      const condPos = positions[b.id] ?? { x: 90, y: COND_Y(i) };
      const tgtPos = positions[`tgt:${b.id}`] ?? { x: 470, y: COND_Y(i) };
      if (b.isElse) {
        list.push({
          id: b.id,
          type: "else",
          position: condPos,
          data: { onRemove: () => removeBranch(b.id), active: b.id === active } satisfies ElseData,
        });
      } else {
        list.push({
          id: b.id,
          type: "condition",
          position: condPos,
          data: {
            label: i === 0 ? "If" : "Else if",
            group: b.group,
            onGroupChange: (g: Group) => patchGroup(b.id, g),
            onRemove: () => removeBranch(b.id),
            active: b.id === active,
          } satisfies ConditionData,
        });
      }
      list.push({
        id: `tgt:${b.id}`,
        type: "component",
        position: tgtPos,
        data: {
          target: b.target,
          components,
          onPick: (t: TargetDraft) => patchTarget(b.id, t),
          active: b.id === active,
        } satisfies TargetNodeData,
      });
    });
    return list;
  }, [branches, positions, components, active, removeBranch, patchGroup, patchTarget]);

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
          <ReactFlow
            nodes={nodes}
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
