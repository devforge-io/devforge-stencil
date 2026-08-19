/**
 * TLS and certificate checks.
 *
 * Everything here is derived from `ctx.tls` - the peer certificate, negotiated
 * protocol and cipher captured by a raw `node:tls` handshake with the final
 * host, plus the results of probing TLS 1.0 and 1.1 individually. `fetch()`
 * exposes none of that, which is why the fetcher opens its own socket.
 *
 * This module owns the transport itself: is the certificate trusted, does it
 * cover the hostname, when does it expire, which protocol versions and ciphers
 * does the server still agree to, and how strong are the keys behind them.
 *
 * Response headers - HSTS, CSP, cookie flags, framing - belong to the security
 * checks and are deliberately not repeated. The two exceptions are the
 * interactions at the end: HSTS plus a broken certificate is a specific,
 * unrecoverable failure mode that neither module can see on its own, and
 * `ctx.insecureFallback` - set when the fetcher could only retrieve the
 * document by disabling certificate validation - qualifies every other finding
 * in the whole report, so it is stated here as loudly as possible.
 *
 * Pure: reads `ctx`, performs no network I/O of its own.
 */

import type { Finding, PageContext, TlsInfo } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DOCS_MOZILLA_CONFIG = "https://ssl-config.mozilla.org/";
const DOCS_SERVER_SIDE_TLS = "https://wiki.mozilla.org/Security/Server_Side_TLS";
const DOCS_RFC_8996 = "https://www.rfc-editor.org/rfc/rfc8996";
const DOCS_MDN_TLS = "https://developer.mozilla.org/en-US/docs/Web/Security/Transport_Layer_Security";
const DOCS_MDN_CIPHER = "https://developer.mozilla.org/en-US/docs/Glossary/Cipher_suite";
const DOCS_MDN_FORWARD_SECRECY = "https://developer.mozilla.org/en-US/docs/Glossary/Forward_Secrecy";
const DOCS_MDN_CERTIFICATE = "https://developer.mozilla.org/en-US/docs/Glossary/Digital_certificate";
const DOCS_MDN_HSTS =
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security";

/**
 * Maximum lifetime the CA/Browser Forum baseline requirements allow for a
 * publicly trusted certificate. Apple, then Google and Mozilla, began rejecting
 * anything longer in September 2020.
 */
const MAX_PUBLIC_VALIDITY_DAYS = 398;

/** A modest list of two-label public suffixes, enough to spot an apex domain. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "co.nz",
  "net.nz",
  "org.nz",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "com.br",
  "com.mx",
  "com.ar",
  "co.za",
  "co.jp",
  "or.jp",
  "ne.jp",
  "co.in",
  "co.kr",
  "com.sg",
  "com.hk",
  "com.tr",
  "com.cn",
  "com.tw",
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Read an already-lowercased response header, trimmed, or null when absent. */
function header(ctx: PageContext, name: string): string | null {
  const raw = ctx.headers[name];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Parse an ISO timestamp, returning null for anything unusable. */
function parseIso(value: string | null): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days from `a` to `b`; negative when `b` is in the past. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** `2026-08-16` - stable, unambiguous, and never NaN because the input parsed. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A finite number or null - guards every arithmetic path against NaN. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Non-empty trimmed string, or null. Never returns "undefined" as text. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Join a list for display, capping the tail. */
function formatList(values: string[], cap: number): string {
  if (values.length <= cap) return values.join(", ");
  return `${values.slice(0, cap).join(", ")} … and ${values.length - cap} more`;
}

/** Host of the final URL, lowercased, or null when it somehow doesn't parse. */
function finalHost(ctx: PageContext): string | null {
  try {
    return new URL(ctx.finalUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Does a SAN entry cover this host?
 *
 * Wildcards match exactly one label and only at the leftmost position, which is
 * what browsers implement - `*.example.com` covers `www.example.com` but not
 * `example.com` and not `a.b.example.com`.
 */
function sanCovers(san: string, host: string): boolean {
  const entry = san.trim().toLowerCase();
  const target = host.trim().toLowerCase();
  if (entry === "" || target === "") return false;
  if (entry === target) return true;
  if (!entry.startsWith("*.")) return false;

  const suffix = entry.slice(2);
  if (suffix === "") return false;
  if (!target.endsWith(`.${suffix}`)) return false;

  const label = target.slice(0, target.length - suffix.length - 1);
  return label !== "" && !label.includes(".");
}

/**
 * Work out the apex/`www.` pair for a host, when the host is close enough to a
 * registrable domain for the pairing to be meaningful. Returns null for deeper
 * subdomains like `app.example.com`, where asking about `www.app.example.com`
 * would be nonsense.
 */
function apexAndWww(host: string): { apex: string; www: string } | null {
  const base = host.startsWith("www.") ? host.slice(4) : host;
  const labels = base.split(".").filter((l) => l !== "");
  if (labels.length < 2) return null;

  const isRegistrable =
    labels.length === 2 ||
    (labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join(".")));
  if (!isRegistrable) return null;

  return { apex: base, www: `www.${base}` };
}

/**
 * Normalise a cipher suite name into uppercase whitespace-separated tokens.
 *
 * OpenSSL uses hyphens (`ECDHE-RSA-AES128-GCM-SHA256`) and the IANA names use
 * underscores (`TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`); flattening both to
 * spaces lets one set of token tests handle either spelling.
 */
function cipherTokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

/* -------------------------------------------------------------------------- */
/* Chain verification errors                                                   */
/* -------------------------------------------------------------------------- */

interface ChainErrorExplanation {
  /** Plain-English translation of the OpenSSL/Node code. */
  summary: string;
  fix: string;
  snippet?: string;
}

/**
 * Node surfaces OpenSSL's verification codes verbatim. They are precise and
 * completely opaque to anyone who has not read the OpenSSL source, so translate
 * the ones that actually show up in the field.
 */
const CHAIN_ERRORS: Record<string, ChainErrorExplanation> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    summary:
      "the certificate signed itself - no certificate authority vouched for it, so there is nothing for a browser to verify it against",
    fix: "Replace the self-signed certificate with one from a public CA. Let's Encrypt issues them free and renews automatically.",
    snippet: ["# Certbot, nginx", "sudo certbot --nginx -d example.com -d www.example.com"].join("\n"),
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    summary:
      "somewhere above the leaf, the chain terminates in a self-signed certificate that is not in the public trust store - typically a private or corporate CA",
    fix: "Reissue from a publicly trusted CA. A private CA only works when every client has been made to trust its root, which is impossible for public visitors.",
    snippet: ["# Certbot, nginx", "sudo certbot --nginx -d example.com -d www.example.com"].join("\n"),
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    summary:
      "the leaf certificate is fine but the intermediate that signed it was not sent, so the chain cannot be walked back to a trusted root",
    fix: "Serve the full chain: point your server at the concatenated leaf-plus-intermediates file, not the bare certificate.",
    snippet: [
      "# nginx - fullchain.pem, not cert.pem",
      "ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;",
      "ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;",
    ].join("\n"),
  },
  UNABLE_TO_GET_ISSUER_CERT: {
    summary: "the issuing certificate could not be located, which usually means an intermediate is missing from what the server sends",
    fix: "Serve the full chain - leaf plus every intermediate - rather than the leaf alone.",
    snippet: "ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;",
  },
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: {
    summary: "the root that signed this chain is not in the public trust store, so the chain ends in an unknown authority",
    fix: "Reissue from a publicly trusted CA, or if this is deliberately an internal service, do not expose it on a public hostname.",
  },
  CERT_HAS_EXPIRED: {
    summary: "the certificate's validity period has already ended",
    fix: "Renew the certificate immediately and reload the server so it picks up the new file. Then automate renewal so this cannot recur.",
    snippet: ["sudo certbot renew --force-renewal", "sudo systemctl reload nginx"].join("\n"),
  },
  CERT_NOT_YET_VALID: {
    summary: "the certificate's validity period has not started yet - usually a wrong server clock or a certificate installed ahead of its issuance date",
    fix: "Check the server clock (enable NTP) and confirm you installed the certificate you meant to install.",
    snippet: "timedatectl set-ntp true",
  },
  ERR_TLS_CERT_ALTNAME_INVALID: {
    summary: "the certificate is valid but none of the names it covers match the hostname that was requested",
    fix: "Reissue the certificate with every hostname the site is served on listed as a subject alternative name.",
    snippet: "sudo certbot --nginx -d example.com -d www.example.com",
  },
  CERT_REVOKED: {
    summary: "the certificate has been revoked by the authority that issued it, normally because the private key was compromised",
    fix: "Treat the key as compromised: generate a new key pair, request a new certificate, and rotate any secrets that shared the host.",
  },
  CERT_UNTRUSTED: {
    summary: "the root of the chain is present but explicitly not trusted",
    fix: "Reissue from a CA in the public trust store.",
  },
  CERT_SIGNATURE_FAILURE: {
    summary: "the signature on the certificate did not verify - the chain is inconsistent or the file is corrupt",
    fix: "Reissue the certificate and confirm the deployed file is exactly what the CA returned, with no truncation or re-encoding.",
  },
  HOSTNAME_MISMATCH: {
    summary: "the certificate does not cover the hostname that was requested",
    fix: "Reissue the certificate with the correct subject alternative names.",
  },
};

function explainChainError(code: string | null): ChainErrorExplanation | null {
  const key = text(code);
  if (key === null) return null;
  return CHAIN_ERRORS[key.toUpperCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Certificate authorities                                                     */
/* -------------------------------------------------------------------------- */

interface CaRule {
  pattern: RegExp;
  name: string;
  /** Something worth knowing about certificates from this issuer. */
  note: string;
}

const CA_RULES: CaRule[] = [
  {
    pattern: /let'?s\s*encrypt|\bISRG\b/i,
    name: "Let's Encrypt",
    note: "Let's Encrypt certificates last 90 days and are designed to be renewed automatically at the 30-day mark, so a healthy site never shows less than 30 days remaining.",
  },
  {
    pattern: /zerossl/i,
    name: "ZeroSSL",
    note: "ZeroSSL issues via ACME like Let's Encrypt, so renewal should be automated rather than diarised.",
  },
  {
    pattern: /google\s*trust\s*services|\bGTS\b/i,
    name: "Google Trust Services",
    note: "Typically seen on Google Cloud load balancers and Firebase Hosting, where renewal is managed for you.",
  },
  {
    pattern: /\bamazon\b|\bAWS\b/i,
    name: "Amazon",
    note: "Amazon-issued certificates come from AWS Certificate Manager, which renews automatically as long as the domain validation record stays in place.",
  },
  {
    pattern: /cloudflare/i,
    name: "Cloudflare",
    note: "A Cloudflare-issued edge certificate means traffic terminates at Cloudflare's proxy. Check that the connection from Cloudflare back to your origin is also verified (Full (strict) mode), because this handshake says nothing about that leg.",
  },
  {
    pattern: /digicert/i,
    name: "DigiCert",
    note: "A commercial CA - renewal is usually manual or API-driven rather than ACME, so keep the expiry in a calendar.",
  },
  {
    pattern: /sectigo/i,
    name: "Sectigo",
    note: "A commercial CA - renewal is usually manual or API-driven, so keep the expiry in a calendar.",
  },
  {
    pattern: /comodo/i,
    name: "Comodo CA",
    note: "Comodo CA is now Sectigo; certificates still carrying the old branding are typically several years old.",
  },
  {
    pattern: /globalsign/i,
    name: "GlobalSign",
    note: "A commercial CA - renewal is usually manual or API-driven, so keep the expiry in a calendar.",
  },
  {
    pattern: /go\s*daddy/i,
    name: "GoDaddy",
    note: "A commercial CA - renewal is usually manual or tied to your hosting panel.",
  },
  {
    pattern: /starfield/i,
    name: "Starfield Technologies",
    note: "Starfield is GoDaddy's second root, and also backs some AWS-issued certificates.",
  },
  {
    pattern: /entrust/i,
    name: "Entrust",
    note: "Chrome began distrusting Entrust-issued certificates for public TLS from late 2024 - check that this certificate chains to a root Chrome still accepts.",
  },
  { pattern: /identrust/i, name: "IdenTrust", note: "IdenTrust cross-signs several other authorities, so this may be a legacy chain." },
  { pattern: /buypass/i, name: "Buypass", note: "Buypass Go issues via ACME, so renewal should be automated." },
  { pattern: /actalis/i, name: "Actalis", note: "A commercial European CA." },
  { pattern: /certum|asseco/i, name: "Certum", note: "A commercial European CA." },
  { pattern: /ssl\.com/i, name: "SSL.com", note: "A commercial CA that also supports ACME issuance." },
  { pattern: /\bharica\b/i, name: "HARICA", note: "A Greek academic CA that also issues publicly trusted certificates." },
  { pattern: /thawte/i, name: "Thawte", note: "Thawte is a DigiCert brand." },
  { pattern: /geotrust/i, name: "GeoTrust", note: "GeoTrust is a DigiCert brand." },
  { pattern: /rapidssl/i, name: "RapidSSL", note: "RapidSSL is a DigiCert brand." },
  { pattern: /microsoft|azure/i, name: "Microsoft", note: "Typically an Azure-managed certificate, renewed by the platform." },
  { pattern: /\bapple\b/i, name: "Apple", note: "An Apple-operated CA." },
  { pattern: /trustwave/i, name: "Trustwave", note: "A commercial CA." },
];

/** Issuer strings that smell like a private or development authority. */
const INTERNAL_ISSUER = /\b(internal|intranet|corp|corporate|local|localhost|lan|home|test|testing|dev|development|staging|self[\s-]?signed|acme[\s-]?co|example|kubernetes|k8s|minica|mkcert|snakeoil)\b/i;

/* -------------------------------------------------------------------------- */
/* Insecure fetch fallback                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Findings that explain *why* certificate validation failed.
 *
 * The fallback finding names whichever of these also fired instead of
 * re-deriving the cause, so the two never disagree. Deliberately keyed `slug`
 * rather than `id` so this list is not mistaken for a set of finding
 * definitions by anything scanning the file for declared ids.
 */
const CHAIN_CAUSE_SLUGS: string[] = [
  "tls-self-signed",
  "tls-expired",
  "tls-not-yet-valid",
  "tls-hostname-mismatch",
  "tls-intermediate-missing",
  "tls-chain-untrusted",
];

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`. */
function joinTitles(titles: string[]): string {
  const quoted = titles.map((t) => `"${t}"`);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The headline finding for a site whose document could only be retrieved with
 * certificate validation switched off.
 *
 * Built through a helper rather than inline because it has to be emittable from
 * both the early-return path (no certificate could be read at all) and the main
 * path (certificate read, and one or more chain findings explain the cause),
 * with identical wording either way.
 */
function insecureFallbackFinding(ctx: PageContext, causeTitles: string[]): Finding {
  const crossReference =
    causeTitles.length > 0
      ? `The specific reason validation failed is reported separately in this category - see ${joinTitles(causeTitles)} - and is not restated here.`
      : "The other findings in this category describe what could be read of the certificate.";

  return {
    id: "tls-insecure-fetch-fallback",
    category: "tls",
    severity: "critical",
    title: "This page could only be read by disabling certificate validation",
    detail: `Fetching ${ctx.finalUrl} failed certificate verification, and the audit only completed by retrying with validation turned off. A browser has no such fallback and would not use one if it did: Chrome, Safari, Firefox and Edge all abandon the connection and render a full-page security interstitial in place of your content. That is the practical state of this site right now - nobody reaches this page without first being shown a warning and choosing to override it, and a large share of visitors will leave instead. Clients with no human to click the button (mobile apps, webhooks, payment callbacks, uptime monitors, search-engine crawlers, anything using curl or a standard HTTP library) do not get a choice at all; they fail closed. ${crossReference} There is a second consequence worth being explicit about: everything else in this report - the HTML, the response headers, the metadata, every finding in every other category - arrived over a connection that was encrypted but not authenticated. Encryption without authentication proves only that someone is on the other end, not that it is your server, so none of what follows can be shown to have come from you unmodified. Fix the certificate first; treat the rest of the report as provisional until you have.`,
    fix: "Resolve the certificate problem before acting on anything else in this report, then re-run the audit so the remaining findings are based on a connection that was actually verified.",
    snippet: [
      "# See exactly what a real client sees - this exits non-zero on any chain error",
      "openssl s_client -connect example.com:443 -servername example.com -verify_return_error </dev/null",
      "",
      "# Most causes are fixed by reissuing and serving the full chain",
      "sudo certbot --nginx -d example.com -d www.example.com",
      "sudo systemctl reload nginx",
    ].join("\n"),
    value: ctx.finalUrl,
    docs: DOCS_MDN_CERTIFICATE,
    weight: 6,
  };
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function tlsChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const tls: TlsInfo | null = ctx.tls;
  // Read defensively: a PageContext built before this field existed reads as
  // `undefined`, which must mean "we did not need the fallback", not a throw.
  const insecureFallback = ctx.insecureFallback === true;

  /* ---------------------------------------------------------------------- */
  /* 0. No handshake to inspect                                              */
  /* ---------------------------------------------------------------------- */

  if (tls === null) {
    if (!ctx.https) {
      findings.push({
        id: "tls-not-applicable",
        category: "tls",
        severity: "critical",
        title: "No TLS to inspect - the site is served over plain HTTP",
        detail: `${ctx.finalUrl} was delivered without a TLS handshake, so there is no certificate, no negotiated protocol and no cipher to examine. Nothing in this category can be verified because none of it exists: the connection is neither encrypted nor authenticated, and a visitor has no way to know they reached your server rather than someone else's.`,
        fix: "Obtain a certificate and serve the site over HTTPS. Let's Encrypt is free and issues in under a minute; Caddy and most managed platforms do it with no configuration at all.",
        snippet: [
          "# Certbot - issues and configures nginx in one step",
          "sudo certbot --nginx -d example.com -d www.example.com",
          "",
          "# Caddy - automatic certificates, nothing to configure",
          "example.com {",
          "  root * /srv",
          "  file_server",
          "}",
        ].join("\n"),
        value: ctx.finalUrl,
        docs: DOCS_MDN_TLS,
        weight: 5,
      });
      return findings;
    }

    findings.push({
      id: "tls-handshake-failed",
      category: "tls",
      severity: "critical",
      title: "The TLS handshake could not be completed",
      detail: `${ctx.origin} answers on https, but a direct TLS connection to it did not produce a usable handshake, so no certificate could be read. Something is wrong at the transport layer itself - a server that only offers protocol versions or ciphers modern clients refuse, an incomplete or corrupt certificate file, an SNI misconfiguration, or a middlebox terminating the connection early. Whatever the cause, some clients are seeing the same failure and simply cannot load the site.`,
      fix: "Reproduce it from outside your network and read the error directly, then check that the server offers TLS 1.2 and 1.3 with a modern cipher list and serves the full certificate chain.",
      snippet: [
        "openssl s_client -connect example.com:443 -servername example.com -showcerts",
        "",
        "# Then compare against a known-good configuration:",
        "#   https://ssl-config.mozilla.org/",
      ].join("\n"),
      value: ctx.origin,
      docs: DOCS_MOZILLA_CONFIG,
      weight: 5,
    });

    // No certificate was readable, so there is no cause finding to point at -
    // emit the fallback headline on its own rather than losing it entirely.
    if (insecureFallback) findings.push(insecureFallbackFinding(ctx, []));

    return findings;
  }

  const host = finalHost(ctx);
  const now = new Date();

  /* ---------------------------------------------------------------------- */
  /* 1. Chain and trust                                                      */
  /* ---------------------------------------------------------------------- */

  const authorizationError = text(tls.authorizationError);
  const explanation = explainChainError(authorizationError);
  const missingIntermediate =
    authorizationError !== null &&
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT$/i.test(authorizationError);

  if (tls.authorized === false) {
    const quoted = authorizationError ?? "no error code reported";
    const translated = explanation
      ? ` In plain English: ${explanation.summary}.`
      : " The code is not one of the common ones, so read it against the OpenSSL verification error list.";

    findings.push({
      id: "tls-chain-untrusted",
      category: "tls",
      severity: "critical",
      title: "The certificate chain does not validate",
      detail: `Verification against the standard certificate authority bundle failed with \`${quoted}\`.${translated} Every browser applies the same check, so visitors get a full-page interstitial warning rather than your site, and non-browser clients - mobile apps, webhooks, payment callbacks, monitoring - usually refuse the connection outright with no way to click through.`,
      fix:
        explanation?.fix ??
        "Reissue the certificate from a publicly trusted authority and serve the complete chain - leaf plus every intermediate - then verify from a machine outside your own network.",
      snippet:
        explanation?.snippet ??
        "openssl s_client -connect example.com:443 -servername example.com -showcerts",
      value: quoted,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 5,
    });
  }

  if (missingIntermediate) {
    findings.push({
      id: "tls-intermediate-missing",
      category: "tls",
      severity: "critical",
      title: "The server is not sending its intermediate certificate",
      detail: `The chain failed with \`${authorizationError ?? "UNABLE_TO_VERIFY_LEAF_SIGNATURE"}\`, which means the leaf certificate itself is fine but the intermediate that signed it was never sent. This is the classic "it works in my browser" bug: desktop browsers cache intermediates they have seen before, or fetch the missing one from the URL in the certificate's Authority Information Access field, and quietly paper over the mistake. Mobile browsers, Firefox on a fresh profile, curl, Java clients, payment gateways and webhook senders do not - so the site works perfectly for the person who deployed it and fails for a slice of real visitors and every server-to-server integration.`,
      fix: "Point the server at the full-chain file rather than the bare leaf certificate, reload, and re-test from a client that has never seen the site before.",
      snippet: [
        "# nginx - fullchain.pem contains leaf + intermediates",
        "ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;",
        "ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;",
        "",
        "# Apache 2.4.8+",
        "SSLCertificateFile    /etc/letsencrypt/live/example.com/fullchain.pem",
        "SSLCertificateKeyFile /etc/letsencrypt/live/example.com/privkey.pem",
        "",
        "# Confirm the server sends more than one certificate:",
        "openssl s_client -connect example.com:443 -servername example.com -showcerts | grep -c 'BEGIN CERTIFICATE'",
      ].join("\n"),
      value: authorizationError ?? "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      docs: DOCS_SERVER_SIDE_TLS,
      weight: 5,
    });
  }

  if (tls.isSelfSigned) {
    findings.push({
      id: "tls-self-signed",
      category: "tls",
      severity: "critical",
      title: "The certificate is self-signed",
      detail: `This certificate vouches for itself - no certificate authority signed it${text(tls.issuer) ? ` (issuer: "${text(tls.issuer)}")` : ""}. It encrypts the connection, but it authenticates nothing: an attacker who can intercept traffic can present their own self-signed certificate and a visitor has no way to tell the two apart. Browsers respond with a full-page interstitial ("Your connection is not private", NET::ERR_CERT_AUTHORITY_INVALID) that a visitor must deliberately click through, and most simply leave instead.`,
      fix: "Replace it with a certificate from a publicly trusted CA. Let's Encrypt is free, issues in seconds and renews itself; self-signed certificates belong on internal hosts that are never reached by a public browser.",
      snippet: [
        "sudo certbot --nginx -d example.com -d www.example.com",
        "",
        "# Or, on a platform with automatic HTTPS:",
        "#   Caddy, Vercel, Netlify, Cloudflare and Fly all issue for you.",
      ].join("\n"),
      value: text(tls.subjectCn) ?? ctx.origin,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 5,
    });
  }

  const sans = Array.isArray(tls.subjectAltNames)
    ? tls.subjectAltNames.map((s) => text(s)).filter((s): s is string => s !== null)
    : [];

  if (tls.hostnameMatches === false) {
    const covered = sans.length > 0 ? formatList(sans, 10) : "none - the certificate lists no subject alternative names at all";
    findings.push({
      id: "tls-hostname-mismatch",
      category: "tls",
      severity: "critical",
      title: "The certificate does not cover this hostname",
      detail: `The request was for ${host ?? ctx.origin}, but the certificate covers: ${covered}. Browsers treat a name mismatch exactly like an untrusted chain - a full-page interstitial, no content rendered - because a certificate for the wrong name is precisely what an interceptor would present. It usually means one virtual host is serving another's certificate, a default certificate is answering for an unconfigured hostname, or a domain was added to the site without being added to the certificate.`,
      fix: `Reissue the certificate with every hostname the site answers on listed as a subject alternative name${host ? `, including ${host}` : ""}. If several sites share the server, check that SNI is routing to the right virtual host.`,
      snippet: [
        `sudo certbot --nginx -d ${host ?? "example.com"}${host && !host.startsWith("www.") ? ` -d www.${host}` : ""}`,
        "",
        "# Check which certificate a given hostname actually gets:",
        `openssl s_client -connect ${host ?? "example.com"}:443 -servername ${host ?? "example.com"} | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"`,
      ].join("\n"),
      value: `requested ${host ?? ctx.origin}; certificate covers ${sans.length > 0 ? formatList(sans, 6) : "no SAN entries"}`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 5,
    });
  }

  if (tls.authorized === true && tls.hostnameMatches === true && !tls.isSelfSigned) {
    findings.push({
      id: "tls-chain-trusted",
      category: "tls",
      severity: "pass",
      title: "Certificate chain is trusted and matches the hostname",
      detail: `The chain validated against the standard certificate authority bundle and the certificate covers ${host ?? "the requested host"}. Visitors get a padlock rather than a warning, and non-browser clients will connect without special handling.`,
      value: text(tls.subjectCn) ?? host ?? ctx.origin,
      weight: 4,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Validity window                                                      */
  /* ---------------------------------------------------------------------- */

  const validFrom = parseIso(tls.validFrom);
  const validTo = parseIso(tls.validTo);
  const reportedDays = finiteOrNull(tls.daysUntilExpiry);
  const daysLeft = reportedDays ?? (validTo ? daysBetween(now, validTo) : null);

  if (daysLeft === null) {
    findings.push({
      id: "tls-expiry-unknown",
      category: "tls",
      severity: "info",
      title: "Certificate expiry could not be determined",
      detail:
        "The handshake succeeded but the certificate's notAfter date was not readable, so this audit cannot say how long the certificate has left. That is a limitation of the reading, not necessarily a problem with the certificate.",
      fix: "Check the expiry directly and make sure something is watching it - an unmonitored certificate is the single most common cause of an unplanned outage.",
      snippet: "echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -dates",
      docs: DOCS_MDN_CERTIFICATE,
      weight: 1,
    });
  } else if (daysLeft <= 0) {
    const expiredOn = validTo ? formatDate(validTo) : null;
    const agoDays = Math.abs(daysLeft);
    findings.push({
      id: "tls-expired",
      category: "tls",
      severity: "critical",
      title: "The certificate has expired",
      detail: `The certificate stopped being valid ${agoDays === 0 ? "today" : `${pluralise(agoDays, "day")} ago`}${expiredOn ? ` (${expiredOn})` : ""}. This is not a warning about the future - every browser reaching this site right now shows a full-page NET::ERR_CERT_DATE_INVALID interstitial instead of your content, and API clients, apps and webhooks fail closed. For practical purposes the site is down.`,
      fix: "Renew now and reload the server so it picks up the new file, then fix the automation that was meant to do this. Renewal alone is not enough - most servers hold the old certificate in memory until reloaded.",
      snippet: [
        "sudo certbot renew --force-renewal",
        "sudo systemctl reload nginx",
        "",
        "# Then confirm the automatic renewal timer is actually running:",
        "systemctl list-timers | grep certbot",
      ].join("\n"),
      value: expiredOn ? `expired ${expiredOn}` : `${agoDays} days past expiry`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 5,
    });
  } else if (daysLeft <= 7) {
    findings.push({
      id: "tls-expiring-imminent",
      category: "tls",
      severity: "critical",
      title: `Certificate expires in ${pluralise(daysLeft, "day")}`,
      detail: `The certificate is valid until ${validTo ? formatDate(validTo) : "its notAfter date"}, which is ${pluralise(daysLeft, "day")} away. Under a week of runway means automatic renewal has either failed or was never configured: an ACME client renews at 30 days precisely so this window is never reached. When it lapses the site goes from working to a full-page browser warning with no gradual degradation in between, and it will typically happen outside working hours.`,
      fix: "Renew today, then find out why the automation did not. The usual causes are a broken HTTP-01 challenge path, a DNS record that changed, a renewal hook that fails silently, or a cron/timer that was never enabled.",
      snippet: [
        "sudo certbot renew --dry-run   # surfaces the real failure",
        "sudo certbot renew",
        "sudo systemctl reload nginx",
      ].join("\n"),
      value: validTo ? `expires ${formatDate(validTo)} (${daysLeft} days)` : `${daysLeft} days remaining`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 5,
    });
  } else if (daysLeft <= 15) {
    findings.push({
      id: "tls-expiring-soon",
      category: "tls",
      severity: "warning",
      title: `Certificate expires in ${pluralise(daysLeft, "day")}`,
      detail: `The certificate is valid until ${validTo ? formatDate(validTo) : "its notAfter date"}. Two weeks is well inside the window in which every automated issuer would already have renewed - Let's Encrypt and other ACME clients renew at 30 days remaining - so the fact that the certificate is still this old is itself the signal that renewal is not running.`,
      fix: "Run the renewal manually to confirm it works, then verify the scheduled job that should have done it. A dry run will show the real error without burning rate limits.",
      snippet: ["sudo certbot renew --dry-run", "systemctl list-timers | grep certbot"].join("\n"),
      value: validTo ? `expires ${formatDate(validTo)} (${daysLeft} days)` : `${daysLeft} days remaining`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 3,
    });
  } else if (daysLeft <= 30) {
    findings.push({
      id: "tls-expiring-within-month",
      category: "tls",
      severity: "warning",
      title: `Certificate expires in ${pluralise(daysLeft, "day")}`,
      detail: `The certificate is valid until ${validTo ? formatDate(validTo) : "its notAfter date"}. There is no emergency here, but 30 days is exactly the threshold at which ACME clients renew, so a certificate sitting inside this window suggests renewal has not run yet - or has stopped running. On a commercial certificate with a longer lifetime this is simply the point at which to diarise the replacement.`,
      fix: "Confirm renewal is automated and scheduled. If the certificate is issued manually, start the reissue now rather than in the final week.",
      snippet: "sudo certbot renew --dry-run",
      value: validTo ? `expires ${formatDate(validTo)} (${daysLeft} days)` : `${daysLeft} days remaining`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 2,
    });
  } else {
    findings.push({
      id: "tls-expiry-ok",
      category: "tls",
      severity: "pass",
      title: `Certificate valid for another ${pluralise(daysLeft, "day")}`,
      detail: `The certificate does not expire until ${validTo ? formatDate(validTo) : "well beyond the 30-day renewal threshold"}, comfortably outside the window where renewal problems become visible.`,
      value: validTo ? `expires ${formatDate(validTo)} (${daysLeft} days)` : `${daysLeft} days remaining`,
      weight: 3,
    });
  }

  if (validFrom !== null && validFrom.getTime() > now.getTime()) {
    const startsIn = daysBetween(now, validFrom);
    findings.push({
      id: "tls-not-yet-valid",
      category: "tls",
      severity: "critical",
      title: "The certificate is not valid yet",
      detail: `The certificate's notBefore date is ${formatDate(validFrom)}, which is ${startsIn <= 0 ? "still in the future" : `${pluralise(startsIn, "day")} from now`}. Browsers reject a certificate that has not started as firmly as one that has ended (NET::ERR_CERT_DATE_INVALID). Almost always this is one of two things: the server's clock is wrong, or a certificate was installed ahead of the date it was issued for.`,
      fix: "Check the system clock first - enable NTP and confirm the timezone - then confirm the installed certificate is the one you intended to deploy.",
      snippet: ["timedatectl status", "sudo timedatectl set-ntp true"].join("\n"),
      value: `valid from ${formatDate(validFrom)}`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 4,
    });
  }

  if (validFrom !== null && validTo !== null) {
    const issuerLabel = text(tls.issuer);
    const subjectLabel = text(tls.subjectCn);
    findings.push({
      id: "tls-validity-window",
      category: "tls",
      severity: "info",
      title: "Certificate validity window",
      detail: `Valid from ${formatDate(validFrom)} to ${formatDate(validTo)}${subjectLabel ? `, issued for "${subjectLabel}"` : ""}${issuerLabel ? `, issued by ${issuerLabel}` : ""}. Recorded here so the dates are visible alongside everything else rather than needing a separate lookup.`,
      value: `${formatDate(validFrom)} → ${formatDate(validTo)}${issuerLabel ? ` (${issuerLabel})` : ""}`,
      docs: DOCS_MDN_CERTIFICATE,
      weight: 1,
    });

    const lifetimeDays = daysBetween(validFrom, validTo);
    if (lifetimeDays > MAX_PUBLIC_VALIDITY_DAYS) {
      findings.push({
        id: "tls-validity-too-long",
        category: "tls",
        severity: "warning",
        title: `Certificate lifetime is ${pluralise(lifetimeDays, "day")}`,
        detail: `The certificate was issued for ${lifetimeDays} days, beyond the ${MAX_PUBLIC_VALIDITY_DAYS}-day ceiling browsers have enforced for publicly trusted certificates since September 2020. Safari, Chrome and Firefox reject an over-long certificate outright when it chains to a public root, so if this one is currently working it almost certainly chains to a private authority - which means it is trusted only on machines that were configured to trust it. Long lifetimes are also a liability in their own right: a key compromise stays exploitable for as long as the certificate remains valid, and revocation checking is unreliable in practice.`,
        fix: "Reissue for 398 days or fewer - ideally 90, with automated renewal. The industry is moving toward much shorter lifetimes still, so automation is the only sustainable answer.",
        snippet: "sudo certbot --nginx -d example.com   # 90-day certificate, renewed automatically",
        value: `${lifetimeDays} days (${formatDate(validFrom)} → ${formatDate(validTo)})`,
        docs: DOCS_MDN_CERTIFICATE,
        weight: 2,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Protocol versions                                                    */
  /* ---------------------------------------------------------------------- */

  const protocol = text(tls.protocol);
  // "" rather than null so every comparison below stays a plain string test.
  const protocolUpper = protocol === null ? "" : protocol.toUpperCase().replace(/[\s_]/g, "");

  if (protocol === null) {
    findings.push({
      id: "tls-protocol-unknown",
      category: "tls",
      severity: "info",
      title: "Negotiated protocol version was not reported",
      detail:
        "The handshake completed but the negotiated TLS version could not be read, so this audit makes no claim either way about which version was used.",
      fix: "Check it directly if you need certainty.",
      snippet: "openssl s_client -connect example.com:443 -servername example.com | grep Protocol",
      docs: DOCS_MOZILLA_CONFIG,
      weight: 1,
    });
  } else if (protocolUpper === "TLSV1.3") {
    findings.push({
      id: "tls-protocol-13",
      category: "tls",
      severity: "pass",
      title: "Connection negotiated TLS 1.3",
      detail:
        "TLS 1.3 is the current version. It completes the handshake in a single round trip instead of two, encrypts more of the handshake itself, and its cipher suites are AEAD-only - every construction with a history of practical attacks (RC4, CBC padding, static RSA key exchange, renegotiation) was removed from the specification rather than merely discouraged.",
      value: protocol,
      weight: 3,
    });
  } else if (protocolUpper === "TLSV1.2") {
    findings.push({
      id: "tls-protocol-12",
      category: "tls",
      severity: "info",
      title: "Connection negotiated TLS 1.2",
      detail:
        "TLS 1.2 is secure when configured with a modern cipher list, and nothing here is broken. TLS 1.3 is worth enabling alongside it though: the handshake costs one round trip instead of two, which is a real latency saving on mobile networks, and it removes the legacy cipher and key-exchange options that make a 1.2 configuration something you have to get right by hand.",
      fix: "Enable TLS 1.3 in addition to 1.2. Clients that support it negotiate up automatically; older clients keep working on 1.2.",
      snippet: [
        "# nginx (1.13.0+ with OpenSSL 1.1.1+)",
        "ssl_protocols TLSv1.2 TLSv1.3;",
        "ssl_prefer_server_ciphers off;",
        "",
        "# Apache (2.4.36+ with OpenSSL 1.1.1+)",
        "SSLProtocol -all +TLSv1.2 +TLSv1.3",
      ].join("\n"),
      value: protocol,
      docs: DOCS_MOZILLA_CONFIG,
      weight: 2,
    });
  } else if (/^(TLSV1(\.[01])?|SSLV[23])$/.test(protocolUpper)) {
    findings.push({
      id: "tls-protocol-obsolete",
      category: "tls",
      severity: "critical",
      title: `Connection negotiated ${protocol}`,
      detail: `The handshake settled on ${protocol}, which is the best this server would agree to. Every current browser refuses this version - Chrome, Firefox, Safari and Edge all removed support for TLS 1.0 and 1.1 in 2020, and SSL 3.0 far earlier - so real visitors are seeing ERR_SSL_VERSION_OR_CIPHER_MISMATCH rather than your site. RFC 8996 formally deprecated both TLS 1.0 and 1.1, and PCI DSS has prohibited them since 2018.`,
      fix: "Enable TLS 1.2 and 1.3 on the server. This is normally a one-line change plus a reload; if the software is too old to support them, that software is the actual problem.",
      snippet: [
        "# nginx",
        "ssl_protocols TLSv1.2 TLSv1.3;",
        "",
        "# Apache",
        "SSLProtocol -all +TLSv1.2 +TLSv1.3",
      ].join("\n"),
      value: protocol,
      docs: DOCS_RFC_8996,
      weight: 5,
    });
  }

  const tls10 = tls.legacyProtocols?.tls10 ?? null;
  const tls11 = tls.legacyProtocols?.tls11 ?? null;

  if (tls10 === true) {
    findings.push({
      id: "tls-legacy-tls10-enabled",
      category: "tls",
      severity: "warning",
      title: "The server still accepts TLS 1.0",
      detail:
        "A connection offering only TLS 1.0 was accepted. RFC 8996 deprecated it in 2021, every major browser dropped it in 2020, and PCI DSS has forbidden it for cardholder data since June 2018 - so nothing legitimate is still using it. What it does provide is a downgrade target: TLS 1.0 relies on MD5/SHA-1 in its handshake and inherits the CBC-mode weaknesses behind BEAST and Lucky13. Leaving it enabled buys no compatibility you can actually use and will fail a compliance scan.",
      fix: "Restrict the server to TLS 1.2 and 1.3. Nothing that can currently reach your site will notice.",
      snippet: [
        "# nginx",
        "ssl_protocols TLSv1.2 TLSv1.3;",
        "",
        "# Apache",
        "SSLProtocol -all +TLSv1.2 +TLSv1.3",
        "",
        "# HAProxy",
        "bind :443 ssl crt /etc/ssl/site.pem no-sslv3 no-tlsv10 no-tlsv11",
      ].join("\n"),
      value: "TLS 1.0 accepted",
      docs: DOCS_RFC_8996,
      weight: 3,
    });
  }

  if (tls11 === true) {
    findings.push({
      id: "tls-legacy-tls11-enabled",
      category: "tls",
      severity: "warning",
      title: "The server still accepts TLS 1.1",
      detail:
        "A connection offering only TLS 1.1 was accepted. TLS 1.1 was deprecated by RFC 8996 alongside 1.0, removed from every major browser in 2020, and is prohibited under PCI DSS. It fixed 1.0's explicit-IV problem but kept the same weak handshake hashes and the same limited cipher choices, so it offers no meaningful protection that 1.2 does not, and no client you want is negotiating it.",
      fix: "Restrict the server to TLS 1.2 and 1.3.",
      snippet: [
        "# nginx",
        "ssl_protocols TLSv1.2 TLSv1.3;",
        "",
        "# Apache",
        "SSLProtocol -all +TLSv1.2 +TLSv1.3",
      ].join("\n"),
      value: "TLS 1.1 accepted",
      docs: DOCS_RFC_8996,
      weight: 3,
    });
  }

  if (tls10 === false && tls11 === false) {
    findings.push({
      id: "tls-legacy-refused",
      category: "tls",
      severity: "pass",
      title: "Legacy protocols correctly refused",
      detail:
        "Connections offering only TLS 1.0 or only TLS 1.1 were both rejected. The server insists on TLS 1.2 or better, which is the current baseline for browsers, PCI DSS and RFC 8996 alike, and removes the downgrade path those versions provide.",
      value: "TLS 1.0 refused; TLS 1.1 refused",
      weight: 3,
    });
  } else if (tls10 === null || tls11 === null) {
    const unknownVersions = [tls10 === null ? "TLS 1.0" : null, tls11 === null ? "TLS 1.1" : null]
      .filter((v): v is string => v !== null)
      .join(" and ");
    findings.push({
      id: "tls-legacy-probe-inconclusive",
      category: "tls",
      severity: "info",
      title: "Legacy protocol support could not be determined",
      detail: `The probe for ${unknownVersions} did not return a usable answer - the connection may have been dropped by a firewall, rate-limited, or refused for a reason unrelated to protocol version. This audit therefore makes no claim about whether ${unknownVersions === "TLS 1.0 and TLS 1.1" ? "these versions are" : "that version is"} accepted; it is neither confirmed enabled nor confirmed disabled.`,
      fix: "Test it directly if you need a definitive answer.",
      snippet: [
        "openssl s_client -connect example.com:443 -servername example.com -tls1",
        "openssl s_client -connect example.com:443 -servername example.com -tls1_1",
        "# 'no protocols available' or a handshake failure means the version is refused.",
      ].join("\n"),
      docs: DOCS_RFC_8996,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Cipher suite                                                         */
  /* ---------------------------------------------------------------------- */

  const cipherName = text(tls.cipher?.name ?? null);
  const cipherVersion = text(tls.cipher?.version ?? null);
  const isTls13 = protocolUpper === "TLSV1.3";

  if (cipherName === null) {
    findings.push({
      id: "tls-cipher-unknown",
      category: "tls",
      severity: "info",
      title: "Negotiated cipher suite was not reported",
      detail:
        "The handshake completed but the cipher suite could not be read, so nothing is claimed here about cipher or key-exchange strength.",
      fix: "Check it directly if you need certainty.",
      snippet: "openssl s_client -connect example.com:443 -servername example.com | grep Cipher",
      docs: DOCS_MDN_CIPHER,
      weight: 1,
    });
  } else {
    const tokens = cipherTokens(cipherName);
    const tokenSet = new Set(tokens);
    const flat = tokens.join(" ");

    const brokenParts: string[] = [];
    if (tokenSet.has("RC4")) brokenParts.push("RC4, whose keystream biases have been practically exploitable since 2013 (RFC 7465 prohibits it)");
    if (tokenSet.has("3DES") || /\bDES CBC3\b/.test(flat)) brokenParts.push("Triple DES, whose 64-bit block size makes it vulnerable to the Sweet32 birthday attack on long-lived connections");
    if (tokenSet.has("DES")) brokenParts.push("single DES, whose 56-bit key has been brute-forceable since the 1990s");
    if (tokenSet.has("NULL")) brokenParts.push("a NULL cipher, meaning the traffic is authenticated but not encrypted at all");
    if (tokenSet.has("EXPORT") || tokenSet.has("EXP")) brokenParts.push("an export-grade cipher, deliberately weakened to 1990s regulatory limits and the basis of the FREAK and Logjam attacks");
    if (tokenSet.has("MD5")) brokenParts.push("MD5 for message authentication, which has been collision-broken for two decades");
    if (tokenSet.has("ANON") || tokenSet.has("ADH") || tokenSet.has("AECDH")) brokenParts.push("anonymous key exchange, which performs no authentication and is trivially machine-in-the-middled");

    if (brokenParts.length > 0) {
      findings.push({
        id: "tls-cipher-broken",
        category: "tls",
        severity: "critical",
        title: "The negotiated cipher suite is broken",
        detail: `The connection was secured with \`${cipherName}\`, which uses ${brokenParts.join("; ")}. A cipher suite in this category means the encryption is decorative: the padlock appears, but the guarantee behind it does not hold against an attacker who can record the traffic. Modern browsers refuse these suites entirely, so the fact that one was negotiated also means the server is accepting connections from clients that no longer exist as anything but scanners.`,
        fix: "Replace the cipher list with a current one. Mozilla's SSL Configuration Generator produces a correct list for your exact server and version - do not hand-write one.",
        snippet: [
          "# nginx - Mozilla 'intermediate' profile",
          "ssl_protocols TLSv1.2 TLSv1.3;",
          "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
          "ssl_prefer_server_ciphers off;",
        ].join("\n"),
        value: cipherVersion ? `${cipherName} (${cipherVersion})` : cipherName,
        docs: DOCS_MOZILLA_CONFIG,
        weight: 5,
      });
    }

    const hasForwardSecrecy =
      isTls13 || tokens.some((t) => t.startsWith("ECDHE") || t.startsWith("DHE") || t.startsWith("EECDH") || t.startsWith("EDH"));

    if (!hasForwardSecrecy) {
      findings.push({
        id: "tls-no-forward-secrecy",
        category: "tls",
        severity: "warning",
        title: "The cipher suite does not provide forward secrecy",
        detail: `\`${cipherName}\` uses no ephemeral key exchange - no ECDHE or DHE - so the session key is derived from the certificate's long-term private key rather than from a key pair discarded when the connection ends. The consequence is retroactive: anyone recording your traffic today can decrypt all of it the moment that private key is obtained, whether through a server compromise, a stolen backup, a subpoena or a bug like Heartbleed. With forward secrecy, the same key disclosure reveals nothing about past sessions.`,
        fix: "Prefer ECDHE suites in the server's cipher list, or enable TLS 1.3, where ephemeral key exchange is mandatory and static RSA was removed from the specification.",
        snippet: [
          "# nginx",
          "ssl_protocols TLSv1.2 TLSv1.3;",
          "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
          "ssl_prefer_server_ciphers off;",
        ].join("\n"),
        value: cipherName,
        docs: DOCS_MDN_FORWARD_SECRECY,
        weight: 3,
      });
    }

    const isAead = isTls13 || tokenSet.has("GCM") || tokenSet.has("CCM") || tokenSet.has("CCM8") || tokenSet.has("POLY1305");

    if (isAead && brokenParts.length === 0) {
      findings.push({
        id: "tls-cipher-aead",
        category: "tls",
        severity: "pass",
        title: "Strong AEAD cipher suite negotiated",
        detail: `\`${cipherName}\` is an authenticated-encryption suite${hasForwardSecrecy ? " with ephemeral key exchange" : ""}, so encryption and integrity are computed together in one construction. That closes off the entire family of padding-oracle attacks that come from encrypting and authenticating separately${hasForwardSecrecy ? ", and a future compromise of the server's private key cannot decrypt traffic captured today" : ""}.`,
        value: cipherVersion ? `${cipherName} (${cipherVersion})` : cipherName,
        weight: 3,
      });
    }

    if (tokenSet.has("CBC")) {
      findings.push({
        id: "tls-cipher-cbc-mode",
        category: "tls",
        severity: "info",
        title: "The negotiated cipher uses CBC mode",
        detail: `\`${cipherName}\` encrypts in CBC mode with a separate MAC, the MAC-then-encrypt construction behind a long line of padding-oracle attacks: BEAST, Lucky13, POODLE and the various implementation-specific variants that followed. Current TLS 1.2 implementations mitigate all of these, so this is not an exploitable finding - but it is the older design, and the mitigations are constant-time code that has had to be re-fixed more than once.`,
        fix: "Order AEAD suites (AES-GCM, ChaCha20-Poly1305) ahead of CBC ones, or enable TLS 1.3, which removed CBC entirely.",
        snippet: [
          "# nginx - AEAD only",
          "ssl_protocols TLSv1.2 TLSv1.3;",
          "ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;",
        ].join("\n"),
        value: cipherName,
        docs: DOCS_MDN_CIPHER,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Key strength and signature                                           */
  /* ---------------------------------------------------------------------- */

  const signatureAlgorithm = text(tls.signatureAlgorithm);
  const signatureLower = signatureAlgorithm ? signatureAlgorithm.toLowerCase().replace(/[\s_-]/g, "") : null;
  const keyBits = finiteOrNull(tls.keyBits);
  const looksEllipticCurve =
    (signatureLower !== null && (signatureLower.includes("ecdsa") || signatureLower.includes("ed25519") || signatureLower.includes("ed448"))) ||
    (keyBits !== null && (keyBits === 256 || keyBits === 384 || keyBits === 521));

  if (keyBits === null) {
    findings.push({
      id: "tls-key-size-unknown",
      category: "tls",
      severity: "info",
      title: "Certificate key size was not reported",
      detail:
        "The handshake did not expose the public key size, so no claim is made about key strength here. Some server and proxy configurations withhold it.",
      fix: "Read it from the certificate directly if you need to confirm it.",
      snippet: "echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -text | grep 'Public-Key'",
      docs: DOCS_SERVER_SIDE_TLS,
      weight: 1,
    });
  } else if (looksEllipticCurve) {
    if (keyBits < 256) {
      findings.push({
        id: "tls-key-curve-weak",
        category: "tls",
        severity: "critical",
        title: `Elliptic curve key is only ${keyBits} bits`,
        detail: `The certificate's key is a ${keyBits}-bit elliptic curve key. Curves below P-256 fall short of the 128-bit security level that everything from browsers to NIST treats as the modern floor, and public CAs will not issue them. A key this size is within reach of a well-resourced attacker, and everything the certificate authenticates rests on it.`,
        fix: "Reissue with a P-256 key (secp256r1), which is the default for every ACME client and is both faster and stronger than RSA-2048.",
        snippet: "sudo certbot --nginx -d example.com --key-type ecdsa --elliptic-curve secp256r1",
        value: `${keyBits}-bit EC`,
        docs: DOCS_SERVER_SIDE_TLS,
        weight: 5,
      });
    } else {
      findings.push({
        id: "tls-key-elliptic-curve",
        category: "tls",
        severity: "pass",
        title: `Strong ${keyBits}-bit elliptic curve key`,
        detail: `The certificate uses a ${keyBits}-bit EC key${keyBits === 256 ? " (P-256)" : keyBits === 384 ? " (P-384)" : ""}, which provides roughly the security of a ${keyBits === 256 ? "3072" : "7680"}-bit RSA key from a fraction of the computation. Smaller keys also mean a smaller handshake and less CPU per connection, which shows up as latency on mobile.`,
        value: `${keyBits}-bit EC`,
        weight: 2,
      });
    }
  } else if (keyBits < 2048) {
    findings.push({
      id: "tls-key-weak",
      category: "tls",
      severity: "critical",
      title: `RSA key is only ${keyBits} bits`,
      detail: `The certificate uses a ${keyBits}-bit RSA key. Anything below 2048 bits has been below the accepted minimum since 2013; public CAs stopped issuing them, and NIST, the CA/Browser Forum and every browser vendor treat them as broken. A 1024-bit RSA key is considered factorable by a determined, well-funded attacker - and factoring it yields the private key, which means impersonating this site completely and, without forward secrecy, decrypting every recorded session.`,
      fix: "Generate a new key of at least 2048 bits - or better, a P-256 elliptic curve key - and reissue the certificate. Do not reuse the old key pair.",
      snippet: [
        "# ECDSA P-256, the modern default",
        "sudo certbot --nginx -d example.com --key-type ecdsa --elliptic-curve secp256r1",
        "",
        "# Or RSA 2048 if a legacy client requires it",
        "sudo certbot --nginx -d example.com --key-type rsa --rsa-key-size 2048",
      ].join("\n"),
      value: `${keyBits}-bit RSA`,
      docs: DOCS_SERVER_SIDE_TLS,
      weight: 5,
    });
  } else if (keyBits === 2048) {
    findings.push({
      id: "tls-key-rsa-2048",
      category: "tls",
      severity: "pass",
      title: "RSA key is 2048 bits",
      detail:
        "2048-bit RSA is the current minimum and remains perfectly acceptable - it is what the majority of the web uses and there is no reason to treat it as a problem. Worth knowing for the next reissue: a P-256 elliptic curve key offers more security for far less computation per handshake, and every browser has supported ECDSA certificates for over a decade.",
      value: `${keyBits}-bit RSA`,
      weight: 2,
    });
  } else {
    findings.push({
      id: "tls-key-strong",
      category: "tls",
      severity: "pass",
      title: `Strong ${keyBits}-bit RSA key`,
      detail: `The certificate uses a ${keyBits}-bit RSA key, comfortably above the 2048-bit minimum. The extra margin costs some CPU per handshake but is entirely sound.`,
      value: `${keyBits}-bit RSA`,
      weight: 2,
    });
  }

  if (signatureLower !== null && /sha1|md5|md2|md4/.test(signatureLower)) {
    const which = signatureLower.includes("sha1") ? "SHA-1" : "MD5";
    findings.push({
      id: "tls-signature-weak",
      category: "tls",
      severity: "critical",
      title: `Certificate is signed with ${which}`,
      detail: `The signature algorithm is \`${signatureAlgorithm ?? which}\`. ${which} is collision-broken - SHA-1 demonstrably so since the SHAttered attack in 2017, MD5 since 2008, when researchers used it to forge a working CA certificate. A collision lets an attacker construct a second certificate carrying the same signature, which is the whole trust model defeated. Browsers have rejected publicly trusted SHA-1 certificates since 2017, so if this one is loading it chains to a private root.`,
      fix: "Reissue with a SHA-256 signature. Every current CA does this by default; a SHA-1 certificate in 2026 means either a very old file or a private CA that needs its configuration updated.",
      snippet: [
        "# Confirm the signature algorithm on the deployed certificate",
        "echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null \\",
        "  | openssl x509 -noout -text | grep 'Signature Algorithm'",
      ].join("\n"),
      value: signatureAlgorithm ?? which,
      docs: DOCS_SERVER_SIDE_TLS,
      weight: 5,
    });
  } else if (signatureLower !== null && /sha256|sha384|sha512|ed25519|ed448/.test(signatureLower)) {
    findings.push({
      id: "tls-signature-modern",
      category: "tls",
      severity: "pass",
      title: "Certificate uses a modern signature algorithm",
      detail: `Signed with \`${signatureAlgorithm ?? "a SHA-2 family algorithm"}\`, which has no known collision weakness and meets the CA/Browser Forum baseline requirements.`,
      value: signatureAlgorithm ?? "SHA-2 family",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Name coverage and hygiene                                            */
  /* ---------------------------------------------------------------------- */

  if (sans.length === 0) {
    findings.push({
      id: "tls-san-missing",
      category: "tls",
      severity: "warning",
      title: "The certificate lists no subject alternative names",
      detail: `No SAN entries were found${text(tls.subjectCn) ? `; the only name on the certificate appears to be the common name "${text(tls.subjectCn)}"` : ""}. Browsers have ignored the common name entirely since Chrome 58 in 2017 - RFC 2818 deprecated it long before that - and match hostnames only against the SAN extension. A certificate with no SANs is rejected by name-matching regardless of how valid the chain is.`,
      fix: "Reissue with every hostname listed as a subject alternative name. Any current CA does this automatically; a certificate missing them was almost certainly generated by hand with an old openssl invocation.",
      snippet: [
        "# openssl req with SANs (openssl 1.1.1+)",
        'openssl req -new -key key.pem -out csr.pem \\',
        '  -subj "/CN=example.com" \\',
        '  -addext "subjectAltName=DNS:example.com,DNS:www.example.com"',
      ].join("\n"),
      value: text(tls.subjectCn) ?? "no names read",
      docs: DOCS_MDN_CERTIFICATE,
      weight: 3,
    });
  } else {
    findings.push({
      id: "tls-san-coverage",
      category: "tls",
      severity: "info",
      title: `Certificate covers ${pluralise(sans.length, "hostname")}`,
      detail: `Subject alternative names on this certificate: ${formatList(sans, 12)}. This is the definitive list of hostnames the certificate is valid for - anything served on a name outside it produces a browser warning.`,
      value: formatList(sans, 20),
      docs: DOCS_MDN_CERTIFICATE,
      weight: 1,
    });

    if (sans.length >= 25) {
      findings.push({
        id: "tls-san-count-high",
        category: "tls",
        severity: "info",
        title: `${pluralise(sans.length, "hostname")} share this certificate`,
        detail: `The certificate carries ${sans.length} subject alternative names. That is normal for a shared or multi-domain (UCC) certificate but has two consequences worth knowing: the full list is public - it is sent to every client and logged to Certificate Transparency - so every sibling hostname, including internal-sounding ones, is discoverable; and a single key compromise or emergency revocation affects all of them at once.`,
        fix: "Consider separate certificates per site, or a wildcard where the names share a parent, so that revocation and key rotation have a smaller blast radius. Also check the list for hostnames that were never meant to be public.",
        value: formatList(sans, 30),
        docs: DOCS_MDN_CERTIFICATE,
        weight: 1,
      });
    }

    const wildcards = sans.filter((s) => s.startsWith("*."));
    if (wildcards.length > 0) {
      findings.push({
        id: "tls-san-wildcard",
        category: "tls",
        severity: "info",
        title: `Certificate includes ${pluralise(wildcards.length, "wildcard name")}`,
        detail: `Wildcard entries: ${formatList(wildcards, 6)}. Wildcards are convenient - one certificate for every subdomain, no reissue when you add one - but they concentrate risk: the same private key ends up deployed on every host that uses it, so a compromise anywhere in that set is a compromise of all of them, and revoking it takes every subdomain offline together. A wildcard also matches exactly one label, so \`*.example.com\` covers \`app.example.com\` but not \`example.com\` itself or \`a.b.example.com\`.`,
        fix: "Keep the wildcard key off hosts that do not need it, and prefer per-host certificates for anything handling sensitive traffic. With ACME automation, issuing individual certificates is no longer the chore it once was.",
        value: formatList(wildcards, 10),
        docs: DOCS_MDN_CERTIFICATE,
        weight: 1,
      });
    }

    const pair = host ? apexAndWww(host) : null;
    if (pair !== null) {
      const apexCovered = sans.some((s) => sanCovers(s, pair.apex));
      const wwwCovered = sans.some((s) => sanCovers(s, pair.www));

      if (apexCovered && wwwCovered) {
        findings.push({
          id: "tls-san-apex-and-www",
          category: "tls",
          severity: "pass",
          title: "Both the apex domain and www are covered",
          detail: `The certificate covers ${pair.apex} and ${pair.www}, so visitors reach a valid certificate whichever form they type, and a redirect between the two never lands on a warning page.`,
          value: `${pair.apex}, ${pair.www}`,
          weight: 2,
        });
      } else if (apexCovered !== wwwCovered) {
        const covered = apexCovered ? pair.apex : pair.www;
        const missing = apexCovered ? pair.www : pair.apex;
        findings.push({
          id: "tls-san-apex-www-gap",
          category: "tls",
          severity: "warning",
          title: `Only ${covered} is covered - ${missing} is not`,
          detail: `The certificate covers ${covered} but has no entry matching ${missing}. Visitors who type ${missing}, follow an old link, or hit a bookmark in that form get a full-page certificate warning - and crucially they get it *before* any redirect you have configured can run, because the TLS handshake happens first. A redirect from ${missing} to ${covered} does not help unless ${missing} also presents a valid certificate.`,
          fix: `Reissue the certificate with both names, then keep the redirect. Both hostnames need to be on the certificate even if one only ever redirects.`,
          snippet: `sudo certbot --nginx -d ${pair.apex} -d ${pair.www}`,
          value: `covered: ${covered}; missing: ${missing}`,
          docs: DOCS_MDN_CERTIFICATE,
          weight: 3,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Issuer                                                               */
  /* ---------------------------------------------------------------------- */

  const issuer = text(tls.issuer);
  if (issuer !== null && !tls.isSelfSigned) {
    const rule = CA_RULES.find((candidate) => candidate.pattern.test(issuer));

    if (rule) {
      findings.push({
        id: "tls-issuer-identified",
        category: "tls",
        severity: "info",
        title: `Certificate issued by ${rule.name}`,
        detail: `The issuing authority is "${issuer}". ${rule.note}`,
        value: issuer,
        docs: DOCS_MDN_CERTIFICATE,
        weight: 1,
      });
    } else if (INTERNAL_ISSUER.test(issuer) || tls.authorized === false) {
      findings.push({
        id: "tls-issuer-internal",
        category: "tls",
        severity: "warning",
        title: "Certificate appears to come from a private or internal authority",
        detail: `The issuer is "${issuer}", which does not match any well-known public certificate authority and reads like an internal, development or ad-hoc CA. A private CA is only trusted on machines that have been explicitly configured to trust its root - which is fine for an intranet service and unworkable for a public site, where every visitor's browser will reject it.`,
        fix: "For anything reachable from the public internet, reissue from a publicly trusted CA. Keep the private CA for internal hostnames that never face a visitor's browser.",
        snippet: "sudo certbot --nginx -d example.com -d www.example.com",
        value: issuer,
        docs: DOCS_MDN_CERTIFICATE,
        weight: 3,
      });
    } else {
      findings.push({
        id: "tls-issuer-unrecognised",
        category: "tls",
        severity: "info",
        title: "Certificate issued by an authority this audit does not recognise",
        detail: `The issuer is "${issuer}". The chain validated against the standard trust store, so this is a legitimate publicly trusted authority - it is simply not one of the CAs named in this tool's list. No action is implied; the name is recorded so you can confirm it is the authority you expect.`,
        value: issuer,
        docs: DOCS_MDN_CERTIFICATE,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Interaction with HSTS                                                */
  /* ---------------------------------------------------------------------- */

  const hsts = header(ctx, "strict-transport-security");
  const certificateBroken =
    tls.authorized === false ||
    tls.isSelfSigned ||
    tls.hostnameMatches === false ||
    (daysLeft !== null && daysLeft <= 0);

  if (hsts !== null && certificateBroken) {
    const reasons = [
      tls.authorized === false ? "the chain does not validate" : null,
      tls.isSelfSigned ? "the certificate is self-signed" : null,
      tls.hostnameMatches === false ? "the certificate does not cover this hostname" : null,
      daysLeft !== null && daysLeft <= 0 ? "the certificate has expired" : null,
    ].filter((r): r is string => r !== null);

    findings.push({
      id: "tls-hsts-with-broken-certificate",
      category: "tls",
      severity: "critical",
      title: "HSTS is active and the certificate is invalid - visitors cannot get through at all",
      detail: `Strict-Transport-Security is set ("${hsts.length > 120 ? `${hsts.slice(0, 120)}…` : hsts}") and ${reasons.join(", and ")}. These two facts are much worse together than apart. HSTS instructs the browser to treat every certificate error on this host as fatal and to remove the "Proceed anyway" option entirely - that is the whole point of the header. So where a certificate problem on a normal site produces an interstitial a determined visitor can click past, here it produces a dead end: no content, no override, for every visitor whose browser has seen the header before, for the full max-age. If the domain is on the preload list, it applies to first-time visitors too.`,
      fix: "Fix the certificate first - this is an outage, not a warning. Do not respond by removing the HSTS header: browsers that already cached the policy will keep enforcing it for the remainder of max-age regardless, so the only path back to a working site is a valid certificate.",
      snippet: [
        "# 1. Get a valid certificate on the affected hostname",
        "sudo certbot --nginx -d example.com -d www.example.com",
        "sudo systemctl reload nginx",
        "",
        "# 2. Verify from outside - the chain must validate cleanly",
        "openssl s_client -connect example.com:443 -servername example.com -verify_return_error",
      ].join("\n"),
      value: `${hsts} + ${reasons.join("; ")}`,
      docs: DOCS_MDN_HSTS,
      weight: 5,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. The document itself was fetched over an unverified connection        */
  /* ---------------------------------------------------------------------- */

  // Emitted last so it can name the chain findings that already fired, but it
  // carries the highest weight in the category and sorts to the top of the
  // report - it is the thing to act on before anything else means much.
  if (insecureFallback) {
    const causeTitles = CHAIN_CAUSE_SLUGS.map(
      (slug) => findings.find((f) => f.id === slug)?.title,
    ).filter((title): title is string => typeof title === "string" && title.trim() !== "");

    findings.push(insecureFallbackFinding(ctx, causeTitles));
  }

  return findings;
}
