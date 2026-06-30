import { createContext, useCallback, useContext, useState } from "react";
import type { PBNode } from "./types";
import type { PBStore } from "./store";
import { findNode, findParent } from "./utils";
import { cn } from "~/lib/utils";

interface LayersProps {
  store: PBStore;
  root: PBNode;
  selectedId: string | null;
}

type DropPos = "before" | "after" | "inside";
interface DropTarget {
  id: string;
  pos: DropPos;
}

interface LayersDndValue {
  draggingId: string | null;
  dropTarget: DropTarget | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOverRow: (e: React.DragEvent, node: PBNode) => void;
  onDropRow: (e: React.DragEvent, node: PBNode) => void;
  onDragEnd: () => void;
}
const LayersDnd = createContext<LayersDndValue | null>(null);

// --- drop math -------------------------------------------------------------

/**
 * Resolve a drop (node + position) to the parent id and child index to move into.
 * `index` is computed against the parent's children *with the dragged node
 * removed*, matching `store.moveNode` (which removes then re-inserts) — so
 * same-parent reordering lands where the indicator showed.
 */
function targetParentAndIndex(
  root: PBNode,
  draggedId: string,
  node: PBNode,
  pos: DropPos
): { parentId: string; index: number } | null {
  if (pos === "inside") {
    const post = node.children.filter((c) => c.id !== draggedId);
    return { parentId: node.id, index: post.length }; // append as last child
  }
  const fp = findParent(root, node.id);
  if (!fp) return null;
  const post = fp.parent.children.filter((c) => c.id !== draggedId);
  const sib = post.findIndex((c) => c.id === node.id);
  if (sib === -1) return null;
  return { parentId: fp.parent.id, index: pos === "before" ? sib : sib + 1 };
}

function canDrop(root: PBNode, draggedId: string, node: PBNode, pos: DropPos): boolean {
  if (draggedId === node.id) return false;
  const dragged = findNode(root, draggedId);
  if (!dragged) return false;
  if (findNode(dragged, node.id)) return false; // can't drop into itself or a descendant
  if (pos === "inside" && node.type !== "element") return false; // only elements hold children
  const t = targetParentAndIndex(root, draggedId, node, pos);
  if (!t) return false;
  if (dragged.parentConstraint) {
    const parent = findNode(root, t.parentId);
    if (!parent || parent.name !== dragged.parentConstraint) return false;
  }
  return true;
}

/** Pick the drop zone from the cursor's vertical position within the row. */
function dropPosFor(e: React.DragEvent, node: PBNode): DropPos {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
  if (node.type === "element") {
    // top / middle / bottom → before / inside / after
    return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
  }
  // leaves (text / void) can only be reordered as siblings
  return ratio < 0.5 ? "before" : "after";
}

// --- components ------------------------------------------------------------

export function Layers({ store, root, selectedId }: LayersProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id); // required for Firefox to start a drag
  }, []);

  const onDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
  }, []);

  const onDragOverRow = useCallback(
    (e: React.DragEvent, node: PBNode) => {
      if (!draggingId) return;
      const pos = dropPosFor(e, node);
      if (!canDrop(root, draggingId, node, pos)) {
        setDropTarget((prev) => (prev?.id === node.id ? null : prev));
        return;
      }
      e.preventDefault(); // mark as a valid drop target
      e.dataTransfer.dropEffect = "move";
      setDropTarget((prev) => (prev?.id === node.id && prev.pos === pos ? prev : { id: node.id, pos }));
    },
    [draggingId, root]
  );

  const onDropRow = useCallback(
    (e: React.DragEvent, node: PBNode) => {
      e.preventDefault();
      if (draggingId) {
        const pos = dropPosFor(e, node);
        if (canDrop(root, draggingId, node, pos)) {
          const t = targetParentAndIndex(root, draggingId, node, pos);
          if (t) store.moveNode(draggingId, t.parentId, t.index);
        }
      }
      onDragEnd();
    },
    [draggingId, root, store, onDragEnd]
  );

  const value: LayersDndValue = { draggingId, dropTarget, onDragStart, onDragOverRow, onDropRow, onDragEnd };

  return (
    <LayersDnd.Provider value={value}>
      <div className="text-xs">
        {root.children.map((child) => (
          <LayerItem key={child.id} node={child} store={store} selectedId={selectedId} depth={0} />
        ))}
        {root.children.length === 0 && (
          <p className="text-muted-foreground text-center py-4 text-[10px]">
            No elements. Drag blocks to the canvas.
          </p>
        )}
      </div>
    </LayersDnd.Provider>
  );
}

function LayerItem({
  node,
  store,
  selectedId,
  depth,
}: {
  node: PBNode;
  store: PBStore;
  selectedId: string | null;
  depth: number;
}) {
  const dnd = useContext(LayersDnd);
  const [collapsed, setCollapsed] = useState(false);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children.length > 0;
  const displayName = node.name ?? node.tag;
  const textPreview =
    node.type === "text" && node.text
      ? ` — "${node.text.slice(0, 20)}${node.text.length > 20 ? "..." : ""}"`
      : "";

  const isDragging = dnd?.draggingId === node.id;
  const indicator = dnd?.dropTarget?.id === node.id ? dnd.dropTarget.pos : null;

  const handleSelect = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      store.select(node.id);
    },
    [store, node.id]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      store.removeNode(node.id);
    },
    [store, node.id]
  );

  return (
    <div>
      <div className="relative">
        {indicator === "before" && (
          <div className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 bg-primary" />
        )}
        <div
          draggable
          onDragStart={(e) => dnd?.onDragStart(e, node.id)}
          onDragOver={(e) => dnd?.onDragOverRow(e, node)}
          onDrop={(e) => dnd?.onDropRow(e, node)}
          onDragEnd={() => dnd?.onDragEnd()}
          className={cn(
            "flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer group",
            isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
            isDragging && "opacity-40",
            indicator === "inside" && "ring-1 ring-inset ring-primary bg-primary/10"
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={handleSelect}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed(!collapsed);
              }}
              className="w-3 h-3 flex items-center justify-center text-[8px]"
            >
              {collapsed ? "▶" : "▼"}
            </button>
          ) : (
            <span className="w-3" />
          )}
          <span className="truncate flex-1 text-[11px]">
            {displayName}
            <span className={cn("opacity-60", isSelected ? "text-primary-foreground/70" : "text-muted-foreground")}>
              {textPreview}
            </span>
          </span>
          <button
            type="button"
            onClick={handleDelete}
            className={cn(
              "opacity-0 group-hover:opacity-100 text-[10px] px-1",
              isSelected ? "text-primary-foreground/70 hover:text-primary-foreground" : "text-muted-foreground hover:text-destructive"
            )}
            title="Delete"
          >
            ×
          </button>
        </div>
        {indicator === "after" && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px z-10 h-0.5 bg-primary" />
        )}
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <LayerItem
              key={child.id}
              node={child}
              store={store}
              selectedId={selectedId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
