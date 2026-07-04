import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { ResizableImage } from "./resizable-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const lowlight = createLowlight(common);

function createTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-",
  });
  td.use(gfm);

  // Images with sizing/alignment — encode attrs in markdown title field
  td.addRule("figureImage", {
    filter: "figure",
    replacement: (_content, node) => {
      const img = (node as HTMLElement).querySelector("img");
      if (!img) return "";
      const src = img.getAttribute("src") ?? "";
      const alt = img.getAttribute("alt") ?? "";
      // Read data attributes for width/alignment
      const width = img.getAttribute("data-width") ?? "";
      const alignment = img.getAttribute("data-alignment") ?? "";

      const attrs: string[] = [];
      if (width) attrs.push(`width=${width}`);
      if (alignment && alignment !== "center") attrs.push(`align=${alignment}`);

      const title = attrs.length > 0 ? ` "${attrs.join(" ")}"` : "";
      return `\n\n![${alt}](${src}${title})\n\n`;
    },
  });

  // Standalone img tags (not in figure)
  td.addRule("styledImage", {
    filter: (node) =>
      node.nodeName === "IMG" &&
      node.parentNode?.nodeName !== "FIGURE",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      const width = el.getAttribute("data-width") ?? "";
      const alignment = el.getAttribute("data-alignment") ?? "";

      const attrs: string[] = [];
      if (width) attrs.push(`width=${width}`);
      if (alignment && alignment !== "center") attrs.push(`align=${alignment}`);

      const title = attrs.length > 0 ? ` "${attrs.join(" ")}"` : "";
      return `\n\n![${alt}](${src}${title})\n\n`;
    },
  });

  td.addRule("taskListItem", {
    filter: (node) =>
      node.nodeName === "LI" &&
      node.getAttribute("data-type") === "taskItem",
    replacement: (content, node) => {
      const checked = (node as HTMLElement).getAttribute("data-checked") === "true";
      return `${checked ? "- [x]" : "- [ ]"} ${content.trim()}\n`;
    },
  });

  return td;
}

async function uploadFile(file: File, slug?: string): Promise<string | null> {
  const formData = new FormData();
  formData.append("file", file);
  if (slug) formData.append("slug", slug);

  try {
    const res = await fetch("/api/assets/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json();
      console.error("Upload failed:", err.error);
      return null;
    }
    const { url, commitSha } = await res.json();
    return commitSha ? `${url}?ref=${commitSha}` : url;
  } catch (e) {
    console.error("Upload error:", e);
    return null;
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function MarkdownEditor({
  value,
  onChange,
  name,
  initialHtml,
  slug,
}: {
  value: string;
  onChange: (val: string) => void;
  name: string;
  initialHtml?: string;
  /** Upload pasted/dropped images under content/assets/<slug>/. */
  slug?: string;
}) {
  const [tab, setTab] = useState<"write" | "raw">("write");
  const [htmlReady, setHtmlReady] = useState(!!initialHtml);
  const [editorHtml, setEditorHtml] = useState(initialHtml ?? "");
  const [uploading, setUploading] = useState(0);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const turndown = useMemo(() => createTurndown(), []);

  useEffect(() => {
    if (initialHtml || !value) {
      setHtmlReady(true);
      return;
    }
    fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: value,
    })
      .then((r) => r.text())
      .then((html) => {
        setEditorHtml(html);
        setHtmlReady(true);
      })
      .catch(() => setHtmlReady(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const insertImage = useCallback(
    (editorInstance: ReturnType<typeof useEditor>, url: string) => {
      if (!editorInstance) return;
      editorInstance.chain().focus().setImage({ src: url }).run();
    },
    []
  );

  const handleFileUpload = useCallback(
    async (files: FileList | File[], editorInstance: ReturnType<typeof useEditor>) => {
      if (!editorInstance) return;

      const imageFiles = Array.from(files).filter(isImageFile);
      if (imageFiles.length === 0) return;

      setUploading((n) => n + imageFiles.length);

      for (const file of imageFiles) {
        const url = await uploadFile(file, slug);
        if (url) {
          insertImage(editorInstance, url);
        }
        setUploading((n) => n - 1);
      }
    },
    [insertImage, slug]
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          codeBlock: false,
        }),
        CodeBlockLowlight.configure({
          lowlight,
          defaultLanguage: null,
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { class: "text-brand-600 underline" },
        }),
        ResizableImage,
        Placeholder.configure({
          placeholder: "Start writing...",
        }),
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
      ],
      content: editorHtml,
      editable: true,
      immediatelyRender: false,
      editorProps: {
        handleDrop: (view, event) => {
          const files = event.dataTransfer?.files;
          if (files && files.length > 0 && Array.from(files).some(isImageFile)) {
            event.preventDefault();
            handleFileUpload(files, editor);
            return true;
          }
          return false;
        },
        handlePaste: (view, event) => {
          const files = event.clipboardData?.files;
          if (files && files.length > 0 && Array.from(files).some(isImageFile)) {
            event.preventDefault();
            handleFileUpload(files, editor);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const html = ed.getHTML();
        const md = turndown.turndown(html);
        onChange(md);
      },
    },
    [htmlReady, editorHtml]
  );

  const handleRawChange = useCallback(
    (rawValue: string) => {
      onChange(rawValue);
    },
    [onChange]
  );

  const switchToWrite = useCallback(() => {
    if (tab === "raw" && editor) {
      fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: value,
      })
        .then((r) => r.text())
        .then((html) => {
          editor.commands.setContent(html);
        })
        .catch(() => {});
    }
    setTab("write");
  }, [tab, editor, value]);

  const addLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("URL:");
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, [editor]);

  const addImageFromUrl = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Image URL:");
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
  }, [editor]);

  const addImageFromFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        handleFileUpload(files, editor);
      }
      // Reset so the same file can be selected again
      e.target.value = "";
    },
    [editor, handleFileUpload]
  );

  if (!htmlReady) {
    return (
      <div className="border border-gray-300 dark:border-gray-700 rounded-lg p-4 min-h-[400px] flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading editor...</p>
      </div>
    );
  }

  return (
    // Note: no overflow-hidden — it would trap the sticky toolbar below.
    <div className="border border-gray-300 dark:border-gray-700 rounded-lg">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Tab bar + toolbar — sticks below the dashboard header (h-14) on scroll. */}
      <div className="sticky top-14 z-20 rounded-t-lg border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200 dark:border-gray-800">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={switchToWrite}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                tab === "write"
                  ? "bg-brand-600 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              Write
            </button>
            <button
              type="button"
              onClick={() => setTab("raw")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                tab === "raw"
                  ? "bg-brand-600 text-white"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              Raw
            </button>
          </div>
          {uploading > 0 && (
            <span className="text-xs text-brand-600 dark:text-brand-200 animate-pulse">
              Uploading {uploading} file{uploading > 1 ? "s" : ""}...
            </span>
          )}
        </div>

        {/* Toolbar (write mode only) */}
        {tab === "write" && editor && (
          <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
            <ToolbarBtn
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title="Bold"
            >
              B
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title="Italic"
              className="italic"
            >
              I
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title="Strikethrough"
              className="line-through"
            >
              S
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
              title="Inline code"
            >
              {"</>"}
            </ToolbarBtn>
            <Sep />
            <ToolbarBtn
              active={editor.isActive("heading", { level: 1 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 1 }).run()
              }
              title="Heading 1"
            >
              H1
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("heading", { level: 2 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run()
              }
              title="Heading 2"
            >
              H2
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("heading", { level: 3 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 3 }).run()
              }
              title="Heading 3"
            >
              H3
            </ToolbarBtn>
            <Sep />
            <ToolbarBtn
              active={editor.isActive("bulletList")}
              onClick={() =>
                editor.chain().focus().toggleBulletList().run()
              }
              title="Bullet list"
            >
              UL
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("orderedList")}
              onClick={() =>
                editor.chain().focus().toggleOrderedList().run()
              }
              title="Numbered list"
            >
              OL
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("taskList")}
              onClick={() =>
                editor.chain().focus().toggleTaskList().run()
              }
              title="Task list"
            >
              {"[ ]"}
            </ToolbarBtn>
            <Sep />
            <ToolbarBtn
              active={editor.isActive("blockquote")}
              onClick={() =>
                editor.chain().focus().toggleBlockquote().run()
              }
              title="Blockquote"
            >
              {">"}
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("codeBlock")}
              onClick={() =>
                editor.chain().focus().toggleCodeBlock().run()
              }
              title="Code block"
            >
              {"```"}
            </ToolbarBtn>
            <ToolbarBtn
              active={false}
              onClick={() =>
                editor.chain().focus().setHorizontalRule().run()
              }
              title="Horizontal rule"
            >
              ---
            </ToolbarBtn>
            <Sep />
            <ToolbarBtn active={editor.isActive("link")} onClick={addLink} title="Link">
              Link
            </ToolbarBtn>
            <ToolbarBtn active={showImagePicker} onClick={() => setShowImagePicker((v) => !v)} title="Insert image">
              Img
            </ToolbarBtn>
          </div>
        )}

        {/* Image picker — kept inside the sticky bar so it stays directly below
            the toolbar as you scroll, instead of at its scrolled-away origin. */}
        {showImagePicker && tab === "write" && (
        <ImagePicker
          onSelect={(url) => {
            if (editor) {
              editor.chain().focus().setImage({ src: url }).run();
            }
            setShowImagePicker(false);
          }}
          onUpload={() => {
            fileInputRef.current?.click();
            setShowImagePicker(false);
          }}
          onUrlInsert={(url) => {
            if (editor) {
              editor.chain().focus().setImage({ src: url }).run();
            }
            setShowImagePicker(false);
          }}
          onClose={() => setShowImagePicker(false)}
        />
        )}
      </div>

      {/* Editor area */}
      {tab === "write" && editor && (
        <EditorContent
          editor={editor}
          className="prose max-w-none px-4 py-3 bg-white dark:bg-gray-950 min-h-[400px] rounded-b-lg focus-within:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror_pre]:bg-gray-900 [&_.ProseMirror_pre]:text-gray-100 [&_.ProseMirror_pre]:p-4 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_code]:bg-gray-100 [&_.ProseMirror_code]:dark:bg-gray-800 [&_.ProseMirror_code]:px-1.5 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:text-sm [&_.ProseMirror_code]:font-mono [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-brand-500 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:text-gray-500 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-gray-400 [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_ul[data-type=taskList]]:list-none [&_.ProseMirror_ul[data-type=taskList]]:pl-0 [&_.ProseMirror_ul[data-type=taskList]_li]:flex [&_.ProseMirror_ul[data-type=taskList]_li]:gap-2 [&_.ProseMirror_ul[data-type=taskList]_li_label]:mt-0.5 [&_.ProseMirror_hr]:my-6 [&_.ProseMirror_hr]:border-gray-300 [&_.ProseMirror_hr]:dark:border-gray-700 [&_.ProseMirror_img]:rounded-lg [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:my-4"
        />
      )}

      {tab === "raw" && (
        <textarea
          value={value}
          onChange={(e) => handleRawChange(e.target.value)}
          rows={24}
          spellCheck={false}
          className="w-full px-4 py-3 bg-white dark:bg-gray-950 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none resize-y min-h-[400px] rounded-b-lg"
        />
      )}

      <input type="hidden" name={name} value={value} />
    </div>
  );
}

interface AssetItem {
  name: string;
  url: string;
  size: number;
  commitSha: string;
}

function ImagePicker({
  onSelect,
  onUpload,
  onUrlInsert,
  onClose,
}: {
  onSelect: (url: string) => void;
  onUpload: () => void;
  onUrlInsert: (url: string) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [urlInput, setUrlInput] = useState("");
  const [activeTab, setActiveTab] = useState<"browse" | "url">("browse");

  useEffect(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then((data) => {
        setAssets(data.assets ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
  const isImage = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return imageExtensions.has(ext);
  };

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("browse")}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === "browse"
                ? "bg-brand-600 text-white"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
          >
            Browse Assets
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("url")}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === "url"
                ? "bg-brand-600 text-white"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
          >
            From URL
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm"
        >
          Close
        </button>
      </div>

      {activeTab === "browse" && (
        <>
          <button
            type="button"
            onClick={onUpload}
            className="mb-3 px-3 py-1.5 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg text-xs text-gray-600 dark:text-gray-400 hover:border-brand-500 hover:text-brand-600 transition-colors w-full"
          >
            + Upload new file
          </button>

          {loading ? (
            <p className="text-xs text-gray-400 text-center py-4">Loading assets...</p>
          ) : assets.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No assets uploaded yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
              {assets.map((asset) => (
                <button
                  key={asset.name}
                  type="button"
                  onClick={() => onSelect(
                    asset.commitSha
                      ? `${asset.url}?ref=${asset.commitSha}`
                      : asset.url
                  )}
                  className="group relative border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden hover:border-brand-500 transition-colors text-left"
                >
                  {isImage(asset.name) ? (
                    <img
                      src={asset.url}
                      alt={asset.name}
                      className="w-full h-20 object-cover"
                    />
                  ) : (
                    <div className="w-full h-20 bg-gray-100 dark:bg-gray-900 flex items-center justify-center">
                      <span className="text-xs text-gray-400 font-mono">
                        {asset.name.split(".").pop()?.toUpperCase()}
                      </span>
                    </div>
                  )}
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate px-1.5 py-1">
                    {asset.name}
                  </p>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === "url" && (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/image.png"
            className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlInput.trim()) {
                e.preventDefault();
                onUrlInsert(urlInput.trim());
              }
            }}
          />
          <button
            type="button"
            disabled={!urlInput.trim()}
            onClick={() => onUrlInsert(urlInput.trim())}
            className="px-3 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-40"
          >
            Insert
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({
  children,
  active,
  onClick,
  title,
  className = "",
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
        active
          ? "bg-brand-100 dark:bg-brand-700/30 text-brand-700 dark:text-brand-200"
          : "text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-gray-300 dark:bg-gray-700 mx-1" />;
}
