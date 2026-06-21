import { useEffect, useRef, useCallback, useMemo, memo } from "react";
import type { PBStore } from "./store";
import type { PBNode } from "./types";
import { findNode, findParent } from "./utils";
import { parseHtml } from "./serializer";

/**
 * Check if a node can be dropped at the given position.
 * Validates parentConstraint — e.g. Column can only go inside Row.
 */
function canDropAt(
  dragNode: PBNode,
  targetId: string,
  position: DropPosition,
  root: PBNode
): boolean {
  if (!dragNode.parentConstraint) return true;

  let parentNode: PBNode | null = null;
  if (position === "inside") {
    parentNode = findNode(root, targetId);
  } else {
    const p = findParent(root, targetId);
    parentNode = p ? p.parent : null;
  }

  if (!parentNode) return false;
  return parentNode.name === dragNode.parentConstraint;
}

interface CanvasProps {
  store: PBStore;
  externalStyles?: string[];
  initialDarkMode?: boolean;
}

type DropPosition = "before" | "after" | "inside";

interface DropTarget {
  id: string;
  position: DropPosition;
}

export const Canvas = memo(function Canvas({ store, externalStyles = [], initialDarkMode = false }: CanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const storeRef = useRef(store);
  const pendingRender = useRef(false);
  const currentDropTarget = useRef<DropTarget | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const lastRenderedTreeHtml = useRef<string>("");
  storeRef.current = store;

  // Build srcdoc with Tailwind CDN
  const srcdoc = useMemo(() => {
    const styleTags = externalStyles
      .map((u) => `<link rel="stylesheet" href="${u}" />`)
      .join("\n");

    // Build Tailwind font family config from loaded Google Fonts
    const fontFamilies: Record<string, string[]> = {};
    for (const url of externalStyles) {
      const match = url.match(/family=([^&:]+)/);
      if (match) {
        const family = match[1].replace(/\+/g, " ");
        const key = family.toLowerCase().replace(/\s+/g, "-");
        fontFamilies[key] = [`'${family}'`, "sans-serif"];
      }
    }
    const tailwindConfig = JSON.stringify({
      darkMode: "class",
      theme: { extend: { fontFamily: fontFamilies } },
    });

    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

    return `<!DOCTYPE html>
<html>
<head>
  <base href="${baseUrl}/" />
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${styleTags}
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script>tailwind.config=${tailwindConfig}<\/script>
  <style>
    html { -webkit-text-size-adjust: 100%; }
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
      position: absolute; top: -16px; left: 0;
      font-size: 9px; line-height: 14px; padding: 0 5px;
      border-radius: 3px 3px 0 0; white-space: nowrap;
      pointer-events: none; z-index: 10;
    }
    [data-pb-hover="true"]:not([data-pb-selected="true"])::before { background: #60a5fa; color: white; }
    [data-pb-selected="true"]::before { background: #4c6ef5; color: white; }
    /* Selection toolbar */
    .pb-toolbar {
      position: absolute; display: none; z-index: 20;
      background: #1e1e1e; border-radius: 4px; padding: 1px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      gap: 0; align-items: center;
    }
    .pb-toolbar.visible { display: flex; }
    .pb-toolbar button {
      background: none; border: none; color: #aaa; cursor: pointer;
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      border-radius: 3px; padding: 0;
    }
    .pb-toolbar button:hover { background: #333; color: white; }
    .pb-toolbar button.danger:hover { background: #dc2626; color: white; }
    .pb-toolbar .sep { width: 1px; height: 14px; background: #444; margin: 0 1px; }
  </style>
</head>
<body></body>
</html>`;
  }, [externalStyles]);

  const render = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const body = iframe.contentDocument.body;
    const doc = iframe.contentDocument;
    const state = storeRef.current.getState();
    const root = state.root;

    // Build tree HTML WITHOUT selection to compare against last render
    const treeHtml = root.children
      .map((c) => renderNode(c, null))
      .join("");

    if (treeHtml === lastRenderedTreeHtml.current) {
      // Tree hasn't changed — just update selection in-place
      doc.querySelectorAll("[data-pb-selected]").forEach((el) =>
        el.removeAttribute("data-pb-selected")
      );
      if (state.selection.nodeId) {
        const sel = doc.querySelector(`[data-pb-id="${state.selection.nodeId}"]`);
        if (sel) sel.setAttribute("data-pb-selected", "true");
      }
      return;
    }

    lastRenderedTreeHtml.current = treeHtml;

    // Preserve toolbar before wiping innerHTML
    const toolbar = body.querySelector(".pb-toolbar");
    if (toolbar) toolbar.remove();

    // Full re-render — build HTML with selection markers
    const html = root.children
      .map((c) => renderNode(c, state.selection.nodeId))
      .join("");

    body.innerHTML = html || "";

    // Re-append toolbar
    if (toolbar) body.appendChild(toolbar);

    // Make all elements draggable
    body.querySelectorAll("[data-pb-id]").forEach((el) => {
      (el as HTMLElement).draggable = true;
    });
    // Prevent native drag on SVG internals
    body.querySelectorAll("svg *").forEach((el) => {
      el.addEventListener("dragstart", (e) => e.preventDefault());
    });

    // Apply root classes to body (for body-level styles like dark mode, bg, font)
    body.className = root.classes.join(" ");
    // Apply root inline styles
    const rootStyleStr = Object.entries(root.styles).map(([k, v]) => `${k}:${v}`).join(";");
    body.setAttribute("style", rootStyleStr || "");

    // Auto-detect dark mode from root classes and apply to <html>
    const isDark = root.classes.some((c) =>
      c === "bg-gray-900" || c === "bg-gray-950" || c === "bg-black" ||
      c === "bg-slate-900" || c === "bg-slate-950" || c === "bg-zinc-900" ||
      c === "bg-zinc-950" || c === "bg-neutral-900" || c === "bg-neutral-950"
    );
    const htmlEl = doc.documentElement;
    if (isDark) {
      htmlEl.classList.add("dark");
    } else if (!htmlEl.dataset.pbDarkManual) {
      // Only auto-remove if dark wasn't set manually via the toggle button
      htmlEl.classList.remove("dark");
    }

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
    const handleLoad = () => {
      // Apply persisted dark mode preference before first render
      const doc = iframe.contentDocument;
      if (doc && initialDarkMode) {
        doc.documentElement.classList.add("dark");
        doc.documentElement.dataset.pbDarkManual = "true";
      }
      setTimeout(render, 300);
    };
    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [render, srcdoc, initialDarkMode]);

  // Re-render on store changes
  useEffect(() => {
    return store.subscribe(() => {
      scheduleRender();
    });
  }, [store, scheduleRender]);

  // Attach click/hover/dblclick listeners inside the iframe (same-origin, works fine)
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const attach = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      // Create selection toolbar
      const toolbar = doc.createElement("div");
      toolbar.className = "pb-toolbar";
      toolbar.innerHTML = `
        <button data-action="move-up" title="Move up">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
        <button data-action="move-down" title="Move down">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
        </button>
        <div class="sep"></div>
        <button data-action="size-down" class="size-btn" title="Decrease size" style="display:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>
        </button>
        <span class="size-label" style="display:none;color:#888;font-size:9px;padding:0 2px;"></span>
        <button data-action="size-up" class="size-btn" title="Increase size" style="display:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <div class="sep size-btn" style="display:none"></div>
        <button data-action="duplicate" title="Duplicate">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
        <button data-action="parent" title="Select parent">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/><rect x="3" y="2" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/></svg>
        </button>
        <div class="sep"></div>
        <button data-action="delete" class="danger" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      `;
      doc.body.appendChild(toolbar);

      // Tailwind size steps
      const WH_SIZES = ["3", "3.5", "4", "5", "6", "7", "8", "9", "10", "12", "14", "16", "20", "24"];
      const TEXT_SIZES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"];

      type IconSizeMode = "wh" | "text" | null;

      function getIconSizeMode(node: PBNode): IconSizeMode {
        if (node.tag === "svg") return "wh";
        if (node.tag === "i" || (node.tag === "span" && node.classes.includes("material-icons"))) return "text";
        return null;
      }

      function getCurrentSize(node: PBNode, mode: IconSizeMode): string | null {
        if (mode === "wh") {
          for (const cls of node.classes) {
            const m = cls.match(/^w-(\S+)$/);
            if (m && WH_SIZES.includes(m[1])) return m[1];
          }
          return null;
        }
        if (mode === "text") {
          for (const cls of node.classes) {
            const m = cls.match(/^text-(\S+)$/);
            if (m && TEXT_SIZES.includes(m[1])) return m[1];
          }
          return null;
        }
        return null;
      }

      // Toolbar actions
      toolbar.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("button");
        if (!btn) return;
        e.stopPropagation();
        const action = btn.getAttribute("data-action");
        const store = storeRef.current;
        const selId = store.getState().selection.nodeId;
        if (!selId) return;
        const root = store.getRoot();

        if (action === "delete") {
          store.removeNode(selId);
        } else if (action === "duplicate") {
          store.duplicateNode(selId);
        } else if (action === "move-up" || action === "move-down") {
          const p = findParent(root, selId);
          if (!p) return;
          const dir = action === "move-up" ? -1 : 1;
          const newIdx = p.index + dir;
          if (newIdx < 0 || newIdx >= p.parent.children.length) return;
          store.moveNode(selId, p.parent.id, newIdx);
        } else if (action === "parent") {
          const p = findParent(root, selId);
          if (p && p.parent.id !== root.id) {
            store.select(p.parent.id);
          }
        } else if (action === "size-up" || action === "size-down") {
          const node = findNode(root, selId);
          if (!node) return;
          const mode = getIconSizeMode(node);
          if (!mode) return;

          const sizes = mode === "wh" ? WH_SIZES : TEXT_SIZES;
          const currentSize = getCurrentSize(node, mode);
          const currentIdx = currentSize ? sizes.indexOf(currentSize) : -1;
          const defaultIdx = mode === "wh" ? 2 : 4; // w-4 or text-xl
          const newIdx2 = action === "size-up"
            ? Math.min(sizes.length - 1, (currentIdx >= 0 ? currentIdx : defaultIdx) + 1)
            : Math.max(0, (currentIdx >= 0 ? currentIdx : defaultIdx) - 1);
          const newSize = sizes[newIdx2];

          let newClasses: string[];
          if (mode === "wh") {
            newClasses = node.classes
              .filter((c) => !c.match(/^[wh]-\S+$/))
              .concat([`w-${newSize}`, `h-${newSize}`]);
          } else {
            newClasses = node.classes
              .filter((c) => !c.match(/^text-(xs|sm|base|lg|xl|[2-9]xl)$/))
              .concat([`text-${newSize}`]);
          }
          store.updateNode(selId, { classes: newClasses });
        }
      });

      // Position toolbar on selection
      const positionToolbar = () => {
        const store = storeRef.current;
        const selId = store.getState().selection.nodeId;
        if (!selId) {
          toolbar.classList.remove("visible");
          return;
        }
        const el = doc.querySelector(`[data-pb-id="${selId}"]`) as HTMLElement | null;
        if (!el) {
          toolbar.classList.remove("visible");
          return;
        }
        const rect = el.getBoundingClientRect();
        const toolbarWidth = toolbar.offsetWidth || 150;
        toolbar.style.top = `${rect.top + doc.documentElement.scrollTop - 30}px`;
        toolbar.style.left = `${Math.max(0, rect.right - toolbarWidth)}px`;
        toolbar.style.right = "auto";
        toolbar.classList.add("visible");

        // Show/hide size buttons for icons
        const node = findNode(store.getRoot(), selId);
        const sizeMode = node ? getIconSizeMode(node) : null;
        toolbar.querySelectorAll(".size-btn, .size-label").forEach((el) => {
          (el as HTMLElement).style.display = sizeMode ? "" : "none";
        });
        if (sizeMode && node) {
          const size = getCurrentSize(node, sizeMode) ?? "—";
          const label = toolbar.querySelector(".size-label") as HTMLElement;
          if (label) label.textContent = sizeMode === "wh" ? `w${size}` : size;
        }
      };

      // Re-position toolbar on store changes and scroll
      storeRef.current.subscribe(positionToolbar);
      doc.addEventListener("scroll", positionToolbar);
      setTimeout(positionToolbar, 100);

      doc.addEventListener("click", (e) => {
        // Don't deselect when clicking the toolbar
        if ((e.target as HTMLElement).closest(".pb-toolbar")) return;
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

      // --- Internal drag/drop (moving elements within the canvas) ---
      let internalDragId: string | null = null;
      let internalDropTarget: DropTarget | null = null;

      // Create indicator line inside iframe
      const iLine = doc.createElement("div");
      iLine.style.cssText = "position:absolute;pointer-events:none;z-index:100;display:none;background:#4c6ef5;border-radius:2px;";
      doc.body.appendChild(iLine);

      doc.addEventListener("dragstart", (e) => {
        const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
        if (!target || !e.dataTransfer) return;
        internalDragId = target.getAttribute("data-pb-id");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/pb-internal", "true");
        target.style.opacity = "0.4";
      }, true);

      doc.addEventListener("dragend", (e) => {
        // Restore opacity
        if (internalDragId) {
          const el = doc.querySelector(`[data-pb-id="${internalDragId}"]`) as HTMLElement | null;
          if (el) el.style.opacity = "";
        }
        internalDragId = null;
        internalDropTarget = null;
        iLine.style.display = "none";
        doc.querySelectorAll("[data-pb-drop-target]").forEach((h) => h.removeAttribute("data-pb-drop-target"));
      }, true);

      doc.addEventListener("dragover", (e) => {
        if (!internalDragId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

        const target = (e.target as HTMLElement).closest("[data-pb-id]") as HTMLElement | null;
        doc.querySelectorAll("[data-pb-drop-target]").forEach((h) => h.removeAttribute("data-pb-drop-target"));
        iLine.style.display = "none";

        if (!target || target.getAttribute("data-pb-id") === internalDragId) return;

        const id = target.getAttribute("data-pb-id")!;
        const node = findNode(storeRef.current.getRoot(), id);
        if (!node) return;

        const rect = target.getBoundingClientRect();
        const parent = target.parentElement;
        const isHoriz = parent ? (() => {
          const s = doc.defaultView?.getComputedStyle(parent);
          return s?.display.includes("flex") && (s.flexDirection === "row" || s.flexDirection === "");
        })() : false;

        const ratio = isHoriz
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;

        let position: DropPosition;
        if (ratio < 0.3) position = "before";
        else if (ratio > 0.7) position = "after";
        else if (node.droppable !== false && node.type !== "text" && node.type !== "void") position = "inside";
        else if (ratio < 0.5) position = "before";
        else position = "after";

        // Validate parent constraint for internal drags
        if (internalDragId) {
          const dragNode = findNode(storeRef.current.getRoot(), internalDragId);
          if (dragNode && !canDropAt(dragNode, id, position, storeRef.current.getRoot())) {
            return;
          }
        }

        internalDropTarget = { id, position };

        if (position === "inside") {
          target.setAttribute("data-pb-drop-target", "true");
        } else {
          iLine.style.display = "block";
          if (isHoriz) {
            iLine.style.width = "3px";
            iLine.style.height = `${rect.height}px`;
            iLine.style.top = `${rect.top + doc.documentElement.scrollTop}px`;
            iLine.style.left = position === "before"
              ? `${rect.left - 2}px`
              : `${rect.right - 1}px`;
          } else {
            iLine.style.height = "3px";
            iLine.style.width = `${rect.width}px`;
            iLine.style.left = `${rect.left}px`;
            iLine.style.top = position === "before"
              ? `${rect.top + doc.documentElement.scrollTop - 2}px`
              : `${rect.bottom + doc.documentElement.scrollTop - 1}px`;
          }
        }
      }, true);

      doc.addEventListener("drop", (e) => {
        if (!internalDragId || !internalDropTarget) return;
        e.preventDefault();
        e.stopPropagation();

        const store = storeRef.current;
        const root = store.getRoot();
        const drop = internalDropTarget;

        if (internalDragId === drop.id) return;

        if (drop.position === "inside") {
          store.moveNode(internalDragId, drop.id);
        } else {
          const p = findParent(root, drop.id);
          if (p) {
            const idx = drop.position === "before" ? p.index : p.index + 1;
            store.moveNode(internalDragId, p.parent.id, idx);
          }
        }

        internalDragId = null;
        internalDropTarget = null;
        iLine.style.display = "none";
        doc.querySelectorAll("[data-pb-drop-target]").forEach((h) => h.removeAttribute("data-pb-drop-target"));
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
    // Temporarily restore pointer-events so elementFromPoint works
    const pe = iframe.style.pointerEvents;
    if (pe === "none") iframe.style.pointerEvents = "auto";
    const el = iframe.contentDocument.elementFromPoint(x, y) as HTMLElement | null;
    if (pe === "none") iframe.style.pointerEvents = "none";
    return el;
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
    e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes("text/pb-block-html") ? "copy" : "move";

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
      // Validate parent constraints
      const validChildren = parsed.children.filter((child) =>
        canDropAt(child, drop.id, drop.position, root)
      );
      if (validChildren.length === 0) return;

      if (drop.position === "inside") {
        for (const child of validChildren) s.addNode(drop.id, child);
      } else {
        const p = findParent(root, drop.id);
        const parentId = p?.parent.id ?? root.id;
        const idx = p ? (drop.position === "before" ? p.index : p.index + 1) : undefined;
        for (let i = 0; i < validChildren.length; i++) {
          s.addNode(parentId, validChildren[i], idx !== undefined ? idx + i : undefined);
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
        // Only disable iframe pointer events for external drags (from sidebar blocks)
        // Internal drags (from within the iframe) are handled by iframe's own listeners
        if (Array.from(e.dataTransfer.types).includes("text/pb-block-html")) {
          if (iframeRef.current) iframeRef.current.style.pointerEvents = "none";
        }
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
});

function renderNode(node: PBNode, selectedId: string | null): string {
  const componentSlug = node.attributes?.["data-pb-component"];
  const name = componentSlug ?? node.name ?? node.tag;

  if (node.type === "text") {
    const tag = node.tag || "span";
    const classAttr = node.classes.length > 0 ? ` class="${encodeClasses(node.classes)}"` : "";
    const sel = node.id === selectedId ? ' data-pb-selected="true"' : "";
    return `<${tag} data-pb-id="${node.id}" data-pb-name="${name}"${classAttr}${sel}>${escapeHtml(node.text ?? "")}</${tag}>`;
  }

  const tag = node.tag;

  // SVGs can't be HTML-dragged — wrap in a draggable <span> for the canvas
  if (tag === "svg") {
    const wrapAttrs: string[] = [
      `data-pb-id="${node.id}"`,
      `data-pb-name="${name}"`,
    ];
    if (node.id === selectedId) wrapAttrs.push('data-pb-selected="true"');
    // Move layout classes (w-*, h-*, block, shrink-*, m-*, p-*) to the wrapper
    const layoutRe = /^(w-|h-|block|inline|shrink|grow|m[xytblr]?-|p[xytblr]?-|self-|flex-)/;
    const wrapClasses = node.classes.filter((c) => layoutRe.test(c));
    const svgClasses = node.classes.filter((c) => !layoutRe.test(c));
    if (wrapClasses.length > 0) wrapAttrs.push(`class="${encodeClasses(wrapClasses)}"`);

    const svgAttrs: string[] = [];
    if (svgClasses.length > 0) svgAttrs.push(`class="${encodeClasses(svgClasses)}"`);
    // SVG needs w-full h-full to fill the wrapper
    else svgAttrs.push('class="w-full h-full"');

    const styleStr = Object.entries(node.styles).map(([k, v]) => `${k}:${v}`).join(";");
    if (styleStr) svgAttrs.push(`style="${styleStr}"`);
    for (const [k, v] of Object.entries(node.attributes)) {
      svgAttrs.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
    }

    const childrenHtml = node.children.map((c) => renderNode(c, selectedId)).join("");
    return `<span ${wrapAttrs.join(" ")}><svg ${svgAttrs.join(" ")}>${childrenHtml}</svg></span>`;
  }

  const attrs: string[] = [`data-pb-id="${node.id}"`, `data-pb-name="${name}"`];
  if (node.children.length > 0) attrs.push('data-pb-container="true"');
  if (node.id === selectedId) attrs.push('data-pb-selected="true"');
  if (node.classes.length > 0) {
    attrs.push(`class="${encodeClasses(node.classes)}"`);
  }

  const styleStr = Object.entries(node.styles).map(([k, v]) => `${k}:${v}`).join(";");
  if (styleStr) attrs.push(`style="${styleStr}"`);

  for (const [k, v] of Object.entries(node.attributes)) {
    attrs.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
  }

  if (node.type === "void") return `<${tag} ${attrs.join(" ")} />`;

  const childrenHtml = node.children.map((c) => renderNode(c, selectedId)).join("");
  return `<${tag} ${attrs.join(" ")}>${childrenHtml}</${tag}>`;
}

function encodeClasses(classes: string[]): string {
  return classes.map((c) => c.replace(/"/g, "&quot;").replace(/>/g, "&gt;").replace(/</g, "&lt;")).join(" ");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
