/**
 * Technical checks: HTTP status, redirect behaviour, https enforcement,
 * host/trailing-slash consistency, 404 handling, favicons and manifests,
 * charset placement, legacy markup and mixed content.
 *
 * Meta tags, Open Graph, structured data and the SEO/accessibility angles on
 * this markup belong to other check modules.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function trim(input: string, max = 180): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function list(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((v) => trim(v, 90));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

function plural(n: number, singular: string, many?: string): string {
  return n === 1 ? singular : (many ?? `${singular}s`);
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function relTokenList(rel: string | null): string[] {
  if (!rel) return [];
  return rel.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Count non-overlapping matches of a global regex without mutating callers' state. */
function countMatches(html: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let total = 0;
  while (re.exec(html) !== null) {
    total += 1;
    if (total > 5000) break;
  }
  return total;
}

/** True when a resource URL is plain http, i.e. mixed content on an https page. */
function isInsecure(url: string | null): boolean {
  if (!url) return false;
  return /^http:\/\//i.test(url.trim());
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const LEGACY_TAGS = /<(center|font|marquee|blink|frameset|big|strike|tt)\b/gi;
const DOCUMENT_WRITE = /document\s*\.\s*write(?:ln)?\s*\(/gi;
const INLINE_HANDLER =
  /\son(?:click|load|error|change|submit|focus|blur|mouseover|mouseout|mousedown|mouseup|keydown|keyup|keypress|input|dblclick)\s*=\s*["']/gi;
const STYLE_BLOCK = /<style[\s>]/gi;
const X_UA_COMPATIBLE = /<meta[^>]+http-equiv\s*=\s*["']?x-ua-compatible["']?[^>]*>/i;
const FLASH_OBJECT =
  /(application\/x-shockwave-flash|\.swf\b|classid\s*=\s*["']?clsid:d27cdb6e|application\/x-silverlight|\.xap\b)/i;

/* -------------------------------------------------------------------------- */
/* Check module                                                               */
/* -------------------------------------------------------------------------- */

export function technicalChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;
  const html = ctx.html;
  const finalUrl = parseUrl(ctx.finalUrl);
  const requestedUrl = parseUrl(ctx.requestedUrl);

  /* ---------------------------------------------------------------------- */
  /* HTTP status                                                            */
  /* ---------------------------------------------------------------------- */

  const status = ctx.finalStatus;
  if (status >= 500) {
    findings.push({
      id: "tech-status-server-error",
      category: "technical",
      severity: "critical",
      title: `Server error (HTTP ${status})`,
      detail:
        "The final document responded with a 5xx. Search engines drop persistently failing URLs from the index and back off crawling the whole host, and every visitor sees an error page.",
      fix: "Fix the server-side failure. If the outage is planned, return 503 with a Retry-After header so crawlers retry instead of de-indexing.",
      value: `HTTP ${status} at ${trim(ctx.finalUrl, 120)}`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors",
      weight: 5,
    });
  } else if (status >= 400) {
    findings.push({
      id: "tech-status-client-error",
      category: "technical",
      severity: "critical",
      title: `Page returns HTTP ${status}`,
      detail:
        "The audited URL responded with a client error, so this page does not exist as far as browsers and crawlers are concerned. Any inbound links or rankings it once had are lost.",
      fix: status === 404
        ? "Restore the page, or 301-redirect the URL to the closest equivalent so link equity is preserved."
        : "Check authentication, geo-blocking and bot filtering - crawlers are being refused this URL.",
      value: `HTTP ${status} at ${trim(ctx.finalUrl, 120)}`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors",
      weight: 5,
    });
  } else if (status >= 300) {
    findings.push({
      id: "tech-status-unresolved-redirect",
      category: "technical",
      severity: "warning",
      title: `Final response is still a redirect (HTTP ${status})`,
      detail:
        "After following the redirect chain the document still returns a 3xx. That usually means a redirect loop, a chain longer than the client would follow, or a redirect with no Location header.",
      fix: "Trace the chain and make sure it terminates on a 200 response within one or two hops.",
      value: `HTTP ${status}`,
      weight: 3,
    });
  } else {
    findings.push({
      id: "tech-status-ok",
      category: "technical",
      severity: "pass",
      title: `Page responds HTTP ${status}`,
      detail: "The document is served successfully, which is the precondition for everything else on this report.",
      value: trim(ctx.finalUrl, 140),
      weight: 3,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Redirects                                                              */
  /* ---------------------------------------------------------------------- */

  const hops = ctx.redirects;
  if (hops.length === 0) {
    findings.push({
      id: "tech-redirect-none",
      category: "technical",
      severity: "pass",
      title: "No redirects",
      detail: "The requested URL served the document directly, with no latency spent on intermediate hops.",
      weight: 1,
    });
  } else {
    const chain = hops.map((hop) => `${hop.status} ${trim(hop.from, 70)} → ${trim(hop.to, 70)}`);
    findings.push({
      id: "tech-redirect-chain",
      category: "technical",
      severity: "info",
      title: `${hops.length} ${plural(hops.length, "redirect")} followed`,
      detail:
        "The requested URL did not serve the document directly. Redirects are normal, but each hop costs a round trip and every internal link pointing at the pre-redirect URL pays that cost.",
      fix: "Update internal links, sitemaps and canonical tags to point at the final URL so the redirect only ever serves external traffic.",
      value: list(chain, 6),
      docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
      weight: 1,
    });

    if (hops.length > 2) {
      findings.push({
        id: "tech-redirect-chain-long",
        category: "technical",
        severity: "warning",
        title: `Redirect chain is ${hops.length} hops long`,
        detail:
          "Chains longer than two hops waste crawl budget, add latency on every request, and risk being abandoned - Googlebot follows a limited number of hops per crawl before giving up and retrying later.",
        fix: "Collapse the chain to a single 301 from the original URL straight to the final destination.",
        value: list(chain, 6),
        docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
        weight: 2,
      });
    }

    const temporary = hops.filter((hop) => hop.status === 302 || hop.status === 307);
    if (temporary.length > 0) {
      findings.push({
        id: "tech-redirect-temporary",
        category: "technical",
        severity: "info",
        title: `${temporary.length} temporary ${plural(temporary.length, "redirect")} in the chain`,
        detail:
          "302/307 tells search engines the move is temporary, so they keep the old URL indexed and do not consolidate signals onto the destination. That is correct for genuinely temporary moves and wrong for permanent ones.",
        fix: "Use 301 (or 308) for permanent moves so ranking signals transfer to the destination.",
        value: list(temporary.map((hop) => `${hop.status} ${trim(hop.from, 70)}`)),
        docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
        weight: 1,
      });
    }

    const upgraded = hops.some((hop) => /^http:\/\//i.test(hop.from) && /^https:\/\//i.test(hop.to));
    if (upgraded) {
      findings.push({
        id: "tech-redirect-https-upgrade",
        category: "technical",
        severity: "pass",
        title: "http upgraded to https",
        detail: "The chain includes an http → https upgrade, so insecure requests are forced onto TLS rather than served in the clear.",
        weight: 2,
      });
    }

    const lastHop = hops[hops.length - 1];
    const startHost = parseUrl(hops[0].from)?.host ?? requestedUrl?.host ?? null;
    const endHost = parseUrl(lastHop.to)?.host ?? finalUrl?.host ?? null;
    const bareHost = (host: string): string => host.replace(/^www\./i, "");
    if (startHost && endHost && bareHost(startHost) !== bareHost(endHost)) {
      findings.push({
        id: "tech-redirect-cross-host",
        category: "technical",
        severity: "info",
        title: "Redirect ends on a different host",
        detail:
          "The chain finishes on a different domain than it started - not just a www variant. That is expected during a domain migration, but a surprise cross-host redirect can mean a stale DNS record, a parked-domain forwarder, or an unintended CDN rule.",
        fix: "Confirm this is intentional. For a permanent migration, use 301s and keep them in place indefinitely.",
        value: `${startHost} → ${endHost}`,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* https enforcement                                                      */
  /* ---------------------------------------------------------------------- */

  const httpsRedirect = ctx.httpsRedirect;
  if (httpsRedirect && httpsRedirect.checked) {
    if (!httpsRedirect.redirectsToHttps) {
      findings.push({
        id: "tech-https-not-enforced",
        category: "technical",
        severity: "warning",
        title: "http is served without redirecting to https",
        detail:
          "Requesting the origin over plain http did not redirect to https. The insecure version stays reachable, browsers may flag it as \"Not secure\", and the same content living at two schemes is a duplicate-content split.",
        fix: "301-redirect every http request to its https equivalent at the edge, then add HSTS once you are confident the redirect is total.",
        snippet: "Strict-Transport-Security: max-age=31536000; includeSubDomains",
        docs: "https://web.dev/articles/why-https-matters",
        weight: 2,
      });
    } else {
      findings.push({
        id: "tech-https-enforced",
        category: "technical",
        severity: "pass",
        title: "http redirects to https",
        detail: "Insecure requests are upgraded automatically, so visitors never land on an unencrypted version of the site.",
        weight: 2,
      });
    }
  }

  if (!ctx.https) {
    findings.push({
      id: "tech-final-url-insecure",
      category: "technical",
      severity: "critical",
      title: "Page is served over http",
      detail:
        "The final document is not encrypted. Browsers mark http pages as \"Not secure\", block modern APIs on them, and https has been a (light) ranking signal since 2014. Anything typed into this page travels in plaintext.",
      fix: "Install a TLS certificate (Let's Encrypt is free and automatable) and redirect all http traffic to https.",
      value: trim(ctx.finalUrl, 140),
      docs: "https://web.dev/articles/why-https-matters",
      weight: 4,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Host and path consistency                                              */
  /* ---------------------------------------------------------------------- */

  if (requestedUrl && finalUrl) {
    const requestedWww = requestedUrl.hostname.startsWith("www.");
    const finalWww = finalUrl.hostname.startsWith("www.");
    if (requestedUrl.hostname !== finalUrl.hostname && requestedWww !== finalWww) {
      findings.push({
        id: "tech-www-normalised",
        category: "technical",
        severity: "info",
        title: `Host normalised to the ${finalWww ? "www" : "bare"} domain`,
        detail:
          "The requested hostname was redirected to the other www variant. Picking one canonical host is correct - just make sure every internal link, sitemap entry and canonical tag already uses it, so no visitor pays for the redirect twice.",
        value: `${requestedUrl.hostname} → ${finalUrl.hostname}`,
        weight: 1,
      });
    } else if (requestedUrl.hostname === finalUrl.hostname) {
      findings.push({
        id: "tech-host-consistent",
        category: "technical",
        severity: "pass",
        title: "Hostname served as requested",
        detail: "The requested host serves the document directly with no www normalisation redirect.",
        value: finalUrl.hostname,
        weight: 1,
      });
    }
  }

  const canonicalLink = doc.links.find((link) => relTokenList(link.rel).includes("canonical"));
  if (canonicalLink?.href && finalUrl) {
    const canonicalUrl = parseUrl(canonicalLink.href) ?? parseUrl(new URL(canonicalLink.href, ctx.finalUrl).toString());
    if (
      canonicalUrl &&
      canonicalUrl.host === finalUrl.host &&
      canonicalUrl.pathname !== finalUrl.pathname &&
      stripSlash(canonicalUrl.pathname) === stripSlash(finalUrl.pathname)
    ) {
      findings.push({
        id: "tech-trailing-slash-mismatch",
        category: "technical",
        severity: "info",
        title: "Trailing slash differs between the URL and its canonical",
        detail:
          "The served URL and the canonical it declares differ only by a trailing slash. Servers treat these as two URLs, so both can be crawled and linked, splitting signals until the canonical is honoured.",
        fix: "Pick one form, enforce it with a 301 at the edge, and emit canonical tags and internal links in that same form.",
        value: `served ${trim(finalUrl.pathname, 80)} | canonical ${trim(canonicalUrl.pathname, 80)}`,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 404 handling                                                           */
  /* ---------------------------------------------------------------------- */

  const probe = ctx.notFoundProbe;
  if (probe) {
    if (probe.isSoft404 || (probe.status >= 200 && probe.status < 300)) {
      findings.push({
        id: "tech-soft-404",
        category: "technical",
        severity: "warning",
        title: `Nonexistent URLs return HTTP ${probe.status}`,
        detail:
          "A deliberately invalid path responded with a success status instead of 404. Every mistyped link, stale URL and crawler guess then looks like a real page: crawl budget is spent on them and empty \"not found\" pages can end up indexed.",
        fix: "Return a real 404 (or 410) status code for missing pages. A friendly error page is good - it just has to be served with the right status.",
        snippet: "// React Router: throw a Response so the status reaches the client\nthrow new Response(\"Not Found\", { status: 404 });",
        value: `probe returned HTTP ${probe.status}`,
        docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors",
        weight: 2,
      });
    } else if (probe.status === 404 || probe.status === 410) {
      findings.push({
        id: "tech-404-handling-ok",
        category: "technical",
        severity: "pass",
        title: "Missing pages return a proper 404",
        detail: "A nonexistent path responded with the correct status, so crawlers drop bad URLs instead of indexing empty pages.",
        value: `probe returned HTTP ${probe.status}`,
        weight: 2,
      });
    } else {
      findings.push({
        id: "tech-404-unexpected-status",
        category: "technical",
        severity: "info",
        title: `Nonexistent URL returned HTTP ${probe.status}`,
        detail:
          "A path that should not exist responded with something other than 404, 410 or 200. Redirecting all unknown URLs to the homepage is the most common cause, and it hides genuine broken links from your analytics.",
        fix: "Serve 404 for unknown paths rather than redirecting them to the homepage.",
        value: `probe returned HTTP ${probe.status}`,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Icons and manifest                                                     */
  /* ---------------------------------------------------------------------- */

  if (!ctx.faviconOk) {
    findings.push({
      id: "tech-favicon-missing",
      category: "technical",
      severity: "info",
      title: "No favicon found",
      detail:
        "No usable favicon was served. Google shows a favicon beside every mobile search result and browsers show one in every tab and bookmark; without one the site gets a generic globe.",
      fix: "Serve /favicon.ico and link an SVG or PNG icon from the head. The icon must be crawlable and at least 8×8 for Google to use it.",
      snippet: '<link rel="icon" href="/favicon.ico" sizes="32x32">\n<link rel="icon" href="/icon.svg" type="image/svg+xml">',
      docs: "https://developers.google.com/search/docs/appearance/favicon-in-search",
      weight: 1,
    });
  } else {
    findings.push({
      id: "tech-favicon-ok",
      category: "technical",
      severity: "pass",
      title: "Favicon available",
      detail: "A favicon is served, so browsers and search results can show the site's icon.",
      weight: 1,
    });
  }

  const appleTouchIcon = doc.links.some((link) => {
    const tokens = relTokenList(link.rel);
    return tokens.includes("apple-touch-icon") || tokens.includes("apple-touch-icon-precomposed");
  });
  if (!appleTouchIcon) {
    findings.push({
      id: "tech-apple-touch-icon-missing",
      category: "technical",
      severity: "info",
      title: "No apple-touch-icon",
      detail:
        "iOS uses apple-touch-icon for home-screen bookmarks. Without one Safari screenshots the page and uses that, which almost always looks broken at icon size.",
      fix: "Add a 180×180 PNG and link it from the head.",
      snippet: '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel#apple-touch-icon",
      weight: 1,
    });
  } else {
    findings.push({
      id: "tech-apple-touch-icon-ok",
      category: "technical",
      severity: "pass",
      title: "apple-touch-icon declared",
      detail: "iOS home-screen bookmarks will show a proper icon rather than a page screenshot.",
      weight: 1,
    });
  }

  const manifest = ctx.manifest;
  if (!manifest) {
    findings.push({
      id: "tech-manifest-missing",
      category: "technical",
      severity: "info",
      title: "No web app manifest",
      detail:
        "No manifest was linked from the document. A manifest is what lets a site be installed to a home screen with its own name, icon, theme colour and launch behaviour. Optional for a content site; required for anything installable.",
      fix: "Add a manifest.webmanifest and link it from the head.",
      snippet: '<link rel="manifest" href="/site.webmanifest">',
      docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest",
      weight: 1,
    });
  } else if (!manifest.ok || !manifest.parsed) {
    findings.push({
      id: "tech-manifest-unreadable",
      category: "technical",
      severity: "warning",
      title: "Manifest is linked but could not be read",
      detail:
        "The document links a web app manifest, but fetching or parsing it failed. A broken manifest is worse than none: the install prompt silently never appears and there is no browser-visible error.",
      fix: "Check the manifest URL resolves, is served as application/manifest+json, and contains valid JSON.",
      value: trim(manifest.url, 140),
      docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest",
      weight: 2,
    });
  } else {
    const parsed = manifest.parsed;
    const missingKeys: string[] = [];

    const name = parsed["name"];
    const shortName = parsed["short_name"];
    if (typeof name !== "string" || name.trim() === "") {
      if (typeof shortName !== "string" || shortName.trim() === "") {
        missingKeys.push("name");
        findings.push({
          id: "tech-manifest-name-missing",
          category: "technical",
          severity: "warning",
          title: "Manifest has no name",
          detail:
            "Neither name nor short_name is set. Installed apps then show up on the home screen and in the app switcher with the URL or an empty label.",
          fix: 'Set "name" (full title, used on the splash screen) and "short_name" (12 characters or fewer, used under the icon).',
          snippet: '{\n  "name": "Acme Solar Portal",\n  "short_name": "Acme"\n}',
          docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest/name",
          weight: 2,
        });
      }
    }

    const icons = parsed["icons"];
    if (!Array.isArray(icons) || icons.length === 0) {
      missingKeys.push("icons");
      findings.push({
        id: "tech-manifest-icons-missing",
        category: "technical",
        severity: "warning",
        title: "Manifest declares no icons",
        detail:
          "Without icons the browser cannot render an install prompt at all - Chrome requires at least a 192×192 and a 512×512 PNG before it will offer installation.",
        fix: "Add an icons array with 192×192 and 512×512 entries, plus a maskable variant for Android adaptive icons.",
        snippet: '"icons": [\n  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },\n  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },\n  { "src": "/icon-mask.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }\n]',
        docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest/icons",
        weight: 2,
      });
    }

    const startUrl = parsed["start_url"];
    if (typeof startUrl !== "string" || startUrl.trim() === "") {
      missingKeys.push("start_url");
      findings.push({
        id: "tech-manifest-start-url-missing",
        category: "technical",
        severity: "warning",
        title: "Manifest has no start_url",
        detail:
          "start_url defines where the app opens from the home screen. Without it the browser falls back to the manifest's own location, so the installed app can launch on the wrong page.",
        fix: 'Set "start_url" to the app\'s entry point. A tracking parameter is a useful way to measure installs.',
        snippet: '"start_url": "/?source=pwa"',
        docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest/start_url",
        weight: 2,
      });
    }

    const display = parsed["display"];
    if (typeof display !== "string" || display.trim() === "") {
      missingKeys.push("display");
      findings.push({
        id: "tech-manifest-display-missing",
        category: "technical",
        severity: "warning",
        title: "Manifest has no display mode",
        detail:
          'display controls whether the installed app opens chrome-less. Omitting it defaults to "browser", which means the "installed" app is just a bookmark that opens a normal tab.',
        fix: 'Set "display" to "standalone" (or "minimal-ui") so the app opens in its own window.',
        snippet: '"display": "standalone"',
        docs: "https://developer.mozilla.org/en-US/docs/Web/Manifest/display",
        weight: 1,
      });
    }

    if (missingKeys.length === 0) {
      findings.push({
        id: "tech-manifest-ok",
        category: "technical",
        severity: "pass",
        title: "Web app manifest is complete",
        detail: "The manifest declares a name, icons, start_url and display mode - everything a browser needs to offer installation.",
        value: trim(manifest.url, 140),
        weight: 2,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Charset                                                                */
  /* ---------------------------------------------------------------------- */

  const charsetIndex = html.slice(0, 1024).toLowerCase().indexOf("charset");
  if (!doc.charset) {
    findings.push({
      id: "tech-charset-missing",
      category: "technical",
      severity: "warning",
      title: "No character encoding declared",
      detail:
        "The document declares no charset. Browsers then guess, and a wrong guess turns curly quotes, em dashes and any non-English text into mojibake. Some browsers also refuse to sniff, treating an undeclared page as a security risk.",
      fix: "Declare UTF-8 as the very first thing in <head>.",
      snippet: '<meta charset="utf-8">',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta#charset",
      weight: 2,
    });
  } else {
    if (charsetIndex === -1) {
      findings.push({
        id: "tech-charset-late",
        category: "technical",
        severity: "info",
        title: "Character encoding declared late",
        detail:
          "The charset declaration does not appear in the first 1024 bytes of the response. The HTML spec only requires browsers to look that far; if they find it later they must discard everything parsed so far and start again, wasting the head start.",
        fix: "Move <meta charset=\"utf-8\"> to the first line inside <head>, before the title and before any other meta tag.",
        snippet: '<head>\n  <meta charset="utf-8">\n  <title>…</title>\n</head>',
        value: `declared as "${trim(doc.charset, 40)}" beyond byte 1024`,
        docs: "https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding",
        weight: 1,
      });
    }

    const normalised = doc.charset.trim().toLowerCase();
    if (normalised !== "utf-8" && normalised !== "utf8") {
      findings.push({
        id: "tech-charset-not-utf8",
        category: "technical",
        severity: "warning",
        title: `Character encoding is ${trim(doc.charset, 40)}, not UTF-8`,
        detail:
          "Legacy encodings cannot represent most of Unicode, so emoji, non-Latin scripts and even typographic punctuation break. UTF-8 is required by the HTML standard for new content.",
        fix: "Convert the source files to UTF-8 and declare it, making sure the server's Content-Type header agrees.",
        snippet: '<meta charset="utf-8">',
        value: trim(doc.charset, 60),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta#charset",
        weight: 2,
      });
    } else if (charsetIndex !== -1) {
      findings.push({
        id: "tech-charset-ok",
        category: "technical",
        severity: "pass",
        title: "UTF-8 declared early",
        detail: "The encoding is declared as UTF-8 within the first 1024 bytes, so the parser never has to restart.",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Mixed content                                                          */
  /* ---------------------------------------------------------------------- */

  if (ctx.https) {
    const insecureScripts = doc.scripts.filter((script) => isInsecure(script.src));
    const insecureStyles = doc.stylesheets.filter((sheet) => isInsecure(sheet.href));
    const insecureImages = doc.images.filter((img) => isInsecure(img.src));

    if (insecureScripts.length > 0) {
      findings.push({
        id: "tech-mixed-content-scripts",
        category: "technical",
        severity: "critical",
        title: `${insecureScripts.length} ${plural(insecureScripts.length, "script")} loaded over http`,
        detail:
          "An https page is requesting scripts over plain http. Browsers block active mixed content outright, so these scripts simply never execute - whatever they power is broken for every visitor. A script that did load over http could also be rewritten in transit.",
        fix: "Change the URLs to https. If the third party does not support TLS, self-host the file or drop the dependency.",
        value: list(insecureScripts.map((script) => script.src ?? "")),
        docs: "https://web.dev/articles/what-is-mixed-content",
        weight: 4,
      });
    }

    if (insecureStyles.length > 0) {
      findings.push({
        id: "tech-mixed-content-stylesheets",
        category: "technical",
        severity: "critical",
        title: `${insecureStyles.length} ${plural(insecureStyles.length, "stylesheet")} loaded over http`,
        detail:
          "Stylesheets count as active mixed content because CSS can inject content and load further resources. Browsers block them on https pages, so the page renders unstyled.",
        fix: "Serve stylesheets over https, or self-host them alongside the site.",
        value: list(insecureStyles.map((sheet) => sheet.href ?? "")),
        docs: "https://web.dev/articles/what-is-mixed-content",
        weight: 4,
      });
    }

    if (insecureImages.length > 0) {
      findings.push({
        id: "tech-mixed-content-images",
        category: "technical",
        severity: "warning",
        title: `${insecureImages.length} ${plural(insecureImages.length, "image")} loaded over http`,
        detail:
          "Passive mixed content is upgraded or blocked depending on the browser, and it downgrades the padlock in the address bar. An attacker on the network can also swap the image for anything they like.",
        fix: "Point image URLs at https, or add an upgrade-insecure-requests directive while you migrate.",
        snippet: "Content-Security-Policy: upgrade-insecure-requests",
        value: list(insecureImages.map((img) => img.src ?? "")),
        docs: "https://web.dev/articles/what-is-mixed-content",
        weight: 2,
      });
    }

    if (insecureScripts.length === 0 && insecureStyles.length === 0 && insecureImages.length === 0) {
      findings.push({
        id: "tech-mixed-content-none",
        category: "technical",
        severity: "pass",
        title: "No mixed content",
        detail: "Every script, stylesheet and image referenced by this https page uses a secure or relative URL.",
        weight: 2,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Legacy and CSP-hostile markup                                          */
  /* ---------------------------------------------------------------------- */

  if (X_UA_COMPATIBLE.test(html)) {
    findings.push({
      id: "tech-x-ua-compatible",
      category: "technical",
      severity: "info",
      title: "Obsolete X-UA-Compatible meta tag",
      detail:
        "This tag told Internet Explorer which rendering engine to use. IE has been out of support since 2022 and no current browser reads it, so it is dead weight in every response.",
      fix: "Delete the X-UA-Compatible meta tag.",
      value: trim(html.match(X_UA_COMPATIBLE)?.[0] ?? "", 140),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta#http-equiv",
      weight: 1,
    });
  }

  if (FLASH_OBJECT.test(html)) {
    findings.push({
      id: "tech-legacy-plugin-content",
      category: "technical",
      severity: "warning",
      title: "Flash or Silverlight content detected",
      detail:
        "The page references a plugin format that no browser has supported since 2021. Whatever it was showing is invisible to every visitor and to search engines.",
      fix: "Replace plugin embeds with HTML5 <video>, <canvas> or plain markup, and remove the surrounding <object>/<embed> fallback.",
      value: trim(html.match(FLASH_OBJECT)?.[0] ?? "", 100),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/embed",
      weight: 2,
    });
  }

  const documentWrites = countMatches(html, DOCUMENT_WRITE);
  if (documentWrites > 0) {
    findings.push({
      id: "tech-document-write",
      category: "technical",
      severity: "info",
      title: `document.write used ${documentWrites} ${plural(documentWrites, "time")}`,
      detail:
        "document.write blocks the parser and, on slow connections, Chrome refuses to execute it at all for scripts it injects. It also destroys the document if called after load. Legacy ad and analytics tags are the usual source.",
      fix: "Replace it with DOM insertion, or load the injected script asynchronously.",
      snippet: 'const s = document.createElement("script");\ns.src = "https://example.com/tag.js";\ns.async = true;\ndocument.head.appendChild(s);',
      docs: "https://developer.chrome.com/blog/removing-document-write",
      weight: 1,
    });
  }

  const legacyTagCount = countMatches(html, LEGACY_TAGS);
  if (legacyTagCount > 0) {
    const seen = Array.from(
      new Set((html.match(new RegExp(LEGACY_TAGS.source, "gi")) ?? []).map((m) => m.replace(/[<\s>]/g, "").toLowerCase())),
    );
    findings.push({
      id: "tech-legacy-tags",
      category: "technical",
      severity: "info",
      title: `${legacyTagCount} obsolete HTML ${plural(legacyTagCount, "tag")}`,
      detail:
        "Presentational tags removed from the HTML standard are still in the markup. Browsers render most of them out of inertia, but they carry no semantics, cannot be styled consistently, and mark the template as long unmaintained.",
      fix: "Replace them with CSS: text-align for <center>, font-family/color for <font>, and animation for <marquee>.",
      value: seen.join(", "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element#obsolete_and_deprecated_elements",
      weight: 1,
    });
  }

  const inlineStyleBlocks = countMatches(html, STYLE_BLOCK);
  if (inlineStyleBlocks > 3) {
    findings.push({
      id: "tech-inline-style-blocks",
      category: "technical",
      severity: "info",
      title: `${inlineStyleBlocks} inline <style> blocks`,
      detail:
        "Several separate <style> blocks in one document. A small critical-CSS block is a deliberate performance technique, but many scattered blocks are usually component leakage: they cannot be cached separately from the HTML and each one needs a nonce or hash under a strict Content-Security-Policy.",
      fix: "Keep one critical-CSS block if you use that pattern and move the rest into a cacheable stylesheet.",
      value: `${inlineStyleBlocks} blocks`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP",
      weight: 1,
    });
  }

  const inlineHandlers = countMatches(html, INLINE_HANDLER);
  if (inlineHandlers > 0) {
    findings.push({
      id: "tech-inline-event-handlers",
      category: "technical",
      severity: "info",
      title: `${inlineHandlers} inline event ${plural(inlineHandlers, "handler")}`,
      detail:
        "Attributes like onclick=\"…\" are inline script. A Content-Security-Policy strong enough to stop XSS blocks them entirely - and unlike <script> blocks they cannot be rescued with a nonce, so they must be rewritten before CSP can be tightened.",
      fix: "Move the behaviour into addEventListener calls in a proper script file.",
      snippet: 'document.querySelector("#buy")?.addEventListener("click", handleBuy);',
      value: `${inlineHandlers} attributes`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP",
      weight: 1,
    });
  }

  const inlineScripts = doc.scripts.filter((script) => script.src === null && script.inlineLength > 0);
  if (inlineScripts.length > 0) {
    const totalInline = inlineScripts.reduce((sum, script) => sum + script.inlineLength, 0);
    findings.push({
      id: "tech-inline-script-blocks",
      category: "technical",
      severity: "info",
      title: `${inlineScripts.length} inline ${plural(inlineScripts.length, "script block")}`,
      detail:
        "Inline scripts are never cached separately from the HTML, so their bytes are re-sent on every page load, and each one needs a nonce or hash under a strict Content-Security-Policy.",
      fix: "Move logic into external, cacheable script files. Keep inline blocks for genuinely per-request data such as hydration state.",
      value: `${totalInline.toLocaleString("en-AU")} characters across ${inlineScripts.length} blocks`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP",
      weight: 1,
    });
  }

  if (
    !X_UA_COMPATIBLE.test(html) &&
    !FLASH_OBJECT.test(html) &&
    documentWrites === 0 &&
    legacyTagCount === 0 &&
    inlineHandlers === 0
  ) {
    findings.push({
      id: "tech-legacy-markup-clean",
      category: "technical",
      severity: "pass",
      title: "No legacy or CSP-hostile markup",
      detail:
        "No obsolete tags, plugin embeds, document.write calls, inline event handlers or IE compatibility directives were found.",
      weight: 2,
    });
  }

  return findings;
}
