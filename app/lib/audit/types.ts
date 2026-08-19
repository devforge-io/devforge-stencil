/**
 * Shared contract for the website audit tool.
 *
 * This file is the single source of truth every other audit module compiles
 * against: the fetcher produces a `PageContext`, each check module turns that
 * context into `Finding[]`, and the aggregator folds those into an
 * `AuditReport` that is safe to serialise to the browser.
 *
 * Client-safe: no server-only imports here.
 */

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

/** How badly a finding hurts the site. `pass` records a check that succeeded. */
export type Severity = "critical" | "warning" | "info" | "pass";

export type CategoryId =
  | "meta"
  | "opengraph"
  | "seo"
  | "structured-data"
  | "ai"
  | "performance"
  | "security"
  | "tls"
  | "exposure"
  | "email-dns"
  | "domain"
  | "accessibility"
  | "technical";

export interface Finding {
  /** Stable, unique, kebab-case slug - e.g. "meta-description-missing". */
  id: string;
  category: CategoryId;
  severity: Severity;
  /** Short imperative headline, e.g. "Missing meta description". */
  title: string;
  /** One or two sentences on what was found and why it matters. */
  detail: string;
  /** How to fix it. Omit for `pass` findings. */
  fix?: string;
  /** Copy-pasteable snippet demonstrating the fix. */
  snippet?: string;
  /** The observed value, when quoting it back is useful. */
  value?: string;
  /** Reference URL for further reading. */
  docs?: string;
  /**
   * Relative weight of this finding inside its category when scoring.
   * Defaults to 1 when omitted. Use higher numbers for checks that matter more.
   */
  weight?: number;
}

/* -------------------------------------------------------------------------- */
/* Parsed HTML                                                                 */
/* -------------------------------------------------------------------------- */

export interface Heading {
  /** 1–6 */
  level: number;
  text: string;
}

export interface ImageTag {
  src: string | null;
  /** `null` when the attribute is absent; `""` when present but empty (decorative). */
  alt: string | null;
  width: string | null;
  height: string | null;
  loading: string | null;
  srcset: string | null;
}

export interface AnchorTag {
  href: string | null;
  text: string;
  rel: string | null;
  target: string | null;
  /** True when the resolved href shares a host with the audited page. */
  internal: boolean;
}

export interface LinkTag {
  rel: string;
  href: string | null;
  type: string | null;
  hreflang: string | null;
  sizes: string | null;
  media: string | null;
  title: string | null;
}

export interface ScriptTag {
  src: string | null;
  type: string | null;
  async: boolean;
  defer: boolean;
  module: boolean;
  /** Length of the inline body in characters; 0 for external scripts. */
  inlineLength: number;
}

export interface StylesheetTag {
  href: string | null;
  media: string | null;
}

export interface FormField {
  tag: "input" | "select" | "textarea";
  type: string | null;
  id: string | null;
  name: string | null;
  ariaLabel: string | null;
  ariaLabelledBy: string | null;
  placeholder: string | null;
  /** True when a `<label for=...>` in the document points at this field's id. */
  hasLabel: boolean;
}

/** Everything the checks need from the HTML, extracted once. */
export interface ParsedDocument {
  title: string | null;
  lang: string | null;
  charset: string | null;
  /** `<meta name="x" content="y">` - keys lowercased. Last occurrence wins. */
  metaByName: Record<string, string>;
  /** `<meta property="og:x" content="y">` - keys lowercased. Last occurrence wins. */
  metaByProperty: Record<string, string>;
  /** Count of duplicate declarations, keyed the same way as the maps above. */
  metaDuplicates: Record<string, number>;
  links: LinkTag[];
  headings: Heading[];
  images: ImageTag[];
  anchors: AnchorTag[];
  scripts: ScriptTag[];
  stylesheets: StylesheetTag[];
  formFields: FormField[];
  /** Successfully parsed `application/ld+json` blocks. */
  jsonLd: unknown[];
  /** Count of ld+json blocks that failed to parse. */
  jsonLdErrors: number;
  /** True when the markup uses schema.org microdata (itemscope/itemprop). */
  hasMicrodata: boolean;
  /** True when the markup uses RDFa (vocab/typeof/property). */
  hasRdfa: boolean;
  /** Visible text with script/style/comments stripped and whitespace collapsed. */
  textContent: string;
  wordCount: number;
  /** Total characters of raw HTML. */
  htmlLength: number;
  /** textContent.length / htmlLength, 0–1. Low values suggest a JS-rendered shell. */
  textToHtmlRatio: number;
  hasNoscript: boolean;
  /** Semantic landmarks present: "main", "nav", "header", "footer", "article", "aside", "section". */
  landmarks: string[];
  /** Distinct `role="..."` values found. */
  roles: string[];
  /** True when an `<html>`-level or body-level inline `dir` attribute is present. */
  hasDir: boolean;
  /** iframes found, with their title attribute (null when missing). */
  iframes: { src: string | null; title: string | null }[];
  /** True when a viewport meta tag disables user scaling. */
  viewportBlocksZoom: boolean;
}

/* -------------------------------------------------------------------------- */
/* Fetched resources                                                           */
/* -------------------------------------------------------------------------- */

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

/** A sibling text resource such as robots.txt or llms.txt. */
export interface TextResource {
  url: string;
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
}

export interface RobotsGroup {
  /** Lowercased user-agent tokens this group applies to. */
  userAgents: string[];
  allow: string[];
  disallow: string[];
}

export interface RobotsResource extends TextResource {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** True when a group applying to `*` disallows `/`. */
  blocksAllCrawlers: boolean;
}

export interface SitemapResource {
  url: string;
  ok: boolean;
  status: number;
  /** True when the document is a <sitemapindex> rather than a <urlset>. */
  isIndex: boolean;
  urlCount: number;
  /** Where the sitemap was discovered. */
  source: "robots" | "well-known" | "link-tag";
}

/* -------------------------------------------------------------------------- */
/* Security reconnaissance                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Result of the TLS handshake with the final host.
 *
 * Gathered from a `node:tls` connection rather than from `fetch`, which hides
 * the peer certificate and negotiated protocol entirely.
 */
export interface TlsInfo {
  /** Negotiated protocol, e.g. "TLSv1.3". */
  protocol: string | null;
  cipher: { name: string; version: string } | null;
  /** Whether Node's default CA bundle trusted the chain. */
  authorized: boolean;
  authorizationError: string | null;
  subjectCn: string | null;
  issuer: string | null;
  /** ISO timestamps. */
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
  subjectAltNames: string[];
  /** RSA modulus size or EC curve size, when exposed. */
  keyBits: number | null;
  signatureAlgorithm: string | null;
  isSelfSigned: boolean;
  /** Whether the certificate actually covers the host we requested. */
  hostnameMatches: boolean;
  /** Protocol versions the server still accepts, probed individually. */
  legacyProtocols: { tls10: boolean | null; tls11: boolean | null };
}

/**
 * One conventional path probed with a plain GET.
 *
 * Non-intrusive reconnaissance only: these are ordinary reads of well-known
 * locations, the same thing any security-header scanner does. No payloads, no
 * traversal, no credential guessing.
 */
export interface ExposedPathProbe {
  /** Path relative to the origin, e.g. "/.env". */
  path: string;
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  /**
   * True only when the response looks like the genuine artefact rather than a
   * 404 page or an SPA catch-all - status 2xx plus a content shape that matches
   * what the file should contain.
   */
  exposed: boolean;
  /** Short, secret-redacted excerpt kept as evidence. */
  excerpt: string | null;
  /** Human label, e.g. "Environment file". */
  label: string;
  /** Inherent risk if this path really is exposed. */
  risk: "critical" | "warning" | "info";
}

/** A JavaScript source map reachable by an unauthenticated request. */
export interface SourceMapProbe {
  scriptUrl: string;
  mapUrl: string;
  accessible: boolean;
  /** True when the map embeds full original sources, not just mappings. */
  hasSourcesContent: boolean;
  /** Original source paths named in the map, capped for display. */
  sources: string[];
}

/** DNS records relevant to email spoofing and certificate issuance. */
export interface DnsRecords {
  host: string;
  /** Registrable domain the email records were queried against. */
  domain: string;
  spf: string | null;
  dmarc: string | null;
  /** DKIM selectors attempted. */
  dkimTested: string[];
  /** Selectors that returned a record. */
  dkimFound: string[];
  caa: string[];
  mx: string[];
  ns: string[];
  /**
   * Every TXT record on the apex, each joined into one string.
   *
   * Kept raw so checks can detect duplicate `v=spf1` / `v=DMARC1` records -
   * a permerror that the single `spf`/`dmarc` fields above would hide.
   */
  txt: string[];
  /** Null when it could not be determined at this layer. */
  dnssec: boolean | null;
}

/**
 * Domain registration data, from RDAP.
 *
 * RDAP is the structured JSON successor to port-43 WHOIS: it is served over
 * HTTPS, needs no bespoke per-registry text parsing, and exposes DNSSEC
 * delegation authoritatively — something a stub resolver cannot tell us.
 */
export interface RdapInfo {
  /** The RDAP endpoint that actually answered, after bootstrap redirects. */
  source: string;
  handle: string | null;
  registrar: string | null;
  registrarIanaId: string | null;
  /** EPP status codes, lowercased, e.g. "client transfer prohibited". */
  statuses: string[];
  /** ISO timestamps. */
  registered: string | null;
  expires: string | null;
  lastChanged: string | null;
  daysUntilExpiry: number | null;
  /** Age of the registration in days. A brand-new domain carries little trust. */
  ageDays: number | null;
  /** From `secureDNS.delegationSigned`. Null when the registry omits it. */
  dnssecSigned: boolean | null;
  /** Nameservers as the registry has them, which can drift from live NS records. */
  nameservers: string[];
  /** True when registrant contact details are redacted or behind a privacy proxy. */
  privacyProtected: boolean | null;
  registrantName: string | null;
  registrantCountry: string | null;
  abuseEmail: string | null;
}

/** Which HTTP methods the origin admits to supporting. */
export interface HttpMethodsProbe {
  allowHeader: string | null;
  methods: string[];
  /** TRACE reflected the request - cross-site tracing exposure. */
  traceEnabled: boolean;
}

/** Everything a check gets to look at. Server-only - never sent to the client. */
export interface PageContext {
  /** What the user typed, after normalisation. */
  requestedUrl: string;
  /** Where we ended up after redirects. */
  finalUrl: string;
  finalStatus: number;
  redirects: RedirectHop[];
  /** Response headers of the final document, keys lowercased. */
  headers: Record<string, string>;
  html: string;
  /** Bytes of the HTML document as delivered. */
  bytes: number;
  /** Uncompressed size of the HTML in bytes. */
  decodedBytes: number;
  timings: { ttfbMs: number; totalMs: number };
  doc: ParsedDocument;
  https: boolean;
  /** Origin of the final URL, e.g. "https://example.com". */
  origin: string;
  robots: RobotsResource | null;
  sitemap: SitemapResource | null;
  llmsTxt: TextResource | null;
  /** HEAD/GET probe of a web app manifest, when one is linked. */
  manifest: { url: string; ok: boolean; parsed: Record<string, unknown> | null } | null;
  /** Probe of a URL that should not exist, to see whether 404s are handled. */
  notFoundProbe: { status: number; isSoft404: boolean } | null;
  /** Result of requesting the naked origin over http, to check for an https redirect. */
  httpsRedirect: { checked: boolean; redirectsToHttps: boolean } | null;
  /** True when an icon `<link>` tag is present, or `/favicon.ico` responds 2xx. */
  faviconOk: boolean;

  /* --- security reconnaissance (all best-effort, null when unavailable) --- */

  /** Null for plain-http targets or when the handshake could not be completed. */
  tls: TlsInfo | null;
  /**
   * True when the document could only be retrieved after disabling certificate
   * validation, because the chain was untrusted.
   *
   * The audit still runs - diagnosing a broken certificate is the whole point -
   * but nothing fetched over that connection is authenticated, and the report
   * must say so prominently.
   */
  insecureFallback: boolean;
  /** Every conventional path probed, exposed or not, so checks can report both. */
  exposedPaths: ExposedPathProbe[];
  /** RFC 9116 vulnerability disclosure policy. */
  securityTxt: TextResource | null;
  dns: DnsRecords | null;
  /** Domain registration facts from RDAP. Null for IP-literal or unresolvable hosts. */
  rdap: RdapInfo | null;
  methods: HttpMethodsProbe | null;
  sourceMaps: SourceMapProbe[];
  /** True when a probed directory returned an autoindex listing. */
  directoryListing: { url: string; found: boolean }[];
}

/** Signature every check module implements. */
export type CheckFn = (ctx: PageContext) => Finding[];

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

export interface CategoryResult {
  id: CategoryId;
  label: string;
  /** One-line description of what this category covers. */
  blurb: string;
  /** 0–100. */
  score: number;
  /** Relative importance in the overall score. */
  weight: number;
  findings: Finding[];
  counts: SeverityCounts;
}

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
  pass: number;
}

/** What the social/search preview cards render from. */
export interface PagePreview {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterCard: string | null;
  twitterImage: string | null;
  siteName: string | null;
  favicon: string | null;
  displayUrl: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

/** The serialisable result handed to the browser. */
export interface AuditReport {
  requestedUrl: string;
  finalUrl: string;
  finalStatus: number;
  fetchedAt: string;
  /** 0–100, weighted across categories. */
  score: number;
  grade: Grade;
  categories: CategoryResult[];
  counts: SeverityCounts;
  preview: PagePreview;
  redirects: RedirectHop[];
  timings: { ttfbMs: number; totalMs: number };
  stats: {
    htmlBytes: number;
    wordCount: number;
    imageCount: number;
    linkCount: number;
    scriptCount: number;
    textToHtmlRatio: number;
  };
}

/** Returned instead of a report when the target could not be audited at all. */
export interface AuditFailure {
  ok: false;
  /** Machine-readable reason. */
  code:
    | "invalid-url"
    | "blocked-host"
    | "dns-failure"
    | "timeout"
    | "too-large"
    | "not-html"
    | "http-error"
    | "network-error";
  message: string;
  /** Present for http-error. */
  status?: number;
}

export type AuditResult = { ok: true; report: AuditReport } | AuditFailure;

/* -------------------------------------------------------------------------- */
/* Category metadata                                                           */
/* -------------------------------------------------------------------------- */

export const CATEGORY_META: Record<
  CategoryId,
  { label: string; blurb: string; weight: number }
> = {
  meta: {
    label: "Meta tags",
    blurb: "Title, description, canonical, viewport and the rest of the head.",
    weight: 1.4,
  },
  seo: {
    label: "SEO",
    blurb: "Headings, links, crawlability and on-page search signals.",
    weight: 1.5,
  },
  opengraph: {
    label: "Open Graph & social",
    blurb: "How the page looks when shared to social platforms and chat apps.",
    weight: 1.2,
  },
  "structured-data": {
    label: "Structured data",
    blurb: "Schema.org markup that powers rich results.",
    weight: 1.0,
  },
  ai: {
    label: "AI readiness",
    blurb: "Whether AI crawlers and assistants can read and cite this page.",
    weight: 1.3,
  },
  performance: {
    label: "Performance",
    blurb: "Payload size, compression, caching and render-blocking resources.",
    weight: 1.1,
  },
  security: {
    label: "Security headers",
    blurb: "HTTPS and the response headers that protect your visitors.",
    weight: 1.0,
  },
  tls: {
    label: "TLS & certificate",
    blurb: "Certificate validity, chain trust, protocol versions and cipher strength.",
    weight: 1.1,
  },
  exposure: {
    label: "Exposed files & leakage",
    blurb: "Config files, source maps, listings and secrets reachable without a login.",
    weight: 1.4,
  },
  "email-dns": {
    label: "Email & DNS",
    blurb: "SPF, DKIM, DMARC and CAA - the records that stop domain spoofing.",
    weight: 0.9,
  },
  domain: {
    label: "Domain & registration",
    blurb: "Registration, expiry, transfer locks and DNSSEC, straight from the registry.",
    weight: 0.9,
  },
  accessibility: {
    label: "Accessibility",
    blurb: "Alt text, labels, language and landmark structure.",
    weight: 1.2,
  },
  technical: {
    label: "Technical",
    blurb: "Redirects, favicons, manifests, 404 handling and hygiene.",
    weight: 0.8,
  },
};

export const CATEGORY_ORDER: CategoryId[] = [
  "meta",
  "seo",
  "opengraph",
  "ai",
  "structured-data",
  "accessibility",
  "performance",
  "security",
  "exposure",
  "tls",
  "email-dns",
  "domain",
  "technical",
];
