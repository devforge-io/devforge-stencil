/**
 * Open Graph and Twitter card checks: what a link to this page looks like when
 * it is pasted into Slack, LinkedIn, iMessage, Discord, Facebook or X.
 *
 * Self-contained by design - no shared helpers, so this module can evolve
 * independently of its sibling check modules.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

const OG_TITLE_MAX = 60;
const OG_DESCRIPTION_MAX = 200;
const OG_DESCRIPTION_MIN = 55;
const MIN_IMAGE_EDGE = 200;
const IDEAL_RATIO = 1.91;
const RATIO_LOW = 1.3;
const RATIO_HIGH = 2.6;

const VALID_TWITTER_CARDS = new Set([
  "summary",
  "summary_large_image",
  "app",
  "player",
]);

const KNOWN_OG_TYPES = new Set([
  "website",
  "article",
  "book",
  "profile",
  "music.song",
  "music.album",
  "music.playlist",
  "music.radio_station",
  "video.movie",
  "video.episode",
  "video.tv_show",
  "video.other",
  "product",
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function truncate(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Social meta tags are written with `property` per the OGP spec and with `name`
 * by many frameworks (and by Twitter's own docs). Accept either.
 */
function social(ctx: PageContext, key: string): string | null {
  const fromProperty = ctx.doc.metaByProperty[key];
  if (typeof fromProperty === "string" && fromProperty.trim().length > 0) {
    return fromProperty.trim();
  }
  const fromName = ctx.doc.metaByName[key];
  if (typeof fromName === "string" && fromName.trim().length > 0) {
    return fromName.trim();
  }
  return null;
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

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canonicalHref(ctx: PageContext): string | null {
  const link = ctx.doc.links.find((entry) =>
    entry.rel
      .toLowerCase()
      .split(/\s+/)
      .includes("canonical"),
  );
  if (link === undefined || link.href === null) return null;
  const href = link.href.trim();
  if (href.length === 0) return null;
  const resolved = safeUrl(href, ctx.finalUrl);
  return resolved === null ? href : resolved.href;
}

/** True when any Open Graph or Twitter tag exists in either meta map. */
function hasAnySocialTag(ctx: PageContext): boolean {
  const keys = [
    ...Object.keys(ctx.doc.metaByProperty),
    ...Object.keys(ctx.doc.metaByName),
  ];
  return keys.some((key) => {
    const lower = key.toLowerCase();
    return lower.startsWith("og:") || lower.startsWith("twitter:");
  });
}

function siteNameGuess(ctx: PageContext): string {
  const host = safeUrl(ctx.origin)?.hostname.replace(/^www\./, "");
  if (host === undefined) return "Your Site";
  const label = host.split(".")[0] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Check                                                                       */
/* -------------------------------------------------------------------------- */

export function opengraphChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;

  const pageTitle = typeof doc.title === "string" ? doc.title.trim() : "";
  const pageDescription =
    typeof doc.metaByName["description"] === "string"
      ? doc.metaByName["description"].trim()
      : "";
  const suggestedTitle = pageTitle.length > 0 ? truncate(pageTitle, OG_TITLE_MAX) : "Page title";
  const suggestedDescription =
    pageDescription.length > 0
      ? truncate(pageDescription, 180)
      : truncate(doc.textContent.length > 0 ? doc.textContent : "A one-sentence summary of this page.", 180);
  const site = siteNameGuess(ctx);

  const fullCardSnippet = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${site}">`,
    `<meta property="og:title" content="${suggestedTitle}">`,
    `<meta property="og:description" content="${suggestedDescription}">`,
    `<meta property="og:url" content="${ctx.finalUrl}">`,
    `<meta property="og:image" content="${ctx.origin}/og-image.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="Describe what the image shows">`,
    `<meta property="og:locale" content="en_AU">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");

  /* ---------------------------------------------------------------------- */
  /* Nothing at all - collapse to one high-signal finding                     */
  /* ---------------------------------------------------------------------- */

  if (!hasAnySocialTag(ctx)) {
    findings.push({
      id: "og-none",
      category: "opengraph",
      severity: "critical",
      title: "No social sharing tags at all",
      detail:
        "The page has no Open Graph or Twitter card markup whatsoever. Every share - Slack, LinkedIn, iMessage, WhatsApp, Discord, X, Facebook - renders as a bare blue URL with no image, no headline and no summary, which is the single biggest avoidable drop in click-through on shared links.",
      value: "0 og:* tags, 0 twitter:* tags",
      fix: "Add a full Open Graph block to the head, plus twitter:card so X uses the large-image layout. Generate a 1200x630 PNG for og:image and serve it from an absolute HTTPS URL.",
      snippet: fullCardSnippet,
      docs: "https://ogp.me/",
      weight: 10,
    });
    return findings;
  }

  /* ---------------------------------------------------------------------- */
  /* Required Open Graph properties                                          */
  /* ---------------------------------------------------------------------- */

  const ogTitle = social(ctx, "og:title");
  const ogDescription = social(ctx, "og:description");
  const ogImage = social(ctx, "og:image") ?? social(ctx, "og:image:url");
  const ogUrl = social(ctx, "og:url");
  const ogType = social(ctx, "og:type");
  const ogSiteName = social(ctx, "og:site_name");
  const ogLocale = social(ctx, "og:locale");

  if (ogTitle === null) {
    findings.push({
      id: "og-title-missing",
      category: "opengraph",
      severity: "warning",
      title: "Missing og:title",
      detail:
        "No og:title is declared, so scrapers fall back to the <title> tag. That title is written for a search result and usually carries a brand suffix and keyword phrasing that reads awkwardly as a card headline.",
      fix: "Add og:title with a punchier, human-facing version of the headline - no brand suffix needed, since og:site_name supplies that.",
      snippet: `<meta property="og:title" content="${suggestedTitle}">`,
      docs: "https://ogp.me/#metadata",
      weight: 3,
    });
  } else {
    if (ogTitle.length > OG_TITLE_MAX) {
      findings.push({
        id: "og-title-too-long",
        category: "opengraph",
        severity: "info",
        title: "og:title will be clipped on cards",
        detail: `og:title is ${ogTitle.length} characters. Most platforms show one or two lines and truncate around ${OG_TITLE_MAX}, so the end of the headline disappears behind an ellipsis.`,
        value: ogTitle,
        fix: `Shorten to about ${OG_TITLE_MAX} characters and put the compelling half first.`,
        snippet: `<meta property="og:title" content="${truncate(ogTitle, OG_TITLE_MAX)}">`,
        docs: "https://ogp.me/#metadata",
        weight: 1,
      });
    } else {
      findings.push({
        id: "og-title-ok",
        category: "opengraph",
        severity: "pass",
        title: "og:title is present and well sized",
        detail: `og:title is ${ogTitle.length} characters, which fits the headline area of a share card without truncation.`,
        value: ogTitle,
        weight: 2,
      });
    }

    if (pageTitle.length > 0 && ogTitle === pageTitle) {
      findings.push({
        id: "og-title-duplicates-title",
        category: "opengraph",
        severity: "info",
        title: "og:title is a straight copy of <title>",
        detail:
          "og:title is byte-identical to the <title> tag. That is not broken, but a search title is optimised for keyword matching while a card headline is optimised for a human deciding whether to tap - they rarely want the same wording.",
        value: ogTitle,
        fix: "Drop the brand suffix and any keyword scaffolding from og:title, and write it as a headline someone would click in a feed.",
        weight: 1,
      });
    }
  }

  if (ogDescription === null) {
    findings.push({
      id: "og-description-missing",
      category: "opengraph",
      severity: "warning",
      title: "Missing og:description",
      detail:
        "No og:description is declared. Platforms fall back to the meta description if one exists, and to nothing at all if it does not, leaving the card as a headline with dead space under it.",
      fix: "Add og:description with one or two sentences - up to about 200 characters - saying what someone gets from opening the link.",
      snippet: `<meta property="og:description" content="${suggestedDescription}">`,
      docs: "https://ogp.me/#optional",
      weight: 2,
    });
  } else {
    if (ogDescription.length > OG_DESCRIPTION_MAX) {
      findings.push({
        id: "og-description-too-long",
        category: "opengraph",
        severity: "info",
        title: "og:description overflows the card",
        detail: `og:description is ${ogDescription.length} characters. Facebook and LinkedIn cut off near ${OG_DESCRIPTION_MAX} and Slack shows even less, so the closing sentence is lost.`,
        value: ogDescription,
        fix: `Trim to about ${OG_DESCRIPTION_MAX} characters, front-loading the hook.`,
        snippet: `<meta property="og:description" content="${truncate(ogDescription, OG_DESCRIPTION_MAX)}">`,
        docs: "https://ogp.me/#optional",
        weight: 1,
      });
    } else if (ogDescription.length < OG_DESCRIPTION_MIN) {
      findings.push({
        id: "og-description-too-short",
        category: "opengraph",
        severity: "info",
        title: "og:description is very short",
        detail: `og:description is only ${ogDescription.length} characters, so the card body looks sparse next to competitors that fill the space.`,
        value: ogDescription,
        fix: "Expand to 100-200 characters with the specific benefit or the most interesting fact on the page.",
        weight: 1,
      });
    } else {
      findings.push({
        id: "og-description-ok",
        category: "opengraph",
        severity: "pass",
        title: "og:description is present and well sized",
        detail: `og:description is ${ogDescription.length} characters, which renders in full on the major platforms.`,
        value: ogDescription,
        weight: 1,
      });
    }

    if (pageDescription.length > 0 && ogDescription === pageDescription) {
      findings.push({
        id: "og-description-duplicates-meta",
        category: "opengraph",
        severity: "info",
        title: "og:description is a straight copy of the meta description",
        detail:
          "og:description repeats the meta description verbatim. A search snippet is written to match a query; a card body is written to make someone tap a link in a chat window. Adapting the copy typically lifts share click-through.",
        value: ogDescription,
        fix: "Rewrite og:description in a more conversational register, or lead with the single most shareable detail on the page.",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* og:image                                                                */
  /* ---------------------------------------------------------------------- */

  const ogImageWidth = toInt(social(ctx, "og:image:width"));
  const ogImageHeight = toInt(social(ctx, "og:image:height"));
  const ogImageAlt = social(ctx, "og:image:alt");
  const ogImageSecure = social(ctx, "og:image:secure_url");
  const ogImageType = social(ctx, "og:image:type");

  if (ogImage === null) {
    findings.push({
      id: "og-image-missing",
      category: "opengraph",
      severity: "critical",
      title: "Missing og:image",
      detail:
        "No og:image is declared, so every share of this page renders as a text-only link. The preview image is the difference between a rich card that occupies a third of the screen in a feed and a single line of blue text that scrolls past.",
      fix: "Create a 1200x630 PNG or JPEG with the page headline and your logo, host it at a stable absolute HTTPS URL, and declare it with og:image plus explicit width and height.",
      snippet: [
        `<meta property="og:image" content="${ctx.origin}/og-image.png">`,
        `<meta property="og:image:width" content="1200">`,
        `<meta property="og:image:height" content="630">`,
        `<meta property="og:image:alt" content="Describe what the image shows">`,
      ].join("\n"),
      docs: "https://developers.facebook.com/docs/sharing/webmasters/images/",
      weight: 8,
    });
  } else {
    const imageIsAbsolute = hasScheme(ogImage);
    const resolvedImage = safeUrl(ogImage, ctx.finalUrl);

    if (!imageIsAbsolute) {
      findings.push({
        id: "og-image-relative",
        category: "opengraph",
        severity: "critical",
        title: "og:image is a relative URL",
        detail:
          "The og:image value has no scheme or host. The Open Graph protocol requires an absolute URL, and Facebook, LinkedIn, X and Slack all fail to resolve relative paths - the card falls back to no image at all.",
        value: ogImage,
        fix: "Change og:image to the fully qualified absolute URL, including https:// and the host.",
        snippet: `<meta property="og:image" content="${resolvedImage ? resolvedImage.href : `${ctx.origin}/og-image.png`}">`,
        docs: "https://ogp.me/#metadata",
        weight: 6,
      });
    } else if (resolvedImage !== null && resolvedImage.protocol === "http:" && ctx.https) {
      findings.push({
        id: "og-image-insecure",
        category: "opengraph",
        severity: "warning",
        title: "og:image is served over plain HTTP",
        detail:
          "The page is HTTPS but the card image is an http:// URL. Several scrapers refuse mixed-scheme assets outright, and those that accept it may show a broken image placeholder.",
        value: ogImage,
        fix: "Serve the image over HTTPS and update og:image, or add og:image:secure_url with the HTTPS equivalent.",
        snippet: `<meta property="og:image" content="${ogImage.replace(/^http:/i, "https:")}">`,
        docs: "https://ogp.me/#structured",
        weight: 3,
      });
    } else {
      findings.push({
        id: "og-image-ok",
        category: "opengraph",
        severity: "pass",
        title: "og:image is declared with an absolute URL",
        detail: "A share image is set and uses a fully qualified URL that scrapers can fetch.",
        value: ogImage,
        weight: 4,
      });
    }

    if (ogImageWidth === null || ogImageHeight === null) {
      findings.push({
        id: "og-image-dimensions-missing",
        category: "opengraph",
        severity: "warning",
        title: "og:image has no declared dimensions",
        detail:
          "og:image:width and og:image:height are not both present. Without them a platform has to download and measure the image before it can lay the card out, so the first person to share the link sees a grey placeholder - sometimes permanently, if the scrape times out.",
        value:
          ogImageWidth !== null || ogImageHeight !== null
            ? `width=${ogImageWidth ?? "missing"}, height=${ogImageHeight ?? "missing"}`
            : "neither width nor height declared",
        fix: "Declare both dimensions in pixels immediately after og:image so the card can be laid out before the image finishes loading.",
        snippet: [
          `<meta property="og:image:width" content="1200">`,
          `<meta property="og:image:height" content="630">`,
        ].join("\n"),
        docs: "https://developers.facebook.com/docs/sharing/webmasters/images/",
        weight: 3,
      });
    } else {
      if (ogImageWidth < MIN_IMAGE_EDGE || ogImageHeight < MIN_IMAGE_EDGE) {
        findings.push({
          id: "og-image-too-small",
          category: "opengraph",
          severity: "warning",
          title: "og:image is below the minimum size",
          detail: `The declared image is ${ogImageWidth}x${ogImageHeight}. Platforms require at least ${MIN_IMAGE_EDGE}x${MIN_IMAGE_EDGE} to render any card and at least 600x315 for the large layout, so this either fails to render or is forced into a small thumbnail beside the text.`,
          value: `${ogImageWidth}x${ogImageHeight}`,
          fix: "Replace the asset with a 1200x630 image (the safe modern default) and update the declared dimensions to match.",
          docs: "https://developers.facebook.com/docs/sharing/webmasters/images/",
          weight: 3,
        });
      } else {
        const ratio = ogImageWidth / ogImageHeight;
        if (ratio < RATIO_LOW || ratio > RATIO_HIGH) {
          findings.push({
            id: "og-image-aspect-ratio",
            category: "opengraph",
            severity: "warning",
            title: "og:image aspect ratio is far from 1.91:1",
            detail: `The image is ${ogImageWidth}x${ogImageHeight}, an aspect ratio of ${ratio.toFixed(2)}:1. Cards are laid out for ${IDEAL_RATIO}:1, so the platform centre-crops - text near the top or bottom of your image gets cut off.`,
            value: `${ogImageWidth}x${ogImageHeight} (${ratio.toFixed(2)}:1)`,
            fix: "Re-export the share image at 1200x630 and keep any text inside the middle 80% so cropping on other platforms stays safe.",
            docs: "https://developers.facebook.com/docs/sharing/webmasters/images/",
            weight: 2,
          });
        } else {
          findings.push({
            id: "og-image-dimensions-ok",
            category: "opengraph",
            severity: "pass",
            title: "og:image dimensions are card-ready",
            detail: `The image is declared as ${ogImageWidth}x${ogImageHeight} (${ratio.toFixed(2)}:1), close enough to the 1.91:1 card layout to avoid cropping, and the explicit size lets platforms render the card before the image loads.`,
            value: `${ogImageWidth}x${ogImageHeight}`,
            weight: 2,
          });
        }
      }
    }

    if (ogImageAlt === null) {
      findings.push({
        id: "og-image-alt-missing",
        category: "opengraph",
        severity: "info",
        title: "og:image:alt is not set",
        detail:
          "The share image has no alternative text. Screen reader users on Facebook and LinkedIn hear nothing where the card image is, and platforms that surface alt text lose that context entirely.",
        fix: "Add og:image:alt describing what the image shows, not what the page is about - under 100 characters.",
        snippet: `<meta property="og:image:alt" content="Describe what the image shows">`,
        docs: "https://ogp.me/#structured",
        weight: 1,
      });
    } else {
      findings.push({
        id: "og-image-alt-ok",
        category: "opengraph",
        severity: "pass",
        title: "og:image:alt is set",
        detail: "The share image carries alternative text for assistive technology on social platforms.",
        value: ogImageAlt,
        weight: 1,
      });
    }

    if (ogImageType === null && ogImageSecure === null && ctx.https === false) {
      findings.push({
        id: "og-image-secure-url-missing",
        category: "opengraph",
        severity: "info",
        title: "No og:image:secure_url on a non-HTTPS page",
        detail:
          "The page is served over HTTP and declares no HTTPS variant of the share image, so scrapers embedding the card in a secure context may drop the image.",
        fix: "Serve the site over HTTPS, and in the meantime add og:image:secure_url with the https:// form of the image.",
        snippet: `<meta property="og:image:secure_url" content="${ogImage.replace(/^http:/i, "https:")}">`,
        docs: "https://ogp.me/#structured",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* og:url                                                                  */
  /* ---------------------------------------------------------------------- */

  const canonical = canonicalHref(ctx);

  if (ogUrl === null) {
    findings.push({
      id: "og-url-missing",
      category: "opengraph",
      severity: "warning",
      title: "Missing og:url",
      detail:
        "No og:url is declared. Platforms then key their engagement counts and their cached card off whatever URL was pasted, so the same page shared with different UTM parameters accumulates separate, fragmented like and share counts.",
      fix: "Add og:url with the canonical, absolute, parameter-free URL of this page.",
      snippet: `<meta property="og:url" content="${canonical ?? ctx.finalUrl}">`,
      docs: "https://ogp.me/#metadata",
      weight: 2,
    });
  } else if (!hasScheme(ogUrl)) {
    findings.push({
      id: "og-url-relative",
      category: "opengraph",
      severity: "warning",
      title: "og:url is relative",
      detail:
        "og:url must be an absolute URL. A relative value cannot be resolved by a scraper running on another host, so share counts and card caching break.",
      value: ogUrl,
      fix: "Use the fully qualified absolute URL including scheme and host.",
      snippet: `<meta property="og:url" content="${canonical ?? ctx.finalUrl}">`,
      docs: "https://ogp.me/#metadata",
      weight: 3,
    });
  } else if (canonical !== null && !sameUrl(ogUrl, canonical)) {
    findings.push({
      id: "og-url-canonical-mismatch",
      category: "opengraph",
      severity: "warning",
      title: "og:url does not match the canonical URL",
      detail:
        "og:url and the canonical link point at different addresses. Social engagement accrues to one URL while search consolidation happens on another, and some scrapers treat the disagreement as a signal that the metadata is stale.",
      value: `og:url=${ogUrl} vs canonical=${canonical}`,
      fix: "Set og:url to exactly the same absolute URL as rel=canonical.",
      snippet: `<meta property="og:url" content="${canonical}">`,
      docs: "https://ogp.me/#metadata",
      weight: 2,
    });
  } else if (!sameUrl(ogUrl, ctx.finalUrl)) {
    findings.push({
      id: "og-url-final-mismatch",
      category: "opengraph",
      severity: "warning",
      title: "og:url does not match the URL actually served",
      detail: `og:url points somewhere other than the address this page was served from, which sends every share and every scraper re-fetch to a different document than the one being viewed.`,
      value: `og:url=${ogUrl} vs served=${ctx.finalUrl}`,
      fix: `Set og:url to ${ctx.finalUrl}, or fix the redirect chain if the served URL is the wrong one.`,
      snippet: `<meta property="og:url" content="${ctx.finalUrl}">`,
      docs: "https://ogp.me/#metadata",
      weight: 2,
    });
  } else {
    findings.push({
      id: "og-url-ok",
      category: "opengraph",
      severity: "pass",
      title: "og:url is absolute and consistent",
      detail:
        "og:url is a fully qualified URL that agrees with the served address and the canonical link, so social engagement consolidates onto one address.",
      value: ogUrl,
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* og:type, og:site_name, og:locale                                        */
  /* ---------------------------------------------------------------------- */

  if (ogType === null) {
    findings.push({
      id: "og-type-missing",
      category: "opengraph",
      severity: "warning",
      title: "Missing og:type",
      detail:
        'og:type is a required Open Graph property. Without it scrapers assume "website", which means article-specific fields such as publication date and author are ignored even when you supply them.',
      fix: 'Add og:type - "website" for landing and index pages, "article" for posts and news, "product" for commerce pages.',
      snippet: `<meta property="og:type" content="${doc.landmarks.includes("article") ? "article" : "website"}">`,
      docs: "https://ogp.me/#types",
      weight: 2,
    });
  } else if (!KNOWN_OG_TYPES.has(ogType.toLowerCase())) {
    findings.push({
      id: "og-type-unknown",
      category: "opengraph",
      severity: "info",
      title: "og:type is not a recognised value",
      detail:
        "The declared og:type is not one of the types defined by the Open Graph protocol, so consumers fall back to generic website handling and any type-specific properties you declared are discarded.",
      value: ogType,
      fix: 'Use a standard type such as "website", "article", "profile", "book", "product" or one of the music/video subtypes.',
      docs: "https://ogp.me/#types",
      weight: 1,
    });
  } else {
    findings.push({
      id: "og-type-ok",
      category: "opengraph",
      severity: "pass",
      title: "og:type is declared",
      detail: "A recognised Open Graph type is set, so platforms apply the right card treatment.",
      value: ogType,
      weight: 1,
    });

    if (ogType.toLowerCase() === "article") {
      const publishedTime = social(ctx, "article:published_time");
      const articleAuthor = social(ctx, "article:author");
      if (publishedTime === null || articleAuthor === null) {
        findings.push({
          id: "og-article-metadata-incomplete",
          category: "opengraph",
          severity: "info",
          title: "Article card is missing its byline metadata",
          detail: `og:type is "article" but ${[
            publishedTime === null ? "article:published_time" : null,
            articleAuthor === null ? "article:author" : null,
          ]
            .filter((entry): entry is string => entry !== null)
            .join(" and ")} ${publishedTime === null && articleAuthor === null ? "are" : "is"} absent, so platforms that show a date or byline on article cards have nothing to display.`,
          fix: "Add article:published_time as an ISO 8601 timestamp and article:author pointing at the author's profile URL or name.",
          snippet: [
            `<meta property="article:published_time" content="2026-01-15T09:00:00+10:00">`,
            `<meta property="article:author" content="${ctx.origin}/about">`,
          ].join("\n"),
          docs: "https://ogp.me/#type_article",
          weight: 1,
        });
      }
    }
  }

  if (ogSiteName === null) {
    findings.push({
      id: "og-site-name-missing",
      category: "opengraph",
      severity: "info",
      title: "No og:site_name",
      detail:
        "og:site_name is absent, so cards show the bare hostname above the headline instead of your brand as you write it. It is one tag and it is the only branding on an otherwise generic card.",
      fix: "Add og:site_name with the brand exactly as you want it displayed.",
      snippet: `<meta property="og:site_name" content="${site}">`,
      docs: "https://ogp.me/#optional",
      weight: 1,
    });
  } else {
    findings.push({
      id: "og-site-name-ok",
      category: "opengraph",
      severity: "pass",
      title: "og:site_name is set",
      detail: "Cards display your brand name rather than the raw hostname.",
      value: ogSiteName,
      weight: 1,
    });
  }

  if (ogLocale === null) {
    findings.push({
      id: "og-locale-missing",
      category: "opengraph",
      severity: "info",
      title: "No og:locale",
      detail:
        'og:locale is absent, so scrapers default to en_US. That affects date and number formatting on some platforms and, on multilingual sites, which alternate version gets surfaced.',
      fix: "Add og:locale in language_TERRITORY form, and og:locale:alternate for each translated version of the page.",
      snippet: `<meta property="og:locale" content="${
        typeof doc.lang === "string" && doc.lang.trim().length > 0
          ? doc.lang.trim().replace("-", "_")
          : "en_AU"
      }">`,
      docs: "https://ogp.me/#optional",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Duplicate Open Graph declarations                                       */
  /* ---------------------------------------------------------------------- */

  const duplicatedOg = ["og:title", "og:description", "og:url", "og:type", "og:site_name"].filter(
    (key) => duplicateCount(ctx, key) > 0,
  );
  if (duplicatedOg.length > 0) {
    findings.push({
      id: "og-duplicate-tags",
      category: "opengraph",
      severity: "warning",
      title: "Duplicate Open Graph tags",
      detail: `These properties are declared more than once: ${duplicatedOg.join(", ")}. Facebook takes the first occurrence and most other scrapers take the last, so different platforms render different cards from the same page.`,
      value: duplicatedOg.join(", "),
      fix: "Emit each Open Graph property exactly once. Duplicates usually mean a layout default and a page-level override are both rendering instead of merging.",
      docs: "https://ogp.me/#metadata",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Twitter / X card                                                        */
  /* ---------------------------------------------------------------------- */

  const twitterCard = social(ctx, "twitter:card");
  const twitterTitle = social(ctx, "twitter:title");
  const twitterDescription = social(ctx, "twitter:description");
  const twitterImage = social(ctx, "twitter:image") ?? social(ctx, "twitter:image:src");
  const twitterImageAlt = social(ctx, "twitter:image:alt");
  const twitterSite = social(ctx, "twitter:site");
  const twitterCreator = social(ctx, "twitter:creator");

  if (twitterCard === null) {
    findings.push({
      id: "og-twitter-card-missing",
      category: "opengraph",
      severity: "warning",
      title: "No twitter:card declared",
      detail:
        "X falls back to Open Graph when twitter:card is absent, but it defaults to the small summary layout - a thumbnail beside the text rather than the full-width image. You keep a card, you lose the format that actually gets noticed.",
      fix: 'Add twitter:card with "summary_large_image" when you have a 1200x630 image, or "summary" for a square thumbnail.',
      snippet: `<meta name="twitter:card" content="summary_large_image">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/overview/abouts-cards",
      weight: 2,
    });
  } else if (!VALID_TWITTER_CARDS.has(twitterCard.toLowerCase())) {
    findings.push({
      id: "og-twitter-card-invalid",
      category: "opengraph",
      severity: "warning",
      title: "twitter:card value is not valid",
      detail:
        "The twitter:card value is not one of the four card types X accepts, so the declaration is discarded and the card falls back to the default summary layout.",
      value: twitterCard,
      fix: 'Use exactly one of: summary, summary_large_image, app, player. Note the underscores in summary_large_image.',
      snippet: `<meta name="twitter:card" content="summary_large_image">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/overview/abouts-cards",
      weight: 2,
    });
  } else {
    findings.push({
      id: "og-twitter-card-ok",
      category: "opengraph",
      severity: "pass",
      title: "twitter:card is set to a valid type",
      detail: "X renders the card layout you asked for rather than guessing from Open Graph.",
      value: twitterCard,
      weight: 2,
    });

    if (twitterCard.toLowerCase() === "summary_large_image" && ogImage === null && twitterImage === null) {
      findings.push({
        id: "og-twitter-large-image-without-image",
        category: "opengraph",
        severity: "warning",
        title: "summary_large_image card has no image to show",
        detail:
          "twitter:card requests the large-image layout but neither twitter:image nor og:image is declared, so X downgrades the card to a plain text summary.",
        fix: "Supply a 1200x630 image via og:image (X uses it as a fallback) or twitter:image.",
        snippet: `<meta name="twitter:image" content="${ctx.origin}/og-image.png">`,
        docs: "https://developer.x.com/en/docs/x-for-websites/cards/overview/abouts-cards",
        weight: 3,
      });
    }
  }

  if (twitterTitle === null && ogTitle === null) {
    findings.push({
      id: "og-twitter-title-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:title and no og:title",
      detail:
        "Neither the X-specific title nor the Open Graph title exists, so the card headline falls all the way back to the <title> tag.",
      fix: "Add og:title at minimum; add twitter:title only when you want different wording on X.",
      snippet: `<meta name="twitter:title" content="${suggestedTitle}">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  }

  if (twitterDescription === null && ogDescription === null) {
    findings.push({
      id: "og-twitter-description-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:description and no og:description",
      detail:
        "The card body will be empty on X: neither the X-specific description nor the Open Graph description is present.",
      fix: "Add og:description, which X uses as its fallback, and override with twitter:description only if the copy should differ.",
      snippet: `<meta name="twitter:description" content="${suggestedDescription}">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  }

  if (twitterImage === null && ogImage !== null) {
    findings.push({
      id: "og-twitter-image-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:image - relying on the Open Graph fallback",
      detail:
        "twitter:image is absent, so X uses og:image. That works, but it means you cannot serve a different crop for the 2:1 X layout when your og:image has text near the edges.",
      fix: "Leave as-is unless the card crops badly on X; if it does, add twitter:image with a purpose-built version.",
      snippet: `<meta name="twitter:image" content="${ctx.origin}/twitter-card.png">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  } else if (twitterImage !== null && !hasScheme(twitterImage)) {
    findings.push({
      id: "og-twitter-image-relative",
      category: "opengraph",
      severity: "warning",
      title: "twitter:image is a relative URL",
      detail:
        "X requires an absolute URL for twitter:image. A relative path cannot be resolved by the card scraper, so the image silently fails to render.",
      value: twitterImage,
      fix: "Use the fully qualified absolute HTTPS URL.",
      snippet: `<meta name="twitter:image" content="${safeUrl(twitterImage, ctx.finalUrl)?.href ?? `${ctx.origin}/twitter-card.png`}">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 3,
    });
  }

  if (twitterImageAlt === null && (twitterImage !== null || ogImage !== null)) {
    findings.push({
      id: "og-twitter-image-alt-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:image:alt",
      detail:
        "The card image has no alt text for X, where alt text on media is surfaced to screen readers and to users who tap the ALT badge.",
      fix: "Add twitter:image:alt describing the image, up to 420 characters.",
      snippet: `<meta name="twitter:image:alt" content="Describe what the image shows">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  }

  if (twitterSite === null) {
    findings.push({
      id: "og-twitter-site-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:site handle",
      detail:
        "twitter:site attributes the card to your account, which adds a follow affordance on the card and feeds X's analytics for links to your domain.",
      fix: "Add twitter:site with your brand's @handle.",
      snippet: `<meta name="twitter:site" content="@yourhandle">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  } else if (!twitterSite.startsWith("@")) {
    findings.push({
      id: "og-twitter-handle-format",
      category: "opengraph",
      severity: "info",
      title: "twitter:site is not in @handle form",
      detail:
        "The twitter:site value does not start with @. X expects the handle form and ignores full profile URLs or bare usernames in some contexts.",
      value: twitterSite,
      fix: "Rewrite the value as @handle.",
      snippet: `<meta name="twitter:site" content="@${twitterSite.replace(/^.*\//, "").replace(/^@/, "")}">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  }

  if (twitterCreator === null && (ogType?.toLowerCase() === "article" || doc.landmarks.includes("article"))) {
    findings.push({
      id: "og-twitter-creator-missing",
      category: "opengraph",
      severity: "info",
      title: "No twitter:creator on editorial content",
      detail:
        "This looks like an article but no twitter:creator is declared, so the author gets no attribution on the card when the piece is shared.",
      fix: "Add twitter:creator with the author's @handle.",
      snippet: `<meta name="twitter:creator" content="@authorhandle">`,
      docs: "https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Overall card health                                                     */
  /* ---------------------------------------------------------------------- */

  if (
    ogTitle !== null &&
    ogDescription !== null &&
    ogImage !== null &&
    hasScheme(ogImage) &&
    ogUrl !== null &&
    ogType !== null &&
    twitterCard !== null
  ) {
    findings.push({
      id: "og-card-complete",
      category: "opengraph",
      severity: "pass",
      title: "Share card is complete",
      detail:
        "Title, description, absolute image, URL, type and twitter:card are all present, which is everything the major platforms need to render a full rich preview.",
      value: `${ogType} card for "${truncate(ogTitle, 80)}"`,
      weight: 3,
    });
  }

  return findings;
}
