import { useEffect, useRef, useCallback, useMemo } from "react";
import type { PBStore } from "./store";
import type { PBNode } from "./types";
import { findNode, findParent } from "./utils";
import { parseHtml } from "./serializer";

interface CanvasProps {
  store: PBStore;
  externalStyles?: string[];
}

type DropPosition = "before" | "after" | "inside";

interface DropTarget {
  id: string;
  position: DropPosition;
}

export function Canvas({ store, externalStyles = [] }: CanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const storeRef = useRef(store);
  const pendingRender = useRef(false);
  const currentDropTarget = useRef<DropTarget | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  storeRef.current = store;

  // Build srcdoc with Tailwind CDN
  const srcdoc = useMemo(() => {
    const styleTags = externalStyles
      .map((u) => `<link rel="stylesheet" href="${u}" />`)
      .join("\n");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${styleTags}
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script>tailwind.config={darkMode:'class'}<\/script>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding-top: 22px; min-height: 100vh; font-family: system-ui, sans-serif; }
    [data-pb-id] { position: relative; min-height: 2px; }
    [data-pb-id]:empty { min-height: 20px; }
    [data-pb-selected="true"] { outline: 2px solid #4c6ef5 !important; outline-offset: -1px; z-index: 1; }
    [data-pb-hover="true"]:not([data-pb-selected="true"]) { outline: 1px dashed #60a5fa; outline-offset: -1px; }
    [data-pb-editing="true"] { outline: 2px solid #22c55e !important; outline-offset: -1px; }
    [data-pb-drop-target="true"] { outline: 2px dashed #4c6ef5 !important; outline-offset: -2px; background: rgba(76,110,245,0.06); }
    /* Edit-mode padding on containers */
    [data-pb-container="true"] { padding: max(var(--tw-p, 0px), 6px); }
    /* Floating labels */
    [data-pb-hover="true"]::before,
    [data-pb-selected="true"]::before {
      content: attr(data-pb-name);
      position: absolute; top: -18px; left: 0;
      font-size: 10px; line-height: 1; padding: 2px 6px;
      border-radius: 3px 3px 0 0; white-space: nowrap;
      pointer-events: none; z-index: 10;
    }
    [data-pb-hover="true"]:not([data-pb-selected="true"])::before { background: #60a5fa; color: white; }
    [data-pb-selected="true"]::before { background: #4c6ef5; color: white; }
  </style>
</head>
<body></body>
</html>`;
  }, [externalStyles]);

  const render = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const body = iframe.contentDocument.body;
    const state = storeRef.current.getState();
    const root = state.root;

    const html = root.children
      .map((c) => renderNode(c, state.selection.nodeId))
      .join("");

    body.innerHTML = html || "";
    // Apply root classes to body (for body-level styles like dark mode, bg, font)
    body.className = root.classes.join(" ");
    // Apply root inline styles
    const rootStyleStr = Object.entries(root.styles).map(([k, v]) => `${k}:${v}`).join(";");
    body.setAttribute("style", rootStyleStr || "");
  }, []);

  const scheduleRender = useCallback(() => {
    if (pendingRender.current) return;
    pendingRender.current = true;
    requestAnimationFrame(() => {
      pendingRender.current = false;
      render();
    });
  }, [render]);

  // Create indicator element
  useEffect(() => {
    const line = document.createElement("div");
    line.style.cssText = "position:absolute;pointer-events:none;z-index:100;display:none;background:#4c6ef5;border-radius:2px;";
    indicatorRef.current = line;
    wrapperRef.current?.appendChild(line);
    return () => line.remove();
  }, []);

  // Render on iframe load
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handleLoad = () => setTimeout(render, 300);
    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [render, srcdoc]);

  // Re-render on store changes
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

  // Attach click/hover/dblclick listeners inside the iframe (same-origin, works fine)
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const attach = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      doc.addEventListener("click", (e) => {
        e.preventDefault();
        const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
        storeRef.current.select(target?.getAttribute("data-pb-id") ?? null);
      }, true);

      let lastHoverId: string | null = null;
      doc.addEventListener("mouseover", (e) => {
        const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
        const id = target?.getAttribute("data-pb-id") ?? null;
        if (id === lastHoverId) return;
        lastHoverId = id;
        doc.querySelectorAll("[data-pb-hover]").forEach((h) => h.removeAttribute("data-pb-hover"));
        target?.setAttribute("data-pb-hover", "true");
      });

      doc.addEventListener("dblclick", (e) => {
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
          if (node.type === "text") {
            storeRef.current.updateNode(id, { text: target.textContent?.trim() ?? "" });
          }
          target.removeEventListener("blur", finishEdit);
        };
        target.addEventListener("blur", finishEdit);
      }, true);
    };

    iframe.addEventListener("load", attach);
    return () => iframe.removeEventListener("load", attach);
  }, []);

  // --- Drag/drop on the wrapper div (avoids cross-document issues) ---

  const getIframeElement = useCallback((clientX: number, clientY: number): HTMLElement | null => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument) return null;
    const rect = iframe.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return iframe.contentDocument.elementFromPoint(x, y) as HTMLElement | null;
  }, []);

  const isParentHorizontal = useCallback((el: HTMLElement): boolean => {
    const parent = el.parentElement;
    if (!parent) return false;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return false;
    const style = iframe.contentWindow.getComputedStyle(parent);
    return style.display.includes("flex") && (style.flexDirection === "row" || style.flexDirection === "");
  }, []);

  const showIndicator = useCallback((targetEl: HTMLElement, position: DropPosition, horizontal: boolean) => {
    const line = indicatorRef.current;
    const wrapper = wrapperRef.current;
    const iframe = iframeRef.current;
    if (!line || !wrapper || !iframe) return;

    const iRect = iframe.getBoundingClientRect();
    const wRect = wrapper.getBoundingClientRect();
    const eRect = targetEl.getBoundingClientRect();

    // Convert iframe-internal coords to wrapper-relative
    const top = eRect.top + iRect.top - wRect.top;
    const left = eRect.left + iRect.left - wRect.left;

    line.style.display = "block";

    if (position === "inside") {
      line.style.display = "none";
      targetEl.setAttribute("data-pb-drop-target", "true");
      return;
    }

    if (horizontal) {
      line.style.width = "3px";
      line.style.height = `${eRect.height}px`;
      line.style.top = `${top}px`;
      line.style.left = position === "before" ? `${left - 2}px` : `${left + eRect.width - 1}px`;
    } else {
      line.style.height = "3px";
      line.style.width = `${eRect.width}px`;
      line.style.left = `${left}px`;
      line.style.top = position === "before" ? `${top - 2}px` : `${top + eRect.height - 1}px`;
    }
  }, []);

  const hideIndicator = useCallback(() => {
    const line = indicatorRef.current;
    if (line) line.style.display = "none";
    iframeRef.current?.contentDocument?.querySelectorAll("[data-pb-drop-target]").forEach((h) => {
      h.removeAttribute("data-pb-drop-target");
    });
    // Clear body highlight
    const body = iframeRef.current?.contentDocument?.body;
    if (body) {
      body.style.outline = "";
      body.style.outlineOffset = "";
      body.style.background = "";
      body.style.minHeight = "";
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes("text/pb-block-html") ? "copy" : "move";

    // Check if cursor is over the iframe area
    const iframeRect = iframeRef.current?.getBoundingClientRect();
    const isOverIframe = iframeRect &&
      e.clientX >= iframeRect.left && e.clientX <= iframeRect.right &&
      e.clientY >= iframeRect.top && e.clientY <= iframeRect.bottom;

    const el = isOverIframe ? getIframeElement(e.clientX, e.clientY) : null;
    iframeRef.current?.contentDocument?.querySelectorAll("[data-pb-drop-target]").forEach((h) => h.removeAttribute("data-pb-drop-target"));

    const target = el?.closest("[data-pb-id]") as HTMLElement | null;

    if (!target) {
      // Over empty area — find nearest top-level child
      hideIndicator();
      const body = iframeRef.current?.contentDocument?.body;
      if (!body) return;
      const children = body.querySelectorAll(":scope > [data-pb-id]");
      if (children.length === 0) {
        // Empty canvas — highlight body as drop target
        body.style.outline = "2px dashed #4c6ef5";
        body.style.outlineOffset = "-2px";
        body.style.background = "rgba(76,110,245,0.06)";
        body.style.minHeight = "200px";
        currentDropTarget.current = { id: storeRef.current.getRoot().id, position: "inside" };
        return;
      }
      let nearest: HTMLElement | null = null;
      let pos: DropPosition = "after";
      const iRect = iframeRef.current!.getBoundingClientRect();
      const y = e.clientY - iRect.top;
      for (const child of Array.from(children) as HTMLElement[]) {
        const r = child.getBoundingClientRect();
        if (y < r.top + r.height / 2) { nearest = child; pos = "before"; break; }
        nearest = child; pos = "after";
      }
      if (nearest) {
        currentDropTarget.current = { id: nearest.getAttribute("data-pb-id")!, position: pos };
        showIndicator(nearest, pos, false);
      }
      return;
    }

    const id = target.getAttribute("data-pb-id")!;
    const node = findNode(storeRef.current.getRoot(), id);
    if (!node) return;

    const rect = target.getBoundingClientRect();
    const horizontal = isParentHorizontal(target);
    const ratio = horizontal
      ? (e.clientX - iframeRef.current!.getBoundingClientRect().left - rect.left) / rect.width
      : (e.clientY - iframeRef.current!.getBoundingClientRect().top - rect.top) / rect.height;

    let position: DropPosition;
    if (ratio < 0.3) position = "before";
    else if (ratio > 0.7) position = "after";
    else if (node.droppable !== false && node.type !== "text" && node.type !== "void") position = "inside";
    else if (ratio < 0.5) position = "before";
    else position = "after";

    currentDropTarget.current = { id, position };
    hideIndicator();
    showIndicator(target, position, horizontal);
  }, [getIframeElement, isParentHorizontal, showIndicator, hideIndicator]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!wrapperRef.current?.contains(e.relatedTarget as Node)) {
      hideIndicator();
      currentDropTarget.current = null;
    }
  }, [hideIndicator]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    hideIndicator();

    let drop = currentDropTarget.current;
    currentDropTarget.current = null;

    // If no drop target was set (e.g. dragging onto empty pb-container), use root
    if (!drop) {
      const blockHtml = e.dataTransfer.getData("text/pb-block-html");
      if (blockHtml) {
        drop = { id: storeRef.current.getRoot().id, position: "inside" };
      } else {
        return;
      }
    }

    const s = storeRef.current;
    const root = s.getRoot();

    const nodeId = e.dataTransfer.getData("text/pb-node-id");
    const blockHtml = e.dataTransfer.getData("text/pb-block-html");

    if (nodeId) {
      if (nodeId === drop.id) return;
      if (drop.position === "inside") {
        s.moveNode(nodeId, drop.id);
      } else {
        const p = findParent(root, drop.id);
        if (p) s.moveNode(nodeId, p.parent.id, drop.position === "before" ? p.index : p.index + 1);
      }
      return;
    }

    if (blockHtml) {
      const parsed = parseHtml(blockHtml);
      if (drop.position === "inside") {
        for (const child of parsed.children) s.addNode(drop.id, child);
      } else {
        const p = findParent(root, drop.id);
        const parentId = p?.parent.id ?? root.id;
        const idx = p ? (drop.position === "before" ? p.index : p.index + 1) : undefined;
        for (let i = 0; i < parsed.children.length; i++) {
          s.addNode(parentId, parsed.children[i], idx !== undefined ? idx + i : undefined);
        }
      }
    }
  }, [hideIndicator]);

  return (
    <div
      ref={wrapperRef}
      className="pb-container relative w-full h-full"
      onClick={(e) => {
        if (e.target === wrapperRef.current) {
          storeRef.current.select(null);
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        // Disable iframe pointer events so wrapper receives drop
        if (iframeRef.current) iframeRef.current.style.pointerEvents = "none";
      }}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        handleDragLeave(e);
        if (!wrapperRef.current?.contains(e.relatedTarget as Node)) {
          if (iframeRef.current) iframeRef.current.style.pointerEvents = "";
        }
      }}
      onDrop={(e) => {
        if (iframeRef.current) iframeRef.current.style.pointerEvents = "";
        handleDrop(e);
      }}
    >
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        className="w-full h-full border-0 rounded"
        title="Page Builder Canvas"
      />
    </div>
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
  if (node.children.length > 0) attrs.push('data-pb-container="true"');
  if (node.id === selectedId) attrs.push('data-pb-selected="true"');
  if (node.classes.length > 0) attrs.push(`class="${node.classes.join(" ")}"`);

  const styleStr = Object.entries(node.styles).map(([k, v]) => `${k}:${v}`).join(";");
  if (styleStr) attrs.push(`style="${styleStr}"`);

  for (const [k, v] of Object.entries(node.attributes)) {
    attrs.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
  }

  if (node.type === "void") return `<${tag} ${attrs.join(" ")} />`;

  const childrenHtml = node.children.map((c) => renderNode(c, selectedId)).join("");
  return `<${tag} ${attrs.join(" ")}>${childrenHtml}</${tag}>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
