import { useState, useEffect, useCallback, useRef } from "react";

async function uploadFile(file: File): Promise<string | null> {
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/assets/upload", { method: "POST", body: formData });
    if (!res.ok) return null;
    const { url, commitSha } = await res.json();
    return commitSha ? `${url}?ref=${commitSha}` : url;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// HTML → Wikitext converter (client-side, for contenteditable round-trip)
// ---------------------------------------------------------------------------

function htmlToWikitext(container: HTMLElement): string {
  const parts: string[] = [];

  for (const child of Array.from(container.childNodes)) {
    parts.push(nodeToWiki(child));
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function nodeToWiki(node: Node): string {
  // Template blocks — stored as data attribute, return verbatim
  if (node.nodeType === 1) {
    const el = node as HTMLElement;
    const tpl = el.getAttribute("data-wiki-tpl");
    if (tpl) return tpl + "\n\n";
  }

  // References section — skip (regenerated from refs in body)
  if (node.nodeType === 1 && (node as HTMLElement).classList.contains("wiki-references")) return "";

  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const kids = () => Array.from(el.childNodes).map(nodeToWiki).join("");

  switch (tag) {
    case "h1": return `= ${kids().trim()} =\n\n`;
    case "h2": return `== ${kids().trim()} ==\n\n`;
    case "h3": return `=== ${kids().trim()} ===\n\n`;
    case "h4": return `==== ${kids().trim()} ====\n\n`;
    case "h5": return `===== ${kids().trim()} =====\n\n`;
    case "h6": return `====== ${kids().trim()} ======\n\n`;
    case "p": return `${kids()}\n\n`;
    case "strong": case "b": return `'''${kids()}'''`;
    case "em": case "i": return `''${kids()}''`;
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = kids();
      if (el.classList.contains("wiki-link")) {
        return text === href.replace(/_/g, " ") ? `[[${href}]]` : `[[${href}|${text}]]`;
      }
      return text === href ? `[${href}]` : `[${href} ${text}]`;
    }
    case "sup": {
      if (el.classList.contains("wiki-cite")) {
        const isSelfClose = el.getAttribute("data-ref-selfclose") === "true";
        const refText = el.getAttribute("data-ref-text");
        const refName = el.getAttribute("data-ref-name");
        // Self-closing ref: <ref name="x" />
        if (isSelfClose && refName) return `<ref name="${refName}" />`;
        // Full ref: <ref name="x">content</ref> or <ref>content</ref>
        if (refText) {
          const nameAttr = refName ? ` name="${refName}"` : "";
          return `<ref${nameAttr}>${refText}</ref>`;
        }
        if (refName) return `<ref name="${refName}" />`;
        return "";
      }
      return `<sup>${kids()}</sup>`;
    }
    case "ul": return Array.from(el.children).map((li) => `* ${nodeToWiki(li).trim()}\n`).join("") + "\n";
    case "ol": return Array.from(el.children).map((li) => `# ${nodeToWiki(li).trim()}\n`).join("") + "\n";
    case "li": return kids();
    case "blockquote": return `: ${kids().trim()}\n\n`;
    case "hr": return "----\n\n";
    case "br": return "\n";
    case "pre": return `<pre>${el.textContent ?? ""}</pre>\n\n`;
    case "code": {
      if (el.parentElement?.tagName.toLowerCase() === "pre") return el.textContent ?? "";
      return `<nowiki>${el.textContent ?? ""}</nowiki>`;
    }
    case "figure": {
      const img = el.querySelector("img");
      if (!img) return kids();
      return nodeToWiki(img);
    }
    case "img": {
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      const onerror = el.getAttribute("onerror") ?? "";
      // Extract filename: local /api/assets/X or just use src
      let filename = src;
      if (src.includes("/api/assets/")) filename = decodeURIComponent(src.split("/api/assets/")[1]?.split('"')[0] ?? src);
      const options: string[] = [];
      if (el.classList.contains("wiki-thumb")) options.push("thumb");
      if (alt) options.push(alt);
      const optStr = options.length ? "|" + options.join("|") : "";
      return `[[File:${filename}${optStr}]]`;
    }
    case "figcaption": return "";
    case "aside": {
      const tpl = el.getAttribute("data-wiki-tpl");
      if (tpl) return tpl + "\n\n";
      return "";
    }
    case "div": {
      if (el.classList.contains("wiki-short-description") || el.classList.contains("wiki-references")) {
        const tpl = el.getAttribute("data-wiki-tpl");
        if (tpl) return tpl + "\n";
        return "";
      }
      return kids();
    }
    case "dl": return kids();
    case "dt": return `; ${kids().trim()}\n`;
    case "dd": return `: ${kids().trim()}\n`;
    case "table": return ""; // tables in body are complex; skip for now
    case "span": {
      if (el.classList.contains("wiki-template")) {
        const tpl = el.getAttribute("data-wiki-tpl");
        return tpl ?? `{{${el.textContent ?? ""}}}`;
      }
      return kids();
    }
    case "time": return kids();
    default: return kids();
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WikipediaEditor({
  value,
  onChange,
  name,
  initialHtml,
}: {
  value: string;
  onChange: (val: string) => void;
  name: string;
  initialHtml?: string;
}) {
  const [tab, setTab] = useState<"write" | "raw">("write");
  const [previewHtml, setPreviewHtml] = useState(initialHtml ?? "");
  const [uploading, setUploading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const updatingFromPreview = useRef(false);
  const updatingFromSource = useRef(false);

  // Fetch rendered preview from server
  const fetchPreview = useCallback((wikitext: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetch("/api/preview-wiki", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: wikitext,
      })
        .then((r) => r.text())
        .then((html) => {
          if (!updatingFromPreview.current) {
            setPreviewHtml(html);
          }
        })
        .catch(() => {});
    }, 500);
  }, []);

  // Initial preview
  useEffect(() => {
    if (!initialHtml && value) fetchPreview(value);
    else if (initialHtml) setPreviewHtml(initialHtml);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Source textarea changed → update preview
  const handleSourceChange = useCallback(
    (newValue: string) => {
      if (updatingFromPreview.current) return;
      updatingFromSource.current = true;
      onChange(newValue);
      fetchPreview(newValue);
      setTimeout(() => { updatingFromSource.current = false; }, 100);
    },
    [onChange, fetchPreview]
  );

  // Preview contenteditable changed → extract wikitext
  const handlePreviewInput = useCallback(() => {
    if (updatingFromSource.current || !previewRef.current) return;
    updatingFromPreview.current = true;
    const wikitext = htmlToWikitext(previewRef.current);
    onChange(wikitext);
    setTimeout(() => { updatingFromPreview.current = false; }, 100);
  }, [onChange]);

  // Floating toolbar — show/hide on selection
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Click-to-edit popover for links and citations
  const [editPopover, setEditPopover] = useState<{
    type: "link" | "citation";
    el: HTMLElement;
    x: number;
    y: number;
    href: string;
    text: string;
    isWiki: boolean;
    refText: string;
    refName: string;
    isSelfClose: boolean;
  } | null>(null);

  const handlePreviewClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // Click on a link (or child of a link)
    const link = target.closest("a.wiki-link, a.external") as HTMLAnchorElement | null;
    if (link && previewRef.current?.contains(link)) {
      e.preventDefault();
      const containerRect = previewRef.current.parentElement?.getBoundingClientRect();
      if (!containerRect) return;
      const rect = link.getBoundingClientRect();
      setEditPopover({
        type: "link",
        el: link,
        x: rect.left - containerRect.left,
        y: rect.bottom - containerRect.top + 4,
        href: link.getAttribute("href") ?? "",
        text: link.textContent ?? "",
        isWiki: link.classList.contains("wiki-link"),
        refText: "",
        refName: "",
        isSelfClose: false,
      });
      setToolbarPos(null);
      return;
    }

    // Click on a citation
    const cite = target.closest("sup.wiki-cite") as HTMLElement | null;
    if (cite && previewRef.current?.contains(cite)) {
      e.preventDefault();
      const containerRect = previewRef.current.parentElement?.getBoundingClientRect();
      if (!containerRect) return;
      const rect = cite.getBoundingClientRect();
      setEditPopover({
        type: "citation",
        el: cite,
        x: rect.left - containerRect.left,
        y: rect.bottom - containerRect.top + 4,
        href: "",
        text: "",
        isWiki: false,
        refText: cite.getAttribute("data-ref-text") ?? "",
        refName: cite.getAttribute("data-ref-name") ?? "",
        isSelfClose: cite.getAttribute("data-ref-selfclose") === "true",
      });
      setToolbarPos(null);
      return;
    }

    // Click elsewhere — close popover
    setEditPopover(null);
  }, []);

  const handlePopoverSave = useCallback((updates: { href?: string; text?: string; refText?: string; refName?: string }) => {
    if (!editPopover) return;
    const el = editPopover.el;

    if (editPopover.type === "link") {
      const a = el as HTMLAnchorElement;
      if (updates.href !== undefined) a.href = updates.href;
      if (updates.text !== undefined) a.textContent = updates.text;
    } else if (editPopover.type === "citation") {
      if (updates.refText !== undefined) el.setAttribute("data-ref-text", updates.refText);
      if (updates.refName !== undefined) {
        if (updates.refName) el.setAttribute("data-ref-name", updates.refName);
        else el.removeAttribute("data-ref-name");
      }
    }

    setEditPopover(null);
    handlePreviewInput();
  }, [editPopover, handlePreviewInput]);

  const handlePopoverRemove = useCallback(() => {
    if (!editPopover) return;
    const el = editPopover.el;

    if (editPopover.type === "link") {
      // Unwrap: replace <a> with its text content
      const text = document.createTextNode(el.textContent ?? "");
      el.parentNode?.replaceChild(text, el);
    } else if (editPopover.type === "citation") {
      el.parentNode?.removeChild(el);
    }

    setEditPopover(null);
    handlePreviewInput();
  }, [editPopover, handlePreviewInput]);

  const checkSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !previewRef.current?.contains(sel.anchorNode)) {
      setToolbarPos(null);
      setHasSelection(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const containerRect = previewRef.current.parentElement?.getBoundingClientRect();
    if (!containerRect) return;

    setToolbarPos({
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top - 44,
    });
    setHasSelection(true);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", checkSelection);
    return () => document.removeEventListener("selectionchange", checkSelection);
  }, [checkSelection]);

  // Toolbar actions
  const wrapSelection = useCallback((before: string, after: string) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    range.deleteContents();
    range.insertNode(document.createTextNode(before + text + after));
    sel.removeAllRanges();
    handlePreviewInput();
  }, [handlePreviewInput]);

  const addWikiLink = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    const target = window.prompt("Wiki page name:", text);
    if (!target) return;

    range.deleteContents();
    const a = document.createElement("a");
    a.href = target.replace(/\s+/g, "_");
    a.className = "wiki-link";
    a.textContent = text;
    a.setAttribute("contenteditable", "true");
    range.insertNode(a);
    sel.removeAllRanges();
    setToolbarPos(null);
    handlePreviewInput();
  }, [handlePreviewInput]);

  const addExtLink = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    const url = window.prompt("URL:", "https://");
    if (!url) return;

    range.deleteContents();
    const a = document.createElement("a");
    a.href = url;
    a.className = "external";
    a.rel = "nofollow";
    a.textContent = text;
    range.insertNode(a);
    sel.removeAllRanges();
    setToolbarPos(null);
    handlePreviewInput();
  }, [handlePreviewInput]);

  const addCitation = useCallback(() => {
    const sel = window.getSelection();
    const citation = window.prompt("Citation text:");
    if (!citation) return;

    const sup = document.createElement("sup");
    sup.className = "wiki-cite";
    sup.setAttribute("data-ref-text", citation);
    sup.innerHTML = `<a>[*]</a>`;

    if (sel && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      range.collapse(false);
      range.insertNode(sup);
    } else if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.insertNode(sup);
    }
    setToolbarPos(null);
    handlePreviewInput();
  }, [handlePreviewInput]);

  const toggleBold = useCallback(() => {
    document.execCommand("bold", false);
    handlePreviewInput();
  }, [handlePreviewInput]);

  const toggleItalic = useCallback(() => {
    document.execCommand("italic", false);
    handlePreviewInput();
  }, [handlePreviewInput]);

  // File upload
  const handleFileUpload = useCallback(
    async (files: FileList) => {
      const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      setUploading(true);
      for (const file of imageFiles) {
        const url = await uploadFile(file);
        if (url) {
          const fname = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
          handleSourceChange(value + `\n\n[[File:${fname}|thumb|${fname}]]`);
        }
      }
      setUploading(false);
    },
    [value, handleSourceChange]
  );

  const insertSourceSnippet = useCallback(
    (snippet: string) => {
      const ta = textareaRef.current;
      if (!ta) { handleSourceChange(value + snippet); return; }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = value.slice(0, start) + snippet + value.slice(end);
      handleSourceChange(newVal);
      requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + snippet.length; });
    },
    [value, handleSourceChange]
  );

  // Sync preview HTML when it changes from server
  useEffect(() => {
    if (!previewRef.current || !previewHtml) return;
    // Only update DOM if not currently editing the preview
    if (!updatingFromPreview.current) {
      // Save cursor position
      const sel = window.getSelection();
      const hadFocus = previewRef.current.contains(document.activeElement);

      previewRef.current.innerHTML = previewHtml;

      // Don't steal focus if user was typing in source
      if (!hadFocus && textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  }, [previewHtml]);

  return (
    <div className="border border-gray-300 dark:border-gray-700 rounded-lg overflow-hidden">
      <input ref={fileInputRef} type="file" accept="image/*" multiple
        onChange={(e) => { if (e.target.files) handleFileUpload(e.target.files); e.target.value = ""; }}
        className="hidden" />

      {/* Tab bar */}
      <div className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between px-2 py-1">
          <div className="flex gap-1">
            <TabBtn active={tab === "write"} onClick={() => setTab("write")}>Write</TabBtn>
            <TabBtn active={tab === "raw"} onClick={() => setTab("raw")}>Raw</TabBtn>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400 font-mono">wikitext</span>
            {uploading && <span className="text-xs text-blue-600 animate-pulse">Uploading...</span>}
          </div>
        </div>
      </div>

      {/* Write tab */}
      {tab === "write" && (
        <div className="flex flex-col">
          {/* Editable rendered preview */}
          <div className="relative bg-white dark:bg-gray-950 overflow-auto" style={{ minHeight: "400px" }}>
            {/* Floating selection toolbar */}
            {hasSelection && toolbarPos && (
              <div
                ref={toolbarRef}
                className="absolute z-50 flex items-center gap-0.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg shadow-lg px-1 py-0.5"
                style={{ left: `${toolbarPos.x}px`, top: `${toolbarPos.y}px`, transform: "translateX(-50%)" }}
              >
                <FloatingBtn onClick={toggleBold} title="Bold (''')">B</FloatingBtn>
                <FloatingBtn onClick={toggleItalic} title="Italic ('')" className="italic">I</FloatingBtn>
                <FloatingSep />
                <FloatingBtn onClick={addWikiLink} title="Wiki Link [[]]">Wiki</FloatingBtn>
                <FloatingBtn onClick={addExtLink} title="External Link []">URL</FloatingBtn>
                <FloatingSep />
                <FloatingBtn onClick={addCitation} title="Add Citation">Cite</FloatingBtn>
              </div>
            )}

            {/* Edit popover for links / citations */}
            {editPopover && (
              <EditPopover
                type={editPopover.type}
                x={editPopover.x}
                y={editPopover.y}
                href={editPopover.href}
                text={editPopover.text}
                isWiki={editPopover.isWiki}
                refText={editPopover.refText}
                refName={editPopover.refName}
                isSelfClose={editPopover.isSelfClose}
                onSave={handlePopoverSave}
                onRemove={handlePopoverRemove}
                onClose={() => setEditPopover(null)}
              />
            )}

            <div className="px-6 py-4">
              <article
                ref={previewRef}
                className="prose max-w-none wiki-content outline-none"
                contentEditable
                suppressContentEditableWarning
                onInput={handlePreviewInput}
                onClick={handlePreviewClick}
                onPaste={(e) => {
                  const files = e.clipboardData?.files;
                  if (files && files.length > 0 && Array.from(files).some((f) => f.type.startsWith("image/"))) {
                    e.preventDefault();
                    handleFileUpload(files);
                  }
                }}
              />
            </div>
          </div>

          {/* Source toolbar */}
          <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-t border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
            <span className="text-[10px] text-gray-400 mr-2">Source:</span>
            <ToolbarBtn onClick={() => insertSourceSnippet("'''bold'''")} title="Bold">B</ToolbarBtn>
            <ToolbarBtn onClick={() => insertSourceSnippet("''italic''")} title="Italic" className="italic">I</ToolbarBtn>
            <Sep />
            <ToolbarBtn onClick={() => insertSourceSnippet("\n== Heading ==\n")} title="Heading">H2</ToolbarBtn>
            <ToolbarBtn onClick={() => insertSourceSnippet("[[Link|text]]")} title="Wiki link">{"[[ ]]"}</ToolbarBtn>
            <ToolbarBtn onClick={() => insertSourceSnippet("[https://example.com text]")} title="External link">{"[ ]"}</ToolbarBtn>
            <ToolbarBtn onClick={() => insertSourceSnippet('<ref>Citation</ref>')} title="Citation">Cite</ToolbarBtn>
            <Sep />
            <ToolbarBtn onClick={() => fileInputRef.current?.click()} title="Upload image">Img</ToolbarBtn>
            <ToolbarBtn onClick={() => insertSourceSnippet("\n----\n")} title="Horizontal rule">----</ToolbarBtn>
          </div>

          {/* Source editor */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleSourceChange(e.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-900 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none resize-y min-h-[150px] border-0"
          />
        </div>
      )}

      {/* Raw tab */}
      {tab === "raw" && (
        <textarea
          value={value}
          onChange={(e) => handleSourceChange(e.target.value)}
          rows={30}
          spellCheck={false}
          className="w-full px-4 py-3 bg-white dark:bg-gray-950 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none resize-y min-h-[500px]"
          placeholder={"{{Infobox software\n| name = Example\n}}\n\n== Section ==\n\nText with '''bold''' and ''italic''.\n\n<ref>Citation</ref>"}
        />
      )}

      <input type="hidden" name={name} value={value} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
        active ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
      }`}
    >{children}</button>
  );
}

function ToolbarBtn({ onClick, title, children, className = "" }: {
  onClick: () => void; title: string; children: React.ReactNode; className?: string;
}) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={`px-2 py-1 rounded text-xs font-mono text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${className}`}
    >{children}</button>
  );
}

function FloatingBtn({ onClick, title, children, className = "" }: {
  onClick: () => void; title: string; children: React.ReactNode; className?: string;
}) {
  return (
    <button type="button" title={title} onClick={onClick}
      onMouseDown={(e) => e.preventDefault()} // prevent losing selection
      className={`px-2 py-1 rounded text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors ${className}`}
    >{children}</button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-gray-300 dark:bg-gray-700 mx-1" />;
}

function FloatingSep() {
  return <div className="w-px h-4 bg-gray-600 dark:bg-gray-400 mx-0.5" />;
}

function EditPopover({
  type,
  x,
  y,
  href,
  text,
  isWiki,
  refText,
  refName,
  isSelfClose,
  onSave,
  onRemove,
  onClose,
}: {
  type: "link" | "citation";
  x: number;
  y: number;
  href: string;
  text: string;
  isWiki: boolean;
  refText: string;
  refName: string;
  isSelfClose: boolean;
  onSave: (updates: { href?: string; text?: string; refText?: string; refName?: string }) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [localHref, setLocalHref] = useState(href);
  const [localText, setLocalText] = useState(text);
  const [localRefText, setLocalRefText] = useState(refText);
  const [localRefName, setLocalRefName] = useState(refName);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Clamp position so popover stays within its offset parent
  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const parentW = parent.clientWidth;
    const elW = el.offsetWidth;
    const currentLeft = el.offsetLeft;
    if (currentLeft + elW > parentW) {
      el.style.left = `${Math.max(8, parentW - elW - 8)}px`;
    }
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (type === "link") {
    return (
      <div
        ref={popoverRef}
        className="absolute z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 space-y-2"
        style={{ left: `${x}px`, top: `${y}px`, minWidth: "280px" }}
      >
        <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
          {isWiki ? "Wiki Link" : "External Link"}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs text-gray-500">{isWiki ? "Page name" : "URL"}</label>
          <input
            value={localHref}
            onChange={(e) => setLocalHref(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") { onSave({ href: localHref, text: localText }); }
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs text-gray-500">Display text</label>
          <input
            value={localText}
            onChange={(e) => setLocalText(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
            onKeyDown={(e) => {
              if (e.key === "Enter") { onSave({ href: localHref, text: localText }); }
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="flex items-center justify-between pt-1">
          <button type="button" onClick={onRemove}
            className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400">
            Remove link
          </button>
          <div className="flex gap-1">
            <button type="button" onClick={onClose}
              className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
              Cancel
            </button>
            <button type="button" onClick={() => onSave({ href: localHref, text: localText })}
              className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Self-closing ref — just show info, not editable
  if (isSelfClose) {
    return (
      <div
        ref={popoverRef}
        className="absolute z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 space-y-2"
        style={{ left: `${x}px`, top: `${y}px`, minWidth: "240px" }}
      >
        <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
          Citation Reference
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          References <code className="text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded font-mono">{refName}</code>
        </p>
        <p className="text-[10px] text-gray-400">
          This is a back-reference to a named citation defined elsewhere. Edit the original citation to change its content.
        </p>
        <div className="flex items-center justify-between pt-1">
          <button type="button" onClick={onRemove}
            className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400">
            Remove reference
          </button>
          <button type="button" onClick={onClose}
            className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            Close
          </button>
        </div>
      </div>
    );
  }

  // Citation editor — parse cite template fields
  const citeFields = parseCiteTemplate(localRefText);
  const isCiteTemplate = citeFields !== null;

  const saveCitation = useCallback(() => {
    if (isCiteTemplate && citeFields) {
      const rebuilt = buildCiteTemplate(citeFields);
      onSave({ refText: rebuilt, refName: localRefName });
    } else {
      onSave({ refText: localRefText, refName: localRefName });
    }
  }, [isCiteTemplate, citeFields, localRefText, localRefName, onSave]);

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 space-y-2 max-h-[60vh] overflow-y-auto"
      style={{ left: `${x}px`, top: `${y}px`, minWidth: "340px", maxWidth: "420px" }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
          Citation {isCiteTemplate ? `(${citeFields!.type})` : ""}
        </div>
        <div className="text-[10px] text-gray-400">
          {localRefName && <span className="font-mono">name="{localRefName}"</span>}
        </div>
      </div>

      {isCiteTemplate ? (
        <CiteFieldsEditor fields={citeFields!} onChange={(f) => {
          setLocalRefText(buildCiteTemplate(f));
        }} />
      ) : (
        <div className="space-y-1.5">
          <label className="block text-xs text-gray-500">Citation text</label>
          <textarea
            value={localRefText}
            onChange={(e) => setLocalRefText(e.target.value)}
            rows={3}
            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="block text-xs text-gray-500">Ref name (optional, for reuse)</label>
        <input
          value={localRefName}
          onChange={(e) => setLocalRefName(e.target.value)}
          placeholder="e.g. smith2024"
          className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
          onKeyDown={(e) => {
            if (e.key === "Enter") saveCitation();
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onRemove}
          className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400">
          Remove citation
        </button>
        <div className="flex gap-1">
          <button type="button" onClick={onClose}
            className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            Cancel
          </button>
          <button type="button" onClick={saveCitation}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cite template parser / builder / editor
// ---------------------------------------------------------------------------

interface CiteFields {
  type: string; // "Cite web", "Cite journal", etc.
  fields: Array<{ key: string; value: string }>;
}

const CITE_FIELD_ORDER = [
  "url", "title", "website", "work", "journal", "publisher",
  "author", "last", "first", "author2", "last2", "first2",
  "date", "year", "access-date", "accessdate",
  "language", "pages", "volume", "issue", "doi", "isbn", "issn",
  "archive-url", "archive-date", "url-status", "quote",
];

const CITE_FIELD_LABELS: Record<string, string> = {
  url: "URL",
  title: "Title",
  website: "Website",
  work: "Work",
  journal: "Journal",
  publisher: "Publisher",
  author: "Author",
  last: "Last name",
  first: "First name",
  author2: "Author 2",
  last2: "Last name 2",
  first2: "First name 2",
  date: "Date",
  year: "Year",
  "access-date": "Access date",
  accessdate: "Access date",
  language: "Language",
  pages: "Pages",
  volume: "Volume",
  issue: "Issue",
  doi: "DOI",
  isbn: "ISBN",
  issn: "ISSN",
  "archive-url": "Archive URL",
  "archive-date": "Archive date",
  "url-status": "URL status",
  quote: "Quote",
};

function parseCiteTemplate(raw: string): CiteFields | null {
  const m = raw.match(/^\{\{(Cite\s+\w+)(?:\s*\|[\s\S]*)?\}\}$/i);
  if (!m) return null;

  const inner = raw.slice(2, -2);
  // Split on | respecting nested {{ }}
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const c2 = i < inner.length - 1 ? inner[i + 1] : "";
    if (c === "{" && c2 === "{") { depth++; current += "{{"; i++; continue; }
    if (c === "}" && c2 === "}") { depth--; current += "}}"; i++; continue; }
    if (c === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);

  const type = parts[0].trim();
  const fields: Array<{ key: string; value: string }> = [];
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx > 0) {
      fields.push({ key: parts[i].slice(0, eqIdx).trim(), value: parts[i].slice(eqIdx + 1).trim() });
    }
  }

  // Sort known fields first, then unknown
  fields.sort((a, b) => {
    const ai = CITE_FIELD_ORDER.indexOf(a.key);
    const bi = CITE_FIELD_ORDER.indexOf(b.key);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });

  return { type, fields };
}

function buildCiteTemplate(cite: CiteFields): string {
  const params = cite.fields
    .filter((f) => f.value.trim())
    .map((f) => ` |${f.key} = ${f.value}`)
    .join("\n");
  return `{{${cite.type}\n${params}\n}}`;
}

function CiteFieldsEditor({ fields: initialFields, onChange }: {
  fields: CiteFields;
  onChange: (fields: CiteFields) => void;
}) {
  const [fields, setFields] = useState(initialFields.fields);
  const [newKey, setNewKey] = useState("");

  const update = useCallback((idx: number, value: string) => {
    const next = [...fields];
    next[idx] = { ...next[idx], value };
    setFields(next);
    onChange({ ...initialFields, fields: next });
  }, [fields, initialFields, onChange]);

  const remove = useCallback((idx: number) => {
    const next = fields.filter((_, i) => i !== idx);
    setFields(next);
    onChange({ ...initialFields, fields: next });
  }, [fields, initialFields, onChange]);

  const addField = useCallback(() => {
    if (!newKey.trim()) return;
    const next = [...fields, { key: newKey.trim(), value: "" }];
    setFields(next);
    onChange({ ...initialFields, fields: next });
    setNewKey("");
  }, [newKey, fields, initialFields, onChange]);

  return (
    <div className="space-y-1.5">
      {fields.map((f, i) => (
        <div key={`${f.key}-${i}`} className="flex gap-1.5 items-start group">
          <label className="text-[10px] text-gray-500 w-20 shrink-0 pt-1.5 text-right truncate" title={f.key}>
            {CITE_FIELD_LABELS[f.key] ?? f.key}
          </label>
          {f.key === "url" || f.key === "archive-url" ? (
            <input
              value={f.value}
              onChange={(e) => update(i, e.target.value)}
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              placeholder={`https://...`}
            />
          ) : (
            <input
              value={f.value}
              onChange={(e) => update(i, e.target.value)}
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}
          <button type="button" onClick={() => remove(i)}
            className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 text-xs pt-1">
            x
          </button>
        </div>
      ))}
      <div className="flex gap-1.5 items-center pt-1">
        <select
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="text-[10px] px-1.5 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400"
        >
          <option value="">+ Add field...</option>
          {CITE_FIELD_ORDER
            .filter((k) => !fields.some((f) => f.key === k))
            .map((k) => (
              <option key={k} value={k}>{CITE_FIELD_LABELS[k] ?? k}</option>
            ))}
        </select>
        {newKey && (
          <button type="button" onClick={addField}
            className="text-xs text-blue-600 hover:text-blue-800">
            Add
          </button>
        )}
      </div>
    </div>
  );
}
