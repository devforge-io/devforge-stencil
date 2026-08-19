import { getPublishedContentByPath, getPageCompiledCss } from "./content.server";

/**
 * The site's header and footer, lifted from a published CMS page.
 *
 * Hand-written React routes (the tools) still need to look like the rest of the
 * site, but the chrome lives in the CMS as inlined component HTML and its styling
 * lives in each page's compiled CSS. Rather than reimplementing either in React
 * and letting the two drift, this reads the real markup and the real stylesheet.
 *
 * Nothing here is fatal: if the CMS is unreachable the caller renders without
 * chrome rather than failing the page.
 */

export type SiteChrome = {
  headerHtml: string;
  footerHtml: string;
  css: string;
};

const EMPTY: SiteChrome = { headerHtml: "", footerHtml: "", css: "" };

/** Slice out a whole top-level element by tag name. */
function extractElement(html: string, tag: string): string {
  const open = html.indexOf(`<${tag}`);
  if (open === -1) return "";
  const close = html.indexOf(`</${tag}>`);
  if (close === -1 || close < open) return "";
  return html.slice(open, close + tag.length + 3);
}

/**
 * Paths tried in order. `/` is last because it always exists, but its stylesheet
 * is the largest; a lighter page that carries the same chrome is preferred.
 */
const CHROME_SOURCES = ["/tools", "/products", "/"];

export async function getSiteChrome(): Promise<SiteChrome> {
  for (const path of CHROME_SOURCES) {
    try {
      const page = await getPublishedContentByPath(path);
      if (!page) continue;

      const html = (page as { html?: string }).html ?? "";
      const headerHtml = extractElement(html, "header");
      const footerHtml = extractElement(html, "footer");
      if (!headerHtml && !footerHtml) continue;

      // The compiled stylesheet is authoritative; the inline one is the fallback.
      const compiled = await getPageCompiledCss(page.slug).catch(() => null);
      const css = compiled || (page as { css?: string }).css || "";

      return { headerHtml, footerHtml, css };
    } catch {
      // Try the next source.
    }
  }
  return EMPTY;
}
