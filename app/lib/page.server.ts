import matter from "gray-matter";
import type { ContentFrontmatter, ParsedContent } from "./markdown.server";

export interface ParsedPage extends ParsedContent {
  projectData: string; // GrapesJS JSON for the editor
  css: string;
}

/**
 * Parse a .page file: frontmatter + GrapesJS project JSON body.
 *
 * The JSON body contains the full GrapesJS project data.
 * On save, the client sends both `projectData` (for re-editing)
 * and pre-rendered `html`+`css` (for serving).
 * Both are stored in the JSON body.
 */
export function parsePage(raw: string): ParsedPage {
  const { data, content } = matter(raw);
  const body = content.trim();

  let projectData = "{}";
  let html = "";
  let css = "";

  if (body) {
    try {
      const parsed = JSON.parse(body);
      projectData = body;
      html = parsed.html ?? "";
      css = parsed.css ?? "";
    } catch {
      // Invalid JSON — treat as empty
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
      contentType: "page",
      ...data,
    },
    projectData,
    html,
    css,
    raw,
  };
}

/**
 * Build the raw .page file content from parts.
 */
export function buildPageRaw(
  frontmatter: Record<string, unknown>,
  projectData: string,
  html: string,
  css: string
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

  const body = JSON.stringify(
    { ...JSON.parse(projectData || "{}"), html, css },
    null,
    2
  );

  return `---\n${fm}\ncontentType: page\n---\n\n${body}`;
}

/**
 * Render the optional page header image as a full-width banner that can be
 * prepended to the page body. Uses inline styles so it renders the same
 * whether or not a CSS framework is loaded. Returns "" when no image is set.
 */
export function renderHeaderImage(headerImage: unknown): string {
  if (typeof headerImage !== "string" || !headerImage.trim()) return "";
  const src = headerImage.trim().replace(/"/g, "&quot;");
  return `<img src="${src}" alt="" data-pb-header-image="true" style="display:block;width:100%;height:auto;object-fit:cover;">`;
}
