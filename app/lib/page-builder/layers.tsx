import { useState, useCallback } from "react";
import type { PBNode } from "./types";
import type { PBStore } from "./store";
import { cn } from "~/lib/utils";

interface LayersProps {
  store: PBStore;
  root: PBNode;
  selectedId: string | null;
}

export function Layers({ store, root, selectedId }: LayersProps) {
  return (
    <div className="text-xs">
      {root.children.map((child) => (
        <LayerItem
          key={child.id}
          node={child}
          store={store}
          selectedId={selectedId}
          depth={0}
        />
      ))}
      {root.children.length === 0 && (
        <p className="text-muted-foreground text-center py-4 text-[10px]">
          No elements. Drag blocks to the canvas.
        </p>
      )}
    </div>
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
  const [collapsed, setCollapsed] = useState(false);
  const isSelected = selectedId === node.id;
  const hasChildren = node.children.length > 0;
  const displayName = node.name ?? node.tag;
  const textPreview =
    node.type === "text" && node.text
      ? ` — "${node.text.slice(0, 20)}${node.text.length > 20 ? "..." : ""}"`
      : "";

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
      <div
        className={cn(
          "flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer group",
          isSelected
            ? "bg-primary text-primary-foreground"
            : "hover:bg-muted"
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
