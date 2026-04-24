import { useEffect, useRef, useCallback } from "react";
import type { PBStore } from "./store";
import type { PBNode } from "./types";
import { findNode, findParent } from "./utils";
import { parseHtml } from "./serializer";

interface CanvasProps {
  store: PBStore;
}

type DropPosition = "before" | "after" | "inside";

interface DropTarget {
  id: string;
  position: DropPosition;
}

export function Canvas({ store }: CanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef(store);
  const pendingRender = useRef(false);
  const currentDropTarget = useRef<DropTarget | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  storeRef.current = store;

  const render = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const state = storeRef.current.getState();
    const root = state.root;

    // Preserve the indicator element
    const indicator = indicatorRef.current;
    if (indicator) indicator.remove();

    const html = root.children
      .map((c) => renderNode(c, state.selection.nodeId))
      .join("");

    el.innerHTML = html || "";
    el.className = `pb-canvas min-h-full ${root.classes.join(" ")}`;

    // Re-attach indicator
    if (indicator) el.appendChild(indicator);

    // Make all elements draggable
    el.querySelectorAll("[data-pb-id]").forEach((child) => {
      (child as HTMLElement).draggable = true;
    });
  }, []);

  const scheduleRender = useCallback(() => {
    if (pendingRender.current) return;
    pendingRender.current = true;
    requestAnimationFrame(() => {
      pendingRender.current = false;
      render();
    });
  }, [render]);

  // Create the drop indicator line element
  useEffect(() => {
    const line = document.createElement("div");
    line.className = "pb-drop-line";
    line.style.cssText = "position:absolute;pointer-events:none;z-index:100;display:none;";
    indicatorRef.current = line;
    canvasRef.current?.appendChild(line);
    return () => line.remove();
  }, []);

  // Initial render
  useEffect(() => render(), [render]);

  // Re-render on store changes (skip hover-only)
  useEffect(() => {
    let lastRoot: unknown = null;
    let lastSelectedId: string | null = null;
    return store.subscribe(() => {
      const state = store.getState();
      if (state.root !== lastRoot || state.selection.nodeId !== lastSelectedId) {
        lastRoot = state.root;
        lastSelectedId = state.selection.nodeId;
        scheduleRender();
      }
    });
  }, [store, scheduleRender]);

  // Click to select
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
    storeRef.current.select(target?.getAttribute("data-pb-id") ?? null);
  }, []);

  // Hover highlight (DOM only, no re-render)
  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    el.querySelectorAll("[data-pb-hover]").forEach((h) => h.removeAttribute("data-pb-hover"));
    const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
    target?.setAttribute("data-pb-hover", "true");
  }, []);

  // Double-click to edit text
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
    if (!target) return;
    const id = target.getAttribute("data-pb-id")!;
    const node = findNode(storeRef.current.getRoot(), id);
    if (!node?.editable) return;

    e.preventDefault();
    target.contentEditable = "true";
    target.setAttribute("data-pb-editing", "true");
    target.focus();

    const finishEdit = () => {
      target.contentEditable = "false";
      target.removeAttribute("data-pb-editing");
      const text = target.textContent?.trim() ?? "";
      if (node.type === "text") {
        storeRef.current.updateNode(id, { text });
      }
      target.removeEventListener("blur", finishEdit);
      target.removeEventListener("keydown", handleKey);
    };

    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finishEdit(); }
      if (ev.key === "Escape") { ev.preventDefault(); target.textContent = node.text ?? ""; finishEdit(); }
    };

    target.addEventListener("blur", finishEdit);
    target.addEventListener("keydown", handleKey);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
    if (target) {
      e.dataTransfer.setData("text/pb-node-id", target.getAttribute("data-pb-id")!);
      e.dataTransfer.effectAllowed = "move";
    }
  }, []);

  // Show/hide the drop indicator line
  const showIndicator = useCallback((targetEl: HTMLElement, position: DropPosition, isHorizontal: boolean) => {
    const line = indicatorRef.current;
    if (!line) return;
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    if (!canvasRect) return;

    line.style.display = "block";
    line.style.background = "#4c6ef5";
    line.style.borderRadius = "2px";

    if (position === "inside") {
      // Highlight the container
      line.style.display = "none";
      targetEl.setAttribute("data-pb-drop-target", "true");
      return;
    }

    if (isHorizontal) {
      // Vertical line for flex-row parents
      line.style.width = "3px";
      line.style.height = `${rect.height}px`;
      line.style.top = `${rect.top - canvasRect.top}px`;
      if (position === "before") {
        line.style.left = `${rect.left - canvasRect.left - 2}px`;
      } else {
        line.style.left = `${rect.right - canvasRect.left - 1}px`;
      }
    } else {
      // Horizontal line for block/column parents
      line.style.height = "3px";
      line.style.width = `${rect.width}px`;
      line.style.left = `${rect.left - canvasRect.left}px`;
      if (position === "before") {
        line.style.top = `${rect.top - canvasRect.top - 2}px`;
      } else {
        line.style.top = `${rect.bottom - canvasRect.top - 1}px`;
      }
    }
  }, []);

  const hideIndicator = useCallback(() => {
    const line = indicatorRef.current;
    if (line) line.style.display = "none";
    canvasRef.current?.querySelectorAll("[data-pb-drop-target]").forEach((h) => {
      h.removeAttribute("data-pb-drop-target");
    });
  }, []);

  // Determine if parent uses horizontal (flex-row) layout
  const isParentHorizontal = useCallback((targetEl: HTMLElement): boolean => {
    const parent = targetEl.parentElement;
    if (!parent) return false;
    const style = window.getComputedStyle(parent);
    return style.display.includes("flex") && (style.flexDirection === "row" || style.flexDirection === "");
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes("text/pb-block-html") ? "copy" : "move";

    const el = canvasRef.current;
    if (!el) return;

    let target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;

    // Clear old indicators
    el.querySelectorAll("[data-pb-drop-target]").forEach((h) => h.removeAttribute("data-pb-drop-target"));

    if (!target) {
      // Cursor is over the canvas but not on a child element.
      // Find the nearest top-level child by Y position to show before/after.
      const children = el.querySelectorAll(":scope > [data-pb-id]");
      if (children.length === 0) {
        // Empty canvas — drop inside root
        hideIndicator();
        el.setAttribute("data-pb-drop-target", "true");
        currentDropTarget.current = { id: storeRef.current.getRoot().id, position: "inside" };
        return;
      }

      // Find which gap the cursor is in
      let nearestChild: HTMLElement | null = null;
      let nearestPos: DropPosition = "after";
      for (const child of Array.from(children) as HTMLElement[]) {
        const rect = child.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          nearestChild = child;
          nearestPos = "before";
          break;
        }
        nearestChild = child;
        nearestPos = "after";
      }

      if (nearestChild) {
        target = nearestChild;
        const id = target.getAttribute("data-pb-id")!;
        currentDropTarget.current = { id, position: nearestPos };
        showIndicator(target, nearestPos, false);
        return;
      }

      hideIndicator();
      currentDropTarget.current = { id: storeRef.current.getRoot().id, position: "inside" };
      return;
    }

    const id = target.getAttribute("data-pb-id")!;
    const node = findNode(storeRef.current.getRoot(), id);
    if (!node) return;

    const rect = target.getBoundingClientRect();
    const horizontal = isParentHorizontal(target);

    // Use X for horizontal parents, Y for vertical
    let ratio: number;
    if (horizontal) {
      ratio = (e.clientX - rect.left) / rect.width;
    } else {
      ratio = (e.clientY - rect.top) / rect.height;
    }

    let position: DropPosition;
    if (ratio < 0.3) {
      position = "before";
    } else if (ratio > 0.7) {
      position = "after";
    } else if (node.droppable !== false && node.type !== "text" && node.type !== "void") {
      position = "inside";
    } else if (ratio < 0.5) {
      position = "before";
    } else {
      position = "after";
    }

    currentDropTarget.current = { id, position };
    hideIndicator();
    showIndicator(target, position, horizontal);
  }, [isParentHorizontal, showIndicator, hideIndicator]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!canvasRef.current?.contains(e.relatedTarget as Node)) {
      hideIndicator();
      currentDropTarget.current = null;
    }
  }, [hideIndicator]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    hideIndicator();

    const drop = currentDropTarget.current;
    currentDropTarget.current = null;
    if (!drop) return;

    const store = storeRef.current;
    const root = store.getRoot();

    const nodeId = e.dataTransfer.getData("text/pb-node-id");
    const blockHtml = e.dataTransfer.getData("text/pb-block-html");

    if (nodeId) {
      const node = findNode(root, nodeId);
      if (!node || nodeId === drop.id) return;
      if (drop.position === "inside") {
        store.moveNode(nodeId, drop.id);
      } else {
        const parentInfo = findParent(root, drop.id);
        if (!parentInfo) return;
        const idx = drop.position === "before" ? parentInfo.index : parentInfo.index + 1;
        store.moveNode(nodeId, parentInfo.parent.id, idx);
      }
      return;
    }

    if (blockHtml) {
      const parsed = parseHtml(blockHtml);
      const nodesToAdd = parsed.children;
      if (nodesToAdd.length === 0) return;

      if (drop.position === "inside") {
        for (const child of nodesToAdd) {
          store.addNode(drop.id, child);
        }
      } else {
        const parentInfo = findParent(root, drop.id);
        const parentId = parentInfo?.parent.id ?? root.id;
        const idx = parentInfo
          ? (drop.position === "before" ? parentInfo.index : parentInfo.index + 1)
          : undefined;
        for (let i = 0; i < nodesToAdd.length; i++) {
          store.addNode(parentId, nodesToAdd[i], idx !== undefined ? idx + i : undefined);
        }
      }
    }
  }, [hideIndicator]);

  return (
    <div
      ref={canvasRef}
      className="pb-canvas min-h-full relative"
      onClick={handleClick}
      onMouseOver={handleMouseOver}
      onDoubleClick={handleDoubleClick}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}

function renderNode(node: PBNode, selectedId: string | null): string {
  const name = node.name ?? node.tag;

  if (node.type === "text") {
    const tag = node.tag || "span";
    const classes = node.classes.join(" ");
    const classAttr = classes ? ` class="${classes}"` : "";
    const sel = node.id === selectedId ? ' data-pb-selected="true"' : "";
    return `<${tag} data-pb-id="${node.id}" data-pb-name="${name}"${classAttr}${sel}>${escapeHtml(node.text ?? "")}</${tag}>`;
  }

  const tag = node.tag;
  const attrs: string[] = [`data-pb-id="${node.id}"`, `data-pb-name="${name}"`];
  const hasChildren = node.children.length > 0;
  if (hasChildren) attrs.push('data-pb-container="true"');

  if (node.id === selectedId) attrs.push('data-pb-selected="true"');
  if (node.classes.length > 0) attrs.push(`class="${node.classes.join(" ")}"`);

  const styleStr = Object.entries(node.styles)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  if (styleStr) attrs.push(`style="${styleStr}"`);

  for (const [k, v] of Object.entries(node.attributes)) {
    attrs.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
  }

  const attrStr = attrs.join(" ");

  if (node.type === "void") {
    return `<${tag} ${attrStr} />`;
  }

  const childrenHtml = node.children.map((c) => renderNode(c, selectedId)).join("");
  return `<${tag} ${attrStr}>${childrenHtml}</${tag}>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
