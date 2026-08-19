import { listPageIndex } from "~/lib/page-index.server";
import { getGitHubConfig } from "~/lib/github.server";
import { getSettings } from "~/lib/settings.server";
import { normalizeUrlPath } from "~/lib/content.server";

/**
 * GET /llms.txt — a curated map of the site for language models.
 *
 * Follows the llmstxt.org convention: an H1 for the site, a blockquote summary,
 * then linked sections. Generated from the published page index so it cannot
 * drift from what is actually live.
 */
export async function loader({ request }: { request: Request }) {
  const { settings } = await getSettings();
  const configured = typeof settings.siteUrl === "string" ? settings.siteUrl : "";
  const origin = (configured || new URL(request.url).origin).replace(/\/+$/, "");
  const siteName = typeof settings.siteName === "string" ? settings.siteName : "Site";

  let lines: string[] = [];
  try {
    const pages = await listPageIndex(getGitHubConfig().publishBranch);
    const seen = new Set<string>();
    const rows = pages
      .filter((p) => !p.draft)
      .map((p) => ({ ...p, url: normalizeUrlPath(p.path) }))
      .filter((p) => {
        if (!p.url || seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
      })
      .sort((a, b) => (a.url as string).localeCompare(b.url as string));

    for (const r of rows) {
      const desc = (r.description || "").replace(/\s+/g, " ").trim();
      lines.push(`- [${r.title}](${origin}${r.url})${desc ? `: ${desc}` : ""}`);
    }
  } catch {
    lines = [`- [${siteName}](${origin}/)`];
  }

  const body = `# ${siteName}

> Self-hostable developer infrastructure. Every tool runs on your own hardware,
> stores data in formats you can read, and can be taken elsewhere at any time.

## Pages

${lines.join("\n")}

## Notes

- All content is server-rendered; no JavaScript is required to read it.
- Product source and documentation are linked from each product page.
- Full URL list: ${origin}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
