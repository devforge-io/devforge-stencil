import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState, useCallback, useRef } from "react";

// Custom Image node with width, alignment, and float support
export const ResizableImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      alignment: { default: "center" }, // left, center, right, float-left, float-right
    };
  },

  addCommands() {
    return {
      setImage:
        (options: { src: string; alt?: string; title?: string }) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  parseHTML() {
    return [
      {
        tag: "figure",
        getAttrs(node) {
          const el = node as HTMLElement;
          const img = el.querySelector("img");
          if (!img) return false;

          const figStyle = el.getAttribute("style") ?? "";
          const imgStyle = img.getAttribute("style") ?? "";

          let alignment = "center";
          if (figStyle.includes("text-align:right") || figStyle.includes("text-align: right")) {
            alignment = "right";
          } else if (figStyle.includes("text-align:left") || figStyle.includes("text-align: left")) {
            alignment = "left";
          } else if (imgStyle.includes("float:left") || imgStyle.includes("float: left")) {
            alignment = "float-left";
          } else if (imgStyle.includes("float:right") || imgStyle.includes("float: right")) {
            alignment = "float-right";
          }

          const widthMatch = imgStyle.match(/width:\s*([^;]+)/);
          const width = widthMatch ? widthMatch[1].trim() : null;

          return {
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt"),
            title: img.getAttribute("title"),
            width,
            alignment,
          };
        },
        contentElement: "img",
      },
      {
        tag: "img[src]",
        getAttrs(node) {
          const el = node as HTMLElement;
          const style = el.getAttribute("style") ?? "";

          let alignment = "center";
          if (style.includes("float:left") || style.includes("float: left")) {
            alignment = "float-left";
          } else if (style.includes("float:right") || style.includes("float: right")) {
            alignment = "float-right";
          }

          const widthMatch = style.match(/width:\s*([^;]+)/);
          const width = widthMatch ? widthMatch[1].trim() : null;

          return {
            src: el.getAttribute("src"),
            alt: el.getAttribute("alt"),
            title: el.getAttribute("title"),
            width,
            alignment,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { alignment, width, ...rest } = HTMLAttributes;
    const style: string[] = [];
    if (width) style.push(`width: ${width}`);

    const wrapperStyle: string[] = [];
    if (alignment === "center") wrapperStyle.push("text-align: center");
    else if (alignment === "right") wrapperStyle.push("text-align: right");
    else if (alignment === "float-left") {
      style.push("float: left", "margin-right: 1rem", "margin-bottom: 0.5rem");
    } else if (alignment === "float-right") {
      style.push("float: right", "margin-left: 1rem", "margin-bottom: 0.5rem");
    }

    return [
      "figure",
      { style: wrapperStyle.join("; ") },
      [
        "img",
        mergeAttributes(rest, {
          style: style.join("; "),
          class: "rounded-lg max-w-full",
          "data-width": width || undefined,
          "data-alignment": alignment || undefined,
        }),
      ],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

function ImageNodeView({ node, updateAttributes, selected }: NodeViewProps) {
  const { src, alt, width, alignment } = node.attrs;
  const [resizing, setResizing] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      startX.current = e.clientX;
      startWidth.current = imgRef.current?.offsetWidth ?? 300;

      const handleMouseMove = (ev: MouseEvent) => {
        const diff = ev.clientX - startX.current;
        const newWidth = Math.max(100, startWidth.current + diff);
        updateAttributes({ width: `${newWidth}px` });
      };

      const handleMouseUp = () => {
        setResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [updateAttributes]
  );

  const wrapperClass =
    alignment === "center"
      ? "text-center"
      : alignment === "right"
        ? "text-right"
        : alignment === "left"
          ? "text-left"
          : alignment === "float-left"
            ? "float-left mr-4 mb-2"
            : alignment === "float-right"
              ? "float-right ml-4 mb-2"
              : "";

  const imgStyle: React.CSSProperties = { width: width ?? "auto" };
  const isFloat = alignment === "float-left" || alignment === "float-right";

  return (
    <NodeViewWrapper
      className={`relative my-4 ${wrapperClass}`}
      style={isFloat ? imgStyle : undefined}
    >
      {/* Image toolbar when selected */}
      {selected && (
        <div className="absolute -top-9 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-lg p-1 z-10">
          {(
            [
              ["left", "Left"],
              ["center", "Center"],
              ["right", "Right"],
              ["float-left", "Float L"],
              ["float-right", "Float R"],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => updateAttributes({ alignment: val })}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                alignment === val
                  ? "bg-brand-600 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
          <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-0.5" />
          {["25%", "50%", "75%", "100%"].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => updateAttributes({ width: w })}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                width === w
                  ? "bg-brand-600 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {w}
            </button>
          ))}
          <button
            type="button"
            onClick={() => updateAttributes({ width: null })}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              !width
                ? "bg-brand-600 text-white"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
          >
            Auto
          </button>
        </div>
      )}

      <img
        ref={imgRef}
        src={src}
        alt={alt ?? ""}
        draggable={false}
        style={{ width: width ?? "auto" }}
        className={`rounded-lg max-w-full ${
          selected ? "ring-2 ring-brand-500" : ""
        } ${resizing ? "pointer-events-none" : ""}`}
      />

      {/* Resize handle */}
      {selected && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-brand-500/20 rounded-r-lg"
        />
      )}
    </NodeViewWrapper>
  );
}
