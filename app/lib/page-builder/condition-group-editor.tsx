import { Input } from "~/components/ui/input";
import {
  OPERATORS,
  SIGNAL_SUGGESTIONS,
  displayValue,
  parseValue,
  type Group,
  type Leaf,
} from "./conditional-model";
import type { Operator } from "~/lib/conditional/types";

/**
 * The AND/ANY group of leaf conditions (signal → operator → value). Shared by
 * the properties-panel branch editor and the flow-canvas condition nodes.
 *
 * `nodrag`/`nopan`/`nowheel` classes keep React Flow from hijacking pointer and
 * wheel events when this is rendered inside a flow node.
 */
export function ConditionGroupEditor({
  group,
  onChange,
}: {
  group: Group;
  onChange: (g: Group) => void;
}) {
  const setLeaf = (i: number, patch: Partial<Leaf>) =>
    onChange({ ...group, leaves: group.leaves.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) });
  const addLeaf = () =>
    onChange({ ...group, leaves: [...group.leaves, { signal: "", op: "is", value: "" }] });
  const removeLeaf = (i: number) =>
    onChange({ ...group, leaves: group.leaves.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-1.5 nodrag nowheel">
      {group.leaves.length > 1 && (
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span>Match</span>
          <select
            className="h-5 rounded border border-input bg-transparent px-1 text-[9px]"
            value={group.mode}
            onChange={(e) => onChange({ ...group, mode: e.target.value as "all" | "any" })}
          >
            <option value="all">ALL</option>
            <option value="any">ANY</option>
          </select>
          <span>of:</span>
        </div>
      )}

      <datalist id="pb-signal-suggestions">
        {SIGNAL_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {group.leaves.map((leaf, i) => (
        <div key={i} className="space-y-1 rounded border border-border/60 p-1.5">
          <div className="flex items-center gap-1">
            <Input
              list="pb-signal-suggestions"
              className="h-6 text-[10px]"
              placeholder="signal (e.g. auth.loggedIn)"
              value={leaf.signal}
              onChange={(e) => setLeaf(i, { signal: e.target.value })}
            />
            <button type="button" onClick={() => removeLeaf(i)}
              className="px-1 text-muted-foreground hover:text-destructive shrink-0">×</button>
          </div>
          <div className="flex items-center gap-1">
            <select
              className="h-6 rounded-md border border-input bg-transparent px-1 text-[10px] shadow-sm"
              value={leaf.op}
              onChange={(e) => setLeaf(i, { op: e.target.value as Operator })}
            >
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {leaf.op !== "exists" && (
              <Input
                className="h-6 text-[10px]"
                placeholder="value"
                value={displayValue(leaf.value)}
                onChange={(e) => setLeaf(i, { value: parseValue(e.target.value) })}
              />
            )}
          </div>
        </div>
      ))}

      <button type="button" onClick={addLeaf} className="text-[10px] text-primary hover:underline">
        + add condition
      </button>
    </div>
  );
}
