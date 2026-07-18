import { useState } from "react";
import { MarkdownEditor } from "./markdown-editor";

export interface EditorChapter {
  slug: string;
  title: string;
  body: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function uniqueSlug(chapters: EditorChapter[], base: string, skipIndex = -1): string {
  const taken = new Set(chapters.filter((_, i) => i !== skipIndex).map((c) => c.slug));
  let slug = base || "chapter";
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

/**
 * Chapter manager for a tutorial: a reorderable chapter list on the left and a
 * markdown editor for the selected chapter on the right. Serializes the whole
 * chapter array to a hidden input (`name`) for form submission. The markdown
 * editor is remounted per chapter (via `key`) so it re-initializes cleanly.
 */
export function TutorialEditor({
  initialChapters,
  slug,
  name = "chapters",
}: {
  initialChapters: EditorChapter[];
  slug: string;
  name?: string;
}) {
  const [chapters, setChapters] = useState<EditorChapter[]>(
    initialChapters.length
      ? initialChapters
      : [{ slug: "introduction", title: "Introduction", body: "" }]
  );
  const [active, setActive] = useState(0);
  const current = chapters[Math.min(active, chapters.length - 1)];

  const patch = (i: number, p: Partial<EditorChapter>) =>
    setChapters((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  const renameChapter = (i: number, title: string) =>
    setChapters((cs) =>
      cs.map((c, idx) =>
        idx === i ? { ...c, title, slug: uniqueSlug(cs, slugify(title), i) } : c
      )
    );

  const addChapter = () =>
    setChapters((cs) => {
      const title = `Chapter ${cs.length + 1}`;
      const next = [...cs, { slug: uniqueSlug(cs, slugify(title)), title, body: "" }];
      setActive(next.length - 1);
      return next;
    });

  const removeChapter = (i: number) =>
    setChapters((cs) => {
      if (cs.length <= 1) return cs;
      const next = cs.filter((_, idx) => idx !== i);
      setActive((a) => Math.max(0, Math.min(a >= i ? a - 1 : a, next.length - 1)));
      return next;
    });

  const move = (i: number, dir: -1 | 1) =>
    setChapters((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      setActive(j);
      return next;
    });

  return (
    <div className="flex gap-4 items-start">
      <input type="hidden" name={name} value={JSON.stringify(chapters)} />

      {/* Chapter list */}
      <div className="w-60 shrink-0 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          Chapters
        </div>
        <ol className="p-1.5 space-y-0.5">
          {chapters.map((c, i) => (
            <li key={i}>
              <div
                className={`group flex items-center gap-1 rounded px-2 py-1.5 text-sm cursor-pointer ${
                  i === active
                    ? "bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
                onClick={() => setActive(i)}
              >
                <span className="text-xs text-gray-400 tabular-nums w-4">{i + 1}</span>
                <span className="flex-1 truncate">{c.title || c.slug}</span>
                <span className="flex items-center opacity-0 group-hover:opacity-100">
                  <button type="button" title="Move up" disabled={i === 0}
                    onClick={(e) => { e.stopPropagation(); move(i, -1); }}
                    className="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30">↑</button>
                  <button type="button" title="Move down" disabled={i === chapters.length - 1}
                    onClick={(e) => { e.stopPropagation(); move(i, 1); }}
                    className="px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30">↓</button>
                  <button type="button" title="Delete" disabled={chapters.length <= 1}
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete chapter "${c.title || c.slug}"?`)) removeChapter(i); }}
                    className="px-1 text-gray-400 hover:text-red-600 disabled:opacity-30">×</button>
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="p-1.5 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={addChapter}
            className="w-full text-sm px-2 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 transition-colors"
          >
            + Add chapter
          </button>
        </div>
      </div>

      {/* Active chapter editor */}
      <div className="flex-1 min-w-0 space-y-2">
        <div>
          <label className="block text-xs font-medium mb-1 text-gray-600 dark:text-gray-400">
            Chapter title
          </label>
          <input
            value={current.title}
            onChange={(e) => renameChapter(active, e.target.value)}
            placeholder="Chapter title"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            URL: <code className="bg-muted px-1 rounded">/tutorial/{slug || "…"}/{current.slug}</code>
          </p>
        </div>
        <MarkdownEditor
          key={active}
          value={current.body}
          onChange={(v) => patch(active, { body: v })}
          name="_chapterBody"
          slug={slug}
        />
      </div>
    </div>
  );
}
