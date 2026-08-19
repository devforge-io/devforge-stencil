/**
 * SEO checks: headings, on-page content, image SEO, link hygiene,
 * crawlability (robots/sitemap), URL hygiene, hreflang and pagination.
 *
 * Deliberately out of scope here (owned by other check modules):
 * title / meta description / canonical / Open Graph / structured data,
 * and the accessibility angle on alt text and link labelling.
 */

import type { AnchorTag, Finding, LinkTag, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Shorten a value for display in a finding. */
function clip(input: string, max = 180): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Join a handful of example values into a quotable string. */
function examples(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((v) => `"${clip(v, 60)}"`);
  const extra = values.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

/** `rel` attributes are space-separated token lists. */
function relTokens(rel: string | null): string[] {
  if (!rel) return [];
  return rel.toLowerCase().split(/\s+/).filter(Boolean);
}

function hasRel(rel: string | null, token: string): boolean {
  return relTokens(rel).includes(token);
}

function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** Normalise anchor text for generic-phrase comparison. */
function normaliseAnchorText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_ANCHOR_PHRASES = new Set([
  "click here",
  "click",
  "read more",
  "more",
  "learn more",
  "here",
  "link",
  "this link",
  "this",
  "go",
  "continue",
  "details",
  "more info",
  "more information",
  "find out more",
  "see more",
  "view more",
  "download",
  "info",
]);

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)$/i;
const CAMERA_FILENAME = /^(img|dsc|dscn|image|photo|pic|picture|screenshot|screen[\s_-]?shot|untitled|download|unnamed|asset)[\s_-]*\d*$/i;

function looksLikeFilenameAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (!trimmed) return false;
  if (IMAGE_EXTENSION.test(trimmed)) return true;
  if (/[_-]/.test(trimmed) && !/\s/.test(trimmed) && trimmed.length > 6) return true;
  return CAMERA_FILENAME.test(trimmed);
}

/** Anything outside printable ASCII, which a URL must percent-encode. */
const NON_ASCII_PATH = new RegExp("[^\\u0020-\\u007e]");

/** BCP-47-ish shape check, plus the reserved `x-default` token. */
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function isValidHreflangValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.toLowerCase() === "x-default") return true;
  return LANG_TAG.test(v);
}

/** Strip the trailing slash (but never reduce a path to the empty string). */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * robots.txt path matching, including `*` wildcards and the `$` end anchor.
 * Returns the length of the matched pattern (for longest-match precedence) or
 * -1 when the pattern does not apply.
 */
function robotsMatchLength(pattern: string, path: string): number {
  const raw = pattern.trim();
  if (raw === "") return -1;
  const anchored = raw.endsWith("$");
  const body = anchored ? raw.slice(0, -1) : raw;
  const parts = body.split("*");
  let cursor = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "") continue;
    if (i === 0) {
      if (!path.startsWith(part)) return -1;
      cursor = part.length;
      continue;
    }
    const found = path.indexOf(part, cursor);
    if (found === -1) return -1;
    cursor = found + part.length;
  }

  if (anchored && cursor !== path.length) return -1;
  return raw.length;
}

/** Resolve an href against the page, returning null when it cannot be parsed. */
function resolveHref(href: string | null, base: string): URL | null {
  if (!href) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function linksWithRel(links: LinkTag[], token: string): LinkTag[] {
  return links.filter((link) => hasRel(link.rel, token));
}

/* -------------------------------------------------------------------------- */
/* Check module                                                               */
/* -------------------------------------------------------------------------- */

export function seoChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;

  /* ---------------------------------------------------------------------- */
  /* Headings                                                               */
  /* ---------------------------------------------------------------------- */

  const headings = doc.headings;
  const h1s = headings.filter((h) => h.level === 1);

  if (headings.length === 0) {
    findings.push({
      id: "seo-headings-none",
      category: "seo",
      severity: "critical",
      title: "No headings on the page",
      detail:
        "The document contains no <h1>–<h6> elements at all, so search engines have no structural signal about what the page covers and no way to understand its sections.",
      fix: "Add a single descriptive <h1> naming the page's primary topic, then structure the body with <h2> and <h3> subheadings.",
      snippet: '<h1>Commercial solar installation in Brisbane</h1>\n<h2>How the process works</h2>',
      docs: "https://developers.google.com/search/docs/appearance/structured-heading",
      weight: 3,
    });
  } else {
    const outline = headings
      .slice(0, 40)
      .map((h) => `h${h.level}: ${clip(h.text || "(empty)", 60)}`)
      .join(" | ");
    findings.push({
      id: "seo-heading-outline",
      category: "seo",
      severity: "info",
      title: "Heading outline",
      detail: `The page uses ${headings.length} ${pluralise(headings.length, "heading")}. This is the outline a crawler builds from the document.`,
      value: clip(outline, 900),
      docs: "https://developers.google.com/search/docs/appearance/structured-heading",
      weight: 1,
    });
  }

  if (headings.length > 0 && h1s.length === 0) {
    findings.push({
      id: "seo-h1-missing",
      category: "seo",
      severity: "critical",
      title: "Missing <h1>",
      detail: `The page has ${headings.length} ${pluralise(headings.length, "heading")} but no <h1>. The <h1> is the strongest on-page topic signal after the title tag.`,
      fix: "Promote the page's main heading to an <h1>. Use exactly one per page and make it describe the page's primary subject.",
      snippet: "<h1>Your primary page topic</h1>",
      value: `first heading is h${headings[0].level}`,
      docs: "https://developers.google.com/search/docs/appearance/structured-heading",
      weight: 3,
    });
  }

  if (h1s.length === 1 && h1s[0].text.trim().length > 0) {
    findings.push({
      id: "seo-h1-ok",
      category: "seo",
      severity: "pass",
      title: "Exactly one <h1>",
      detail: "The page has a single, non-empty <h1> - the clearest possible topic signal.",
      value: clip(h1s[0].text, 120),
      weight: 3,
    });
  }

  if (h1s.length > 1) {
    findings.push({
      id: "seo-h1-multiple",
      category: "seo",
      severity: "warning",
      title: `Multiple <h1> elements (${h1s.length})`,
      detail:
        "More than one <h1> dilutes the page's primary topic signal and usually indicates a template that reuses <h1> for section titles.",
      fix: "Keep one <h1> for the page topic and demote the rest to <h2>.",
      value: examples(h1s.map((h) => h.text || "(empty)")),
      docs: "https://developers.google.com/search/docs/appearance/structured-heading",
      weight: 2,
    });
  }

  const emptyH1s = h1s.filter((h) => h.text.trim().length === 0);
  if (emptyH1s.length > 0) {
    findings.push({
      id: "seo-h1-empty",
      category: "seo",
      severity: "critical",
      title: "Empty <h1>",
      detail: `${emptyH1s.length} <h1> ${pluralise(emptyH1s.length, "element has", "elements have")} no text content. A background-image or icon-only <h1> carries no keyword signal at all.`,
      fix: "Put real text inside the <h1>. If the heading is a logo image, use an <img> with descriptive alt text inside the <h1>.",
      snippet: '<h1><img src="/logo.svg" alt="Acme - commercial solar"></h1>',
      docs: "https://developers.google.com/search/docs/appearance/structured-heading",
      weight: 3,
    });
  }

  const emptyOtherHeadings = headings.filter((h) => h.level !== 1 && h.text.trim().length === 0);
  if (emptyOtherHeadings.length > 0) {
    findings.push({
      id: "seo-heading-empty",
      category: "seo",
      severity: "warning",
      title: `${emptyOtherHeadings.length} empty ${pluralise(emptyOtherHeadings.length, "heading")}`,
      detail:
        "Headings with no text content still occupy a slot in the document outline, producing gaps that make the page structure look incoherent to crawlers.",
      fix: "Remove empty heading elements, or give them the text they were meant to carry. Never use headings purely for their font size.",
      value: examples(emptyOtherHeadings.map((h) => `h${h.level}`)),
      weight: 1,
    });
  }

  if (headings.length > 0 && headings[0].level !== 1) {
    findings.push({
      id: "seo-heading-first-not-h1",
      category: "seo",
      severity: "warning",
      title: `Document starts with an h${headings[0].level}`,
      detail:
        "The first heading in source order is not the <h1>. Crawlers read the outline top-down, so a page that opens on a lower level reads as a fragment of a larger document.",
      fix: "Move the <h1> above the other headings in the DOM, or promote the first heading to <h1>.",
      value: `h${headings[0].level}: ${clip(headings[0].text || "(empty)", 80)}`,
      weight: 1,
    });
  }

  const skips: string[] = [];
  for (let i = 1; i < headings.length; i += 1) {
    const prev = headings[i - 1];
    const current = headings[i];
    if (current.level > prev.level + 1) {
      skips.push(`h${prev.level} → h${current.level} ("${clip(current.text || "(empty)", 50)}")`);
    }
  }
  if (skips.length > 0) {
    findings.push({
      id: "seo-heading-levels-skipped",
      category: "seo",
      severity: "warning",
      title: `Heading levels skipped (${skips.length} ${pluralise(skips.length, "place")})`,
      detail:
        "The outline jumps more than one level at a time (for example h1 straight to h3). Search engines infer section nesting from heading levels, so gaps flatten the hierarchy they build.",
      fix: "Step heading levels one at a time. If you skipped a level to get smaller text, keep the correct level and restyle it with CSS.",
      value: examples(skips, 4),
      docs: "https://www.w3.org/WAI/tutorials/page-structure/headings/",
      weight: 2,
    });
  } else if (headings.length > 1) {
    findings.push({
      id: "seo-heading-order-ok",
      category: "seo",
      severity: "pass",
      title: "Heading levels are sequential",
      detail: "The outline steps through heading levels one at a time, producing a clean document hierarchy.",
      weight: 1,
    });
  }

  if (headings.length > 60) {
    findings.push({
      id: "seo-headings-excessive",
      category: "seo",
      severity: "warning",
      title: `Excessive headings (${headings.length})`,
      detail:
        "Over 60 headings on a single page usually means heading tags are being used for visual emphasis rather than structure, which flattens the outline and dilutes every heading's signal.",
      fix: "Reserve headings for genuine section boundaries. Style emphasised text with <strong> or CSS classes instead.",
      value: `${headings.length} headings`,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Content depth                                                          */
  /* ---------------------------------------------------------------------- */

  const words = doc.wordCount;
  if (words < 100) {
    findings.push({
      id: "seo-content-very-thin",
      category: "seo",
      severity: "critical",
      title: `Almost no indexable text (${words} words)`,
      detail:
        "Under 100 words of visible text in the served HTML. Google can render JavaScript, but rendering is queued and unreliable - a page this thin in the initial response frequently gets indexed empty or not at all.",
      fix: "Server-render the page's real content. If this is a client-rendered app, add SSR or prerendering so the HTML response contains the copy you want ranked.",
      value: `${words} words, ${doc.textContent.length} characters of text`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
      weight: 3,
    });
  } else if (words < 300) {
    findings.push({
      id: "seo-content-thin",
      category: "seo",
      severity: "warning",
      title: `Thin content (${words} words)`,
      detail:
        "Fewer than 300 words of visible text. Thin pages rarely have enough context to rank for anything competitive, and clusters of them can drag down sitewide quality signals.",
      fix: "Expand the page with substantive, original copy that answers the query it targets - or consolidate it into a stronger related page.",
      value: `${words} words`,
      docs: "https://developers.google.com/search/docs/fundamentals/creating-helpful-content",
      weight: 2,
    });
  } else {
    findings.push({
      id: "seo-content-depth-ok",
      category: "seo",
      severity: "pass",
      title: `Substantive content (${words} words)`,
      detail: "The served HTML contains enough visible text for search engines to understand and rank the page.",
      value: `${words} words`,
      weight: 2,
    });
  }

  const ratio = doc.textToHtmlRatio;
  if (doc.htmlLength > 0 && ratio < 0.05) {
    findings.push({
      id: "seo-text-html-ratio-low",
      category: "seo",
      severity: "warning",
      title: `Very low text-to-HTML ratio (${(ratio * 100).toFixed(1)}%)`,
      detail:
        "Under 5% of the response is visible text. That is the signature of a client-rendered shell: the markup is mostly scripts and empty containers, so a crawler that does not execute JavaScript sees almost nothing.",
      fix: "Server-render or prerender the page so the primary content ships in the initial HTML. Verify with `curl` - whatever you see there is what a non-rendering crawler sees.",
      value: `${doc.textContent.length} text chars in ${doc.htmlLength} HTML chars`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
      weight: 2,
    });
  } else if (doc.htmlLength > 0) {
    findings.push({
      id: "seo-text-html-ratio-ok",
      category: "seo",
      severity: "pass",
      title: `Text-to-HTML ratio is healthy (${(ratio * 100).toFixed(1)}%)`,
      detail: "The initial HTML response carries a reasonable amount of real text, so crawlers can read the page without executing JavaScript.",
      weight: 1,
    });
  }

  if (doc.wordCount < 100 && doc.hasNoscript) {
    findings.push({
      id: "seo-noscript-fallback",
      category: "seo",
      severity: "info",
      title: "<noscript> fallback present on a script-dependent page",
      detail:
        "The page ships almost no text but does include a <noscript> block. Search engines ignore <noscript> content for ranking, so it does not substitute for server-rendered copy.",
      fix: "Treat <noscript> as a courtesy to users, not an indexing strategy - render the real content server-side.",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Image SEO                                                              */
  /* ---------------------------------------------------------------------- */

  const images = doc.images;
  const missingAlt = images.filter((img) => img.alt === null);
  const filenameAlt = images.filter((img) => img.alt !== null && looksLikeFilenameAlt(img.alt));
  const missingDimensions = images.filter((img) => !img.width || !img.height);

  if (images.length === 0) {
    findings.push({
      id: "seo-images-none",
      category: "seo",
      severity: "info",
      title: "No images found",
      detail:
        "The page contains no <img> elements. That is fine for text-only pages, but it also means no Google Images traffic and no visual context for the copy.",
      weight: 1,
    });
  }

  if (missingAlt.length > 0) {
    findings.push({
      id: "seo-image-alt-missing",
      category: "seo",
      severity: "warning",
      title: `${missingAlt.length} of ${images.length} images have no alt attribute`,
      detail:
        "Alt text is the only text description Google has for an image. Images without it are effectively invisible to image search and contribute nothing to the page's topical relevance. (The accessibility category covers the screen-reader impact of the same markup.)",
      fix: "Add descriptive alt text saying what the image shows, in natural language. Purely decorative images should carry an explicit alt=\"\" so they are skipped deliberately.",
      snippet: '<img src="/roof-array.jpg" alt="Technician installing solar panels on a tile roof">',
      value: examples(missingAlt.map((img) => img.src ?? "(no src)")),
      docs: "https://developers.google.com/search/docs/appearance/google-images",
      weight: 2,
    });
  } else if (images.length > 0) {
    findings.push({
      id: "seo-image-alt-ok",
      category: "seo",
      severity: "pass",
      title: "Every image declares an alt attribute",
      detail: `All ${images.length} ${pluralise(images.length, "image")} carry an alt attribute, so Google Images has text to work with.`,
      weight: 2,
    });
  }

  if (filenameAlt.length > 0) {
    findings.push({
      id: "seo-image-alt-filename",
      category: "seo",
      severity: "warning",
      title: `${filenameAlt.length} ${pluralise(filenameAlt.length, "image uses", "images use")} a filename as alt text`,
      detail:
        "Alt values like \"IMG_1234.jpg\" or \"hero-banner-v2\" are auto-generated placeholders. They contain no description, so they add no relevance and read as noise.",
      fix: "Replace filename alt text with a short sentence describing what is actually in the image.",
      value: examples(filenameAlt.map((img) => img.alt ?? "")),
      docs: "https://developers.google.com/search/docs/appearance/google-images",
      weight: 1,
    });
  }

  if (missingDimensions.length > 0) {
    findings.push({
      id: "seo-image-dimensions-missing",
      category: "seo",
      severity: "warning",
      title: `${missingDimensions.length} of ${images.length} images lack width/height`,
      detail:
        "Without intrinsic dimensions the browser cannot reserve space before the image loads, so content jumps as images arrive. That is a direct Cumulative Layout Shift penalty, and CLS is a ranking signal.",
      fix: "Set the image's intrinsic width and height attributes and let CSS handle responsive sizing.",
      snippet: '<img src="/hero.jpg" width="1600" height="900" alt="…" style="height:auto;max-width:100%">',
      value: examples(missingDimensions.map((img) => img.src ?? "(no src)")),
      docs: "https://web.dev/articles/optimize-cls",
      weight: 2,
    });
  } else if (images.length > 0) {
    findings.push({
      id: "seo-image-dimensions-ok",
      category: "seo",
      severity: "pass",
      title: "All images declare width and height",
      detail: "Every image reserves its own layout space, which protects the page's Cumulative Layout Shift score.",
      weight: 1,
    });
  }

  if (images.length > 5) {
    const lazy = images.filter((img) => (img.loading ?? "").toLowerCase() === "lazy");
    if (lazy.length === 0) {
      findings.push({
        id: "seo-image-lazy-loading-missing",
        category: "seo",
        severity: "info",
        title: `No lazy loading across ${images.length} images`,
        detail:
          "None of the images defer loading. On an image-heavy page this forces the browser to fetch everything below the fold immediately, slowing the initial render that Core Web Vitals measures.",
        fix: 'Add loading="lazy" to images below the fold. Leave the hero image eager (and consider fetchpriority="high") so Largest Contentful Paint is not delayed.',
        snippet: '<img src="/gallery-7.jpg" loading="lazy" decoding="async" width="800" height="600" alt="…">',
        docs: "https://web.dev/articles/browser-level-image-lazy-loading",
        weight: 1,
      });
    } else {
      findings.push({
        id: "seo-image-lazy-loading-ok",
        category: "seo",
        severity: "pass",
        title: `Lazy loading in use on ${lazy.length} images`,
        detail: "Below-the-fold imagery defers its download, keeping the initial render fast.",
        weight: 1,
      });
    }
  }

  if (images.length >= 3) {
    const responsive = images.filter((img) => img.srcset && img.srcset.trim().length > 0);
    if (responsive.length === 0) {
      findings.push({
        id: "seo-image-srcset-missing",
        category: "seo",
        severity: "info",
        title: "No responsive image sources",
        detail: `None of the ${images.length} images provide a srcset, so mobile visitors download desktop-sized files. Mobile page experience feeds directly into mobile-first indexing.`,
        fix: "Ship multiple widths via srcset/sizes, or use <picture> to serve modern formats such as AVIF and WebP.",
        snippet: '<img src="/hero-800.jpg"\n     srcset="/hero-400.jpg 400w, /hero-800.jpg 800w, /hero-1600.jpg 1600w"\n     sizes="(max-width: 700px) 100vw, 800px"\n     width="800" height="450" alt="…">',
        docs: "https://developer.mozilla.org/en-US/docs/Learn/HTML/Multimedia_and_embedding/Responsive_images",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Links                                                                  */
  /* ---------------------------------------------------------------------- */

  const anchors = doc.anchors;
  const realAnchors = anchors.filter((a) => a.href !== null && a.href.trim() !== "");
  const internal = realAnchors.filter((a) => a.internal);
  const external = realAnchors.filter((a) => !a.internal);

  if (anchors.length > 0) {
    findings.push({
      id: "seo-link-profile",
      category: "seo",
      severity: "info",
      title: "Link profile",
      detail: `The page links out ${anchors.length} ${pluralise(anchors.length, "time")}: ${internal.length} internal and ${external.length} external.`,
      value: `${internal.length} internal / ${external.length} external / ${anchors.length} total`,
      weight: 1,
    });
  }

  if (internal.length === 0) {
    findings.push({
      id: "seo-links-no-internal",
      category: "seo",
      severity: "critical",
      title: "No internal links",
      detail:
        "The page links to nothing else on this site. Internal links are how crawlers discover pages and how authority flows through a site - an orphan page has neither.",
      fix: "Add contextual links to related pages, plus site navigation and breadcrumbs, so this page participates in the site's link graph.",
      docs: "https://developers.google.com/search/docs/crawling-indexing/links-crawlable",
      weight: 3,
    });
  } else {
    findings.push({
      id: "seo-links-internal-ok",
      category: "seo",
      severity: "pass",
      title: `${internal.length} internal ${pluralise(internal.length, "link")}`,
      detail: "The page is wired into the site's link graph, so crawlers can move from here to the rest of the site.",
      weight: 2,
    });
  }

  const generic: AnchorTag[] = realAnchors.filter((a) =>
    GENERIC_ANCHOR_PHRASES.has(normaliseAnchorText(a.text)),
  );
  if (generic.length > 0) {
    findings.push({
      id: "seo-link-generic-anchor-text",
      category: "seo",
      severity: "warning",
      title: `${generic.length} ${pluralise(generic.length, "link uses", "links use")} generic anchor text`,
      detail:
        "Anchor text is one of the strongest relevance signals for the destination page. Phrases like \"click here\" and \"read more\" describe nothing, so the link passes no topical context.",
      fix: "Rewrite the anchor to describe the destination - \"read our solar installation guide\" rather than \"read more\".",
      snippet: '<a href="/guides/solar-install">Read our solar installation guide</a>',
      value: examples(generic.map((a) => `${a.text.trim()} → ${a.href ?? ""}`)),
      docs: "https://developers.google.com/search/docs/crawling-indexing/links-crawlable",
      weight: 2,
    });
  } else if (realAnchors.length > 0) {
    findings.push({
      id: "seo-link-anchor-text-ok",
      category: "seo",
      severity: "pass",
      title: "Anchor text is descriptive",
      detail: "No links rely on generic phrases such as \"click here\" or \"read more\".",
      weight: 1,
    });
  }

  const emptyAnchors = realAnchors.filter((a) => a.text.trim().length === 0);
  if (emptyAnchors.length > 0) {
    findings.push({
      id: "seo-link-empty-text",
      category: "seo",
      severity: "warning",
      title: `${emptyAnchors.length} ${pluralise(emptyAnchors.length, "link has", "links have")} no text`,
      detail:
        "These anchors wrap no visible text, so they pass zero anchor-text signal to their destination. Icon links and image links are the usual cause. (If the anchor wraps an image with alt text, or carries an aria-label, the accessibility impact is covered - but the SEO signal is still weaker than real text.)",
      fix: "Give the link visible text, or wrap an image that carries descriptive alt text. Visually-hidden text is a valid alternative for icon-only links.",
      snippet: '<a href="/cart"><svg aria-hidden="true">…</svg><span class="sr-only">View your cart</span></a>',
      value: examples(emptyAnchors.map((a) => a.href ?? "")),
      weight: 1,
    });
  }

  const unsafeBlank = realAnchors.filter(
    (a) =>
      (a.target ?? "").toLowerCase() === "_blank" &&
      !hasRel(a.rel, "noopener") &&
      !hasRel(a.rel, "noreferrer"),
  );
  if (unsafeBlank.length > 0) {
    findings.push({
      id: "seo-link-target-blank-unsafe",
      category: "seo",
      severity: "warning",
      title: `${unsafeBlank.length} target="_blank" ${pluralise(unsafeBlank.length, "link", "links")} without rel="noopener"`,
      detail:
        "A new-tab link without rel=\"noopener\" hands the destination page a window.opener reference to yours, which it can use to redirect your tab (tabnabbing). Modern browsers imply noopener, but older ones and in-app webviews do not.",
      fix: 'Add rel="noopener noreferrer" to every target="_blank" link.',
      snippet: '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>',
      value: examples(unsafeBlank.map((a) => a.href ?? "")),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener",
      weight: 2,
    });
  }

  const nofollowInternal = internal.filter((a) => hasRel(a.rel, "nofollow"));
  if (nofollowInternal.length > 0) {
    findings.push({
      id: "seo-link-internal-nofollow",
      category: "seo",
      severity: "warning",
      title: `${nofollowInternal.length} internal ${pluralise(nofollowInternal.length, "link", "links")} marked nofollow`,
      detail:
        "rel=\"nofollow\" on an internal link tells Google not to follow it. Since 2019 nofollow is a hint rather than a directive, but using it internally still discards link equity for no benefit - it does not sculpt PageRank.",
      fix: "Remove rel=\"nofollow\" from internal links. To keep a page out of the index use a robots noindex meta tag instead.",
      value: examples(nofollowInternal.map((a) => a.href ?? "")),
      docs: "https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links",
      weight: 1,
    });
  }

  if (anchors.length > 300) {
    findings.push({
      id: "seo-links-excessive",
      category: "seo",
      severity: "warning",
      title: `Excessive links (${anchors.length})`,
      detail:
        "Over 300 links on one page spreads its authority extremely thin and makes the page look like a directory or link farm. It also bloats the HTML that every crawler must parse.",
      fix: "Trim the link count - paginate long listings, collapse mega-menus, and drop links that no user follows.",
      value: `${anchors.length} anchors`,
      weight: 1,
    });
  }

  const brokenLooking = anchors.filter((a) => {
    const href = (a.href ?? "").trim();
    if (a.href === null) return true;
    if (href === "" || href === "#") return true;
    return /^javascript:/i.test(href);
  });
  if (brokenLooking.length > 0) {
    findings.push({
      id: "seo-link-placeholder-href",
      category: "seo",
      severity: "warning",
      title: `${brokenLooking.length} ${pluralise(brokenLooking.length, "link", "links")} with a placeholder href`,
      detail:
        'Hrefs like "#", "javascript:void(0)" or an absent href point nowhere. Crawlers cannot follow them, so anything reachable only through these links is undiscoverable.',
      fix: "Give every link a real URL. If the element triggers script behaviour rather than navigation, use a <button> instead of an <a>.",
      snippet: '<button type="button" onclick="openDialog()">Open</button>',
      value: examples(brokenLooking.map((a) => (a.href === null ? "(no href)" : a.href || "(empty)"))),
      docs: "https://developers.google.com/search/docs/crawling-indexing/links-crawlable",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Crawlability: robots.txt                                               */
  /* ---------------------------------------------------------------------- */

  const robots = ctx.robots;
  if (!robots || !robots.ok) {
    findings.push({
      id: "seo-robots-missing",
      category: "seo",
      severity: "info",
      title: "No robots.txt found",
      detail:
        "No robots.txt was served at the site root. Crawlers treat this as \"crawl everything\", which is usually fine, but it also means you have nowhere to point at your sitemap or exclude low-value paths.",
      fix: "Add a robots.txt at the origin root, even a permissive one, and reference your sitemap from it.",
      snippet: "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
      weight: 1,
    });
  } else if (robots.blocksAllCrawlers) {
    const wildcardGroup = robots.groups.find((g) => g.userAgents.includes("*"));
    const rule = wildcardGroup ? `User-agent: *\nDisallow: ${wildcardGroup.disallow.join("\nDisallow: ")}` : "Disallow: /";
    findings.push({
      id: "seo-robots-blocks-all",
      category: "seo",
      severity: "critical",
      title: "robots.txt blocks every crawler",
      detail:
        "A User-agent: * group disallows the entire site. No search engine will crawl any page here - this single line removes the site from organic search. Staging configuration reaching production is the usual cause.",
      fix: "Remove the site-wide Disallow: / rule, then request re-crawl in Google Search Console.",
      snippet: "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml",
      value: clip(rule, 200),
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
      weight: 5,
    });
  } else {
    findings.push({
      id: "seo-robots-ok",
      category: "seo",
      severity: "pass",
      title: "robots.txt found and permissive",
      detail: `robots.txt was served with ${robots.groups.length} ${pluralise(robots.groups.length, "group")} and does not block crawlers site-wide.`,
      value: clip(robots.url, 120),
      weight: 2,
    });
  }

  if (robots && robots.ok && !robots.blocksAllCrawlers) {
    let path = "/";
    try {
      path = new URL(ctx.finalUrl).pathname;
    } catch {
      path = "/";
    }
    const wildcard = robots.groups.filter((g) => g.userAgents.includes("*"));
    let bestDisallow = -1;
    let bestDisallowRule = "";
    let bestAllow = -1;
    for (const group of wildcard) {
      for (const rule of group.disallow) {
        const len = robotsMatchLength(rule, path);
        if (len > bestDisallow) {
          bestDisallow = len;
          bestDisallowRule = rule;
        }
      }
      for (const rule of group.allow) {
        const len = robotsMatchLength(rule, path);
        if (len > bestAllow) bestAllow = len;
      }
    }
    if (bestDisallow > -1 && bestDisallow > bestAllow) {
      findings.push({
        id: "seo-robots-path-disallowed",
        category: "seo",
        severity: "critical",
        title: "This page is disallowed in robots.txt",
        detail:
          "A User-agent: * rule blocks the audited path, so search engines will not crawl this page. A blocked page cannot rank on its own content, and any meta robots directives on it will never be read.",
        fix: "Remove or narrow the Disallow rule that matches this path, then request indexing in Search Console.",
        value: `path "${clip(path, 100)}" matched "Disallow: ${clip(bestDisallowRule, 80)}"`,
        docs: "https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt",
        weight: 4,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Crawlability: sitemap                                                  */
  /* ---------------------------------------------------------------------- */

  const sitemap = ctx.sitemap;
  if (!sitemap || !sitemap.ok) {
    findings.push({
      id: "seo-sitemap-missing",
      category: "seo",
      severity: "warning",
      title: "No XML sitemap found",
      detail:
        "No sitemap was discoverable from robots.txt, /sitemap.xml, or a <link> tag. Sitemaps are how you tell search engines which URLs exist and when they changed - without one, discovery relies entirely on internal links.",
      fix: "Generate an XML sitemap at /sitemap.xml listing every indexable URL, reference it from robots.txt, and submit it in Google Search Console.",
      snippet: '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>\n</urlset>',
      docs: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview",
      weight: 2,
    });
  } else if (sitemap.urlCount === 0) {
    findings.push({
      id: "seo-sitemap-empty",
      category: "seo",
      severity: "warning",
      title: "Sitemap contains no URLs",
      detail:
        "A sitemap was found and parsed but lists zero entries. An empty sitemap gives search engines nothing to discover and can look like a generation failure.",
      fix: "Check the sitemap generation step - it is producing a valid but empty document.",
      value: `${sitemap.url} (${sitemap.isIndex ? "sitemapindex" : "urlset"}, HTTP ${sitemap.status})`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap",
      weight: 2,
    });
  } else {
    findings.push({
      id: "seo-sitemap-ok",
      category: "seo",
      severity: "pass",
      title: `Sitemap found with ${sitemap.urlCount} ${sitemap.isIndex ? "child sitemaps" : "URLs"}`,
      detail: `Discovered via ${sitemap.source}. Search engines have an explicit list of the URLs you want crawled.`,
      value: clip(sitemap.url, 140),
      weight: 2,
    });
  }

  if (sitemap && sitemap.ok && robots && robots.ok && robots.sitemaps.length === 0) {
    findings.push({
      id: "seo-sitemap-not-in-robots",
      category: "seo",
      severity: "info",
      title: "Sitemap not referenced from robots.txt",
      detail: `The sitemap was found via ${sitemap.source}, but robots.txt contains no Sitemap: directive. That reference is the cheapest way for any crawler - not just Google - to find it.`,
      fix: "Add a Sitemap: line to robots.txt pointing at the absolute sitemap URL.",
      snippet: `Sitemap: ${sitemap.url}`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* URL hygiene                                                            */
  /* ---------------------------------------------------------------------- */

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(ctx.finalUrl);
  } catch {
    parsedUrl = null;
  }

  if (parsedUrl) {
    const urlIssues: string[] = [];
    const path = parsedUrl.pathname;
    const segments = path.split("/").filter(Boolean);

    if (ctx.finalUrl.length > 115) {
      urlIssues.push("length");
      findings.push({
        id: "seo-url-too-long",
        category: "seo",
        severity: "info",
        title: `Long URL (${ctx.finalUrl.length} characters)`,
        detail:
          "Long URLs get truncated in search results and are awkward to share. They also tend to indicate deep, parameter-heavy routing rather than a clean information architecture.",
        fix: "Shorten the slug to the few words that describe the page. Aim for under 100 characters end to end.",
        value: clip(ctx.finalUrl, 200),
        docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure",
        weight: 1,
      });
    }

    if (/[A-Z]/.test(path)) {
      urlIssues.push("uppercase");
      findings.push({
        id: "seo-url-uppercase",
        category: "seo",
        severity: "warning",
        title: "Uppercase letters in the URL path",
        detail:
          "Paths are case-sensitive on most servers, so /About and /about can serve the same content at two URLs. That splits link signals and creates duplicate-content candidates.",
        fix: "Use lowercase URLs everywhere and 301-redirect mixed-case variants to the canonical lowercase form.",
        value: clip(path, 160),
        docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure",
        weight: 1,
      });
    }

    if (path.includes("_")) {
      urlIssues.push("underscores");
      findings.push({
        id: "seo-url-underscores",
        category: "seo",
        severity: "info",
        title: "Underscores in the URL path",
        detail:
          "Google treats hyphens as word separators but underscores as word joiners, so /solar_panel_install reads as one token rather than three.",
        fix: "Use hyphens between words in slugs. Redirect existing underscore URLs rather than changing them silently.",
        value: clip(path, 160),
        docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure",
        weight: 1,
      });
    }

    const params = Array.from(parsedUrl.searchParams.keys());
    if (params.length >= 3) {
      urlIssues.push("query string");
      findings.push({
        id: "seo-url-query-heavy",
        category: "seo",
        severity: "info",
        title: `URL carries ${params.length} query parameters`,
        detail:
          "Parameter-heavy URLs multiply into near-infinite crawl paths when parameters can be reordered or combined, wasting crawl budget on duplicates.",
        fix: "Move meaningful values into the path, and set a self-referencing canonical so parameter permutations consolidate onto one URL.",
        value: params.join(", "),
        docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure",
        weight: 1,
      });
    }

    if (segments.length > 4) {
      urlIssues.push("depth");
      findings.push({
        id: "seo-url-deep-path",
        category: "seo",
        severity: "info",
        title: `Deep URL path (${segments.length} segments)`,
        detail:
          "Deeply nested paths suggest the page sits many clicks from the homepage. Crawl priority drops with depth, and deep pages tend to accumulate fewer internal links.",
        fix: "Flatten the hierarchy where the extra nesting carries no meaning, and make sure deep pages are linked from higher-level hubs.",
        value: clip(path, 160),
        weight: 1,
      });
    }

    if (NON_ASCII_PATH.test(decodeURIComponentSafe(path)) || /%[0-9A-Fa-f]{2}/.test(path)) {
      urlIssues.push("non-ASCII");
      findings.push({
        id: "seo-url-non-ascii",
        category: "seo",
        severity: "info",
        title: "Non-ASCII or percent-encoded characters in the URL",
        detail:
          "Non-ASCII paths are percent-encoded on the wire, which makes them long and unreadable when shared, copied, or shown in search results.",
        fix: "Transliterate slugs to ASCII (\"münchen\" → \"muenchen\") unless the local-script URL is genuinely valuable to your audience.",
        value: clip(path, 160),
        docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure",
        weight: 1,
      });
    }

    if (urlIssues.length === 0) {
      findings.push({
        id: "seo-url-clean",
        category: "seo",
        severity: "pass",
        title: "Clean URL",
        detail: "The URL is short, lowercase, hyphenated, shallow and free of query clutter.",
        value: clip(ctx.finalUrl, 160),
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* hreflang                                                               */
  /* ---------------------------------------------------------------------- */

  const hreflangLinks = linksWithRel(doc.links, "alternate").filter(
    (link) => link.hreflang !== null && link.hreflang.trim() !== "",
  );

  if (hreflangLinks.length > 0) {
    const values = hreflangLinks.map((l) => (l.hreflang ?? "").trim());
    findings.push({
      id: "seo-hreflang-present",
      category: "seo",
      severity: "info",
      title: `${hreflangLinks.length} hreflang ${pluralise(hreflangLinks.length, "annotation")}`,
      detail: "The page declares localised alternates, telling search engines which language or region version to serve each user.",
      value: examples(values, 8),
      docs: "https://developers.google.com/search/docs/specialty/international/localized-versions",
      weight: 1,
    });

    const invalid = values.filter((v) => !isValidHreflangValue(v));
    if (invalid.length > 0) {
      findings.push({
        id: "seo-hreflang-invalid-code",
        category: "seo",
        severity: "warning",
        title: `${invalid.length} invalid hreflang ${pluralise(invalid.length, "value")}`,
        detail:
          "hreflang values must be an ISO 639-1 language code, optionally with an ISO 3166-1 Alpha-2 region (e.g. \"en\", \"en-AU\"), or the literal \"x-default\". Values that do not parse are ignored entirely, silently breaking the cluster.",
        fix: "Correct the malformed values. Common mistakes are country-only codes (\"uk\" instead of \"en-GB\") and underscores instead of hyphens.",
        snippet: '<link rel="alternate" hreflang="en-AU" href="https://example.com/au/">',
        value: examples(invalid, 8),
        docs: "https://developers.google.com/search/docs/specialty/international/localized-versions",
        weight: 2,
      });
    }

    const selfReferencing = hreflangLinks.some((link) => {
      const resolved = resolveHref(link.href, ctx.finalUrl);
      if (!resolved) return false;
      try {
        const current = new URL(ctx.finalUrl);
        return (
          resolved.host === current.host &&
          stripTrailingSlash(resolved.pathname) === stripTrailingSlash(current.pathname)
        );
      } catch {
        return false;
      }
    });
    if (!selfReferencing) {
      findings.push({
        id: "seo-hreflang-missing-self",
        category: "seo",
        severity: "warning",
        title: "hreflang set has no self-referencing entry",
        detail:
          "Every page in an hreflang cluster must list itself alongside its alternates. Without the self-reference the annotations are not reciprocal and Google discards the whole set.",
        fix: "Add a <link rel=\"alternate\"> for this page's own language pointing at this exact URL.",
        snippet: `<link rel="alternate" hreflang="${doc.lang ?? "en"}" href="${clip(ctx.finalUrl, 120)}">`,
        docs: "https://developers.google.com/search/docs/specialty/international/localized-versions",
        weight: 2,
      });
    } else {
      findings.push({
        id: "seo-hreflang-self-ok",
        category: "seo",
        severity: "pass",
        title: "hreflang set includes a self-reference",
        detail: "The page lists itself among its alternates, which is required for the cluster to be treated as reciprocal.",
        weight: 1,
      });
    }

    if (hreflangLinks.length > 1) {
      const hasXDefault = values.some((v) => v.toLowerCase() === "x-default");
      if (!hasXDefault) {
        findings.push({
          id: "seo-hreflang-no-x-default",
          category: "seo",
          severity: "info",
          title: "No x-default hreflang",
          detail:
            "With multiple localised versions and no x-default, search engines have no declared fallback for users whose language and region match none of your alternates.",
          fix: "Add an x-default entry pointing at your language-selector or most general version.",
          snippet: '<link rel="alternate" hreflang="x-default" href="https://example.com/">',
          docs: "https://developers.google.com/search/docs/specialty/international/localized-versions",
          weight: 1,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Pagination                                                             */
  /* ---------------------------------------------------------------------- */

  const nextLinks = linksWithRel(doc.links, "next");
  const prevLinks = linksWithRel(doc.links, "prev");
  if (nextLinks.length > 0 || prevLinks.length > 0) {
    const parts: string[] = [];
    if (prevLinks.length > 0) parts.push(`prev → ${prevLinks[0].href ?? "(no href)"}`);
    if (nextLinks.length > 0) parts.push(`next → ${nextLinks[0].href ?? "(no href)"}`);
    findings.push({
      id: "seo-pagination-rel",
      category: "seo",
      severity: "info",
      title: "Pagination rel=next/prev declared",
      detail:
        "The page declares rel=\"next\"/\"prev\" links. Google stopped using these as an indexing signal in 2019, but other crawlers and browsers still read them, and they document the sequence for maintainers.",
      fix: "Keep them if you like, but make sure each paginated page is also reachable through real, crawlable <a> links in the page body.",
      value: clip(parts.join(" | "), 220),
      docs: "https://developers.google.com/search/blog/2019/03/rel-next-prev",
      weight: 1,
    });
  }

  return findings;
}

/** decodeURIComponent that never throws on malformed input. */
function decodeURIComponentSafe(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}
