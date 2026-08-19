/**
 * Security checks.
 *
 * Everything here is derived from the response headers of the final document
 * plus a few signals visible in the markup. This is a transport- and
 * header-level review, not a penetration test: it tells you which of the
 * browser's built-in protections you have switched on, and what your server is
 * telling attackers about itself for free.
 *
 * Mixed content is deliberately not covered here - the technical checks own it.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Read an already-lowercased header, trimmed, or null when absent/empty. */
function header(ctx: PageContext, name: string): string | null {
  const raw = ctx.headers[name];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

/** Parse a CSP into a directive map: `{ "script-src": ["'self'", ...] }`. */
function parseCsp(value: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter((t) => t !== "");
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!directives.has(name)) directives.set(name, tokens.slice(1));
  }
  return directives;
}

/** Effective sources for a directive, falling back to default-src. */
function cspSources(directives: Map<string, string[]>, name: string): string[] | null {
  const direct = directives.get(name);
  if (direct) return direct;
  const fallback = directives.get("default-src");
  return fallback ?? null;
}

/**
 * Split a raw `set-cookie` header value into individual cookies.
 *
 * Node's undici already joins multiple Set-Cookie headers with ", ", which is
 * ambiguous because Expires values contain a comma. Split only on a comma that
 * is followed by something shaped like `name=`.
 */
function splitCookies(raw: string): string[] {
  return raw
    .split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+\s*=)/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

interface ParsedCookie {
  name: string;
  raw: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

function parseCookie(raw: string): ParsedCookie {
  const attributes = raw.split(";").map((a) => a.trim());
  const first = attributes[0] ?? "";
  const eq = first.indexOf("=");
  const name = eq === -1 ? first : first.slice(0, eq);
  const lower = attributes.map((a) => a.toLowerCase());
  const sameSiteAttr = attributes.find((a) => a.toLowerCase().startsWith("samesite"));
  const sameSiteValue = sameSiteAttr?.split("=")[1]?.trim() ?? null;

  return {
    name: name.trim(),
    raw,
    secure: lower.includes("secure"),
    httpOnly: lower.includes("httponly"),
    sameSite: sameSiteValue,
  };
}

/** Extract every `<tag ...>` opening tag's attribute string for a given tag. */
function openingTags(html: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const out: string[] = [];
  let match = re.exec(html);
  while (match !== null) {
    out.push(match[1] ?? "");
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

function hostOf(url: string, base: string): string | null {
  try {
    return new URL(url, base).host.toLowerCase();
  } catch {
    return null;
  }
}

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/* -------------------------------------------------------------------------- */
/* Outdated library detection                                                  */
/* -------------------------------------------------------------------------- */

interface LibraryRule {
  label: string;
  /** Capture group 1 must be the version. */
  pattern: RegExp;
  /** Anything strictly below this major.minor is considered outdated. */
  outdatedBelow: [number, number];
  advice: string;
  docs: string;
}

const LIBRARY_RULES: LibraryRule[] = [
  {
    label: "jQuery",
    pattern: /jquery[.\-/]?(?:core[.\-])?v?(\d+)\.(\d+)(?:\.(\d+))?/i,
    outdatedBelow: [3, 5],
    advice:
      "jQuery below 3.5.0 is affected by published XSS issues in `html()`/`append()` parsing (CVE-2020-11022 and CVE-2020-11023). Upgrade to 3.7.x.",
    docs: "https://blog.jquery.com/2020/04/10/jquery-3-5-0-released/",
  },
  {
    label: "AngularJS",
    pattern: /angular(?:\.min)?[.\-/]?v?(1)\.(\d+)(?:\.(\d+))?/i,
    outdatedBelow: [2, 0],
    advice:
      "AngularJS 1.x reached end of life in January 2022 and receives no security patches. Its template expressions are a standing XSS sink. Migrate to Angular or another framework.",
    docs: "https://blog.angular.dev/discontinued-long-term-support-for-angularjs-cc066b82e65a",
  },
  {
    label: "Bootstrap",
    pattern: /bootstrap[.\-/]?v?(\d+)\.(\d+)(?:\.(\d+))?/i,
    outdatedBelow: [4, 0],
    advice: "Bootstrap 3.x is unmaintained and has known XSS issues in its data-* attribute handling. Move to Bootstrap 5.",
    docs: "https://github.com/twbs/bootstrap/security/advisories",
  },
  {
    label: "Lodash",
    pattern: /lodash[.\-/]?v?(\d+)\.(\d+)(?:\.(\d+))?/i,
    outdatedBelow: [4, 17],
    advice: "Lodash below 4.17.21 is vulnerable to prototype pollution (CVE-2020-8203, CVE-2021-23337).",
    docs: "https://github.com/lodash/lodash/security/advisories",
  },
  {
    label: "Moment.js",
    pattern: /moment[.\-/]?v?(\d+)\.(\d+)(?:\.(\d+))?/i,
    outdatedBelow: [2, 29],
    advice: "Moment.js below 2.29.4 has a path-traversal issue (CVE-2022-31129), and the project is in maintenance mode.",
    docs: "https://github.com/moment/moment/security/advisories",
  },
];

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function securityChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const html = ctx.html;
  const doc = ctx.doc;

  /* ---------------------------------------------------------------------- */
  /* 1. Transport                                                            */
  /* ---------------------------------------------------------------------- */

  if (!ctx.https) {
    findings.push({
      id: "sec-https-missing",
      category: "security",
      severity: "critical",
      title: "The page is served over plain HTTP",
      detail: `${ctx.finalUrl} was delivered without TLS. Everything on the wire - form submissions, cookies, the HTML itself - is readable and modifiable by anyone between the visitor and the server, which on public Wi-Fi or a hostile ISP is a live risk, not a theoretical one. Browsers mark the page "Not secure", search engines demote it, and no modern browser API (geolocation, service workers, clipboard) will run.`,
      fix: "Issue a certificate (Let's Encrypt is free and automatable), serve everything over HTTPS, and 301 every HTTP request to its HTTPS equivalent.",
      snippet: [
        "# nginx",
        "server {",
        "  listen 80;",
        "  server_name example.com;",
        "  return 301 https://$host$request_uri;",
        "}",
        "",
        "# Caddy does this automatically:",
        "example.com {",
        "  root * /srv",
        "}",
      ].join("\n"),
      value: ctx.finalUrl,
      docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Transport_Layer_Security",
      weight: 5,
    });
  } else {
    findings.push({
      id: "sec-https",
      category: "security",
      severity: "pass",
      title: "Served over HTTPS",
      detail: "The final document was delivered over TLS, so the connection is authenticated and encrypted end to end.",
      value: ctx.origin,
      weight: 3,
    });
  }

  if (ctx.httpsRedirect?.checked) {
    if (ctx.httpsRedirect.redirectsToHttps) {
      findings.push({
        id: "sec-https-redirect",
        category: "security",
        severity: "pass",
        title: "HTTP requests are redirected to HTTPS",
        detail: "A request to the origin over plain HTTP was redirected to the HTTPS version, so visitors who type the bare domain or follow an old link still end up on a secure connection.",
        weight: 2,
      });
    } else {
      findings.push({
        id: "sec-https-redirect-missing",
        category: "security",
        severity: "warning",
        title: "HTTP requests are not redirected to HTTPS",
        detail:
          "Requesting the origin over http:// did not redirect to https://. Every link, bookmark and typed address that omits the scheme starts as an unencrypted request, and an attacker on the network can answer it before your server does.",
        fix: "Redirect all HTTP traffic to HTTPS with a 301, then add HSTS so browsers stop making the plaintext request in the first place.",
        snippet: [
          "# nginx",
          "server { listen 80; server_name _; return 301 https://$host$request_uri; }",
        ].join("\n"),
        docs: "https://web.dev/articles/why-https-matters",
        weight: 3,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 2. HSTS                                                                 */
  /* ---------------------------------------------------------------------- */

  const hsts = header(ctx, "strict-transport-security");
  if (hsts === null) {
    findings.push({
      id: "sec-hsts-missing",
      category: "security",
      severity: ctx.https ? "warning" : "info",
      title: "No Strict-Transport-Security header",
      detail:
        "HSTS is what makes HTTPS stick. Without it, the very first request a visitor makes each time is plaintext and can be intercepted and downgraded before your redirect ever runs - the classic sslstrip attack. The redirect protects the second request; HSTS protects the first.",
      fix: "Send HSTS on every HTTPS response. Start with a short max-age to confirm nothing breaks, then raise it to a year.",
      snippet: [
        "# nginx",
        'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
        "",
        "# Caddy",
        "header Strict-Transport-Security \"max-age=31536000; includeSubDomains\"",
      ].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security",
      weight: 3,
    });
  } else {
    const maxAgeMatch = /max-age\s*=\s*"?(\d+)/i.exec(hsts);
    const maxAge = maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) : 0;
    const includeSub = /includesubdomains/i.test(hsts);
    const preload = /preload/i.test(hsts);
    const sixMonths = 15552000;

    if (maxAge < sixMonths) {
      findings.push({
        id: "sec-hsts-max-age-short",
        category: "security",
        severity: "warning",
        title: `HSTS max-age is only ${maxAge} seconds`,
        detail: `The header is "${hsts}". A max-age below six months (${sixMonths}s) leaves a wide window in which a returning visitor's browser has forgotten the policy and will make a plaintext request again. It also disqualifies the domain from the preload list, which requires at least a year.`,
        fix: "Raise max-age to 31536000 (one year) once you are confident every subdomain and service is HTTPS-only.",
        snippet: 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
        value: hsts,
        docs: "https://hstspreload.org/",
        weight: 2,
      });
    } else {
      findings.push({
        id: "sec-hsts",
        category: "security",
        severity: "pass",
        title: "HSTS is enabled with a long max-age",
        detail: `"${hsts}" - browsers will refuse to talk to this host over plain HTTP for ${Math.round(maxAge / 86400)} days after their last visit, closing the downgrade window.`,
        value: hsts,
        weight: 2,
      });
    }

    if (!includeSub) {
      findings.push({
        id: "sec-hsts-subdomains-missing",
        category: "security",
        severity: "info",
        title: "HSTS does not cover subdomains",
        detail: `"${hsts}" omits includeSubDomains, so the policy applies to this host only. A forgotten subdomain served over HTTP - a staging box, an old mail client, a vendor CNAME - can still be used to set cookies or run script that affects the parent domain.`,
        fix: "Add includeSubDomains once you have verified every subdomain serves HTTPS. It is a one-way door for the duration of max-age, so audit first.",
        snippet: "Strict-Transport-Security: max-age=31536000; includeSubDomains",
        value: hsts,
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security",
        weight: 1,
      });
    }

    if (!preload) {
      findings.push({
        id: "sec-hsts-preload-missing",
        category: "security",
        severity: "info",
        title: "Domain is not marked for HSTS preloading",
        detail:
          "The preload token is absent. Preloading ships your HTTPS-only policy inside the browser itself, so even a visitor's very first request to your domain can never be plaintext. It is the only way to close that first-request gap completely.",
        fix: "Add `preload` alongside a max-age of at least 31536000 and includeSubDomains, then submit the domain at hstspreload.org. Removal takes months, so commit deliberately.",
        snippet: "Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
        docs: "https://hstspreload.org/",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Content-Security-Policy                                              */
  /* ---------------------------------------------------------------------- */

  const csp = header(ctx, "content-security-policy");
  const cspMeta = doc.metaByName["content-security-policy"] ?? null;
  const cspReportOnly = header(ctx, "content-security-policy-report-only");
  const cspValue = csp ?? cspMeta;
  const directives = cspValue ? parseCsp(cspValue) : new Map<string, string[]>();

  if (cspValue === null) {
    findings.push({
      id: "sec-csp-missing",
      category: "security",
      severity: "warning",
      title: "No Content-Security-Policy",
      detail:
        "There is no CSP on this response. CSP is the only mechanism that limits the damage of an XSS bug after it exists: without it, any injected script - through a comment field, a URL parameter reflected into the page, a compromised third-party tag - runs with full access to the DOM, to cookies not marked HttpOnly, and to any origin it wants to exfiltrate them to.",
      fix: "Start in report-only mode so nothing breaks, collect violations for a week, then enforce. A nonce-based policy is the target; `'strict-dynamic'` lets loader scripts keep working.",
      snippet: [
        "# Phase 1 - observe only",
        "Content-Security-Policy-Report-Only: default-src 'self'; report-uri /csp-report",
        "",
        "# Phase 2 - enforce with a per-request nonce",
        "Content-Security-Policy: default-src 'self'; script-src 'nonce-{RANDOM}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      ].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy",
      weight: 3,
    });

    if (cspReportOnly !== null) {
      findings.push({
        id: "sec-csp-report-only",
        category: "security",
        severity: "info",
        title: "CSP is in report-only mode and not enforced",
        detail: `A Content-Security-Policy-Report-Only header is set ("${cspReportOnly.slice(0, 160)}${cspReportOnly.length > 160 ? "…" : ""}") but no enforcing policy accompanies it. Violations are being logged; nothing is being blocked.`,
        fix: "Once the violation reports are clean, copy the policy into the enforcing Content-Security-Policy header.",
        value: cspReportOnly,
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy-Report-Only",
        weight: 1,
      });
    }
  } else {
    const names = Array.from(directives.keys());
    findings.push({
      id: "sec-csp",
      category: "security",
      severity: "pass",
      title: `Content-Security-Policy is set${csp === null ? " (via meta tag)" : ""}`,
      detail: `${pluralise(names.length, "directive")} present: ${names.join(", ")}. A policy is in place to contain injected script.`,
      value: cspValue.length > 300 ? `${cspValue.slice(0, 300)}…` : cspValue,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy",
      weight: 2,
    });

    const scriptSrc = cspSources(directives, "script-src") ?? [];
    const scriptSrcLower = scriptSrc.map((s) => s.toLowerCase());

    if (scriptSrcLower.includes("'unsafe-inline'")) {
      const hasNonce = scriptSrcLower.some((s) => s.startsWith("'nonce-"));
      const hasHash = scriptSrcLower.some((s) => s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-"));
      const hasStrictDynamic = scriptSrcLower.includes("'strict-dynamic'");
      findings.push({
        id: "sec-csp-unsafe-inline",
        category: "security",
        severity: "info",
        title: "CSP allows 'unsafe-inline' scripts",
        detail: `script-src is "${scriptSrc.join(" ")}". 'unsafe-inline' permits any inline <script> to execute, which is precisely the payload shape XSS uses - so this directive removes most of the protection CSP was added for. It is extremely common, because eliminating inline script is genuine work.${hasStrictDynamic || hasNonce || hasHash ? " Modern browsers ignore 'unsafe-inline' when a nonce, hash or 'strict-dynamic' is also present, so your effective policy may be stronger than it reads." : ""}`,
        fix: "Move to per-request nonces: generate a random nonce, put it in the header and on every legitimate <script>, and drop 'unsafe-inline'. Add 'strict-dynamic' so scripts loaded by your bundler still work.",
        snippet: "Content-Security-Policy: script-src 'nonce-{RANDOM}' 'strict-dynamic' https:; object-src 'none'; base-uri 'none'",
        value: scriptSrc.join(" "),
        docs: "https://web.dev/articles/strict-csp",
        weight: 1,
      });
    }

    if (scriptSrcLower.includes("'unsafe-eval'")) {
      findings.push({
        id: "sec-csp-unsafe-eval",
        category: "security",
        severity: "info",
        title: "CSP allows 'unsafe-eval'",
        detail: `script-src includes 'unsafe-eval', which re-enables eval(), new Function() and string-argument setTimeout. Any injected string that reaches one of those becomes executable code. It is usually there because a templating library or an older bundler needs it.`,
        fix: "Find the dependency that requires eval (build with a CSP-safe template compiler, or precompile templates at build time), then remove the directive.",
        value: scriptSrc.join(" "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src",
        weight: 1,
      });
    }

    const defaultSrc = (directives.get("default-src") ?? []).map((s) => s.toLowerCase());
    if (defaultSrc.includes("*") || scriptSrcLower.includes("*")) {
      findings.push({
        id: "sec-csp-wildcard-source",
        category: "security",
        severity: "warning",
        title: "CSP uses a wildcard source",
        detail: `${defaultSrc.includes("*") ? "default-src" : "script-src"} is set to "*", which permits loading from any origin on the internet. The policy is syntactically valid and functionally close to having no policy at all for that resource type.`,
        fix: "Replace the wildcard with the specific origins you actually load from. If you genuinely cannot enumerate them, at minimum keep script-src tight - that is the directive that matters.",
        value: cspValue.slice(0, 200),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/default-src",
        weight: 2,
      });
    }

    if (!directives.has("object-src") && !directives.has("default-src")) {
      findings.push({
        id: "sec-csp-object-src-missing",
        category: "security",
        severity: "info",
        title: "CSP does not restrict plugin content",
        detail:
          "Neither object-src nor default-src is set, so <object> and <embed> are unrestricted. Legacy plugin content is a well-worn script-execution bypass for CSP.",
        fix: "Add `object-src 'none'` - nothing modern needs it.",
        snippet: "object-src 'none'; base-uri 'none'",
        docs: "https://web.dev/articles/strict-csp",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Framing / clickjacking                                               */
  /* ---------------------------------------------------------------------- */

  const xfo = header(ctx, "x-frame-options");
  const frameAncestors = directives.get("frame-ancestors");

  if (frameAncestors) {
    findings.push({
      id: "sec-frame-ancestors",
      category: "security",
      severity: "pass",
      title: "Framing is restricted by CSP frame-ancestors",
      detail: `frame-ancestors is "${frameAncestors.join(" ")}". This is the modern replacement for X-Frame-Options and, unlike it, supports multiple origins and is honoured consistently across browsers.`,
      value: frameAncestors.join(" "),
      weight: 2,
    });
  } else if (xfo) {
    const normalised = xfo.toLowerCase();
    if (normalised.startsWith("allow-from")) {
      findings.push({
        id: "sec-frame-options-obsolete",
        category: "security",
        severity: "warning",
        title: "X-Frame-Options uses the obsolete ALLOW-FROM directive",
        detail: `"${xfo}" - no current browser implements ALLOW-FROM. Chrome, Firefox and Safari all ignore the header entirely when it is used, so the page is effectively framable by anyone.`,
        fix: "Replace it with CSP frame-ancestors, which is the supported way to allow specific origins.",
        snippet: "Content-Security-Policy: frame-ancestors 'self' https://partner.example.com",
        value: xfo,
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options",
        weight: 2,
      });
    } else {
      findings.push({
        id: "sec-frame-options",
        category: "security",
        severity: "pass",
        title: "X-Frame-Options blocks framing",
        detail: `"${xfo}" prevents other sites embedding this page in an iframe, which is what clickjacking relies on.`,
        value: xfo,
        weight: 2,
      });
      findings.push({
        id: "sec-frame-ancestors-missing",
        category: "security",
        severity: "info",
        title: "No CSP frame-ancestors alongside X-Frame-Options",
        detail:
          "X-Frame-Options is set but the CSP equivalent is not. frame-ancestors supersedes it, handles multiple allowed origins, and takes precedence where both are present - worth adding as the primary control.",
        fix: "Add `frame-ancestors 'none'` (or list the origins you allow) to your CSP and keep X-Frame-Options for older clients.",
        snippet: "Content-Security-Policy: frame-ancestors 'none'",
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors",
        weight: 1,
      });
    }
  } else {
    findings.push({
      id: "sec-clickjacking-exposed",
      category: "security",
      severity: "warning",
      title: "The page can be framed by any site - clickjacking exposure",
      detail:
        "Neither X-Frame-Options nor CSP frame-ancestors is set, so any site can load this page in a transparent iframe over its own UI and harvest clicks intended for something else. That matters most on anything with a state-changing button: a logout, a purchase, a permission grant, an account deletion.",
      fix: "Send frame-ancestors 'none' if the page is never legitimately embedded, or list the specific origins that may embed it.",
      snippet: [
        "# nginx",
        "add_header Content-Security-Policy \"frame-ancestors 'none'\" always;",
        "add_header X-Frame-Options \"DENY\" always;",
      ].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors",
      weight: 3,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Simple hardening headers                                             */
  /* ---------------------------------------------------------------------- */

  const nosniff = header(ctx, "x-content-type-options");
  if (nosniff !== null && nosniff.toLowerCase().includes("nosniff")) {
    findings.push({
      id: "sec-content-type-options",
      category: "security",
      severity: "pass",
      title: "MIME sniffing is disabled",
      detail: `"X-Content-Type-Options: ${nosniff}" forces browsers to honour the declared Content-Type instead of guessing from the bytes.`,
      value: nosniff,
      weight: 2,
    });
  } else {
    findings.push({
      id: "sec-content-type-options-missing",
      category: "security",
      severity: "warning",
      title: "No X-Content-Type-Options: nosniff",
      detail:
        "Without nosniff, browsers may ignore your Content-Type and infer the type from the content itself. An uploaded file served as text/plain that happens to contain HTML can then be executed as HTML in your origin - which turns a benign-looking upload endpoint into stored XSS.",
      fix: "Send `X-Content-Type-Options: nosniff` on every response. It is a one-line change with essentially no compatibility risk.",
      snippet: [
        "# nginx",
        'add_header X-Content-Type-Options "nosniff" always;',
        "",
        "# Express",
        'res.setHeader("X-Content-Type-Options", "nosniff");',
      ].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options",
      weight: 2,
    });
  }

  const referrerPolicy = header(ctx, "referrer-policy");
  const referrerMeta = doc.metaByName["referrer"] ?? null;
  const referrerValue = referrerPolicy ?? referrerMeta;
  if (referrerValue === null) {
    findings.push({
      id: "sec-referrer-policy-missing",
      category: "security",
      severity: "warning",
      title: "No Referrer-Policy header",
      detail:
        "Browsers default to strict-origin-when-cross-origin these days, which is reasonable, but relying on a default means the behaviour is not yours to control. Any full path you leak in a Referer header - a password-reset URL, a signed link, an internal search query, a document ID - goes to every third party the page loads.",
      fix: "Set the policy explicitly. `strict-origin-when-cross-origin` keeps full URLs for same-origin navigation and sends only the origin cross-site.",
      snippet: 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy",
      weight: 1,
    });
  } else if (/unsafe-url/i.test(referrerValue)) {
    findings.push({
      id: "sec-referrer-policy-unsafe",
      category: "security",
      severity: "warning",
      title: "Referrer-Policy is set to unsafe-url",
      detail: `"${referrerValue}" sends the complete URL - path, query string and all - to every destination, including cross-origin and HTTPS-to-HTTP navigations. Anything sensitive that lives in a URL is being handed to third parties on every click and every subresource request.`,
      fix: "Change it to strict-origin-when-cross-origin unless you have a specific attribution requirement that genuinely needs the full URL.",
      snippet: 'Referrer-Policy: strict-origin-when-cross-origin',
      value: referrerValue,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy",
      weight: 2,
    });
  } else {
    findings.push({
      id: "sec-referrer-policy",
      category: "security",
      severity: "pass",
      title: "Referrer-Policy is set explicitly",
      detail: `"${referrerValue}"${referrerPolicy === null ? " (via meta tag)" : ""} - the page controls how much URL information leaves it, rather than depending on browser defaults.`,
      value: referrerValue,
      weight: 1,
    });
  }

  const permissionsPolicy = header(ctx, "permissions-policy") ?? header(ctx, "feature-policy");
  if (permissionsPolicy === null) {
    findings.push({
      id: "sec-permissions-policy-missing",
      category: "security",
      severity: "info",
      title: "No Permissions-Policy header",
      detail:
        "Nothing restricts which powerful browser features this page and its iframes may use - camera, microphone, geolocation, payment, USB. A compromised third-party script or an embedded ad frame inherits the full set of permissions your origin can request.",
      fix: "Deny everything you do not use. The list is short and the risk of breakage is low if you enumerate honestly.",
      snippet: 'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" always;',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy",
      weight: 1,
    });
  } else {
    findings.push({
      id: "sec-permissions-policy",
      category: "security",
      severity: "pass",
      title: "Permissions-Policy restricts browser features",
      detail: `"${permissionsPolicy.slice(0, 200)}${permissionsPolicy.length > 200 ? "…" : ""}" limits which powerful APIs this document and its frames can reach.`,
      value: permissionsPolicy,
      weight: 1,
    });
  }

  const coop = header(ctx, "cross-origin-opener-policy");
  if (coop === null) {
    findings.push({
      id: "sec-coop-missing",
      category: "security",
      severity: "info",
      title: "No Cross-Origin-Opener-Policy",
      detail:
        "Without COOP, a page you open (or that opens you) shares a browsing context group with this document and keeps a `window.opener` reference. That is the basis of tabnabbing and of several cross-origin side-channel attacks. COOP also gates access to high-resolution timers and SharedArrayBuffer.",
      fix: "Send `Cross-Origin-Opener-Policy: same-origin`. Check first that you do not depend on window.opener for an OAuth popup or payment flow - use `same-origin-allow-popups` if you do.",
      snippet: 'add_header Cross-Origin-Opener-Policy "same-origin" always;',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy",
      weight: 1,
    });
  } else {
    findings.push({
      id: "sec-coop",
      category: "security",
      severity: "pass",
      title: "Cross-Origin-Opener-Policy is set",
      detail: `"${coop}" isolates this document's browsing context group from cross-origin windows.`,
      value: coop,
      weight: 1,
    });
  }

  const corp = header(ctx, "cross-origin-resource-policy");
  if (corp === null) {
    findings.push({
      id: "sec-corp-missing",
      category: "security",
      severity: "info",
      title: "No Cross-Origin-Resource-Policy",
      detail:
        "CORP lets a resource declare who is allowed to embed it. Without it, other origins can pull your responses into their pages as images, scripts or fetches and use timing or size differences to infer content - the family of attacks Spectre made practical.",
      fix: "Set `Cross-Origin-Resource-Policy: same-origin` on private responses; use `cross-origin` for assets you intentionally serve to other sites (fonts, public images, a CDN).",
      snippet: 'add_header Cross-Origin-Resource-Policy "same-origin" always;',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Resource-Policy",
      weight: 1,
    });
  } else {
    findings.push({
      id: "sec-corp",
      category: "security",
      severity: "pass",
      title: "Cross-Origin-Resource-Policy is set",
      detail: `"${corp}" controls which origins may embed this response.`,
      value: corp,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Information disclosure                                               */
  /* ---------------------------------------------------------------------- */

  interface Leak {
    header: string;
    value: string;
  }

  const leaks: Leak[] = [];
  const versioned: Leak[] = [];
  for (const name of ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator", "x-drupal-cache", "x-runtime", "x-version"]) {
    const value = header(ctx, name);
    if (value === null) continue;
    // A bare product name is low value; a version number is a shopping list.
    if (/\d+\.\d+/.test(value)) versioned.push({ header: name, value });
    else leaks.push({ header: name, value });
  }

  if (versioned.length > 0) {
    findings.push({
      id: "sec-version-disclosure",
      category: "security",
      severity: "warning",
      title: "Response headers advertise exact software versions",
      detail: `${versioned.map((l) => `${l.header}: ${l.value}`).join("; ")}. Publishing a precise version turns vulnerability research into a lookup: an attacker matches the string against a CVE database and knows before touching you whether a working exploit exists. It also makes you a hit in internet-wide scans for that version.`,
      fix: "Suppress or flatten these headers at the edge. There is no functional reason to send them.",
      snippet: [
        "# nginx",
        "server_tokens off;",
        "more_clear_headers 'X-Powered-By' 'X-AspNet-Version';  # headers-more module",
        "",
        "# Express",
        'app.disable("x-powered-by");',
        "",
        "# Caddy",
        "header -Server",
      ].join("\n"),
      value: versioned.map((l) => `${l.header}: ${l.value}`).join(" | "),
      docs: "https://owasp.org/www-project-secure-headers/",
      weight: 2,
    });
  }

  if (leaks.length > 0) {
    findings.push({
      id: "sec-software-disclosure",
      category: "security",
      severity: "info",
      title: "Response headers name the server software",
      detail: `${leaks.map((l) => `${l.header}: ${l.value}`).join("; ")}. No version numbers here, so the exposure is modest - but it still narrows an attacker's search space to one stack's known weaknesses before they have sent a single probe.`,
      fix: "Strip or generalise these headers at the reverse proxy if you have no use for them.",
      value: leaks.map((l) => `${l.header}: ${l.value}`).join(" | "),
      docs: "https://owasp.org/www-project-secure-headers/",
      weight: 1,
    });
  }

  if (versioned.length === 0 && leaks.length === 0) {
    findings.push({
      id: "sec-no-software-disclosure",
      category: "security",
      severity: "pass",
      title: "No software or version headers leaked",
      detail: "None of Server, X-Powered-By, X-AspNet-Version or X-Generator disclose the stack behind this site.",
      weight: 1,
    });
  }

  const generatorMeta = doc.metaByName["generator"] ?? null;
  if (generatorMeta !== null && /\d/.test(generatorMeta)) {
    findings.push({
      id: "sec-generator-meta",
      category: "security",
      severity: "info",
      title: "A <meta name=\"generator\"> tag names the CMS and version",
      detail: `"${generatorMeta}" is published in the HTML. Automated scanners fingerprint sites on exactly this tag to build target lists for version-specific exploits.`,
      fix: "Remove the generator meta tag. In WordPress: `remove_action('wp_head', 'wp_generator');`. In most static site generators it is a one-line template edit.",
      value: generatorMeta,
      docs: "https://owasp.org/www-project-web-security-testing-guide/",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Cookies                                                              */
  /* ---------------------------------------------------------------------- */

  const rawCookies = header(ctx, "set-cookie");
  if (rawCookies === null) {
    findings.push({
      id: "sec-cookies-none",
      category: "security",
      severity: "pass",
      title: "No cookies set on this response",
      detail: "The document response sets no cookies, so there are no cookie flags to get wrong here.",
      weight: 1,
    });
  } else {
    const cookies = splitCookies(rawCookies).map(parseCookie);
    const insecure = cookies.filter((c) => !c.secure);
    const nonHttpOnly = cookies.filter((c) => !c.httpOnly);
    const noSameSite = cookies.filter((c) => c.sameSite === null);
    const sameSiteNoneInsecure = cookies.filter(
      (c) => c.sameSite !== null && c.sameSite.toLowerCase() === "none" && !c.secure,
    );

    if (insecure.length > 0 && ctx.https) {
      findings.push({
        id: "sec-cookie-secure-missing",
        category: "security",
        severity: "warning",
        title: `${pluralise(insecure.length, "cookie")} set without the Secure flag`,
        detail: `${insecure.map((c) => c.name).join(", ")} - a cookie without Secure is transmitted on plain HTTP requests too. One http:// request to any path on this domain (an old link, an image, an attacker-injected reference) leaks the value in cleartext, even though the site itself is HTTPS-only.`,
        fix: "Add `Secure` to every cookie. On an HTTPS-only site there is no downside.",
        snippet: "Set-Cookie: session=…; Secure; HttpOnly; SameSite=Lax; Path=/",
        value: insecure.map((c) => c.raw.slice(0, 80)).join(" | "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies",
        weight: 3,
      });
    }

    if (nonHttpOnly.length > 0) {
      findings.push({
        id: "sec-cookie-httponly-missing",
        category: "security",
        severity: "warning",
        title: `${pluralise(nonHttpOnly.length, "cookie")} readable by JavaScript`,
        detail: `${nonHttpOnly.map((c) => c.name).join(", ")} lack HttpOnly, so document.cookie can read them. If any script on the page is ever compromised - your own XSS bug, a hijacked analytics tag, a poisoned npm dependency - session tokens walk out with it. HttpOnly is what turns "XSS" into "XSS that cannot steal the session".`,
        fix: "Add `HttpOnly` to any cookie your front-end code does not genuinely need to read. Session and auth cookies always qualify.",
        snippet: "Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax; Path=/",
        value: nonHttpOnly.map((c) => c.name).join(", "),
        docs: "https://owasp.org/www-community/HttpOnly",
        weight: 3,
      });
    }

    if (noSameSite.length > 0) {
      findings.push({
        id: "sec-cookie-samesite-missing",
        category: "security",
        severity: "warning",
        title: `${pluralise(noSameSite.length, "cookie")} without an explicit SameSite`,
        detail: `${noSameSite.map((c) => c.name).join(", ")} rely on the browser default. Chrome treats an unspecified SameSite as Lax, but Safari and Firefox differ in the details and the default has changed before - so your CSRF exposure depends on which browser the visitor happens to use.`,
        fix: "State it explicitly: `SameSite=Lax` for session cookies, `SameSite=Strict` for anything high-value, `SameSite=None; Secure` only for genuine cross-site use.",
        snippet: "Set-Cookie: session=…; SameSite=Lax; Secure; HttpOnly",
        value: noSameSite.map((c) => c.name).join(", "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite",
        weight: 2,
      });
    }

    if (sameSiteNoneInsecure.length > 0) {
      findings.push({
        id: "sec-cookie-samesite-none-insecure",
        category: "security",
        severity: "warning",
        title: "SameSite=None cookies are missing Secure",
        detail: `${sameSiteNoneInsecure.map((c) => c.name).join(", ")} declare SameSite=None without Secure. Browsers reject this combination outright, so these cookies are being silently dropped - which usually shows up as an intermittent login bug rather than an obvious error.`,
        fix: "SameSite=None requires Secure. Add it, or switch to SameSite=Lax if the cookie is not actually needed cross-site.",
        snippet: "Set-Cookie: name=…; SameSite=None; Secure",
        value: sameSiteNoneInsecure.map((c) => c.raw.slice(0, 80)).join(" | "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite",
        weight: 2,
      });
    }

    const fullyProtected = cookies.filter((c) => c.secure && c.httpOnly && c.sameSite !== null);
    if (fullyProtected.length > 0) {
      findings.push({
        id: "sec-cookie-flags",
        category: "security",
        severity: "pass",
        title: `${pluralise(fullyProtected.length, "cookie")} set with Secure, HttpOnly and SameSite`,
        detail: `${fullyProtected.map((c) => `${c.name} (SameSite=${c.sameSite})`).join(", ")} carry the full set of protective flags.`,
        value: fullyProtected.map((c) => c.name).join(", "),
        weight: 1,
      });
    }

    const prefixed = cookies.filter((c) => c.name.startsWith("__Host-") || c.name.startsWith("__Secure-"));
    if (prefixed.length === 0 && cookies.length > 0) {
      findings.push({
        id: "sec-cookie-prefix",
        category: "security",
        severity: "info",
        title: "Cookies do not use the __Host- / __Secure- name prefixes",
        detail: `Cookies set: ${cookies.map((c) => c.name).join(", ")}. The __Host- prefix makes the browser itself enforce Secure, Path=/ and no Domain attribute - which stops a compromised subdomain from overwriting your session cookie, something the flags alone cannot prevent.`,
        fix: "Rename session cookies to `__Host-session` and set them with Secure and Path=/ and no Domain attribute.",
        snippet: "Set-Cookie: __Host-session=…; Secure; HttpOnly; SameSite=Lax; Path=/",
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Markup-level signals                                                 */
  /* ---------------------------------------------------------------------- */

  const inlineHandlerCount = (html.match(/\son(?:click|load|error|mouseover|submit|change|focus|blur|input|keydown|keyup)\s*=\s*["']/gi) ?? []).length;
  const inlineScripts = doc.scripts.filter((s) => s.src === null && s.inlineLength > 0 && s.type !== "application/ld+json");

  if (inlineHandlerCount > 0 || inlineScripts.length > 0) {
    findings.push({
      id: "sec-inline-code",
      category: "security",
      severity: "info",
      title: "Inline script blocks CSP adoption",
      detail: `${pluralise(inlineScripts.length, "inline <script> block")} and ${pluralise(inlineHandlerCount, "inline event handler attribute")} (onclick=, onload= and friends). Each one has to be nonced, hashed or rewritten before you can drop 'unsafe-inline' from a CSP - this is normally the whole of the work in adopting a strict policy.`,
      fix: "Move handlers into addEventListener calls in an external file, and give any remaining inline blocks a per-request nonce.",
      snippet: [
        "<!-- instead of: <button onclick=\"save()\">Save</button> -->",
        '<button id="save">Save</button>',
        '<script nonce="{RANDOM}">',
        '  document.getElementById("save").addEventListener("click", save);',
        "</script>",
      ].join("\n"),
      value: `${inlineScripts.length} inline scripts, ${inlineHandlerCount} inline handlers`,
      docs: "https://web.dev/articles/strict-csp",
      weight: 1,
    });
  } else {
    findings.push({
      id: "sec-no-inline-code",
      category: "security",
      severity: "pass",
      title: "No inline scripts or event handlers",
      detail: "The page carries no inline <script> bodies and no on*= attributes, so a strict nonce-free CSP is achievable without rewriting the front-end.",
      weight: 1,
    });
  }

  const scriptTags = openingTags(html, "script");
  const pageHost = hostOf(ctx.finalUrl, ctx.finalUrl);
  const crossOriginScripts: string[] = [];
  const unprotectedScripts: string[] = [];

  for (const attrs of scriptTags) {
    const src = attrValue(attrs, "src");
    if (src === null || src.trim() === "") continue;
    const host = hostOf(src, ctx.finalUrl);
    if (host === null || host === pageHost) continue;
    crossOriginScripts.push(src);
    if (attrValue(attrs, "integrity") === null) unprotectedScripts.push(src);
  }

  if (crossOriginScripts.length > 0) {
    if (unprotectedScripts.length > 0) {
      findings.push({
        id: "sec-sri-missing",
        category: "security",
        severity: "warning",
        title: `${pluralise(unprotectedScripts.length, "third-party script")} loaded without Subresource Integrity`,
        detail: `Scripts from other origins execute with full access to this page - the DOM, the cookies, the forms. Without an integrity hash, whatever that origin serves today is what runs, and you are trusting their CDN, their build pipeline and their account security as if they were your own. ${unprotectedScripts.slice(0, 4).join(", ")}${unprotectedScripts.length > 4 ? `, and ${unprotectedScripts.length - 4} more` : ""}.`,
        fix: "Add an `integrity` hash and `crossorigin=\"anonymous\"` to any third-party script served from a fixed, versioned URL. For tags that must stay mutable (analytics loaders), pin them behind a CSP allowlist instead and review what they load.",
        snippet: '<script src="https://cdn.example.com/lib@1.2.3/lib.min.js" integrity="sha384-…" crossorigin="anonymous"></script>',
        value: unprotectedScripts.slice(0, 6).join(" | "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity",
        weight: 2,
      });
    } else {
      findings.push({
        id: "sec-sri",
        category: "security",
        severity: "pass",
        title: "Third-party scripts carry Subresource Integrity hashes",
        detail: `All ${crossOriginScripts.length} cross-origin scripts declare an integrity hash, so the browser refuses to execute them if the delivered bytes change.`,
        value: crossOriginScripts.slice(0, 4).join(" | "),
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Outdated libraries                                                   */
  /* ---------------------------------------------------------------------- */

  const outdated: string[] = [];
  const libraryDocs: string[] = [];
  const seenLibraries = new Set<string>();

  for (const script of doc.scripts) {
    const src = script.src;
    if (src === null) continue;
    for (const rule of LIBRARY_RULES) {
      const match = rule.pattern.exec(src);
      if (match === null) continue;
      const major = Number.parseInt(match[1], 10);
      const minor = Number.parseInt(match[2], 10);
      if (Number.isNaN(major) || Number.isNaN(minor)) continue;
      const [minMajor, minMinor] = rule.outdatedBelow;
      const isOld = major < minMajor || (major === minMajor && minor < minMinor);
      const key = `${rule.label}-${major}.${minor}`;
      if (!isOld || seenLibraries.has(key)) continue;
      seenLibraries.add(key);
      outdated.push(`${rule.label} ${major}.${minor} (${src}) - ${rule.advice}`);
      libraryDocs.push(rule.docs);
    }
  }

  if (outdated.length > 0) {
    findings.push({
      id: "sec-outdated-library",
      category: "security",
      severity: "warning",
      title: `${pluralise(outdated.length, "outdated JavaScript library")} detected in script URLs`,
      detail: `Version numbers visible in the script URLs point at releases with published vulnerabilities: ${outdated.join(" ")}`,
      fix: "Upgrade to a supported release. Where the version is only inferred from the filename, confirm the actual bundled version before acting - but the URL is what an attacker fingerprints on either way.",
      value: outdated.map((o) => o.split(" - ")[0]).join(" | "),
      docs: libraryDocs[0] ?? "https://owasp.org/www-project-top-ten/",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. Forms and link targets                                              */
  /* ---------------------------------------------------------------------- */

  const insecureForms: string[] = [];
  for (const attrs of openingTags(html, "form")) {
    const action = attrValue(attrs, "action");
    if (action !== null && /^http:\/\//i.test(action.trim())) insecureForms.push(action.trim());
  }

  if (insecureForms.length > 0) {
    findings.push({
      id: "sec-form-insecure-action",
      category: "security",
      severity: "critical",
      title: `${pluralise(insecureForms.length, "form")} submits over plain HTTP`,
      detail: `Form actions point at http:// URLs (${insecureForms.slice(0, 3).join(", ")}). Everything typed into those forms crosses the network unencrypted, regardless of the page being served over HTTPS. Browsers show a hard warning on password fields in this situation and Chrome blocks the submission outright.`,
      fix: "Change the action to https://, or make it a same-origin relative path so it inherits the page's scheme.",
      snippet: '<form method="post" action="/subscribe">',
      value: insecureForms.join(" | "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content",
      weight: 4,
    });
  }

  const unsafeTargets = doc.anchors.filter((a) => {
    if ((a.target ?? "").toLowerCase() !== "_blank") return false;
    if (a.internal) return false;
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    return !rel.includes("noopener") && !rel.includes("noreferrer");
  });

  if (unsafeTargets.length > 0) {
    findings.push({
      id: "sec-target-blank-noopener",
      category: "security",
      severity: "info",
      title: `${pluralise(unsafeTargets.length, "external link")} opens a new tab without rel="noopener"`,
      detail: `Links such as ${unsafeTargets.slice(0, 3).map((a) => a.href ?? "").filter((h) => h !== "").join(", ")} use target="_blank" with no noopener. The opened page gets a window.opener handle back to this one and can redirect it to a phishing clone while the visitor is looking at the new tab. Current browsers imply noopener for target="_blank", so this is now a compatibility concern rather than a live hole - but stating it costs nothing.`,
      fix: 'Add rel="noopener noreferrer" to external links that open in a new tab.',
      snippet: '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>',
      value: unsafeTargets.slice(0, 5).map((a) => a.href ?? "").filter((h) => h !== "").join(" | "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener",
      weight: 1,
    });
  }

  const externalIframes = doc.iframes.filter((f) => {
    if (f.src === null) return false;
    const host = hostOf(f.src, ctx.finalUrl);
    return host !== null && host !== pageHost;
  });

  if (externalIframes.length > 0) {
    const sandboxed = openingTags(html, "iframe").filter((attrs) => attrValue(attrs, "sandbox") !== null).length;
    if (sandboxed < externalIframes.length) {
      findings.push({
        id: "sec-iframe-sandbox",
        category: "security",
        severity: "info",
        title: `${pluralise(externalIframes.length - sandboxed, "third-party iframe")} embedded without a sandbox attribute`,
        detail: `Embedded from: ${externalIframes.slice(0, 3).map((f) => hostOf(f.src ?? "", ctx.finalUrl) ?? "").join(", ")}. An unsandboxed frame can run scripts, submit forms, trigger downloads and navigate the top-level page. Sandboxing lets you grant back only what the embed actually needs.`,
        fix: 'Add sandbox with the minimum set of allow-* tokens the embed requires, e.g. sandbox="allow-scripts allow-same-origin".',
        snippet: '<iframe src="https://player.example.com/v" sandbox="allow-scripts allow-presentation" loading="lazy" title="Video"></iframe>',
        value: externalIframes.map((f) => f.src ?? "").filter((s) => s !== "").slice(0, 4).join(" | "),
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 11. CORS                                                                */
  /* ---------------------------------------------------------------------- */

  const acao = header(ctx, "access-control-allow-origin");
  const acac = header(ctx, "access-control-allow-credentials");
  if (acao === "*" && acac !== null && /true/i.test(acac)) {
    findings.push({
      id: "sec-cors-wildcard-credentials",
      category: "security",
      severity: "critical",
      title: "CORS allows any origin with credentials",
      detail: `Access-Control-Allow-Origin is "*" and Access-Control-Allow-Credentials is "${acac}". Browsers reject this exact combination, but a server configured this way is usually reflecting the request Origin elsewhere - which would let any site read authenticated responses from this one on behalf of a logged-in visitor.`,
      fix: "Never combine a wildcard origin with credentials. Echo back only origins from an explicit allowlist, and add `Vary: Origin`.",
      snippet: [
        "# Only reflect known origins",
        'if ($http_origin ~* "^https://(app|admin)\\.example\\.com$") {',
        '  add_header Access-Control-Allow-Origin $http_origin always;',
        '  add_header Access-Control-Allow-Credentials "true" always;',
        '  add_header Vary "Origin" always;',
        "}",
      ].join("\n"),
      value: `Access-Control-Allow-Origin: ${acao}; Access-Control-Allow-Credentials: ${acac}`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS",
      weight: 4,
    });
  } else if (acao === "*") {
    findings.push({
      id: "sec-cors-wildcard",
      category: "security",
      severity: "info",
      title: "CORS allows any origin to read this response",
      detail:
        'Access-Control-Allow-Origin is "*". For a public HTML page that is harmless. It becomes a problem the moment the same configuration is applied to an endpoint that returns per-user data, so check that this is set at the page level and not blanket across the whole host.',
      fix: "Scope the wildcard to genuinely public assets and drop it everywhere else.",
      value: acao,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin",
      weight: 1,
    });
  }

  return findings;
}
