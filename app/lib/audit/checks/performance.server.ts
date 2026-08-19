/**
 * Performance checks.
 *
 * This is a static, single-fetch analysis: one HTTP request, its headers, its
 * timings and the markup that came back. No browser is launched, so nothing
 * here measures what a real user experiences - it measures the decisions baked
 * into the response that make a fast experience possible or impossible.
 *
 * Core Web Vitals need a real browser; `perf-static-analysis-scope` says so
 * explicitly rather than letting the reader assume otherwise.
 */

import type { Finding, PageContext, ScriptTag } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function header(ctx: PageContext, name: string): string | null {
  const raw = ctx.headers[name];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** The contents of <head>, or a leading slice when the tag is missing. */
function headSection(html: string): string {
  const match = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (match !== null && typeof match[1] === "string") return match[1];
  const bodyStart = html.search(/<body\b/i);
  return bodyStart > 0 ? html.slice(0, bodyStart) : html.slice(0, Math.min(html.length, 30000));
}

/** Every `<tag …>` opening tag's attribute string. */
function openingTags(html: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const out: string[] = [];
  let match = re.exec(html);
  while (match !== null) {
    out.push(typeof match[1] === "string" ? match[1] : "");
    if (out.length > 5000) break;
    match = re.exec(html);
  }
  return out;
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = re.exec(attrs);
  if (match === null) return null;
  if (typeof match[2] === "string") return match[2];
  if (typeof match[3] === "string") return match[3];
  if (typeof match[4] === "string") return match[4];
  return "";
}

function hasBareAttr(attrs: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, "i").test(attrs);
}

function resolveHost(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

/** Well-known third-party font hosts that benefit from an early connection. */
const FONT_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "p.typekit.net",
  "fonts.bunny.net",
  "api.fontshare.com",
  "cdn.fontshare.com",
  "use.fontawesome.com",
  "kit.fontawesome.com",
  "fast.fonts.net",
];

const MODERN_IMAGE_FORMATS = [".webp", ".avif", ".svg"];
const LEGACY_IMAGE_FORMATS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff"];

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function performanceChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;
  const html = ctx.html;
  const head = headSection(html);

  /* ---------------------------------------------------------------------- */
  /* 1. Scope disclosure                                                     */
  /* ---------------------------------------------------------------------- */

  findings.push({
    id: "perf-static-analysis-scope",
    category: "performance",
    severity: "info",
    title: "This is a static analysis, not a Core Web Vitals measurement",
    detail:
      "Everything in this category comes from one server-side fetch: response headers, timings for that single request, and the markup that came back. No browser was launched, no JavaScript executed, no rendering measured. Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift can only be established with a real browser or with field data from real visitors, so nothing here should be read as a Core Web Vitals score. What it does tell you is which structural decisions in the response make good vitals achievable or impossible.",
    fix: "Pair this with PageSpeed Insights (lab plus CrUX field data for the URL) and with your own RUM if you have it. The findings below are the things you can fix before you measure.",
    snippet: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(ctx.finalUrl)}`,
    docs: "https://web.dev/articles/vitals",
    weight: 1,
  });

  /* ---------------------------------------------------------------------- */
  /* 2. Server timings                                                       */
  /* ---------------------------------------------------------------------- */

  const ttfb = ctx.timings.ttfbMs;
  if (ttfb > 1800) {
    findings.push({
      id: "perf-ttfb-critical",
      category: "performance",
      severity: "critical",
      title: `Time to first byte is ${formatMs(ttfb)}`,
      detail: `The server took ${formatMs(ttfb)} to send the first byte. Nothing can render before that - every other optimisation on the page is queued behind this number. Above roughly 1.8 s the page is very unlikely to reach a good Largest Contentful Paint no matter what else you do, and visitors on mobile connections will see a blank screen long enough to leave.`,
      fix: "Find where the time goes: slow database queries and un-cached API calls in the request path are the usual cause, followed by cold serverless starts and a distant origin. Cache the rendered HTML at the edge if the page is not personalised, and add a Server-Timing header so you can attribute the delay.",
      snippet: "Server-Timing: db;dur=420, render;dur=95, cache;desc=MISS",
      value: `${Math.round(ttfb)} ms`,
      docs: "https://web.dev/articles/ttfb",
      weight: 4,
    });
  } else if (ttfb > 800) {
    findings.push({
      id: "perf-ttfb-slow",
      category: "performance",
      severity: "warning",
      title: `Time to first byte is ${formatMs(ttfb)}`,
      detail: `${formatMs(ttfb)} to first byte is above the 800 ms threshold Google treats as "needs improvement". This delay is paid before the browser has seen a single tag, so it sits in front of every render and every subresource request.`,
      fix: "Cache the HTML response where you can, move rendering closer to the user with an edge deployment or CDN, and profile the server-side work in the request path.",
      value: `${Math.round(ttfb)} ms`,
      docs: "https://web.dev/articles/ttfb",
      weight: 3,
    });
  } else if (ttfb < 200) {
    findings.push({
      id: "perf-ttfb-fast",
      category: "performance",
      severity: "pass",
      title: `Fast time to first byte (${formatMs(ttfb)})`,
      detail: `The server responded in ${formatMs(ttfb)}, comfortably inside the 200 ms "good" band. The browser starts parsing almost immediately.`,
      value: `${Math.round(ttfb)} ms`,
      weight: 2,
    });
  } else {
    findings.push({
      id: "perf-ttfb-acceptable",
      category: "performance",
      severity: "pass",
      title: `Acceptable time to first byte (${formatMs(ttfb)})`,
      detail: `${formatMs(ttfb)} to first byte is within the acceptable range (under 800 ms), though there is room to improve - caching the response at the edge typically brings this under 200 ms.`,
      value: `${Math.round(ttfb)} ms`,
      weight: 1,
    });
  }

  const total = ctx.timings.totalMs;
  const transfer = Math.max(0, total - ttfb);
  if (total > 1800) {
    findings.push({
      id: "perf-total-time-critical",
      category: "performance",
      severity: "critical",
      title: `The HTML document took ${formatMs(total)} to download completely`,
      detail: `Total time for the document was ${formatMs(total)}, of which ${formatMs(transfer)} was spent transferring ${formatBytes(ctx.bytes)} after the first byte arrived. The parser cannot finish, and deferred scripts cannot start, until this completes.`,
      fix: "Reduce the HTML payload and enable compression. If the response is streamed, make sure the critical markup is flushed early rather than held until the last data source resolves.",
      value: `${Math.round(total)} ms total, ${Math.round(transfer)} ms transfer`,
      docs: "https://web.dev/articles/ttfb",
      weight: 3,
    });
  } else if (total > 800) {
    findings.push({
      id: "perf-total-time-slow",
      category: "performance",
      severity: "warning",
      title: `The HTML document took ${formatMs(total)} to download`,
      detail: `${formatMs(total)} in total, with ${formatMs(transfer)} of that spent on transfer after the first byte. Both halves are worth attention: the server think-time and the payload size.`,
      fix: "Compress the response and trim the payload; check whether the origin is geographically far from your visitors.",
      value: `${Math.round(total)} ms total, ${Math.round(transfer)} ms transfer`,
      weight: 2,
    });
  } else {
    findings.push({
      id: "perf-total-time",
      category: "performance",
      severity: "pass",
      title: `HTML delivered in ${formatMs(total)}`,
      detail: `The complete document arrived in ${formatMs(total)} (${formatMs(transfer)} of transfer after first byte). The browser can get on with parsing quickly.`,
      value: `${Math.round(total)} ms`,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Payload size                                                         */
  /* ---------------------------------------------------------------------- */

  const decoded = ctx.decodedBytes > 0 ? ctx.decodedBytes : ctx.bytes;
  if (decoded > 300 * 1024) {
    findings.push({
      id: "perf-html-size-critical",
      category: "performance",
      severity: "critical",
      title: `The HTML document is ${formatBytes(decoded)}`,
      detail: `${formatBytes(decoded)} of HTML (${formatBytes(ctx.bytes)} on the wire) is far past the point where the document itself becomes the bottleneck. The main thread parses this synchronously before anything renders, and on a mid-range phone that parse alone costs hundreds of milliseconds. Documents this size are usually carrying inlined state, a full data set rendered server-side, or base64 images.`,
      fix: "Find what is bulking it up: serialised app state (`__NEXT_DATA__`, loader payloads), inlined base64 images, or thousands of rendered rows. Paginate lists, move images to real files with proper caching, and trim the serialised state to what the first render actually needs.",
      value: `${formatBytes(decoded)} decoded, ${formatBytes(ctx.bytes)} transferred`,
      docs: "https://web.dev/articles/lcp",
      weight: 3,
    });
  } else if (decoded > 100 * 1024) {
    findings.push({
      id: "perf-html-size-large",
      category: "performance",
      severity: "warning",
      title: `The HTML document is ${formatBytes(decoded)}`,
      detail: `${formatBytes(decoded)} decoded (${formatBytes(ctx.bytes)} transferred). Above roughly 100 KB the document parse starts showing up in main-thread profiles, and every byte here is on the critical path - unlike a script, the HTML cannot be deferred.`,
      fix: "Check for inlined JSON state and base64 data URIs first; they are the usual cause of a document this size.",
      value: `${formatBytes(decoded)} decoded, ${formatBytes(ctx.bytes)} transferred`,
      docs: "https://web.dev/articles/lcp",
      weight: 2,
    });
  } else {
    findings.push({
      id: "perf-html-size",
      category: "performance",
      severity: "pass",
      title: `Lean HTML document (${formatBytes(decoded)})`,
      detail: `${formatBytes(decoded)} decoded, ${formatBytes(ctx.bytes)} on the wire. The document parses quickly and does not crowd the critical path.`,
      value: `${formatBytes(decoded)} decoded, ${formatBytes(ctx.bytes)} transferred`,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Compression                                                          */
  /* ---------------------------------------------------------------------- */

  const encoding = header(ctx, "content-encoding");
  if (encoding === null) {
    findings.push({
      id: "perf-compression-missing",
      category: "performance",
      severity: decoded > 10 * 1024 ? "warning" : "info",
      title: "The HTML is served uncompressed",
      detail: `No Content-Encoding header - all ${formatBytes(ctx.bytes)} crossed the network as-is. HTML is highly repetitive and typically compresses by 70–80%, so this response is plausibly ${formatBytes(Math.round(decoded * 0.25))} of actual necessary transfer. On a mobile connection that difference is measured in whole seconds.`,
      fix: "Turn on Brotli with a gzip fallback at the reverse proxy or CDN. It is a configuration change, not a code change.",
      snippet: [
        "# nginx",
        "gzip on;",
        "gzip_types text/html text/css application/javascript application/json image/svg+xml;",
        "brotli on;",
        "brotli_types text/html text/css application/javascript application/json image/svg+xml;",
        "",
        "# Caddy compresses automatically:",
        "encode zstd br gzip",
      ].join("\n"),
      value: `${formatBytes(ctx.bytes)} uncompressed`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Compression",
      weight: 3,
    });
  } else if (/^(br|zstd)/i.test(encoding)) {
    const saved = decoded > ctx.bytes ? `${Math.round((1 - ctx.bytes / decoded) * 100)}%` : "n/a";
    findings.push({
      id: "perf-compression-modern",
      category: "performance",
      severity: "pass",
      title: `Modern compression in use (${encoding})`,
      detail: `Content-Encoding is "${encoding}", saving ${saved} against the decoded size (${formatBytes(ctx.bytes)} transferred vs ${formatBytes(decoded)} decoded). Brotli and zstd both beat gzip on text by a meaningful margin.`,
      value: `${encoding}, ${formatBytes(ctx.bytes)} → ${formatBytes(decoded)}`,
      weight: 2,
    });
  } else if (/gzip|deflate/i.test(encoding)) {
    findings.push({
      id: "perf-compression-gzip",
      category: "performance",
      severity: "info",
      title: "Compressed with gzip rather than Brotli",
      detail: `Content-Encoding is "${encoding}", which is fine - but Brotli typically produces 15–20% smaller output on HTML at comparable server cost, and every browser in use today supports it. On this ${formatBytes(decoded)} document that is roughly ${formatBytes(Math.round(ctx.bytes * 0.17))} of avoidable transfer per request.`,
      fix: "Enable Brotli and keep gzip as the fallback for the handful of clients that need it.",
      snippet: [
        "# nginx (ngx_brotli)",
        "brotli on;",
        "brotli_comp_level 5;",
        "brotli_types text/html text/css application/javascript application/json image/svg+xml;",
      ].join("\n"),
      value: encoding,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Caching                                                              */
  /* ---------------------------------------------------------------------- */

  const cacheControl = header(ctx, "cache-control");
  const etag = header(ctx, "etag");
  const lastModified = header(ctx, "last-modified");

  if (cacheControl === null) {
    findings.push({
      id: "perf-cache-control-missing",
      category: "performance",
      severity: "warning",
      title: "No Cache-Control header on the document",
      detail:
        "Without an explicit Cache-Control, browsers and intermediary caches fall back to heuristic freshness - usually a fraction of the time since Last-Modified - which means the caching behaviour of your site is a guess made by someone else's code. In practice you get either needless revalidation on every visit or stale content you cannot flush.",
      fix: "State the policy. For an HTML page that changes, `no-cache` (revalidate every time, but reuse the bytes when the ETag matches) is usually right; add `stale-while-revalidate` to serve instantly while refreshing in the background.",
      snippet: 'Cache-Control: no-cache, stale-while-revalidate=60',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control",
      weight: 2,
    });
  } else if (/no-store/i.test(cacheControl)) {
    findings.push({
      id: "perf-cache-no-store",
      category: "performance",
      severity: "info",
      title: "Cache-Control: no-store prevents all caching",
      detail: `"${cacheControl}" forbids storing the response anywhere - no browser cache, no CDN, and it also disables the browser's back/forward cache, so pressing Back triggers a full round trip and re-render. That is the correct setting for a page containing personal data, and the wrong one for a public marketing page.`,
      fix: "If the page carries nothing sensitive, switch to `no-cache` (still revalidates, but keeps the bfcache and lets a 304 avoid re-downloading).",
      snippet: "Cache-Control: no-cache",
      value: cacheControl,
      docs: "https://web.dev/articles/bfcache",
      weight: 1,
    });
  } else {
    findings.push({
      id: "perf-cache-control",
      category: "performance",
      severity: "pass",
      title: "Cache-Control is set explicitly",
      detail: `"${cacheControl}" - caching behaviour is a decision here rather than a browser heuristic.`,
      value: cacheControl,
      weight: 1,
    });
  }

  if (etag === null && lastModified === null) {
    findings.push({
      id: "perf-validators-missing",
      category: "performance",
      severity: "info",
      title: "No ETag or Last-Modified for revalidation",
      detail:
        "Neither validator is present, so a cache that wants to check freshness has no way to ask \"has this changed?\". Every revalidation becomes a full re-download instead of a 304 Not Modified with an empty body.",
      fix: "Emit a strong ETag (a hash of the response body) or a Last-Modified date. Most servers and frameworks can do this automatically for static responses.",
      snippet: 'ETag: "a3f5b2c1"\nLast-Modified: Wed, 21 Oct 2025 07:28:00 GMT',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag",
      weight: 1,
    });
  } else {
    findings.push({
      id: "perf-validators",
      category: "performance",
      severity: "pass",
      title: "Cache validators are present",
      detail: `${etag ? `ETag: ${etag}` : ""}${etag && lastModified ? "; " : ""}${lastModified ? `Last-Modified: ${lastModified}` : ""}. Unchanged responses can be answered with a 304 and no body.`,
      value: `${etag ?? ""} ${lastModified ?? ""}`.trim(),
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Render-blocking scripts                                              */
  /* ---------------------------------------------------------------------- */

  const headScriptTags = openingTags(head, "script");
  const blocking: string[] = [];
  for (const attrs of headScriptTags) {
    const src = attrValue(attrs, "src");
    if (src === null || src.trim() === "") continue;
    const type = (attrValue(attrs, "type") ?? "").toLowerCase();
    if (type === "application/ld+json" || type === "module") continue; // modules defer by default
    if (hasBareAttr(attrs, "async") || hasBareAttr(attrs, "defer")) continue;
    blocking.push(src.trim());
  }

  if (blocking.length > 0) {
    findings.push({
      id: "perf-render-blocking-scripts",
      category: "performance",
      severity: blocking.length > 2 ? "warning" : "info",
      title: `${pluralise(blocking.length, "render-blocking script")} in <head>`,
      detail: `These scripts have neither async nor defer, so the HTML parser stops dead at each one, fetches it, executes it, and only then continues - before any content has been painted: ${blocking.slice(0, 6).join(", ")}${blocking.length > 6 ? `, and ${blocking.length - 6} more` : ""}. On a slow connection each blocking script adds a full round trip to the time before anything appears.`,
      fix: "Add `defer` to scripts that need the DOM and must run in order, `async` to independent third-party tags, or move them to the end of <body>. Only a script that must run before first paint (an A/B test flicker guard, a consent gate) belongs blocking in the head.",
      snippet: '<script src="/app.js" defer></script>\n<script src="https://analytics.example.com/t.js" async></script>',
      value: blocking.join(" | "),
      docs: "https://web.dev/articles/efficiently-load-third-party-javascript",
      weight: 3,
    });
  } else {
    findings.push({
      id: "perf-no-render-blocking-scripts",
      category: "performance",
      severity: "pass",
      title: "No render-blocking scripts in <head>",
      detail: "Every script in the head is async, deferred, a module, or absent entirely - the parser reaches the body without stalling on JavaScript.",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Stylesheets                                                          */
  /* ---------------------------------------------------------------------- */

  const stylesheets = doc.stylesheets;
  const blockingSheets = stylesheets.filter((s) => {
    const media = (s.media ?? "").toLowerCase().trim();
    return media === "" || media === "all" || media.startsWith("screen");
  });

  if (blockingSheets.length > 4) {
    findings.push({
      id: "perf-stylesheet-count",
      category: "performance",
      severity: "warning",
      title: `${pluralise(blockingSheets.length, "render-blocking stylesheet")}`,
      detail: `CSS blocks rendering by definition - the browser will not paint until every applicable stylesheet has arrived and parsed. ${blockingSheets.length} separate files means ${blockingSheets.length} requests that must all complete first, and on HTTP/1.1 connections some of them queue behind each other.`,
      fix: "Bundle the stylesheets that are always needed into one file, inline the critical above-the-fold rules, and load the rest with a media-swap trick so they do not block the first paint.",
      snippet: '<link rel="stylesheet" href="/non-critical.css" media="print" onload="this.media=\'all\'">',
      value: blockingSheets.map((s) => s.href ?? "").filter((h) => h !== "").slice(0, 8).join(" | "),
      docs: "https://web.dev/articles/defer-non-critical-css",
      weight: 2,
    });
  } else if (stylesheets.length > 0) {
    findings.push({
      id: "perf-stylesheet-count-ok",
      category: "performance",
      severity: "pass",
      title: `${pluralise(stylesheets.length, "stylesheet")} referenced`,
      detail: `${blockingSheets.length} of them block rendering, which is a reasonable count. The browser can start painting after a small number of round trips.`,
      value: stylesheets.map((s) => s.href ?? "").filter((h) => h !== "").slice(0, 6).join(" | "),
      weight: 1,
    });
  }

  const importCount = (html.match(/@import\s+(url\()?['"]/gi) ?? []).length;
  if (importCount > 0) {
    findings.push({
      id: "perf-css-import",
      category: "performance",
      severity: "warning",
      title: `${pluralise(importCount, "@import")} found in CSS`,
      detail:
        "@import serialises the download: the browser has to fetch and parse the importing stylesheet before it even discovers the imported one, so the requests happen one after another instead of in parallel. Each level of nesting adds another full round trip to the time before first paint, and the preload scanner cannot help because the URL is not in the HTML.",
      fix: "Replace @import with separate <link rel=\"stylesheet\"> tags, or concatenate the files at build time.",
      snippet: '<link rel="stylesheet" href="/base.css">\n<link rel="stylesheet" href="/theme.css">',
      value: `${importCount} @import rules`,
      docs: "https://web.dev/articles/defer-non-critical-css",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Script weight                                                        */
  /* ---------------------------------------------------------------------- */

  const externalScripts: ScriptTag[] = doc.scripts.filter((s) => s.src !== null);
  const inlineScripts = doc.scripts.filter((s) => s.src === null && s.type !== "application/ld+json");
  const inlineChars = inlineScripts.reduce((sum, s) => sum + s.inlineLength, 0);

  if (externalScripts.length > 15) {
    findings.push({
      id: "perf-script-count-high",
      category: "performance",
      severity: "warning",
      title: `${externalScripts.length} external scripts on one page`,
      detail: `Each is a separate request the browser must fetch, parse, compile and execute on the main thread. JavaScript is the most expensive byte type on the web - a kilobyte of script costs far more than a kilobyte of image, because it has to be parsed and run rather than just decoded. This count is also a good proxy for how much third-party code is executing with full access to the page.`,
      fix: "Audit the list and remove what is not earning its place. Bundle your own scripts, load analytics and chat widgets after interaction rather than on load, and consider a tag manager only if it reduces rather than multiplies the count.",
      value: externalScripts
        .map((s) => s.src ?? "")
        .filter((s) => s !== "")
        .slice(0, 10)
        .join(" | "),
      docs: "https://web.dev/articles/efficiently-load-third-party-javascript",
      weight: 2,
    });
  } else {
    findings.push({
      id: "perf-script-count",
      category: "performance",
      severity: "pass",
      title: `${pluralise(externalScripts.length, "external script")} referenced`,
      detail: `A manageable script count (${externalScripts.length}), of which ${externalScripts.filter((s) => s.async || s.defer || s.module).length} are async, deferred or modules.`,
      value: `${externalScripts.length} external, ${inlineScripts.length} inline`,
      weight: 1,
    });
  }

  if (inlineChars > 50000) {
    findings.push({
      id: "perf-inline-script-size",
      category: "performance",
      severity: "warning",
      title: `${formatBytes(inlineChars)} of inline JavaScript in the document`,
      detail: `${pluralise(inlineScripts.length, "inline script block")} totalling roughly ${inlineChars.toLocaleString("en-AU")} characters. Inline script cannot be cached separately, cannot be deferred, and is re-downloaded in full on every page view - and it executes synchronously where it sits, blocking the parser. Blocks this large are usually serialised application state or an un-split framework bootstrap.`,
      fix: "Move the code into an external file so it can be cached and deferred. If it is serialised state rather than code, trim it to what the first render needs and fetch the rest after hydration.",
      value: `${inlineChars} characters across ${inlineScripts.length} blocks`,
      docs: "https://web.dev/articles/reduce-javascript-payloads-with-code-splitting",
      weight: 2,
    });
  } else if (inlineChars > 0) {
    findings.push({
      id: "perf-inline-script-size-ok",
      category: "performance",
      severity: "pass",
      title: `Inline JavaScript is modest (${formatBytes(inlineChars)})`,
      detail: `${pluralise(inlineScripts.length, "inline block")} totalling ${inlineChars.toLocaleString("en-AU")} characters - small enough that the uncacheable-and-unsplittable downsides do not matter much.`,
      value: `${inlineChars} characters`,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Images                                                               */
  /* ---------------------------------------------------------------------- */

  const images = doc.images;
  if (images.length > 0) {
    // The first few images are plausibly above the fold and should not be lazy.
    const belowFoldCandidates = images.slice(3);
    const notLazy = belowFoldCandidates.filter((img) => (img.loading ?? "").toLowerCase() !== "lazy");

    if (belowFoldCandidates.length > 0 && notLazy.length > 0) {
      findings.push({
        id: "perf-image-lazy-loading",
        category: "performance",
        severity: notLazy.length > 8 ? "warning" : "info",
        title: `${pluralise(notLazy.length, "image")} beyond the first screenful without loading="lazy"`,
        detail: `The page references ${pluralise(images.length, "image")}; ${notLazy.length} of those past the first three carry no lazy-loading hint, so the browser requests them all immediately. They compete for bandwidth with the resources that actually determine the Largest Contentful Paint.`,
        fix: 'Add loading="lazy" to images below the fold. Leave the hero image eager - lazy-loading the LCP element makes it measurably worse.',
        snippet: '<img src="/photo.jpg" width="800" height="600" alt="…" loading="lazy" decoding="async">',
        value: `${notLazy.length}/${images.length} images not lazy`,
        docs: "https://web.dev/articles/browser-level-image-lazy-loading",
        weight: 2,
      });
    } else {
      findings.push({
        id: "perf-image-lazy-loading-ok",
        category: "performance",
        severity: "pass",
        title: "Below-the-fold images are lazy-loaded",
        detail: `Of ${pluralise(images.length, "image")}, everything past the first screenful declares loading="lazy", so the initial load only fetches what is likely visible.`,
        value: `${images.length} images`,
        weight: 1,
      });
    }

    const missingDimensions = images.filter((img) => img.width === null || img.height === null);
    if (missingDimensions.length > 0) {
      findings.push({
        id: "perf-image-dimensions",
        category: "performance",
        severity: missingDimensions.length > images.length / 2 ? "warning" : "info",
        title: `${pluralise(missingDimensions.length, "image")} without width and height attributes`,
        detail: `${missingDimensions.length} of ${images.length} images do not declare their intrinsic size, so the browser reserves no space for them and the content below jumps when each one loads. This is the most common single cause of a poor Cumulative Layout Shift score, and it is entirely avoidable.`,
        fix: "Set width and height to the image's intrinsic pixel dimensions. Modern browsers derive the aspect ratio from them and reserve the box before the file arrives - CSS can still resize it responsively.",
        snippet: '<img src="/photo.jpg" width="1600" height="900" alt="…" style="max-width:100%;height:auto">',
        value: missingDimensions
          .map((img) => img.src ?? "")
          .filter((s) => s !== "")
          .slice(0, 5)
          .join(" | "),
        docs: "https://web.dev/articles/optimize-cls",
        weight: 3,
      });
    } else {
      findings.push({
        id: "perf-image-dimensions-ok",
        category: "performance",
        severity: "pass",
        title: "All images declare width and height",
        detail: `Every one of the ${images.length} images has explicit dimensions, so the browser can reserve layout space before the bytes arrive and nothing shifts as they load.`,
        value: `${images.length} images`,
        weight: 2,
      });
    }

    const withSrcset = images.filter((img) => img.srcset !== null && img.srcset.trim() !== "");
    if (withSrcset.length === 0 && images.length >= 3) {
      findings.push({
        id: "perf-image-srcset",
        category: "performance",
        severity: "info",
        title: "No responsive image sources",
        detail: `None of the ${images.length} images use srcset. Every visitor gets the same file, which means phones download images sized for a desktop display - typically four times the pixels they can show, at four times the bytes and decode cost.`,
        fix: "Emit a srcset with a few widths and a sizes attribute describing the layout slot, and let the browser pick.",
        snippet:
          '<img src="/photo-800.jpg"\n     srcset="/photo-400.jpg 400w, /photo-800.jpg 800w, /photo-1600.jpg 1600w"\n     sizes="(max-width: 600px) 100vw, 800px"\n     width="1600" height="900" alt="…">',
        value: `0/${images.length} images with srcset`,
        docs: "https://web.dev/articles/serve-responsive-images",
        weight: 1,
      });
    } else if (withSrcset.length > 0) {
      findings.push({
        id: "perf-image-srcset-ok",
        category: "performance",
        severity: "pass",
        title: `${withSrcset.length} of ${images.length} images offer responsive sources`,
        detail: "srcset lets the browser choose a file matched to the viewport and pixel density instead of always downloading the largest.",
        value: `${withSrcset.length}/${images.length} with srcset`,
        weight: 1,
      });
    }

    const legacy = images.filter((img) => {
      const src = (img.src ?? "").toLowerCase().split("?")[0];
      return LEGACY_IMAGE_FORMATS.some((ext) => src.endsWith(ext));
    });
    const modern = images.filter((img) => {
      const src = (img.src ?? "").toLowerCase().split("?")[0];
      return MODERN_IMAGE_FORMATS.some((ext) => src.endsWith(ext));
    });
    const hasPictureSource = /<source\b[^>]*type\s*=\s*["']image\/(avif|webp)/i.test(html);

    if (legacy.length > 0 && modern.length === 0 && !hasPictureSource) {
      findings.push({
        id: "perf-image-formats",
        category: "performance",
        severity: "info",
        title: `${pluralise(legacy.length, "image")} served in legacy formats only`,
        detail: `JPEG and PNG files were found with no WebP or AVIF alternative anywhere on the page. AVIF is typically 40–50% smaller than JPEG at equivalent quality and WebP around 30%, and both are supported by every browser in current use.`,
        fix: "Convert to AVIF or WebP and offer the original as a fallback in a <picture> element, or let your image CDN negotiate the format from the Accept header.",
        snippet: [
          "<picture>",
          '  <source srcset="/photo.avif" type="image/avif">',
          '  <source srcset="/photo.webp" type="image/webp">',
          '  <img src="/photo.jpg" width="1600" height="900" alt="…" loading="lazy">',
          "</picture>",
        ].join("\n"),
        value: `${legacy.length} legacy, ${modern.length} modern`,
        docs: "https://web.dev/articles/serve-images-webp",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 10. Third-party origins and resource hints                              */
  /* ---------------------------------------------------------------------- */

  const pageHost = resolveHost(ctx.finalUrl, ctx.finalUrl);
  const thirdPartyHosts = new Set<string>();

  const collect = (url: string | null): void => {
    if (url === null || url.trim() === "") return;
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const host = resolveHost(url, ctx.finalUrl);
    if (host !== null && host !== pageHost) thirdPartyHosts.add(host);
  };

  for (const script of doc.scripts) collect(script.src);
  for (const sheet of doc.stylesheets) collect(sheet.href);
  for (const image of doc.images) collect(image.src);
  for (const frame of doc.iframes) collect(frame.src);
  for (const link of doc.links) {
    const rels = link.rel.toLowerCase().split(/\s+/);
    if (rels.includes("stylesheet") || rels.includes("preload")) collect(link.href);
  }

  const hosts = Array.from(thirdPartyHosts).sort();
  if (hosts.length > 10) {
    findings.push({
      id: "perf-third-party-origins-high",
      category: "performance",
      severity: "warning",
      title: `${hosts.length} distinct third-party origins referenced`,
      detail: `Each new origin costs a DNS lookup, a TCP handshake and a TLS negotiation before a single byte of content arrives - roughly 100–300 ms on mobile, paid per origin and not shared between them. Origins referenced: ${hosts.join(", ")}.`,
      fix: "Cut the list. Self-host fonts and small libraries (this also removes a privacy dependency), consolidate analytics, and add preconnect for the handful of origins that genuinely remain on the critical path.",
      snippet: '<link rel="preconnect" href="https://cdn.example.com" crossorigin>',
      value: hosts.join(", "),
      docs: "https://web.dev/articles/efficiently-load-third-party-javascript",
      weight: 3,
    });
  } else if (hosts.length > 0) {
    findings.push({
      id: "perf-third-party-origins",
      category: "performance",
      severity: "info",
      title: `${pluralise(hosts.length, "third-party origin")} referenced`,
      detail: `Resources are loaded from: ${hosts.join(", ")}. Each origin costs a DNS + TCP + TLS round trip on first contact. This is a modest count, but it is worth knowing exactly whose code and availability your page depends on.`,
      fix: "Add preconnect hints for the origins that serve render-critical resources, and consider self-hosting anything small enough to inline.",
      value: hosts.join(", "),
      docs: "https://web.dev/articles/preconnect-and-dns-prefetch",
      weight: 1,
    });
  } else {
    findings.push({
      id: "perf-no-third-party-origins",
      category: "performance",
      severity: "pass",
      title: "All resources are served from the page's own origin",
      detail: "No third-party hosts are referenced, so there are no extra DNS/TLS handshakes and no external availability to depend on.",
      weight: 1,
    });
  }

  const hintedHosts = new Set<string>();
  for (const link of doc.links) {
    const rels = link.rel.toLowerCase().split(/\s+/);
    if (!rels.includes("preconnect") && !rels.includes("dns-prefetch")) continue;
    const host = resolveHost(link.href ?? "", ctx.finalUrl);
    if (host !== null) hintedHosts.add(host);
  }

  const fontHostsUsed = hosts.filter((h) => FONT_HOSTS.some((f) => h === f || h.endsWith(`.${f}`)));
  const fontHostsUnhinted = fontHostsUsed.filter((h) => !hintedHosts.has(h));

  if (fontHostsUnhinted.length > 0) {
    findings.push({
      id: "perf-font-preconnect-missing",
      category: "performance",
      severity: "info",
      title: "Third-party font hosts have no preconnect",
      detail: `Fonts are loaded from ${fontHostsUnhinted.join(", ")} with no <link rel="preconnect">. Web fonts are discovered late - the browser has to fetch the CSS, parse it, find the @font-face, and only then open a connection to a second host - so the connection setup lands squarely in the middle of the critical path and text either flashes or stays invisible while it completes.`,
      fix: "Preconnect to the font origins in the head, before the stylesheet link. Google Fonts needs two: the CSS host and the crossorigin font host. Better still, self-host the font files and skip the second origin entirely.",
      snippet: [
        '<link rel="preconnect" href="https://fonts.googleapis.com">',
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">',
      ].join("\n"),
      value: fontHostsUnhinted.join(", "),
      docs: "https://web.dev/articles/font-best-practices",
      weight: 2,
    });
  } else if (fontHostsUsed.length > 0) {
    findings.push({
      id: "perf-font-preconnect",
      category: "performance",
      severity: "pass",
      title: "Font origins are preconnected",
      detail: `Connections to ${fontHostsUsed.join(", ")} are warmed with preconnect or dns-prefetch, so the handshake overlaps with parsing instead of delaying text.`,
      value: fontHostsUsed.join(", "),
      weight: 1,
    });
  }

  const preloads = doc.links.filter((l) => l.rel.toLowerCase().split(/\s+/).includes("preload"));
  if (hintedHosts.size > 0 || preloads.length > 0) {
    findings.push({
      id: "perf-resource-hints",
      category: "performance",
      severity: "pass",
      title: "Resource hints are in use",
      detail: `${pluralise(hintedHosts.size, "origin")} preconnected or dns-prefetched and ${pluralise(preloads.length, "resource")} preloaded. These let the browser start work it would otherwise discover late.`,
      value: `preconnect: ${Array.from(hintedHosts).join(", ") || "none"}; preload: ${preloads.map((p) => p.href ?? "").filter((h) => h !== "").slice(0, 4).join(", ") || "none"}`,
      docs: "https://web.dev/articles/preload-critical-assets",
      weight: 1,
    });
  } else if (hosts.length > 0) {
    findings.push({
      id: "perf-resource-hints-missing",
      category: "performance",
      severity: "info",
      title: "No resource hints for third-party origins",
      detail: `${pluralise(hosts.length, "external origin")} is referenced but the page uses no preconnect, dns-prefetch or preload. The browser only discovers each connection when it reaches the tag that needs it, so the handshake happens at the worst possible moment.`,
      fix: "Preconnect to the two or three origins on the critical path - more than that is counterproductive, since each open connection has a cost of its own.",
      snippet: '<link rel="preconnect" href="https://cdn.example.com" crossorigin>',
      value: hosts.slice(0, 5).join(", "),
      docs: "https://web.dev/articles/preconnect-and-dns-prefetch",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. Protocol                                                            */
  /* ---------------------------------------------------------------------- */

  const connection = header(ctx, "connection");
  const keepAlive = header(ctx, "keep-alive");
  const altSvc = header(ctx, "alt-svc");
  const transferEncoding = header(ctx, "transfer-encoding");

  if (connection !== null || keepAlive !== null || transferEncoding !== null) {
    findings.push({
      id: "perf-http-version-legacy",
      category: "performance",
      severity: "info",
      title: "The response looks like HTTP/1.1",
      detail: `Hop-by-hop headers that HTTP/2 forbids are present (${[connection && `connection: ${connection}`, keepAlive && `keep-alive: ${keepAlive}`, transferEncoding && `transfer-encoding: ${transferEncoding}`].filter((v): v is string => typeof v === "string").join("; ")}), which strongly suggests HTTP/1.1. Without multiplexing, the browser is limited to about six parallel connections per origin and requests queue behind each other - the effect grows with every additional file the page needs.`,
      fix: "Enable HTTP/2 (and ideally HTTP/3) at the edge. Most CDNs and reverse proxies need one directive. Note that this is inferred from headers rather than observed directly.",
      snippet: "# nginx\nlisten 443 ssl;\nhttp2 on;\n\n# HTTP/3\nlisten 443 quic reuseport;\nadd_header Alt-Svc 'h3=\":443\"; ma=86400';",
      value: connection ?? keepAlive ?? transferEncoding ?? "",
      docs: "https://web.dev/articles/performance-http2",
      weight: 1,
    });
  } else if (altSvc !== null && /h3/i.test(altSvc)) {
    findings.push({
      id: "perf-http3-advertised",
      category: "performance",
      severity: "pass",
      title: "HTTP/3 is advertised",
      detail: `The server sends "Alt-Svc: ${altSvc}", so returning visitors upgrade to QUIC - faster connection setup and no head-of-line blocking when a packet is lost, which matters most on mobile networks.`,
      value: altSvc,
      docs: "https://web.dev/articles/performance-http3",
      weight: 1,
    });
  } else {
    findings.push({
      id: "perf-http-version",
      category: "performance",
      severity: "info",
      title: "HTTP version could not be determined from headers",
      detail:
        "No HTTP/1.1-only hop-by-hop headers were present, which is consistent with HTTP/2 or HTTP/3, but the protocol version is not exposed at this layer so this is not a positive confirmation. Check it in your browser's network panel - the Protocol column shows h2 or h3.",
      fix: "If you are still on HTTP/1.1, enabling HTTP/2 is usually a single directive at the reverse proxy or a toggle at the CDN, and it removes per-origin request queueing.",
      docs: "https://web.dev/articles/performance-http2",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 12. Redirects                                                           */
  /* ---------------------------------------------------------------------- */

  const hops = ctx.redirects;
  if (hops.length === 0) {
    findings.push({
      id: "perf-no-redirects",
      category: "performance",
      severity: "pass",
      title: "The URL resolves without redirects",
      detail: "The requested URL returned the document directly, so no round trips were spent getting to it.",
      weight: 1,
    });
  } else if (hops.length >= 3) {
    findings.push({
      id: "perf-redirect-chain-long",
      category: "performance",
      severity: "warning",
      title: `${hops.length} redirects before the page loads`,
      detail: `The chain is: ${hops.map((h) => `${h.status} ${h.from} → ${h.to}`).join(" ; ")}. Every hop is a full round trip - DNS, connection and TLS again if the host changes - before the document even starts downloading. On mobile, three hops routinely costs the best part of a second, paid by every visitor arriving at this URL.`,
      fix: "Collapse the chain into a single redirect that goes straight to the final URL. Fix the sources too - the canonical, the sitemap, internal links and any ad or email campaign should all point at the destination directly.",
      snippet: "# One hop, not three:\nreturn 301 https://www.example.com/final-path$is_args$args;",
      value: hops.map((h) => `${h.status} ${h.from} → ${h.to}`).join(" ; "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections",
      weight: 2,
    });
  } else {
    findings.push({
      id: "perf-redirect-chain",
      category: "performance",
      severity: "info",
      title: `${pluralise(hops.length, "redirect")} before the page loads`,
      detail: `${hops.map((h) => `${h.status} ${h.from} → ${h.to}`).join(" ; ")}. Each hop adds a round trip ahead of the document request. One redirect is normal (http→https, or apex→www); it is still latency every visitor pays.`,
      fix: "Make sure internal links, the canonical tag and your sitemap all point at the final URL so the redirect only ever fires for external traffic.",
      value: hops.map((h) => `${h.status} ${h.from} → ${h.to}`).join(" ; "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections",
      weight: 1,
    });
  }

  return findings;
}
