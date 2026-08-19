/**
 * Exposure checks - artefacts and information that should not be public.
 *
 * Three sources feed this module:
 *
 *   1. Non-intrusive path probes performed by the fetcher (`ctx.exposedPaths`,
 *      `ctx.sourceMaps`, `ctx.directoryListing`, `ctx.methods`,
 *      `ctx.securityTxt`) - ordinary GETs of conventional locations.
 *   2. The markup itself (`ctx.html`, `ctx.doc`) - comments, inline values and
 *      response bodies that leak more than they meant to.
 *
 * Response headers, cookies, CSP, HSTS and version-disclosure headers belong to
 * the security module and are deliberately not touched here.
 *
 * Redaction is a hard rule in this file. An audit report is a shareable
 * artefact - screenshotted, emailed, pasted into tickets - so nothing that
 * could be a live credential is ever written into a finding verbatim. Every
 * string that reaches `value`, `detail` or `snippet` passes through
 * `scrubSecrets()` or `maskToken()` first. The one exception is
 * `ExposedPathProbe.excerpt`, which the fetcher has already redacted and which
 * is passed through untouched by contract.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Scanning limits                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much HTML we are willing to run regexes over.
 *
 * This input is attacker-influenced: a hostile page can be tens of megabytes of
 * pathological text. Every pattern below is bounded and applied to at most this
 * many characters, and every scan stops after `MAX_MATCHES` hits.
 */
const MAX_SCAN_CHARS = 500_000;
const MAX_MATCHES = 60;
const MAX_COMMENTS = 400;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Collapse all whitespace runs to single spaces and trim. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Run a global regex over `text`, returning at most `limit` matches.
 *
 * Always works on a fresh regex so module-level patterns cannot carry
 * `lastIndex` between calls, and refuses to loop on zero-length matches.
 */
function collectMatches(pattern: RegExp, text: string, limit = MAX_MATCHES): RegExpExecArray[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const out: RegExpExecArray[] = [];
  let match = re.exec(text);
  while (match !== null && out.length < limit) {
    out.push(match);
    if (match[0].length === 0) re.lastIndex += 1;
    match = re.exec(text);
  }
  return out;
}

function matchedStrings(pattern: RegExp, text: string, limit = MAX_MATCHES): string[] {
  return collectMatches(pattern, text, limit).map((m) => m[0]);
}

/**
 * Stateless `test`.
 *
 * A `/g` regex carries `lastIndex` between calls, so calling `.test()` on a
 * module-level pattern in a loop silently skips matches. Always test through
 * this.
 */
function hasMatch(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text);
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a token to a recognisable shape: enough leading characters to identify
 * what kind of credential it is, and nothing an attacker can use.
 */
function maskToken(token: string, keep: number): string {
  const visible = token.slice(0, Math.max(0, Math.min(keep, token.length)));
  const hidden = token.length - visible.length;
  const stars = "*".repeat(Math.min(Math.max(hidden, 0), 20));
  return `${visible}${stars} (redacted, ${token.length} chars)`;
}

/** `key = "value"` shapes whose value must never be echoed back. */
const CREDENTIAL_ASSIGNMENT =
  /((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|db[_-]?pass)["']?\s*[:=]\s*)["'`]?([^"'`\s,;)<>]{4,200})/gi;

/** Long unbroken token-shaped runs - base64, hex, opaque ids. */
const HIGH_ENTROPY_RUN = /\b[A-Za-z0-9+/_-]{24,512}={0,2}/g;

/**
 * Scrub anything credential-shaped out of a string bound for a finding.
 *
 * Applied to every excerpt this module produces. Deliberately aggressive: a
 * mangled excerpt is a cosmetic problem, a leaked excerpt is a security one.
 */
function scrubSecrets(text: string): string {
  let out = text;

  for (const rule of SECRET_RULES) {
    out = out.replace(new RegExp(rule.pattern.source, "g"), (match) => maskToken(match, rule.keep));
  }

  out = out.replace(CREDENTIAL_ASSIGNMENT, (_full, prefix: string, value: string) =>
    `${prefix}[redacted ${value.length}-char value]`,
  );

  out = out.replace(HIGH_ENTROPY_RUN, (match) => `[redacted ${match.length}-char token]`);

  return out;
}

/** Scrub, collapse and cap an excerpt in one step. */
function safeExcerpt(text: string, max = 160): string {
  return truncate(scrubSecrets(collapse(text)), max);
}

/* -------------------------------------------------------------------------- */
/* Secret-shaped strings                                                       */
/* -------------------------------------------------------------------------- */

interface SecretRule {
  id: string;
  label: string;
  /** Bounded, non-nested. Applied to the capped HTML only. */
  pattern: RegExp;
  /** Leading characters kept when masking - the identifying prefix. */
  keep: number;
  /**
   * `critical` only for prefixes that are secret by definition. Publishable and
   * browser-restricted keys are graded `warning`: shouting "critical" at a
   * Stripe publishable key trains people to ignore this tool.
   */
  severity: "critical" | "warning";
  weight: number;
  title: string;
  detail: string;
  fix: string;
  docs: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: "exp-secret-aws",
    label: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    keep: 4,
    severity: "critical",
    weight: 6,
    title: "An AWS access key is embedded in the page",
    detail:
      "A string matching the AWS access key id format (AKIA…/ASIA…) is present in the HTML delivered to every visitor. AWS keys are never safe in client-side code: paired with a secret key - which is frequently in the same bundle - they authorise API calls against your account, and internet-wide scrapers harvest this exact pattern continuously.",
    fix: "Treat the key as compromised: deactivate and delete it in IAM now, then audit CloudTrail for use you do not recognise. Move the call server-side, or use Cognito/STS to issue short-lived, scoped credentials to the browser.",
    docs: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
  },
  {
    id: "exp-secret-stripe-live",
    label: "Stripe secret key",
    pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,64}\b/,
    keep: 8,
    severity: "critical",
    weight: 6,
    title: "A Stripe live secret key is embedded in the page",
    detail:
      "A `sk_live_`/`rk_live_` key appears in the markup. This is a server-side key: it can create charges, issue refunds, read your full customer list and, on a restricted key, whatever scopes it was granted. Anyone who views source has it.",
    fix: "Roll the key in the Stripe dashboard immediately (Developers → API keys → Roll), then check recent API logs and payouts. The browser only ever needs the publishable key; every call using a secret key belongs on your server.",
    docs: "https://docs.stripe.com/keys",
  },
  {
    id: "exp-secret-github-token",
    label: "GitHub token",
    pattern: /\bgh[pousr]_[0-9A-Za-z]{20,255}\b/,
    keep: 4,
    severity: "critical",
    weight: 6,
    title: "A GitHub token is embedded in the page",
    detail:
      "A `ghp_`/`gho_`/`ghs_` token is present in the HTML. Depending on its scopes this grants read or write access to repositories, packages and Actions - including private ones - under the identity that issued it.",
    fix: "Revoke the token in GitHub → Settings → Developer settings → Personal access tokens, then review the account's audit log and recent pushes. If it belongs to a GitHub App or Action, rotate the installation credential instead.",
    docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github",
  },
  {
    id: "exp-secret-slack",
    label: "Slack token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,120}/,
    keep: 5,
    severity: "critical",
    weight: 5,
    title: "A Slack API token is embedded in the page",
    detail:
      "A token matching Slack's `xox[baprs]-` format is in the markup. Slack tokens read channel history, post as your app or user, and often reach files and DMs - a workspace-wide data exposure rather than a website one.",
    fix: "Revoke the token from the Slack app's OAuth settings and reinstall the app to mint a new one. Proxy Slack calls through your own backend so the token never reaches the browser.",
    docs: "https://api.slack.com/authentication/best-practices",
  },
  {
    id: "exp-secret-private-key",
    label: "Private key block",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    keep: 64,
    severity: "critical",
    weight: 6,
    title: "A private key block is embedded in the page",
    detail:
      "The markup contains a PEM `-----BEGIN … PRIVATE KEY-----` header. Whatever that key authenticates - TLS, SSH, JWT signing, package signing - is now controlled by anyone who read this page. A signing key in particular lets an attacker mint tokens your own systems will trust.",
    fix: "Revoke and reissue the key pair, and rotate anything it signed or protected (certificates, JWTs, deploy access). Then find the build step that copied it into the web output - private keys should never be inside a bundled or served directory.",
    docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/",
  },
  {
    id: "exp-secret-publishable-key",
    label: "Publishable or browser API key",
    pattern: /\b(?:pk_live_[0-9A-Za-z]{16,64}|AIza[0-9A-Za-z_-]{35})\b/,
    keep: 8,
    severity: "warning",
    weight: 2,
    title: "A public API key is embedded in the page",
    detail:
      "A key matching the Stripe publishable (`pk_live_`) or Google (`AIza…`) format is in the markup. These are designed to be public - Stripe publishable keys can only tokenise payment details, and Google browser keys are meant to ship in client code - so this is not automatically a leak. It becomes one when the key is unrestricted: an unrestricted Google key can be lifted onto someone else's site and billed to you.",
    fix: "Confirm this is genuinely the public half. For Google, restrict the key by HTTP referrer and by API in the Cloud console. For Stripe, verify it is `pk_` and not `sk_`. If the key turns out to be a secret, rotate it rather than restricting it.",
    docs: "https://cloud.google.com/docs/authentication/api-keys#securing",
  },
  {
    id: "exp-secret-jwt",
    label: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,600}\.[A-Za-z0-9_-]{8,600}\.[A-Za-z0-9_-]{0,600}/,
    keep: 6,
    severity: "warning",
    weight: 2,
    title: "A JWT is embedded in the page",
    detail:
      "A JWT-shaped string (`eyJ…`) appears in the markup. Some of these are meant to be public - Supabase anon keys and similar client tokens are published deliberately and are safe when row-level security is enforced behind them. Others are live session or service tokens that grant the bearer whatever the claim set allows until it expires.",
    fix: "Decode the payload and check the `role`/`sub` claims and `exp`. If it is an anon/publishable client token, confirm the server-side authorisation behind it actually constrains what it can do. If it is a session or service token, revoke it and stop rendering it into HTML - put it in an HttpOnly cookie instead.",
    docs: "https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html",
  },
];

/* -------------------------------------------------------------------------- */
/* Markup leakage patterns                                                     */
/* -------------------------------------------------------------------------- */

const HTML_COMMENT = /<!--([\s\S]{0,5000}?)-->/g;

/**
 * Conditional comments and framework hydration markers are not leakage.
 *
 * Note the absence of an empty alternative - `\s*` here would match every
 * comment and silently disable the whole section.
 */
const NOISE_COMMENT = /^(?:\[if\b|<!\[endif|\/?\$[?!]?$|\[$|\]$|googleo(?:n|ff)|\/\*)/i;

const TODO_MARKER = /\b(?:todo|fixme|hack|xxx|kludge|workaround|temporary fix)\b/i;
const SECRET_MARKER = /\b(?:password|passwd|api[_-]?key|secret|token|credential|private key|auth[_-]?key|access[_-]?key)\b/i;
const LOCALHOST_REF = /\blocalhost(?::\d{2,5})?\b/i;

const PRIVATE_IP =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/g;
const INTERNAL_HOST = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:local|internal|intranet|lan|corp|localdomain)\b/gi;
/**
 * Non-production hosts. Every alternative demands a second dot so that ordinary
 * links to `dev.to` and friends are not reported as staging infrastructure.
 */
const NON_PROD_URL =
  /\bhttps?:\/\/(?:localhost|0\.0\.0\.0|(?:staging|uat|qa|dev|test|preprod|sandbox)\.[a-z0-9-]{1,40}\.[a-z0-9.-]{1,40}|[a-z0-9-]{1,40}\.(?:staging|dev|test|uat|qa)\.[a-z0-9.-]{1,40}|(?:staging|uat|qa|preprod)-[a-z0-9-]{1,40}\.[a-z0-9.-]{1,40})(?::\d{1,5})?/gi;

const FILESYSTEM_PATHS: RegExp[] = [
  // A user home path is only interesting when it looks like a real server path.
  /(?:\/home|\/Users)\/[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._/-]{0,80}?(?:public_html|htdocs|node_modules|vendor|www|\.(?:php|py|rb|js|ts|log|env|sock|yml|conf))/g,
  /\/var\/www\/[A-Za-z0-9._/-]{1,80}/g,
  /\/usr\/(?:local|share|lib)\/[A-Za-z0-9._/-]{1,80}/g,
  /\/(?:srv|opt)\/[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._/-]{1,60}/g,
  /\b[A-Za-z]:\\(?:[A-Za-z0-9._ -]{1,40}\\){1,6}[A-Za-z0-9._ -]{0,40}/g,
];

interface FingerprintRule {
  marker: RegExp;
  label: string;
}

const FRAMEWORK_FINGERPRINTS: FingerprintRule[] = [
  { marker: /\/wp-(?:content|includes)\//, label: "WordPress (/wp-content/, /wp-includes/)" },
  { marker: /\/sites\/(?:default|all)\/(?:files|modules|themes)\//, label: "Drupal (/sites/default/files/)" },
  { marker: /\/_next\/static\//, label: "Next.js (/_next/static/)" },
  { marker: /\/_nuxt\/|\/\.nuxt\//, label: "Nuxt (/_nuxt/)" },
  { marker: /\/media\/(?:jui|system)\/js\//, label: "Joomla (/media/jui/)" },
  { marker: /\/typo3(?:temp|conf)\//, label: "TYPO3 (/typo3temp/)" },
  { marker: /\/skin\/frontend\/|\/static\/version\d+\//, label: "Magento (/skin/frontend/, /static/versionNNN/)" },
  { marker: /\/cdn\/shop\/|\/s\/files\/1\//, label: "Shopify (/cdn/shop/)" },
  { marker: /\/ScriptResource\.axd|\/WebResource\.axd/, label: "ASP.NET WebForms (ScriptResource.axd)" },
  { marker: /\/bitrix\/(?:js|templates)\//, label: "Bitrix (/bitrix/)" },
];

interface DebugRule {
  pattern: RegExp;
  label: string;
}

/**
 * Deliberately precise. A bare "Warning:" appears in ordinary copy; a warning
 * with a file and a line number does not.
 */
const DEBUG_OUTPUT: DebugRule[] = [
  { pattern: /(?:Warning|Notice|Fatal error|Parse error|Deprecated):[^\n<]{0,200}? on line \d+/g, label: "PHP error output" },
  { pattern: /\.php on line \d+/g, label: "PHP file and line number" },
  { pattern: /Traceback \(most recent call last\)/g, label: "Python traceback" },
  { pattern: /\bat System\.[A-Za-z0-9_.]{2,80}\(/g, label: ".NET stack frame" },
  { pattern: /\b(?:at )?(?:java|javax|org\.springframework|org\.apache)\.[A-Za-z0-9_.]{2,80}(?:Exception|Error)\b/g, label: "Java stack trace" },
  { pattern: /\bSQLSTATE\[[A-Z0-9]{2,8}\]/g, label: "SQL driver error" },
  { pattern: /\bORA-\d{5}\b/g, label: "Oracle error code" },
  { pattern: /\bUncaught (?:Error|Exception|TypeError|ReferenceError):/g, label: "Uncaught exception" },
  { pattern: /Whoops, looks like something went wrong/g, label: "Laravel debug page" },
  { pattern: /Application Trace|Framework Trace/g, label: "Rails debug page" },
  { pattern: /You have an error in your SQL syntax/g, label: "MySQL syntax error" },
];

/* -------------------------------------------------------------------------- */
/* Exposed path knowledge                                                      */
/* -------------------------------------------------------------------------- */

interface PathRule {
  test: RegExp;
  advice: string;
  docs?: string;
}

/** Specific remediation advice per artefact family, first match wins. */
const PATH_RULES: PathRule[] = [
  {
    test: /\.(?:aws\/credentials|npmrc|pypirc|netrc)$/i,
    advice:
      "This file exists to hold credentials, so assume they are gone: revoke and reissue every token in it, then remove the file from anything the web server can reach.",
  },
  {
    test: /id_rsa|id_ed25519|\.ssh\//i,
    advice:
      "An SSH private key or known_hosts file is readable. Revoke the key from every authorized_keys it appears in and generate a new pair - a passphrase slows an attacker down, it does not stop them.",
  },
  {
    test: /\.htpasswd$/i,
    advice:
      "This file contains password hashes. They are crackable offline at leisure, so reset every account in it and block the path before doing anything else.",
  },
  {
    test: /wp-config\.php|configuration\.php|settings\.php|appsettings\.json|application\.(?:properties|yml)|config\.(?:json|yml|yaml|php|ini)$/i,
    advice:
      "Application config typically carries database credentials and signing keys. Rotate anything the file contains, then serve the app from a directory that does not expose it - configuration belongs outside the web root or in environment variables.",
  },
  {
    test: /\.(?:sql|dump|bak|old|orig|save|swp|tar|tar\.gz|tgz|zip|rar|7z)$|backup/i,
    advice:
      "A backup or database dump is downloadable. These usually contain the entire application and its data, including user records. Delete it from the web root and move backups to storage that is not served over HTTP.",
  },
  {
    test: /phpinfo|\/info\.php$/i,
    advice:
      "phpinfo() prints the full PHP configuration: absolute paths, loaded extensions, environment variables and often database credentials. Delete the file - there is no production reason to keep it.",
  },
  {
    test: /\.DS_Store$/i,
    advice:
      "A .DS_Store file lists the names of every file in its directory, including ones not linked anywhere. Delete it and add it to .gitignore and your deploy excludes.",
  },
  {
    test: /docker-compose|dockerfile|\.dockerignore/i,
    advice:
      "Container definitions expose internal service names, ports, image versions and frequently environment values. Remove them from the deployed artefact - they belong in the build context, not the web root.",
  },
  {
    test: /package(?:-lock)?\.json|composer\.(?:json|lock)|yarn\.lock|Gemfile(?:\.lock)?|requirements\.txt/i,
    advice:
      "A dependency manifest gives an attacker your exact package versions, which turns finding an exploitable dependency into a lookup. Low severity on its own; stop serving it if the file is not needed at runtime.",
  },
  {
    test: /server-status|server-info|\/actuator|\/debug\/vars|\/telescope|_profiler|\/metrics$/i,
    advice:
      "A diagnostics endpoint is reachable without authentication. These expose internal routes, environment variables, request contents and sometimes heap dumps. Bind it to localhost or put it behind authentication.",
  },
  {
    test: /adminer|phpmyadmin|\/pma\//i,
    advice:
      "A database administration console is publicly reachable. Restrict it by IP or remove it - these are brute-forced constantly and their vulnerabilities are widely exploited.",
  },
  {
    test: /\.log$|\/logs?\//i,
    advice:
      "A log file is readable. Application logs routinely contain stack traces, session identifiers, internal URLs and occasionally credentials in request dumps. Move logs outside the web root.",
  },
  {
    test: /swagger|openapi|\/graphql$/i,
    advice:
      "An API schema or introspection endpoint is public. That is a legitimate choice for a public API and a mistake for an internal one - confirm which this is, and disable introspection in production if it is the latter.",
  },
  {
    test: /\.(?:vscode|idea)\//i,
    advice:
      "Editor project files are readable. They leak absolute paths, tooling versions and sometimes deployment configuration. Exclude dotfiles from your deploy.",
  },
  {
    test: /\.svn\/|\.hg\/|\.bzr\//i,
    advice:
      "Version-control metadata is readable, which usually means the working copy can be reconstructed. Deploy build output rather than a checkout, and block dot-directories at the server.",
  },
];

function pathAdvice(path: string, label: string): { advice: string; docs?: string } {
  for (const rule of PATH_RULES) {
    if (rule.test.test(path)) return { advice: rule.advice, docs: rule.docs };
  }
  return {
    advice: `${label} should not be reachable without authentication. Remove it from the deployed output, or block the path at the web server and confirm it now returns 404.`,
  };
}

/** "/.git/config" -> "git-config". Used to build a stable, unique finding id. */
function slugifyPath(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "root" : truncate(slug, 48).replace(/…$/, "");
}

/** Server rules that block dotfiles, quoted in more than one finding. */
const DOTFILE_SNIPPET = [
  "# nginx - refuse every dotfile except /.well-known/",
  "location ~ /\\.(?!well-known).* {",
  "  deny all;",
  "  return 404;",
  "}",
  "",
  "# Apache 2.4",
  '<FilesMatch "^\\.">',
  "  Require all denied",
  "</FilesMatch>",
  "",
  "# Caddy",
  "@dotfiles path /.* not /.well-known/*",
  "respond @dotfiles 404",
].join("\n");

/* -------------------------------------------------------------------------- */
/* security.txt parsing                                                        */
/* -------------------------------------------------------------------------- */

/** Field name (lowercased) -> every value declared for it, in order. */
function parseSecurityTxt(body: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const lines = body.split(/\r?\n/, 400);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-----")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^[a-z-]{2,40}$/.test(name) || value === "") continue;
    const existing = fields.get(name);
    if (existing) existing.push(value);
    else fields.set(name, [value]);
  }

  return fields;
}

const SECURITY_TXT_TEMPLATE = [
  "# /.well-known/security.txt - RFC 9116",
  "Contact: mailto:security@example.com",
  "Contact: https://example.com/security/report",
  "Expires: 2027-01-01T00:00:00.000Z",
  "Preferred-Languages: en",
  "Policy: https://example.com/security/policy",
  "Acknowledgments: https://example.com/security/thanks",
  "Canonical: https://example.com/.well-known/security.txt",
].join("\n");

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function exposureChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];

  const truncatedScan = ctx.html.length > MAX_SCAN_CHARS;
  const html = truncatedScan ? ctx.html.slice(0, MAX_SCAN_CHARS) : ctx.html;
  const doc = ctx.doc;

  /* ---------------------------------------------------------------------- */
  /* 1. Exposed files                                                        */
  /* ---------------------------------------------------------------------- */

  const probes = ctx.exposedPaths;
  const exposed = probes.filter((p) => p.exposed);

  if (probes.length === 0) {
    findings.push({
      id: "exp-paths-not-probed",
      category: "exposure",
      severity: "info",
      title: "No common paths could be probed",
      detail:
        "This audit could not complete its sweep of conventional locations such as /.env, /.git/config and /config.json - the requests failed, timed out or were refused before any conclusion could be drawn. The absence of findings below is therefore not evidence that those files are unreachable.",
      fix: "Re-run the audit. If the origin rate-limits or blocks automated requests, check these paths yourself with `curl -I https://your-site/.env` and friends.",
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/",
      weight: 1,
    });
  }

  const usedPathIds = new Set<string>();
  const gitProbes = exposed.filter((p) => /^\/\.git(?:\/|$)/i.test(p.path));
  const envProbes = exposed.filter((p) => /^\/\.env(?:\.|$)/i.test(p.path));

  for (const probe of envProbes.slice(0, 1)) {
    findings.push({
      id: "exp-env-exposed",
      category: "exposure",
      severity: probe.risk,
      title: `Environment file is publicly readable at ${probe.path}`,
      detail: `${probe.url} answered ${probe.status} with ${probe.bytes} bytes of environment configuration. This is the most serious thing this audit can find. .env files hold database passwords, third-party API keys, mail credentials, payment tokens and session signing secrets, and this one is being served to anyone who asks - automated scanners request /.env on every domain they see, usually within hours of it appearing in certificate transparency logs.`,
      fix: "Rotate first, remove second. Every credential in that file must be treated as compromised and reissued - database passwords, API keys, tokens, signing secrets, all of them - because deleting the file does not un-leak what has already been copied, and you have no way to know who fetched it. Once rotation is under way, move the file outside the web root and block dotfiles at the server. Then check your access logs for previous requests to this path.",
      snippet: DOTFILE_SNIPPET,
      value: probe.excerpt ?? undefined,
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/",
      weight: 8,
    });
    usedPathIds.add("exp-env-exposed");
  }

  if (gitProbes.length > 0) {
    const first = gitProbes[0];
    const worst = gitProbes.some((p) => p.risk === "critical") ? "critical" : first.risk;
    findings.push({
      id: "exp-git-exposed",
      category: "exposure",
      severity: worst,
      title: "The .git directory is publicly readable",
      detail: `${gitProbes.map((p) => p.path).join(", ")} responded with repository metadata (${first.url} returned ${first.status}). Once these files are readable the whole repository is very likely retrievable: off-the-shelf tools walk the object store from HEAD and reconstruct the full source tree and its history. That includes everything ever committed and later deleted - credentials that were removed in a follow-up commit, private keys, internal documentation, customer data in fixtures - because deleting a file from the current tree does not remove it from history.`,
      fix: "Block /.git at the web server and confirm it now returns 404. Then treat every secret that has ever been committed to this repository as public and rotate it, including ones you removed later - `git log -p` and tools like gitleaks will find them. Longer term, deploy build artefacts rather than a working checkout so there is no repository on the server to expose.",
      snippet: DOTFILE_SNIPPET,
      value: first.excerpt ?? undefined,
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/",
      weight: 7,
    });
    usedPathIds.add("exp-git-exposed");
  }

  const handled = new Set<string>([...envProbes.slice(0, 1), ...gitProbes].map((p) => p.path));
  const weightByRisk: Record<"critical" | "warning" | "info", number> = { critical: 5, warning: 2, info: 1 };

  for (const probe of exposed) {
    if (handled.has(probe.path)) continue;

    let id = `exp-file-${slugifyPath(probe.path)}`;
    let suffix = 2;
    while (usedPathIds.has(id)) {
      id = `exp-file-${slugifyPath(probe.path)}-${suffix}`;
      suffix += 1;
    }
    usedPathIds.add(id);

    const { advice, docs } = pathAdvice(probe.path, probe.label);
    const size = probe.bytes > 0 ? `${probe.bytes} bytes` : "an empty body";
    const type = probe.contentType === null ? "no content type" : `content type ${probe.contentType}`;

    findings.push({
      id,
      category: "exposure",
      severity: probe.risk,
      title: `${probe.label} is publicly reachable at ${probe.path}`,
      detail: `${probe.url} answered ${probe.status} with ${size} and ${type}, and the response body matches what that artefact should contain rather than a 404 page. Anything reachable this way is reachable by every scanner on the internet; these paths are requested constantly without anyone needing to know your site exists.`,
      fix: advice,
      value: probe.excerpt ?? undefined,
      docs:
        docs ??
        "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/",
      weight: weightByRisk[probe.risk],
    });
  }

  if (probes.length > 0 && exposed.length === 0) {
    const sample = probes.slice(0, 8).map((p) => p.path).join(", ");
    findings.push({
      id: "exp-paths-clean",
      category: "exposure",
      severity: "pass",
      title: `${pluralise(probes.length, "common exposure path")} probed, none reachable`,
      detail: `Every one of the ${probes.length} conventional locations checked - ${sample}${probes.length > 8 ? ", and others" : ""} - either returned an error status or served something that was clearly not the artefact. Nothing here was skipped: the absence of findings above means these paths were requested and came back clean.`,
      value: probes.map((p) => p.path).slice(0, 20).join(" | "),
      weight: 4,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Source maps                                                          */
  /* ---------------------------------------------------------------------- */

  const maps = ctx.sourceMaps;
  const accessibleMaps = maps.filter((m) => m.accessible);
  const mapsWithSources = accessibleMaps.filter((m) => m.hasSourcesContent);
  const mapsWithoutSources = accessibleMaps.filter((m) => !m.hasSourcesContent);

  const SOURCEMAP_FIX =
    "Decide deliberately rather than by default. Shipping maps is a perfectly reasonable choice for an open-source project or a team that wants readable production stack traces - if that is the decision, keep them and make sure nothing sensitive is in the source in the first place. If it is not, either stop emitting maps in production builds (`build.sourcemap: false` in Vite, `productionBrowserSourceMaps: false` in Next.js), or keep generating them and upload them to your error tracker while blocking `.map` requests at the edge.";

  if (mapsWithSources.length > 0) {
    const sources = unique(mapsWithSources.flatMap((m) => m.sources)).slice(0, 6);
    findings.push({
      id: "exp-sourcemap-sources-content",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(mapsWithSources.length, "source map")} publishes your original source code`,
      detail: `${mapsWithSources.slice(0, 3).map((m) => m.mapUrl).join(", ")} ${mapsWithSources.length === 1 ? "is" : "are"} downloadable and embed \`sourcesContent\`, so the maps carry the complete pre-build source, not just line mappings. That means original file and directory names, comments, internal function names, dead code behind feature flags, and commented-out blocks that sometimes still contain endpoints or keys - all reconstructable in a browser devtools pane by anyone who opens it.`,
      fix: SOURCEMAP_FIX,
      snippet: [
        "// vite.config.ts",
        "export default defineConfig({ build: { sourcemap: false } });",
        "",
        "# nginx - generate maps for your error tracker, refuse to serve them",
        "location ~ \\.map$ { deny all; return 404; }",
      ].join("\n"),
      value: safeExcerpt(sources.join(" | "), 300),
      docs: "https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm",
      weight: 3,
    });
  }

  if (mapsWithoutSources.length > 0) {
    const sources = unique(mapsWithoutSources.flatMap((m) => m.sources)).slice(0, 6);
    findings.push({
      id: "exp-sourcemap-accessible",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(mapsWithoutSources.length, "source map")} reachable without authentication`,
      detail: `${mapsWithoutSources.slice(0, 3).map((m) => m.mapUrl).join(", ")} ${mapsWithoutSources.length === 1 ? "is" : "are"} publicly downloadable. These maps do not embed \`sourcesContent\`, so the original code is not included - but the \`sources\` array still names your original file and directory layout, which describes the shape of the application and points at files worth requesting directly.`,
      fix: SOURCEMAP_FIX,
      value: safeExcerpt(sources.join(" | "), 300),
      docs: "https://web.dev/articles/source-maps",
      weight: 2,
    });
  }

  if (maps.length > 0 && accessibleMaps.length === 0) {
    findings.push({
      id: "exp-sourcemap-clean",
      category: "exposure",
      severity: "pass",
      title: `${pluralise(maps.length, "referenced source map")} checked, none reachable`,
      detail: `Same-origin scripts referenced ${pluralise(maps.length, "source map")}, and every one of them was requested and refused or missing. Your original source is not downloadable through the maps.`,
      value: maps.slice(0, 5).map((m) => m.mapUrl).join(" | "),
      weight: 2,
    });
  }

  if (maps.length === 0) {
    findings.push({
      id: "exp-sourcemap-none",
      category: "exposure",
      severity: "pass",
      title: "No source maps referenced by same-origin scripts",
      detail: "None of the first-party scripts on this page carry a sourceMappingURL comment or a SourceMap header, so there is no map for an attacker to fetch.",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Directory listing                                                    */
  /* ---------------------------------------------------------------------- */

  const listings = ctx.directoryListing;
  const openListings = listings.filter((l) => l.found);

  if (openListings.length > 0) {
    findings.push({
      id: "exp-directory-listing",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(openListings.length, "directory")} returns an automatic file listing`,
      detail: `${openListings.map((l) => l.url).slice(0, 5).join(", ")} responded with a server-generated index rather than a page or a 404. Directory listings remove the need to guess: an attacker reads off every filename in the directory, including backups, editor swap files, old copies and uploads that were never linked from anywhere.`,
      fix: "Turn autoindex off and serve a 404 for directories without an index file.",
      snippet: [
        "# nginx",
        "autoindex off;",
        "",
        "# Apache",
        "Options -Indexes",
        "",
        "# Caddy - simply omit the `browse` directive from file_server",
      ].join("\n"),
      value: openListings.map((l) => l.url).join(" | "),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/04-Review_Old_Backup_and_Unreferenced_Files_for_Sensitive_Information",
      weight: 2,
    });
  } else if (listings.length > 0) {
    findings.push({
      id: "exp-directory-listing-clean",
      category: "exposure",
      severity: "pass",
      title: `${pluralise(listings.length, "directory")} probed, no automatic listings`,
      detail: `Common asset directories such as ${listings.slice(0, 4).map((l) => l.url).join(", ")} were requested and none returned a server-generated file index.`,
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. HTTP methods                                                         */
  /* ---------------------------------------------------------------------- */

  const methodsProbe = ctx.methods;

  if (methodsProbe === null) {
    findings.push({
      id: "exp-methods-unknown",
      category: "exposure",
      severity: "info",
      title: "Which HTTP methods the origin accepts could not be determined",
      detail:
        "The OPTIONS and TRACE probes did not complete, so this audit cannot say which methods the server advertises. That is often a WAF refusing unusual verbs - which is itself a reasonable posture - but it means the checks below were not performed.",
      fix: "Check manually with `curl -i -X OPTIONS https://your-site/` and `curl -i -X TRACE https://your-site/`, and confirm TRACE is disabled.",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods",
      weight: 1,
    });
  } else {
    const advertised = unique(methodsProbe.methods.map((m) => m.trim().toUpperCase()).filter((m) => m !== ""));
    const dangerous = advertised.filter((m) => ["PUT", "DELETE", "PATCH", "CONNECT", "TRACK"].includes(m));
    const webdav = advertised.filter((m) =>
      ["PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK", "SEARCH"].includes(m),
    );

    if (methodsProbe.traceEnabled) {
      findings.push({
        id: "exp-trace-enabled",
        category: "exposure",
        severity: "warning",
        title: "TRACE is enabled",
        detail:
          "A TRACE request was echoed back by the server. TRACE reflects the entire request - headers included - which is the basis of cross-site tracing: combined with a script injection it can read headers the browser otherwise keeps away from JavaScript, historically including cookies and Authorization. Modern browsers block TRACE from XHR/fetch, so this is no longer trivially exploitable, but the method has no legitimate production use and every hardening baseline asks for it to be off.",
        fix: "Disable TRACE at the web server.",
        snippet: [
          "# Apache",
          "TraceEnable off",
          "",
          "# nginx does not implement TRACE, but if a backend does:",
          "if ($request_method ~* ^(TRACE|TRACK)$) { return 405; }",
        ].join("\n"),
        value: methodsProbe.allowHeader ?? "TRACE reflected the request",
        docs: "https://owasp.org/www-community/attacks/Cross_Site_Tracing",
        weight: 3,
      });
    }

    if (dangerous.length > 0) {
      findings.push({
        id: "exp-dangerous-methods",
        category: "exposure",
        severity: "warning",
        title: `The origin advertises ${dangerous.join(", ")}`,
        detail: `The Allow header came back as "${methodsProbe.allowHeader ?? advertised.join(", ")}". Advertising a state-changing method is not the same as accepting it unauthenticated - most frameworks answer OPTIONS from a static list and still reject the request - but it tells an attacker exactly which verbs are worth trying, and misconfigured upload or WebDAV modules answering PUT are a well-worn route to dropping a web shell.`,
        fix: "Confirm each of these verbs is actually rejected without credentials (`curl -i -X PUT https://your-site/test.txt`). Restrict the method list at the edge to what the application genuinely needs - usually GET, HEAD, POST and OPTIONS.",
        snippet: [
          "# nginx - allow only the verbs you use",
          "if ($request_method !~ ^(GET|HEAD|POST|OPTIONS)$) { return 405; }",
          "",
          "# Apache",
          "<LimitExcept GET HEAD POST OPTIONS>",
          "  Require all denied",
          "</LimitExcept>",
        ].join("\n"),
        value: methodsProbe.allowHeader ?? advertised.join(", "),
        docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/06-Test_HTTP_Methods",
        weight: 2,
      });
    }

    if (webdav.length > 0) {
      findings.push({
        id: "exp-webdav-methods",
        category: "exposure",
        severity: "warning",
        title: `WebDAV methods are advertised (${webdav.join(", ")})`,
        detail: `The Allow header includes WebDAV verbs: "${methodsProbe.allowHeader ?? webdav.join(", ")}". WebDAV turns the web root into a writable filesystem. PROPFIND alone enumerates files and their properties regardless of what is linked, and where MKCOL/COPY/MOVE are honoured an attacker can place files on the server. Very few public websites need any of this.`,
        fix: "Disable the WebDAV modules unless you are knowingly running a DAV service (`a2dismod dav dav_fs` on Apache). If you are, put it behind authentication on a separate host or path, not on the main web root.",
        snippet: [
          "# Apache - turn WebDAV off for the document root",
          "<Location />",
          "  Dav Off",
          "</Location>",
        ].join("\n"),
        value: methodsProbe.allowHeader ?? webdav.join(", "),
        docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/02-Configuration_and_Deployment_Management_Testing/06-Test_HTTP_Methods",
        weight: 2,
      });
    }

    if (advertised.length === 0 && !methodsProbe.traceEnabled) {
      findings.push({
        id: "exp-methods-no-allow",
        category: "exposure",
        severity: "info",
        title: "The origin advertises no HTTP methods",
        detail:
          "An OPTIONS request returned no Allow header, so the server volunteers nothing about which verbs it supports and TRACE was not reflected. That is a mildly positive posture - but it is silence rather than proof, so it does not confirm the state-changing methods are rejected.",
        fix: "If you want certainty, try the verbs directly: `curl -i -X PUT https://your-site/test.txt` should come back 403 or 405.",
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods/OPTIONS",
        weight: 1,
      });
    } else if (dangerous.length === 0 && webdav.length === 0 && !methodsProbe.traceEnabled && advertised.length > 0) {
      findings.push({
        id: "exp-methods-safe",
        category: "exposure",
        severity: "pass",
        title: "Only safe HTTP methods are advertised",
        detail: `The origin advertises ${advertised.join(", ")} and nothing else. No state-changing verbs, no WebDAV, and TRACE is not reflected.`,
        value: methodsProbe.allowHeader ?? advertised.join(", "),
        weight: 2,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 5. security.txt (RFC 9116)                                              */
  /* ---------------------------------------------------------------------- */

  const securityTxt = ctx.securityTxt;

  if (securityTxt === null || !securityTxt.ok || securityTxt.body.trim() === "") {
    findings.push({
      id: "exp-security-txt-missing",
      category: "exposure",
      severity: "info",
      title: "No security.txt published",
      detail:
        "Neither /.well-known/security.txt nor /security.txt returned a policy file. RFC 9116 defines this file as the standard way to tell a researcher who found a bug in your site where to send it. Without one, reports go to whatever address someone can find - a sales inbox, a contact form, occasionally a public tweet - and the ones that do not find an address quietly go nowhere.",
      fix: "Publish the file at /.well-known/security.txt, served as text/plain. Point Contact at a monitored inbox, set Expires no more than a year out, and diary a reminder to refresh it.",
      snippet: SECURITY_TXT_TEMPLATE,
      docs: "https://www.rfc-editor.org/rfc/rfc9116",
      weight: 1,
    });
  } else {
    const fields = parseSecurityTxt(securityTxt.body);
    const contacts = fields.get("contact") ?? [];
    const expiresRaw = fields.get("expires")?.[0] ?? null;
    const expiresAt = expiresRaw === null ? Number.NaN : Date.parse(expiresRaw);
    const optional = ["encryption", "acknowledgments", "policy", "canonical", "preferred-languages"];
    const present = optional.filter((name) => fields.has(name));
    const missing = optional.filter((name) => !fields.has(name));
    const signed = /-----BEGIN PGP SIGNED MESSAGE-----/.test(securityTxt.body);

    const valid = contacts.length > 0 && !Number.isNaN(expiresAt) && expiresAt > Date.now();

    if (valid) {
      findings.push({
        id: "exp-security-txt",
        category: "exposure",
        severity: "pass",
        title: "A valid security.txt is published",
        detail: `${securityTxt.url} declares ${pluralise(contacts.length, "contact")} and an Expires of ${expiresRaw}${signed ? ", and the file is PGP-signed" : ""}. A researcher who finds a problem here knows where to send it.`,
        value: truncate(contacts.join(" | "), 200),
        weight: 2,
      });
    }

    if (contacts.length === 0) {
      findings.push({
        id: "exp-security-txt-contact-missing",
        category: "exposure",
        severity: "warning",
        title: "security.txt has no Contact field",
        detail: `${securityTxt.url} exists but declares no Contact. Contact is the one field RFC 9116 makes mandatory, and it is the entire point of the file - without it a researcher has a policy document that tells them nothing about where to send a report. Parsers treat a Contact-less file as invalid.`,
        fix: "Add at least one Contact line pointing at a monitored mailbox or reporting form. Multiple lines are allowed and are listed in order of preference.",
        snippet: ["Contact: mailto:security@example.com", "Contact: https://example.com/security/report"].join("\n"),
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5.3",
        weight: 2,
      });
    }

    if (expiresRaw === null || Number.isNaN(expiresAt)) {
      findings.push({
        id: "exp-security-txt-expires-missing",
        category: "exposure",
        severity: "info",
        title: expiresRaw === null ? "security.txt has no Expires field" : "security.txt has an unreadable Expires field",
        detail:
          expiresRaw === null
            ? "RFC 9116 requires exactly one Expires field. Without it there is nothing to tell a reader whether this policy is current or was published years ago by someone who has since left, so a cautious researcher has to assume the latter."
            : `Expires is present but could not be parsed: "${truncate(expiresRaw, 60)}". The field must be an ISO 8601 / RFC 3339 timestamp.`,
        fix: "Add an ISO 8601 timestamp no more than a year in the future, e.g. `Expires: 2027-01-01T00:00:00.000Z`, and refresh it as part of a recurring task.",
        snippet: "Expires: 2027-01-01T00:00:00.000Z",
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5.5",
        weight: 1,
      });
    } else if (expiresAt <= Date.now()) {
      const daysAgo = Math.floor((Date.now() - expiresAt) / 86_400_000);
      findings.push({
        id: "exp-security-txt-expired",
        category: "exposure",
        severity: "warning",
        title: `security.txt expired ${pluralise(daysAgo, "day")} ago`,
        detail: `The Expires field reads ${expiresRaw}, which is in the past. Per RFC 9116 the file's contents should no longer be trusted - and to a researcher an expired policy is a strong signal that the process behind it was abandoned, that the contact address may be a mailbox nobody reads, and that reporting a bug here is not worth their time.`,
        fix: "Confirm the contact address still reaches someone, then push Expires forward (a year is the usual cadence) and add a recurring reminder so it does not lapse again.",
        snippet: "Expires: 2027-01-01T00:00:00.000Z",
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5.5",
        weight: 2,
      });
    }

    if (missing.length > 0) {
      findings.push({
        id: "exp-security-txt-fields",
        category: "exposure",
        severity: "info",
        title: `security.txt omits ${missing.length} optional ${missing.length === 1 ? "field" : "fields"}`,
        detail: `Present: ${present.length > 0 ? present.join(", ") : "none of the optional fields"}${signed ? " (and a PGP signature)" : ""}. Missing: ${missing.join(", ")}. None of these are required, but each removes a question the researcher would otherwise have to ask: Policy sets expectations about scope and safe harbour, Encryption lets them send you something sensitive, Preferred-Languages avoids a report written in a language nobody on your side reads, Canonical proves the file belongs where it is served, and Acknowledgments is the cheapest thanks in the industry.`,
        fix: "Add the fields that apply to you. Policy and Preferred-Languages are the two that most change how a report arrives.",
        snippet: SECURITY_TXT_TEMPLATE,
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5",
        weight: 1,
      });
    }

    if (!/\/\.well-known\/security\.txt$/i.test(securityTxt.url)) {
      findings.push({
        id: "exp-security-txt-location",
        category: "exposure",
        severity: "info",
        title: "security.txt is not served from /.well-known/",
        detail: `The policy was found at ${securityTxt.url}. RFC 9116 puts the canonical location at /.well-known/security.txt; the top-level /security.txt is a legacy fallback that only exists for sites that cannot serve the well-known path. Tooling and researchers check the well-known path, and many check only that.`,
        fix: "Serve the file from /.well-known/security.txt. Keep /security.txt as a redirect if anything already links to it, and set Canonical to the well-known URL.",
        snippet: [
          "Canonical: https://example.com/.well-known/security.txt",
          "",
          "# nginx",
          "location = /security.txt { return 301 /.well-known/security.txt; }",
        ].join("\n"),
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-3",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 6. HTML comments                                                        */
  /* ---------------------------------------------------------------------- */

  let markupIssues = 0;

  const comments = collectMatches(HTML_COMMENT, html, MAX_COMMENTS)
    .map((m) => collapse(m[1] ?? ""))
    .filter((body) => body !== "" && !NOISE_COMMENT.test(body));

  const todoComments = comments.filter((c) => TODO_MARKER.test(c));
  const secretComments = comments.filter((c) => SECRET_MARKER.test(c));
  const internalComments = comments.filter(
    (c) =>
      hasMatch(PRIVATE_IP, c) ||
      hasMatch(INTERNAL_HOST, c) ||
      hasMatch(NON_PROD_URL, c) ||
      hasMatch(LOCALHOST_REF, c),
  );

  if (secretComments.length > 0) {
    findings.push({
      id: "exp-comment-secret-marker",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(secretComments.length, "HTML comment")} mentions credentials`,
      detail: `Comments in the delivered markup contain words like password, api_key, secret or token: ${secretComments.slice(0, 3).map((c) => `"${safeExcerpt(c, 120)}"`).join("; ")}. Excerpts here are redacted by this tool, so check the raw source yourself. Comments are frequently where a credential gets parked "temporarily", and HTML comments are delivered to every visitor - view-source is all it takes.`,
      fix: "Read those comments in the original source. If any of them contains or hints at a real credential, rotate it and then strip the comment. Configure your build to remove comments from production HTML so this class of leak cannot recur.",
      value: safeExcerpt(secretComments[0], 200),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage",
      weight: 3,
    });
    markupIssues += 1;
  }

  if (internalComments.length > 0) {
    findings.push({
      id: "exp-comment-internal-reference",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(internalComments.length, "HTML comment")} references internal infrastructure`,
      detail: `Comments name private addresses, internal hostnames or non-production URLs: ${internalComments.slice(0, 3).map((c) => `"${safeExcerpt(c, 120)}"`).join("; ")}. Each one is a free hint about your internal topology - which staging host to look for, what the internal naming scheme is, which ranges the application talks to - and staging environments are usually the softer target.`,
      fix: "Remove the comments and strip comments from production HTML at build time. Separately, confirm the environments they name are not publicly reachable.",
      value: safeExcerpt(internalComments[0], 200),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage",
      weight: 2,
    });
    markupIssues += 1;
  }

  if (todoComments.length > 0) {
    findings.push({
      id: "exp-comment-todo",
      category: "exposure",
      severity: "info",
      title: `${pluralise(todoComments.length, "development comment")} shipped to production`,
      detail: `TODO/FIXME/HACK notes are present in the delivered HTML: ${todoComments.slice(0, 3).map((c) => `"${safeExcerpt(c, 100)}"`).join("; ")}. Individually harmless, collectively a map - "FIXME: validation is client-side only" is the kind of note that tells an attacker exactly where to push.`,
      fix: "Strip comments from production HTML in your build (most minifiers do this by default; check the option is on).",
      value: safeExcerpt(todoComments[0], 160),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage",
      weight: 1,
    });
    markupIssues += 1;
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Secret-shaped strings in the markup                                  */
  /* ---------------------------------------------------------------------- */

  const inlineScriptCount = doc.scripts.filter((s) => s.src === null && s.inlineLength > 0).length;

  for (const rule of SECRET_RULES) {
    const hits = matchedStrings(rule.pattern, html, 20);
    if (hits.length === 0) continue;

    const masked = unique(hits.map((hit) => maskToken(hit, rule.keep))).slice(0, 4);

    findings.push({
      id: rule.id,
      category: "exposure",
      severity: rule.severity,
      title: hits.length === 1 ? rule.title : `${rule.title} (${hits.length} occurrences)`,
      detail: `${rule.detail} Found ${pluralise(hits.length, "occurrence")} in the HTML of this page${inlineScriptCount > 0 ? `, which carries ${pluralise(inlineScriptCount, "inline script block")}` : ""}. The value is shown redacted below - this report never reproduces a credential in full.`,
      fix: rule.fix,
      value: masked.join(" | "),
      docs: rule.docs,
      weight: rule.weight,
    });
    markupIssues += 1;
  }

  const credentialAssignments = collectMatches(CREDENTIAL_ASSIGNMENT, html, 20).filter((match) => {
    const value = match[2] ?? "";
    if (/^[{$%<]|[}]$/.test(value)) return false;
    if (/^(?:true|false|null|undefined|none|\d+)$/i.test(value)) return false;
    if (/(?:example|your[_-]?|changeme|placeholder|xxxx|todo|sample|dummy|test123|\*{3,})/i.test(value)) return false;
    return value.length >= 12 || /\d/.test(value);
  });

  if (credentialAssignments.length > 0) {
    const keys = unique(
      credentialAssignments.map((m) => collapse(m[1] ?? "").replace(/["']?\s*[:=]\s*$/, "")),
    ).slice(0, 5);

    findings.push({
      id: "exp-inline-credential-assignment",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(credentialAssignments.length, "credential-shaped assignment")} in the markup`,
      detail: `Keys named ${keys.join(", ")} are assigned non-placeholder values in the HTML or inline scripts. This does not match a known key format, so it may well be a harmless config flag or a public identifier - but "apiKey" with a real-looking value in client-side code is the shape of a leak often enough to be worth ten seconds of your time. The values are withheld from this report.`,
      fix: "Look at each of these in the source. Anything that authenticates you to a third party belongs behind your own endpoint, not in a page every visitor downloads. If one of them turns out to be live, rotate it before removing it.",
      value: keys.map((key) => `${key}=[redacted]`).join(" | "),
      docs: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html",
      weight: 2,
    });
    markupIssues += 1;
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Internal hosts, filesystem paths, fingerprints                       */
  /* ---------------------------------------------------------------------- */

  const privateIps = unique(matchedStrings(PRIVATE_IP, html, 30));
  const internalHosts = unique(matchedStrings(INTERNAL_HOST, html, 30));
  const nonProdUrls = unique(matchedStrings(NON_PROD_URL, html, 30));
  const internalRefs = [...privateIps, ...internalHosts, ...nonProdUrls];

  if (internalRefs.length > 0) {
    findings.push({
      id: "exp-internal-hostname",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(internalRefs.length, "internal address")} appears in the markup`,
      detail: `The page references ${internalRefs.slice(0, 6).join(", ")}${internalRefs.length > 6 ? ", and others" : ""}. Private-range IPs, .local/.internal hostnames and localhost URLs describe infrastructure that visitors are not supposed to know about: they map your internal network, name hosts worth probing from anywhere that can reach them, and often mean a development configuration was deployed as-is. Any request the browser makes to these will also simply fail for real visitors.`,
      fix: "Replace them with public hostnames or same-origin relative URLs, and check your build is using the production environment configuration. If the references came from a copy-pasted template, search the codebase for the rest of them.",
      value: internalRefs.slice(0, 10).join(" | "),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage",
      weight: 2,
    });
    markupIssues += 1;
  }

  const fsPaths = unique(FILESYSTEM_PATHS.flatMap((pattern) => matchedStrings(pattern, html, 20)));

  if (fsPaths.length > 0) {
    findings.push({
      id: "exp-filesystem-path",
      category: "exposure",
      severity: "warning",
      title: `${pluralise(fsPaths.length, "absolute filesystem path")} leaked in the markup`,
      detail: `Server paths such as ${fsPaths.slice(0, 4).map((p) => safeExcerpt(p, 90)).join(", ")} appear in the delivered HTML. These normally arrive one of two ways: an error or warning that printed a path, or a build artefact that baked in the machine it was built on. Either way it hands over the account name, the directory layout and often the framework and deploy method - all of which make a path-traversal or file-inclusion attempt far more likely to land on something real.`,
      fix: "If a path came from an error message, turn off displayed errors in production and log them instead. If it came from a build, configure the bundler to strip or rewrite absolute paths (Vite and webpack both support this) and rebuild.",
      value: fsPaths.slice(0, 6).map((p) => safeExcerpt(p, 90)).join(" | "),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/05-Review_Webpage_Content_for_Information_Leakage",
      weight: 2,
    });
    markupIssues += 1;
  }

  const fingerprints = FRAMEWORK_FINGERPRINTS.filter((rule) => hasMatch(rule.marker, html)).map((rule) => rule.label);

  if (fingerprints.length > 0) {
    findings.push({
      id: "exp-framework-path",
      category: "exposure",
      severity: "info",
      title: `The markup identifies the platform behind this site (${fingerprints.length === 1 ? fingerprints[0].split(" (")[0] : `${fingerprints.length} signatures`})`,
      detail: `Asset paths give the stack away: ${fingerprints.join(", ")}. This is unavoidable for most platforms and is not a vulnerability - but it narrows an attacker's search from "the whole internet's worth of bugs" to "this platform's bugs", and where the path embeds a plugin or theme version it narrows it again to specific published CVEs.`,
      fix: "Nothing to fix in the paths themselves. Take it as a reminder that platform and plugin patching is the control that actually matters here, since the platform cannot be hidden. Where paths embed version numbers, consider stripping the version query string from asset URLs.",
      value: fingerprints.join(" | "),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/08-Fingerprint_Web_Application_Framework",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Debug output                                                         */
  /* ---------------------------------------------------------------------- */

  const debugHits: { label: string; sample: string }[] = [];
  for (const rule of DEBUG_OUTPUT) {
    const hits = matchedStrings(rule.pattern, html, 5);
    if (hits.length > 0) debugHits.push({ label: rule.label, sample: hits[0] });
  }

  if (debugHits.length > 0) {
    const visibleInText = debugHits.some((hit) => doc.textContent.includes(hit.sample.slice(0, 40)));
    findings.push({
      id: "exp-stack-trace",
      category: "exposure",
      severity: "critical",
      title: "Debug output or a stack trace is being served to visitors",
      detail: `The response body contains ${debugHits.map((h) => h.label).join(", ")}${visibleInText ? ", rendered visibly on the page" : ", inside the markup"} - for example: "${safeExcerpt(debugHits[0].sample, 160)}". This is a production environment running with debugging on. Error output typically discloses absolute file paths, framework and library versions, SQL fragments, environment variables and request contents; error pages from Laravel, Rails and Django debug mode go further and expose configuration and session data outright. It also converts blind attacks into guided ones: an attacker injects a malformed value and reads your database's own description of what went wrong.`,
      fix: "Turn debugging off in production immediately (`APP_DEBUG=false` in Laravel, `DEBUG = False` in Django, `display_errors = Off` in PHP, `NODE_ENV=production`), serve a generic error page, and send the details to your logs or error tracker instead. Then review what these particular messages disclosed - if they printed credentials or connection strings, rotate them.",
      snippet: [
        "# php.ini",
        "display_errors = Off",
        "log_errors = On",
        "",
        "# Laravel .env",
        "APP_DEBUG=false",
        "APP_ENV=production",
      ].join("\n"),
      value: debugHits.map((h) => `${h.label}: ${safeExcerpt(h.sample, 100)}`).join(" | "),
      docs: "https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/08-Testing_for_Error_Handling/",
      weight: 6,
    });
    markupIssues += 1;
  }

  /* ---------------------------------------------------------------------- */
  /* 10. Harvestable addresses                                               */
  /* ---------------------------------------------------------------------- */

  const mailtoFromDoc = doc.anchors
    .map((a) => a.href ?? "")
    .filter((href) => /^mailto:/i.test(href))
    .map((href) => href.slice(7).split("?")[0].trim());
  const mailtoFromHtml = matchedStrings(/mailto:[^"'\s>?&]{3,120}/gi, html, 30).map((m) => m.slice(7));
  const addresses = unique([...mailtoFromDoc, ...mailtoFromHtml].filter((a) => a.includes("@") && a.length < 120));

  if (addresses.length > 0) {
    findings.push({
      id: "exp-mailto-address",
      category: "exposure",
      severity: "info",
      title: `${pluralise(addresses.length, "email address")} published as a mailto: link`,
      detail: `${addresses.slice(0, 3).join(", ")}${addresses.length > 3 ? `, and ${addresses.length - 3} more` : ""} are in the markup as plain mailto: hrefs. Address harvesters scrape exactly this pattern, so expect these to receive spam and phishing - and a published staff address is also the starting point for a targeted phishing attempt against that person. Publishing a contact address is often the right call; this is a note about which one you publish, not an instruction to hide it.`,
      fix: "Use a role address (hello@, support@, security@) rather than an individual's, put a contact form in front of it where you can, and make sure the mailbox has good spam filtering. Obfuscation tricks mostly inconvenience real visitors rather than scrapers.",
      value: addresses.slice(0, 6).join(" | "),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a#mailto_links",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. Clean markup                                                        */
  /* ---------------------------------------------------------------------- */

  if (markupIssues === 0) {
    findings.push({
      id: "exp-markup-clean",
      category: "exposure",
      severity: "pass",
      title: "No secrets or internal details found in the markup",
      detail: `The delivered HTML${truncatedScan ? " (first 500 KB scanned)" : ""} was checked for credential-shaped strings, developer comments, private-range addresses and internal hostnames, absolute filesystem paths and visible debug output. ${comments.length > 0 ? `${pluralise(comments.length, "comment")} and ` : ""}${pluralise(inlineScriptCount, "inline script block")} were examined and none of them leaked anything.`,
      weight: 3,
    });
  }

  return findings;
}
