import { getSettings } from "~/lib/settings.server";

/**
 * GET /robots.txt
 *
 * Everything public is crawlable, including by AI assistants: the site's whole
 * argument is that people can read and run this stuff, so gating the crawlers
 * that summarise it would be working against that. The dashboard, API and auth
 * routes are disallowed because they are app surface, not content.
 */
export async function loader({ request }: { request: Request }) {
  const { settings } = await getSettings();
  const configured = typeof settings.siteUrl === "string" ? settings.siteUrl : "";
  const origin = (configured || new URL(request.url).origin).replace(/\/+$/, "");

  const body = `# Every public page is open to crawlers, search and AI alike.
User-agent: *
Allow: /
Disallow: /content
Disallow: /api/
Disallow: /login
Disallow: /logout
Disallow: /settings
Disallow: /components

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
