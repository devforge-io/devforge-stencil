import { listPageIndex } from "~/lib/page-index.server";
import { getGitHubConfig } from "~/lib/github.server";
import { getSettings } from "~/lib/settings.server";
import { normalizeUrlPath } from "~/lib/content.server";

/**
 * GET /sitemap.xml — every published page that has been assigned a public path.
 *
 * Built from the page index on the publish branch, which is one repo read rather
 * than a listing plus a read per file. Pages with no `path` frontmatter are not
 * reachable publicly, so they are omitted.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function loader({ request }: { request: Request }) {
  const { settings } = await getSettings();
  const configured = typeof settings.siteUrl === "string" ? settings.siteUrl : "";
  const origin = (configured || new URL(request.url).origin).replace(/\/+$/, "");

  let entries: Array<{ loc: string; lastmod?: string }> = [];
  try {
    const pages = await listPageIndex(getGitHubConfig().publishBranch);
    const seen = new Set<string>();
    for (const p of pages) {
      if (p.draft) continue;
      const path = normalizeUrlPath(p.path);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      entries.push({ loc: origin + path, lastmod: p.updatedAt || p.publishedAt });
    }
  } catch {
    // A sitemap that 500s is worse than a sparse one; fall back to the home page.
    entries = [{ loc: origin + "/" }];
  }

  entries.sort((a, b) => a.loc.localeCompare(b.loc));

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) =>
      `  <url><loc>${xmlEscape(e.loc)}</loc>${
        e.lastmod ? `<lastmod>${xmlEscape(e.lastmod)}</lastmod>` : ""
      }</url>`,
  )
  .join("\n")}
</urlset>`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
