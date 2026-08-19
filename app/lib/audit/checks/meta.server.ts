/**
 * Meta-tag checks: everything that lives in the document head and controls how
 * search engines title, describe, index and canonicalise the page.
 *
 * Self-contained by design - no shared helpers, so this module can evolve
 * independently of its sibling check modules.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

const TITLE_MIN = 20;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function truncate(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Trimmed value of a `<meta name>` entry, or null when absent/blank-only. */
function metaName(ctx: PageContext, key: string): string | null {
  const raw = ctx.doc.metaByName[key];
  if (typeof raw !== "string") return null;
  return raw.trim().length > 0 ? raw.trim() : "";
}

/** True when the meta tag exists at all, even with empty content. */
function metaPresent(ctx: PageContext, key: string): boolean {
  return typeof ctx.doc.metaByName[key] === "string";
}

function duplicateCount(ctx: PageContext, key: string): number {
  const raw = ctx.doc.metaDuplicates[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function safeUrl(value: string, base?: string): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Loose URL equality: ignores a trailing slash and the fragment. */
function sameUrl(a: string, b: string): boolean {
  const ua = safeUrl(a);
  const ub = safeUrl(b);
  if (!ua || !ub) return false;
  return (
    ua.origin.toLowerCase() === ub.origin.toLowerCase() &&
    stripTrailingSlash(ua.pathname) === stripTrailingSlash(ub.pathname) &&
    ua.search === ub.search
  );
}

/** Split a robots value into individual lowercase directive tokens. */
function robotsTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Directives that legitimately carry a `key:value` payload. */
const VALUED_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

/**
 * Parse an `X-Robots-Tag` header, which may carry per-user-agent groups such as
 * `googlebot: noindex, nofollow`. Returns the flattened directive tokens.
 */
function parseXRobotsTag(header: string): string[] {
  const tokens: string[] = [];
  for (const part of header.split(",")) {
    const chunk = part.trim();
    if (chunk.length === 0) continue;
    const match = /^([a-z0-9_*-]+)\s*:\s*(.+)$/i.exec(chunk);
    if (match && !VALUED_DIRECTIVES.has(match[1].toLowerCase())) {
      tokens.push(...robotsTokens(match[2]));
      continue;
    }
    tokens.push(...robotsTokens(chunk));
  }
  return tokens;
}

/** Rough BCP-47 shape check: `en`, `en-AU`, `zh-Hans`, `sr-Latn-RS`. */
function looksLikeLangTag(value: string): boolean {
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value.trim());
}

function hostVariants(origin: string): string[] {
  const url = safeUrl(origin);
  if (!url) return [];
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^www\./, "");
  const label = bare.split(".")[0] ?? bare;
  return Array.from(new Set([host, bare, label, `www.${bare}`]));
}

/* -------------------------------------------------------------------------- */
/* Check                                                                       */
/* -------------------------------------------------------------------------- */

export function metaChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;

  /* ---------------------------------------------------------------------- */
  /* <title>                                                                 */
  /* ---------------------------------------------------------------------- */

  const rawTitle = doc.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : null;

  if (rawTitle === null) {
    findings.push({
      id: "meta-title-missing",
      category: "meta",
      severity: "critical",
      title: "No <title> tag",
      detail:
        "The page has no <title> element. Search engines will invent a title from on-page text or the URL, and browser tabs, bookmarks and shared links all fall back to the bare address.",
      fix: `Add a <title> to the head, 50-60 characters, leading with the page's primary topic and ending with the brand - e.g. "Primary Topic - Brand".`,
      snippet: `<title>Primary Topic - ${hostVariants(ctx.origin)[1] ?? "Your Brand"}</title>`,
      docs: "https://developers.google.com/search/docs/appearance/title-link",
      weight: 5,
    });
  } else if (title !== null && title.length === 0) {
    findings.push({
      id: "meta-title-empty",
      category: "meta",
      severity: "critical",
      title: "Empty <title> tag",
      detail:
        "A <title> element is present but contains no text, which is functionally identical to having no title at all.",
      value: "<title></title>",
      fix: "Put 50-60 characters of descriptive text inside the existing <title> element, leading with the page's primary topic.",
      snippet: `<title>Primary Topic - ${hostVariants(ctx.origin)[1] ?? "Your Brand"}</title>`,
      docs: "https://developers.google.com/search/docs/appearance/title-link",
      weight: 5,
    });
  } else if (title !== null) {
    if (title.length < TITLE_MIN) {
      findings.push({
        id: "meta-title-short",
        category: "meta",
        severity: "warning",
        title: "Title is too short",
        detail: `The title is ${title.length} characters. Under ${TITLE_MIN} characters there is rarely enough room for both the page topic and the brand, and you leave free space in the search result unused.`,
        value: title,
        fix: `Expand to 50-60 characters by adding the specific topic, qualifier or location this page covers, then the brand after a separator.`,
        snippet: `<title>${title} - What This Page Covers</title>`,
        docs: "https://developers.google.com/search/docs/appearance/title-link",
        weight: 2,
      });
    } else if (title.length > TITLE_MAX) {
      findings.push({
        id: "meta-title-long",
        category: "meta",
        severity: "warning",
        title: "Title is too long and will be truncated",
        detail: `The title is ${title.length} characters. Google truncates title links at roughly 600px (about ${TITLE_MAX} characters), so the tail - usually the brand name - gets cut off with an ellipsis.`,
        value: title,
        fix: `Cut to ${TITLE_MAX} characters or fewer. Front-load the words that matter: everything after the first ~60 characters is invisible in the SERP.`,
        snippet: `<title>${truncate(title, TITLE_MAX)}</title>`,
        docs: "https://developers.google.com/search/docs/appearance/title-link",
        weight: 2,
      });
    } else {
      findings.push({
        id: "meta-title-ok",
        category: "meta",
        severity: "pass",
        title: "Title length is in the sweet spot",
        detail: `The <title> is ${title.length} characters, which renders in full in Google's title link without truncation.`,
        value: title,
        weight: 2,
      });
    }

    const titleDupes = duplicateCount(ctx, "title");
    if (titleDupes > 0) {
      findings.push({
        id: "meta-title-duplicate",
        category: "meta",
        severity: "warning",
        title: "More than one <title> tag",
        detail: `${titleDupes + 1} <title> elements were found. Browsers and crawlers keep the first and discard the rest, so whichever one you actually wrote for search may be the one being thrown away.`,
        value: title,
        fix: "Delete every <title> but one. This usually means a layout template and a page template are both emitting a title - let the page-level one win.",
        docs: "https://developers.google.com/search/docs/appearance/title-link",
        weight: 3,
      });
    }

    const normalisedTitle = title.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (hostVariants(ctx.origin).includes(normalisedTitle)) {
      findings.push({
        id: "meta-title-is-domain",
        category: "meta",
        severity: "warning",
        title: "Title is just the domain name",
        detail:
          "The title is nothing but the site's own domain. It tells a searcher nothing about what this particular page offers and wastes the single highest-impact ranking and click-through element on the page.",
        value: title,
        fix: "Replace it with a description of this page's content, then the brand - e.g. \"Managed Kubernetes Hosting - Brand\" rather than \"brand.com\".",
        docs: "https://developers.google.com/search/docs/appearance/title-link",
        weight: 3,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* <meta name="description">                                               */
  /* ---------------------------------------------------------------------- */

  const description = metaName(ctx, "description");
  const suggestedDescription = doc.textContent.trim().length > 0 ? truncate(doc.textContent, 155) : "A concise, benefit-led summary of what this page offers, in about 150 characters.";

  if (description === null) {
    findings.push({
      id: "meta-description-missing",
      category: "meta",
      severity: "warning",
      title: "No meta description",
      detail:
        "There is no <meta name=\"description\">. Google will splice together a snippet from whatever body text it thinks is relevant, which is often navigation copy, boilerplate or a half-sentence fragment.",
      fix: `Add a 140-160 character description that states what the page delivers and includes the terms a searcher would actually type. Write it as ad copy, not as a keyword list.`,
      snippet: `<meta name="description" content="${suggestedDescription}">`,
      docs: "https://developers.google.com/search/docs/appearance/snippet",
      weight: 4,
    });
  } else if (description.length === 0) {
    findings.push({
      id: "meta-description-empty",
      category: "meta",
      severity: "warning",
      title: "Meta description is empty",
      detail:
        "The description tag exists but its content attribute is blank, so it has exactly the same effect as omitting the tag - usually a sign of a template variable that never got filled in.",
      value: '<meta name="description" content="">',
      fix: "Populate the content attribute with 140-160 characters describing this specific page, and check the template that renders it for an unset variable.",
      snippet: `<meta name="description" content="${suggestedDescription}">`,
      docs: "https://developers.google.com/search/docs/appearance/snippet",
      weight: 4,
    });
  } else {
    if (description.length < DESC_MIN) {
      findings.push({
        id: "meta-description-short",
        category: "meta",
        severity: "warning",
        title: "Meta description is too short",
        detail: `The description is ${description.length} characters. Below ${DESC_MIN} you are giving up most of the roughly 160 characters Google will happily display, and short descriptions are more likely to be discarded in favour of an auto-generated snippet.`,
        value: description,
        fix: "Extend to 140-160 characters: add the concrete outcome, the differentiator, or a call to action that suits the page.",
        docs: "https://developers.google.com/search/docs/appearance/snippet",
        weight: 2,
      });
    } else if (description.length > DESC_MAX) {
      findings.push({
        id: "meta-description-long",
        category: "meta",
        severity: "warning",
        title: "Meta description will be truncated",
        detail: `The description is ${description.length} characters. Desktop results cut off around ${DESC_MAX} characters and mobile sooner, so the closing thought - often the call to action - never reaches the searcher.`,
        value: description,
        fix: `Trim to ${DESC_MAX} characters or fewer and move the most persuasive clause to the front.`,
        snippet: `<meta name="description" content="${truncate(description, DESC_MAX)}">`,
        docs: "https://developers.google.com/search/docs/appearance/snippet",
        weight: 2,
      });
    } else {
      findings.push({
        id: "meta-description-ok",
        category: "meta",
        severity: "pass",
        title: "Meta description is a good length",
        detail: `The description is ${description.length} characters, which displays in full in a typical desktop search result.`,
        value: description,
        weight: 2,
      });
    }

    if (title !== null && title.length > 0 && description.toLowerCase() === title.toLowerCase()) {
      findings.push({
        id: "meta-description-same-as-title",
        category: "meta",
        severity: "info",
        title: "Description duplicates the title",
        detail:
          "The meta description is identical to the <title>. The snippet repeats the headline instead of expanding on it, so the result occupies two lines to say one thing.",
        value: description,
        fix: "Rewrite the description to add information the title does not carry: what the page delivers, who it is for, and why to click.",
        weight: 1,
      });
    }
  }

  const descriptionDupes = duplicateCount(ctx, "description");
  if (descriptionDupes > 0) {
    findings.push({
      id: "meta-description-duplicate",
      category: "meta",
      severity: "warning",
      title: "Multiple meta description tags",
      detail: `${descriptionDupes + 1} description tags were found in the head. Crawlers pick one without telling you which, so the snippet you get is effectively arbitrary.`,
      value: description ?? undefined,
      fix: "Keep exactly one <meta name=\"description\">. Duplicates usually come from a global layout and a page component both emitting one - remove the layout-level default when the page supplies its own.",
      docs: "https://developers.google.com/search/docs/appearance/snippet",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Canonical                                                               */
  /* ---------------------------------------------------------------------- */

  const canonicalLinks = doc.links.filter((link) =>
    link.rel
      .toLowerCase()
      .split(/\s+/)
      .includes("canonical"),
  );
  const canonicalHrefs = canonicalLinks
    .map((link) => (link.href ?? "").trim())
    .filter((href) => href.length > 0);

  if (canonicalLinks.length === 0) {
    findings.push({
      id: "meta-canonical-missing",
      category: "meta",
      severity: "warning",
      title: "No canonical URL declared",
      detail:
        "There is no <link rel=\"canonical\">. Any URL variant that reaches this page - tracking parameters, a trailing slash, http vs https, uppercase paths - can be indexed as a separate document, splitting link equity between near-identical copies.",
      fix: "Add a self-referencing canonical with the absolute, https, final-form URL of this page in the head of every page.",
      snippet: `<link rel="canonical" href="${ctx.finalUrl}">`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
      weight: 3,
    });
  } else {
    if (canonicalLinks.length > 1) {
      findings.push({
        id: "meta-canonical-multiple",
        category: "meta",
        severity: "warning",
        title: "More than one canonical link",
        detail: `${canonicalLinks.length} canonical links were found. Google treats conflicting canonicals as untrustworthy and ignores all of them, falling back to its own guess about which URL is primary.`,
        value: canonicalHrefs.join(" | "),
        fix: "Emit exactly one canonical link. Check for a layout-level default that is not being overridden by the page.",
        docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
        weight: 3,
      });
    }

    const canonical = canonicalHrefs[0];

    if (canonical === undefined) {
      findings.push({
        id: "meta-canonical-empty",
        category: "meta",
        severity: "warning",
        title: "Canonical link has no href",
        detail:
          "A <link rel=\"canonical\"> is present but its href is empty or missing, which some crawlers read as canonicalising to the current URL and others simply ignore.",
        fix: "Set href to the absolute URL of this page, or remove the tag entirely if it cannot be populated.",
        snippet: `<link rel="canonical" href="${ctx.finalUrl}">`,
        docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
        weight: 3,
      });
    } else {
      const absolute = hasScheme(canonical);
      const resolved = safeUrl(canonical, ctx.finalUrl);

      if (!absolute) {
        findings.push({
          id: "meta-canonical-relative",
          category: "meta",
          severity: "warning",
          title: "Canonical URL is relative",
          detail:
            "The canonical href is a relative path. The spec allows it and Google resolves it, but every proxy, syndication partner and scraper that re-serves your HTML on another host will resolve it against their domain instead of yours.",
          value: canonical,
          fix: "Use the fully qualified absolute URL including scheme and host.",
          snippet: `<link rel="canonical" href="${resolved ? resolved.href : ctx.finalUrl}">`,
          docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
          weight: 2,
        });
      }

      if (resolved !== null && resolved.origin.toLowerCase() !== ctx.origin.toLowerCase()) {
        findings.push({
          id: "meta-canonical-cross-origin",
          category: "meta",
          severity: "warning",
          title: "Canonical points at a different domain",
          detail:
            "The canonical URL is on another origin, which tells search engines this page is a duplicate of a page you may not own. If that is not deliberate, this page will be dropped from the index and its ranking signals handed to the other domain.",
          value: canonical,
          fix: `Unless this page is intentionally syndicated content, change the canonical to ${ctx.finalUrl}.`,
          snippet: `<link rel="canonical" href="${ctx.finalUrl}">`,
          docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
          weight: 4,
        });
      } else if (resolved !== null && !sameUrl(resolved.href, ctx.finalUrl)) {
        findings.push({
          id: "meta-canonical-mismatch",
          category: "meta",
          severity: "info",
          title: "Canonical points at a different URL on this site",
          detail: `The canonical names another page on the same origin, so this URL is being declared a duplicate of it and will not be indexed in its own right.`,
          value: `${canonical} (page served at ${ctx.finalUrl})`,
          fix: `If this page has unique content, make the canonical self-referencing: ${ctx.finalUrl}. If it really is a variant (a filtered listing, a paginated view, a tracking-parameter copy) this is correct as-is.`,
          docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
          weight: 2,
        });
      } else if (resolved !== null && absolute) {
        findings.push({
          id: "meta-canonical-self",
          category: "meta",
          severity: "pass",
          title: "Self-referencing canonical is in place",
          detail:
            "The canonical URL is absolute and points at this page, which consolidates every parameterised and slash variant of this URL onto one indexable address.",
          value: canonical,
          weight: 3,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Viewport                                                                */
  /* ---------------------------------------------------------------------- */

  const viewport = metaName(ctx, "viewport");

  if (viewport === null || viewport.length === 0) {
    findings.push({
      id: "meta-viewport-missing",
      category: "meta",
      severity: "critical",
      title: "No viewport meta tag",
      detail:
        "Without a viewport tag, mobile browsers render the page at a virtual 980px width and shrink it to fit, so text arrives roughly a third of its intended size and every tap target is too small. Mobile usability is a ranking factor and this is the single tag that governs it.",
      fix: "Add the standard responsive viewport declaration to the head, above any stylesheet links.",
      snippet: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag",
      weight: 5,
    });
  } else {
    if (doc.viewportBlocksZoom) {
      findings.push({
        id: "meta-viewport-blocks-zoom",
        category: "meta",
        severity: "warning",
        title: "Viewport disables pinch-to-zoom",
        detail:
          "The viewport tag sets user-scalable=no or caps maximum-scale, which stops low-vision users from magnifying the page. It is a WCAG 1.4.4 failure and iOS Safari has ignored it since iOS 10 anyway, so it costs accessibility without buying control.",
        value: viewport,
        fix: "Remove user-scalable=no and any maximum-scale below 5 from the viewport content.",
        snippet: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
        docs: "https://www.w3.org/WAI/WCAG21/Understanding/resize-text.html",
        weight: 3,
      });
    }

    if (!/width\s*=\s*device-width/i.test(viewport)) {
      findings.push({
        id: "meta-viewport-no-device-width",
        category: "meta",
        severity: "warning",
        title: "Viewport does not set width=device-width",
        detail:
          "The viewport tag is present but never ties the layout viewport to the device width, so mobile browsers fall back to their default virtual width and the responsive breakpoints in your CSS never fire.",
        value: viewport,
        fix: "Include width=device-width in the viewport content alongside initial-scale=1.",
        snippet: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag",
        weight: 3,
      });
    } else if (!doc.viewportBlocksZoom) {
      findings.push({
        id: "meta-viewport-ok",
        category: "meta",
        severity: "pass",
        title: "Responsive viewport is configured correctly",
        detail:
          "The viewport tag sets width=device-width and leaves pinch-to-zoom available, which is what mobile rendering and WCAG both want.",
        value: viewport,
        weight: 3,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Charset                                                                 */
  /* ---------------------------------------------------------------------- */

  const charset = typeof doc.charset === "string" ? doc.charset.trim() : null;

  if (charset === null || charset.length === 0) {
    findings.push({
      id: "meta-charset-missing",
      category: "meta",
      severity: "warning",
      title: "No character encoding declared",
      detail:
        "The document declares no charset. Browsers then sniff the encoding from the first bytes, which mangles curly quotes, dashes, accented names and emoji, and leaves the page open to UTF-7 style injection in older engines.",
      fix: "Add the charset declaration as the very first element inside <head> - it must appear within the first 1024 bytes of the document.",
      snippet: `<meta charset="utf-8">`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta#charset",
      weight: 2,
    });
  } else if (!/^utf-?8$/i.test(charset)) {
    findings.push({
      id: "meta-charset-not-utf8",
      category: "meta",
      severity: "warning",
      title: "Character encoding is not UTF-8",
      detail:
        "The page declares a legacy encoding. Anything outside that character set - smart quotes, non-Latin names, currency symbols, emoji - renders as replacement characters, and structured data and social scrapers frequently assume UTF-8 regardless.",
      value: charset,
      fix: "Serve the page as UTF-8 and change the declaration to match. Convert existing content files to UTF-8 before switching the header.",
      snippet: `<meta charset="utf-8">`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta#charset",
      weight: 2,
    });
  } else {
    findings.push({
      id: "meta-charset-ok",
      category: "meta",
      severity: "pass",
      title: "UTF-8 encoding is declared",
      detail: "The document declares UTF-8, so the full Unicode range renders as authored.",
      value: charset,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* html lang                                                               */
  /* ---------------------------------------------------------------------- */

  const lang = typeof doc.lang === "string" ? doc.lang.trim() : null;

  if (lang === null || lang.length === 0) {
    findings.push({
      id: "meta-lang-missing",
      category: "meta",
      severity: "warning",
      title: "<html> has no lang attribute",
      detail:
        "The root element declares no language. Screen readers then guess a pronunciation voice, browser translation prompts misfire, and search engines lose an explicit signal for language and region targeting.",
      fix: "Add a lang attribute to <html> using the page's actual language, with a region subtag when it matters for spelling or currency.",
      snippet: `<html lang="en-AU">`,
      docs: "https://www.w3.org/International/questions/qa-html-language-declarations",
      weight: 3,
    });
  } else if (!looksLikeLangTag(lang)) {
    findings.push({
      id: "meta-lang-malformed",
      category: "meta",
      severity: "warning",
      title: "Language tag is not valid BCP 47",
      detail:
        "The lang attribute does not parse as a BCP 47 language tag, so consumers treat it as unknown and fall back to guessing. Common causes are an underscore instead of a hyphen, a full language name, or a leftover template placeholder.",
      value: lang,
      fix: 'Use a hyphenated subtag form: "en", "en-AU", "zh-Hans", "pt-BR". Never "en_US" or "English".',
      snippet: `<html lang="en-AU">`,
      docs: "https://www.w3.org/International/questions/qa-html-language-declarations",
      weight: 2,
    });
  } else {
    findings.push({
      id: "meta-lang-ok",
      category: "meta",
      severity: "pass",
      title: "Page language is declared",
      detail: "The <html> element carries a well-formed BCP 47 language tag.",
      value: lang,
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Robots directives - meta tag and X-Robots-Tag header                     */
  /* ---------------------------------------------------------------------- */

  const robotsMeta = metaName(ctx, "robots");
  const googlebotMeta = metaName(ctx, "googlebot");
  const xRobotsHeader = ctx.headers["x-robots-tag"] ?? null;

  const metaTokens = robotsMeta !== null ? robotsTokens(robotsMeta) : [];
  const googlebotTokens = googlebotMeta !== null ? robotsTokens(googlebotMeta) : [];
  const headerTokens = xRobotsHeader !== null ? parseXRobotsTag(xRobotsHeader) : [];
  const allTokens = [...metaTokens, ...googlebotTokens, ...headerTokens];

  if (metaTokens.includes("noindex") || metaTokens.includes("none")) {
    findings.push({
      id: "meta-robots-noindex",
      category: "meta",
      severity: "critical",
      title: "Page is set to noindex",
      detail:
        "The robots meta tag asks search engines to remove this page from their index entirely. Nothing else on this report matters until it is lifted - the page cannot rank for anything while this directive is served.",
      value: `<meta name="robots" content="${robotsMeta ?? ""}">`,
      fix: 'If this page should be findable, delete the noindex directive (or replace the whole tag with content="index, follow"). If it is deliberately private - a staging build, a thank-you page, an internal tool - leave it and ignore this finding.',
      snippet: `<meta name="robots" content="index, follow">`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/block-indexing",
      weight: 8,
    });
  }

  if (headerTokens.includes("noindex") || headerTokens.includes("none")) {
    findings.push({
      id: "meta-robots-header-noindex",
      category: "meta",
      severity: "critical",
      title: "X-Robots-Tag header contains noindex",
      detail:
        "The response header instructs crawlers not to index this page. Header-level directives are easy to miss because nothing in the HTML hints at them - they are usually left behind by a staging config, a CDN rule or a framework default.",
      value: `X-Robots-Tag: ${xRobotsHeader ?? ""}`,
      fix: "Remove the noindex directive from the X-Robots-Tag response header at the origin, CDN or reverse proxy that is adding it. Check for an environment-specific rule that leaked into production.",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 8,
    });
  }

  if (googlebotTokens.includes("noindex") || googlebotTokens.includes("none")) {
    findings.push({
      id: "meta-robots-googlebot-noindex",
      category: "meta",
      severity: "critical",
      title: "Googlebot-specific noindex directive",
      detail:
        'A <meta name="googlebot"> tag blocks indexing for Google specifically, even though the generic robots tag may look fine. Google gives the more specific tag precedence.',
      value: `<meta name="googlebot" content="${googlebotMeta ?? ""}">`,
      fix: "Remove the noindex from the googlebot meta tag, or delete the tag so the general robots directive applies.",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 6,
    });
  }

  if (allTokens.includes("nofollow") || allTokens.includes("none")) {
    findings.push({
      id: "meta-robots-nofollow",
      category: "meta",
      severity: "warning",
      title: "Page-level nofollow directive",
      detail:
        "A nofollow directive applies to every link on the page, so crawlers will not follow any of them for discovery. Pages linked only from here become orphaned and stop receiving internal ranking signals.",
      value: robotsMeta ?? xRobotsHeader ?? googlebotMeta ?? undefined,
      fix: 'Drop the page-level nofollow and apply rel="nofollow" to the individual links that genuinely need it (paid placements, untrusted user submissions).',
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 3,
    });
  }

  const softDirectives = ["noarchive", "nosnippet", "noimageindex", "notranslate"].filter((token) =>
    allTokens.includes(token),
  );
  if (softDirectives.length > 0) {
    findings.push({
      id: "meta-robots-snippet-limits",
      category: "meta",
      severity: "info",
      title: "Snippet and caching directives are restricting the result",
      detail: `The page serves ${softDirectives.join(", ")}. These suppress parts of the search result - the cached copy, the description snippet, image thumbnails or the translate option - which usually lowers click-through even when rankings hold.`,
      value: softDirectives.join(", "),
      fix: "Remove any of these you did not deliberately choose. nosnippet in particular hides your meta description from the result entirely.",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 1,
    });
  }

  if (
    !allTokens.includes("noindex") &&
    !allTokens.includes("none") &&
    !allTokens.includes("nofollow")
  ) {
    findings.push({
      id: "meta-robots-indexable",
      category: "meta",
      severity: "pass",
      title: "Page is open to indexing",
      detail:
        "No noindex or nofollow directive was found in the robots meta tag or the X-Robots-Tag response header, so crawlers are free to index this page and follow its links.",
      value: robotsMeta ?? "(no robots meta tag - defaults to index, follow)",
      weight: 4,
    });
  }

  const robotsDupes = duplicateCount(ctx, "robots");
  if (robotsDupes > 0) {
    findings.push({
      id: "meta-robots-duplicate",
      category: "meta",
      severity: "warning",
      title: "Multiple robots meta tags",
      detail: `${robotsDupes + 1} robots meta tags were found. Google merges conflicting directives by taking the most restrictive one, so a stray noindex anywhere in the head wins over every permissive tag.`,
      value: robotsMeta ?? undefined,
      fix: "Consolidate to a single robots meta tag so the effective directive is obvious from reading the source.",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Meta refresh                                                            */
  /* ---------------------------------------------------------------------- */

  const refreshValue =
    metaName(ctx, "refresh") ??
    metaName(ctx, "http-equiv:refresh") ??
    (typeof doc.metaByProperty["refresh"] === "string" ? doc.metaByProperty["refresh"].trim() : null) ??
    (/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?/i.test(ctx.html)
      ? (/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']([^"']*)["']/i.exec(
          ctx.html,
        )?.[1] ?? "")
      : null);

  if (refreshValue !== null) {
    findings.push({
      id: "meta-refresh-present",
      category: "meta",
      severity: "warning",
      title: "Page uses a meta refresh redirect",
      detail:
        "A meta refresh redirects or reloads the page from the markup. Search engines treat it as a weak, ambiguous redirect that may not pass ranking signals, and users with assistive technology can be moved mid-sentence with no way to stop it.",
      value: refreshValue.length > 0 ? `content="${refreshValue}"` : "<meta http-equiv=\"refresh\">",
      fix: "Replace it with a server-side 301 (permanent) or 302 (temporary) HTTP redirect, which is unambiguous to crawlers and instant for users.",
      snippet: `# Server-side instead of meta refresh\nLocation: ${ctx.finalUrl}\nStatus: 301 Moved Permanently`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
      weight: 3,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Informational tags                                                      */
  /* ---------------------------------------------------------------------- */

  const keywords = metaName(ctx, "keywords");
  if (keywords !== null) {
    findings.push({
      id: "meta-keywords-present",
      category: "meta",
      severity: "info",
      title: "Meta keywords tag is still present",
      detail:
        "The keywords meta tag is present. No major search engine has used it for ranking in over a decade - Google confirmed it was ignored in 2009 - and it does nothing but publish your keyword strategy to competitors viewing source.",
      value: keywords.length > 0 ? truncate(keywords, 160) : "(empty)",
      fix: "Delete the tag. It is harmless but it is dead weight, and its presence is often a sign the rest of the SEO setup is following equally old advice.",
      docs: "https://developers.google.com/search/blog/2009/09/google-does-not-use-keywords-meta-tag",
      weight: 1,
    });
  }

  const author = metaName(ctx, "author");
  if (author !== null && author.length > 0) {
    findings.push({
      id: "meta-author-present",
      category: "meta",
      severity: "pass",
      title: "Author is declared",
      detail:
        "The page names an author, which is a small but real signal for the experience and authoritativeness half of E-E-A-T.",
      value: author,
      weight: 1,
    });
  } else if (doc.wordCount > 600) {
    findings.push({
      id: "meta-author-missing",
      category: "meta",
      severity: "info",
      title: "No author declared on a long-form page",
      detail: `This page has ${doc.wordCount} words of body copy but names no author. For editorial content, attribution supports E-E-A-T assessment and is worth pairing with Article structured data.`,
      fix: "Add an author meta tag and, better still, an author property inside Article or BlogPosting JSON-LD pointing at a Person with a real bio page.",
      snippet: `<meta name="author" content="Author Name">`,
      docs: "https://developers.google.com/search/docs/fundamentals/creating-helpful-content",
      weight: 1,
    });
  }

  const themeColor = metaName(ctx, "theme-color");
  if (themeColor !== null && themeColor.length > 0) {
    findings.push({
      id: "meta-theme-color-present",
      category: "meta",
      severity: "pass",
      title: "Theme colour is set",
      detail:
        "A theme-color is declared, so mobile browser chrome and installed PWA surfaces adopt the brand colour instead of a default grey.",
      value: themeColor,
      weight: 1,
    });
  } else {
    findings.push({
      id: "meta-theme-color-missing",
      category: "meta",
      severity: "info",
      title: "No theme colour",
      detail:
        "No theme-color meta tag was found. Mobile Chrome, Android task switchers and installed web apps use it to tint the browser UI to match the site.",
      fix: "Add a theme-color matching your primary brand colour, optionally with a prefers-color-scheme variant for dark mode.",
      snippet: `<meta name="theme-color" content="#0f172a">`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta/name/theme-color",
      weight: 1,
    });
  }

  const generator = metaName(ctx, "generator");
  if (generator !== null && generator.length > 0) {
    findings.push({
      id: "meta-generator-present",
      category: "meta",
      severity: "info",
      title: "Generator tag advertises your stack",
      detail:
        "A generator meta tag names the CMS or framework, often with a version number. It has no SEO effect, but it hands automated vulnerability scanners a precise fingerprint of what to try.",
      value: generator,
      fix: "Remove the generator tag in production - most CMSs have a one-line setting or filter for it.",
      weight: 1,
    });
  }

  if (metaPresent(ctx, "revisit-after") || metaPresent(ctx, "distribution") || metaPresent(ctx, "rating")) {
    findings.push({
      id: "meta-legacy-tags",
      category: "meta",
      severity: "info",
      title: "Obsolete meta tags in the head",
      detail:
        "Tags such as revisit-after, distribution or rating are present. No search engine has honoured them for many years; they are copied forward from 1990s SEO templates.",
      fix: "Delete them to keep the head readable and make the tags that do matter easier to audit.",
      weight: 1,
    });
  }

  return findings;
}
