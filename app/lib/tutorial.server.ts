import matter from "gray-matter";
import type { ContentFrontmatter, ParsedContent } from "./markdown.server";

/** One chapter of a tutorial. `body` is markdown, rendered to HTML at serve time. */
export interface TutorialChapter {
  slug: string;
  title: string;
  body: string;
}

export interface ParsedTutorial extends ParsedContent {
  chapters: TutorialChapter[];
}

/** kebab-case a chapter title into a URL-safe slug. */
export function chapterSlugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse a `.tutorial` file: YAML frontmatter + a JSON body holding the ordered
 * chapter list. Mirrors `parsePage` (structured data in one file). `html` is
 * left empty — each chapter's markdown is rendered on demand when served.
 */
export function parseTutorial(raw: string): ParsedTutorial {
  const { data, content } = matter(raw);
  const body = content.trim();

  let chapters: TutorialChapter[] = [];
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.chapters)) {
        chapters = parsed.chapters
          .map((c: unknown) => {
            const ch = (c ?? {}) as Record<string, unknown>;
            return {
              slug: String(ch.slug ?? ""),
              title: String(ch.title ?? ""),
              body: String(ch.body ?? ""),
            };
          })
          .filter((c: TutorialChapter) => c.slug);
      }
    } catch {
      // Invalid JSON — treat as no chapters.
    }
  }

  return {
    frontmatter: {
      title: data.title ?? "Untitled",
      description: data.description,
      tags: data.tags,
      headerImage: data.headerImage,
      path: data.path,
      publishedAt: data.publishedAt,
      updatedAt: data.updatedAt,
      draft: data.draft ?? false,
      contentType: "tutorial",
      ...data,
    } as ContentFrontmatter,
    chapters,
    html: "",
    raw,
  };
}

/** Serialize a `.tutorial` file from frontmatter + chapters. */
export function buildTutorialRaw(
  frontmatter: Record<string, unknown>,
  chapters: TutorialChapter[]
): string {
  const fm = Object.entries(frontmatter)
    .filter(([k, v]) => v !== undefined && v !== null && v !== "" && k !== "contentType")
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}: [${v.map((i) => `"${i}"`).join(", ")}]`;
      }
      if (typeof v === "boolean") return `${k}: ${v}`;
      return `${k}: "${v}"`;
    })
    .join("\n");

  const normalized = normalizeChapters(chapters);
  const body = JSON.stringify({ chapters: normalized }, null, 2);

  return `---\n${fm}\ncontentType: tutorial\n---\n\n${body}`;
}

/**
 * Clean up an incoming chapter list: coerce fields, derive a slug from the
 * title when missing, and de-duplicate slugs (append -2, -3, …).
 */
export function normalizeChapters(chapters: TutorialChapter[]): TutorialChapter[] {
  const seen = new Set<string>();
  const out: TutorialChapter[] = [];
  chapters.forEach((c, i) => {
    const title = (c.title ?? "").trim() || `Chapter ${i + 1}`;
    let slug = (c.slug ?? "").trim() || chapterSlugify(title) || `chapter-${i + 1}`;
    let base = slug;
    let n = 2;
    while (seen.has(slug)) slug = `${base}-${n++}`;
    seen.add(slug);
    out.push({ slug, title, body: c.body ?? "" });
  });
  return out;
}

/** Parse a chapters JSON string coming from the editor form. Never throws. */
export function parseChaptersJson(json: unknown): TutorialChapter[] {
  if (typeof json !== "string" || !json.trim()) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return normalizeChapters(
      arr.map((c: unknown) => {
        const ch = (c ?? {}) as Record<string, unknown>;
        return {
          slug: String(ch.slug ?? ""),
          title: String(ch.title ?? ""),
          body: String(ch.body ?? ""),
        };
      })
    );
  } catch {
    return [];
  }
}
