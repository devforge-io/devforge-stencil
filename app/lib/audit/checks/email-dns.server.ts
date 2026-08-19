/**
 * Email authentication and DNS-layer checks.
 *
 * Everything here is derived from `ctx.dns` - the records published for the
 * audited domain - and nothing else. This is the layer that decides whether a
 * stranger can put your domain in the From line of an email and have it land in
 * an inbox: SPF says which servers may send, DKIM signs what they send, DMARC
 * tells receivers what to do when neither lines up, and CAA constrains who may
 * issue a certificate in your name.
 *
 * The response headers of the website itself are not our business - the
 * security checks own those. We only read DNS.
 *
 * Two accuracy rules govern this module, because people change live DNS records
 * based on what it says:
 *
 *   1. Never assert something the records cannot show. DKIM absence is the
 *      obvious case - selectors are arbitrary strings, we probe a handful, and
 *      "not found" is inconclusive rather than negative. Say so.
 *   2. Where a count or a verdict is necessarily partial (SPF lookups hidden
 *      inside an include, DNSSEC validation we cannot perform), state the
 *      boundary of what was measured inside the finding itself.
 */

import type { DnsRecords, Finding, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Reference material                                                          */
/* -------------------------------------------------------------------------- */

const RFC_SPF = "https://www.rfc-editor.org/rfc/rfc7208";
const RFC_SPF_LIMITS = "https://www.rfc-editor.org/rfc/rfc7208#section-4.6.4";
const RFC_SPF_PTR = "https://www.rfc-editor.org/rfc/rfc7208#section-5.5";
const RFC_DMARC = "https://www.rfc-editor.org/rfc/rfc7489";
const RFC_DKIM = "https://www.rfc-editor.org/rfc/rfc6376";
const RFC_CAA = "https://www.rfc-editor.org/rfc/rfc8659";
const RFC_NULL_MX = "https://www.rfc-editor.org/rfc/rfc7505";
const DNSSEC_ANALYZER = "https://dnsviz.net/";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Join a list for prose, capping the visible entries. */
function listOf(items: string[], max = 8): string {
  if (items.length === 0) return "none";
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

/** A fully qualified owner name for zone-file snippets. */
function zoneName(domain: string, prefix = ""): string {
  const bare = domain.replace(/\.$/, "");
  return `${prefix}${bare}.`;
}

/* -------------------------------------------------------------------------- */
/* SPF parsing                                                                 */
/* -------------------------------------------------------------------------- */

/** Mechanism names defined by RFC 7208. Anything else is a permerror. */
const SPF_MECHANISMS = new Set(["all", "include", "a", "mx", "ptr", "ip4", "ip6", "exists"]);

/**
 * Mechanisms that cost a DNS lookup against the limit of 10 (RFC 7208 §4.6.4).
 * `ip4`, `ip6` and `all` are free; the `redirect` modifier costs one and is
 * handled separately because it is a modifier, not a mechanism.
 */
const SPF_LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists"]);

type SpfQualifier = "+" | "-" | "~" | "?";

interface SpfMechanism {
  qualifier: SpfQualifier;
  /** Lowercased mechanism name. */
  name: string;
  /** Everything after the first `:` or `/`, or null when the term is bare. */
  value: string | null;
  raw: string;
}

interface SpfModifier {
  /** Lowercased modifier name. */
  name: string;
  value: string;
  raw: string;
}

interface ParsedSpf {
  /** True when the record opens with the `v=spf1` version token. */
  valid: boolean;
  mechanisms: SpfMechanism[];
  modifiers: SpfModifier[];
  /** Mechanism terms whose name is not defined by RFC 7208. */
  unknownMechanisms: string[];
  /** The `all` mechanism, when present. */
  all: SpfMechanism | null;
  /** Raw terms that each cost one DNS lookup, in record order. */
  lookupTerms: string[];
  lookupCount: number;
  ptrTerms: string[];
  redirect: string | null;
}

/**
 * Split a raw TXT payload into the individual `v=spf1` records it contains.
 *
 * The resolver hands us the SPF value as a single string. A domain that has
 * accidentally published two SPF records shows up here as two version tokens in
 * one payload (or as newline-separated values), and that case is worth catching
 * because it is a hard permerror rather than a cosmetic duplicate.
 */
function splitSpfRecords(raw: string): string[] {
  const byLine = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const records: string[] = [];
  for (const line of byLine) {
    // A second `v=spf1` inside one line means two records were concatenated.
    const parts = line
      .split(/(?=\bv=spf1\b)/i)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length <= 1) records.push(line);
    else records.push(...parts);
  }
  return records.length === 0 ? [raw.trim()] : records;
}

function parseSpf(record: string): ParsedSpf {
  const terms = record.trim().split(/\s+/).filter((t) => t !== "");
  const valid = /^v=spf1$/i.test(terms[0] ?? "");
  const body = valid ? terms.slice(1) : terms.filter((t) => !/^v=spf1$/i.test(t));

  const mechanisms: SpfMechanism[] = [];
  const modifiers: SpfModifier[] = [];
  const unknownMechanisms: string[] = [];
  const lookupTerms: string[] = [];
  const ptrTerms: string[] = [];

  for (const term of body) {
    // Modifiers are `name=value`; mechanisms never contain an unqualified `=`.
    const modifier = /^([A-Za-z][A-Za-z0-9_.-]*)=(.*)$/.exec(term);
    if (modifier !== null) {
      modifiers.push({ name: modifier[1].toLowerCase(), value: modifier[2], raw: term });
      continue;
    }

    const mechanism = /^([+\-~?])?([A-Za-z][A-Za-z0-9_.-]*)(?:[:/](.*))?$/.exec(term);
    if (mechanism === null) {
      unknownMechanisms.push(term);
      continue;
    }

    const qualifier = (mechanism[1] ?? "+") as SpfQualifier;
    const name = mechanism[2].toLowerCase();
    const value = typeof mechanism[3] === "string" ? mechanism[3] : null;

    if (!SPF_MECHANISMS.has(name)) {
      unknownMechanisms.push(term);
      continue;
    }

    mechanisms.push({ qualifier, name, value, raw: term });
    if (SPF_LOOKUP_MECHANISMS.has(name)) lookupTerms.push(term);
    if (name === "ptr") ptrTerms.push(term);
  }

  const redirectModifier = modifiers.find((m) => m.name === "redirect") ?? null;
  if (redirectModifier !== null) lookupTerms.push(redirectModifier.raw);

  return {
    valid,
    mechanisms,
    modifiers,
    unknownMechanisms,
    all: mechanisms.find((m) => m.name === "all") ?? null,
    lookupTerms,
    lookupCount: lookupTerms.length,
    ptrTerms,
    redirect: redirectModifier?.value ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* DMARC parsing                                                               */
/* -------------------------------------------------------------------------- */

interface ParsedDmarc {
  /** True when the first tag is `v=DMARC1`. */
  valid: boolean;
  /** Lowercased tag names to their raw values. First occurrence wins. */
  tags: Map<string, string>;
  /** Chunks that were not `name=value` pairs. */
  malformed: string[];
}

function parseDmarc(record: string): ParsedDmarc {
  const chunks = record
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "");

  const tags = new Map<string, string>();
  const malformed: string[] = [];

  for (const chunk of chunks) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(chunk);
    if (match === null) {
      malformed.push(chunk);
      continue;
    }
    const name = match[1].toLowerCase();
    if (!tags.has(name)) tags.set(name, match[2].trim());
  }

  const firstIsVersion = /^v\s*=\s*DMARC1$/i.test(chunks[0] ?? "");
  return { valid: firstIsVersion, tags, malformed };
}

function countOccurrences(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

/* -------------------------------------------------------------------------- */
/* Apex TXT records                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every TXT record on the apex, defensively.
 *
 * The contract types this as a plain `string[]`, but a `PageContext` built
 * before the field existed will not carry it at all. The distinction that
 * matters is "no TXT data available" versus "TXT data available and it contains
 * no SPF record" - the first has to fall back to inspecting the `spf` field, the
 * second is real evidence. Returning an empty array for both is safe because
 * every caller here treats empty as "unknown, fall back".
 */
function apexTxt(dns: DnsRecords): string[] {
  const records: unknown = dns.txt;
  if (!Array.isArray(records)) return [];
  return records.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

/** True when a raw TXT record is an SPF record rather than some other TXT payload. */
function isSpfTxtRecord(record: string): boolean {
  return /^v=spf1(\s|$)/i.test(record.trim());
}

/* -------------------------------------------------------------------------- */
/* CAA parsing                                                                 */
/* -------------------------------------------------------------------------- */

interface CaaEntry {
  /** Lowercased property tag: issue, issuewild, iodef, … */
  tag: string;
  value: string;
  raw: string;
}

/**
 * Parse whatever shape the resolver handed us.
 *
 * Node's `resolveCaa` yields objects that callers flatten in different ways, so
 * accept `0 issue "letsencrypt.org"`, `issue letsencrypt.org`, `issue=…`, and a
 * bare issuer domain, rather than assuming one format.
 */
function parseCaa(entries: string[]): CaaEntry[] {
  const parsed: CaaEntry[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const match = /\b(issuewild|issuemail|issue|iodef|contactemail|contactphone)\b\s*[:=]?\s*"?([^"]*)"?/i.exec(trimmed);
    if (match === null) {
      parsed.push({ tag: "issue", value: trimmed.replace(/^["']|["']$/g, ""), raw: trimmed });
      continue;
    }
    parsed.push({
      tag: match[1].toLowerCase(),
      value: match[2].trim().replace(/^["']|["']$/g, ""),
      raw: trimmed,
    });
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Provider fingerprints                                                       */
/* -------------------------------------------------------------------------- */

interface MailProviderRule {
  label: string;
  pattern: RegExp;
  /** Where the relevant records are configured for this provider. */
  hint: string;
}

const MAIL_PROVIDERS: MailProviderRule[] = [
  {
    label: "Google Workspace",
    pattern: /(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com)$/i,
    hint: "SPF is `include:_spf.google.com`; DKIM is generated under Apps → Google Workspace → Gmail → Authenticate email.",
  },
  {
    label: "Microsoft 365",
    pattern: /(^|\.)(mail\.protection\.outlook\.com|outlook\.com|office365\.com)$/i,
    hint: "SPF is `include:spf.protection.outlook.com`; DKIM selectors are `selector1`/`selector2` and are enabled in the Defender portal.",
  },
  {
    label: "Proofpoint",
    pattern: /(^|\.)(pphosted\.com|ppe-hosted\.com|proofpoint\.com)$/i,
    hint: "Inbound mail is filtered by Proofpoint; outbound authentication is still configured at whatever sends your mail.",
  },
  {
    label: "Mimecast",
    pattern: /(^|\.)mimecast(\.com|\.co\.za|-offshore\.com)$/i,
    hint: "Inbound mail is filtered by Mimecast; SPF normally needs `include:_netblocks.mimecast.com` for outbound routing.",
  },
  {
    label: "Zoho Mail",
    pattern: /(^|\.)(zoho\.com|zoho\.eu|zohomail\.com|zohomail\.eu)$/i,
    hint: "SPF is `include:zoho.com`; DKIM is issued per-selector in the Zoho admin console.",
  },
  {
    label: "Fastmail",
    pattern: /(^|\.)(messagingengine\.com|fastmail\.com)$/i,
    hint: "SPF is `include:spf.messagingengine.com`; Fastmail publishes DKIM via three CNAMEs.",
  },
  {
    label: "Proton Mail",
    pattern: /(^|\.)(protonmail\.ch|proton\.me|protonmail\.com)$/i,
    hint: "SPF is `include:_spf.protonmail.ch`; DKIM is published as CNAMEs from the Proton dashboard.",
  },
  {
    label: "Amazon SES / WorkMail",
    pattern: /(^|\.)(amazonaws\.com|awsapps\.com)$/i,
    hint: "SPF is `include:amazonses.com`; SES publishes DKIM as three CNAME records.",
  },
  {
    label: "Cloudflare Email Routing",
    pattern: /(^|\.)mx\.cloudflare\.net$/i,
    hint: "Cloudflare forwards inbound mail only - it does not send, so outbound authentication belongs to your real sender.",
  },
  {
    label: "Barracuda",
    pattern: /(^|\.)barracudanetworks\.com$/i,
    hint: "Inbound filtering by Barracuda; outbound authentication is configured at the sending platform.",
  },
  {
    label: "Yandex 360",
    pattern: /(^|\.)yandex\.(net|ru)$/i,
    hint: "SPF is `include:_spf.yandex.net`; DKIM is issued in the Yandex 360 admin panel.",
  },
];

/**
 * Nameserver operators worth naming.
 *
 * Several of these deliberately spread their nameservers across different TLDs
 * (Route 53 uses .com/.net/.org/.co.uk, Azure DNS the same trick), so matching
 * on the registrable domain alone would report four independent operators where
 * there is one. That would be exactly the wrong conclusion to hand someone
 * reasoning about resilience.
 */
const NS_PROVIDERS: { label: string; pattern: RegExp }[] = [
  { label: "Amazon Route 53", pattern: /awsdns/i },
  { label: "Azure DNS", pattern: /azure-dns/i },
  { label: "Cloudflare", pattern: /(^|\.)cloudflare\.com$/i },
  { label: "GoDaddy", pattern: /(^|\.)domaincontrol\.com$/i },
  { label: "Namecheap", pattern: /(^|\.)registrar-servers\.com$/i },
  { label: "NS1 / IBM", pattern: /(^|\.)nsone\.net$/i },
  { label: "UltraDNS", pattern: /ultradns/i },
  { label: "Akamai Edge DNS", pattern: /akam\.net$|akamai/i },
  { label: "DNSimple", pattern: /(^|\.)dnsimple\.com$/i },
  { label: "DigitalOcean", pattern: /(^|\.)digitalocean\.com$/i },
  { label: "Google Cloud DNS", pattern: /(^|\.)googledomains\.com$/i },
  { label: "Google", pattern: /(^|\.)google\.com$/i },
  { label: "Vercel", pattern: /(^|\.)vercel-dns\.com$/i },
  { label: "DNS Made Easy", pattern: /dnsmadeeasy/i },
  { label: "Squarespace", pattern: /squarespacedns/i },
  { label: "Hetzner", pattern: /(^|\.)hetzner\.(com|de)$/i },
];

/** Strip a leading MX preference and the trailing root dot. Empty means a null MX. */
function mxHost(entry: string): string {
  return entry
    .trim()
    .replace(/^\d+\s+/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function normaliseHost(entry: string): string {
  return entry.trim().replace(/\.$/, "").toLowerCase();
}

/** The operator behind a nameserver hostname; falls back to its last two labels. */
function nameserverProvider(host: string): string {
  const lower = normaliseHost(host);
  for (const rule of NS_PROVIDERS) {
    if (rule.pattern.test(lower)) return rule.label;
  }
  const labels = lower.split(".").filter((l) => l !== "");
  if (labels.length <= 2) return lower;
  return labels.slice(-2).join(".");
}

function mailProviderFor(hosts: string[]): MailProviderRule | null {
  for (const rule of MAIL_PROVIDERS) {
    if (hosts.some((h) => rule.pattern.test(h))) return rule;
  }
  return null;
}

/** Rewrite a record's terminating `all` to a hard fail, for use in fix snippets. */
function hardenAll(record: string): string {
  const trimmed = record.trim();
  return /(^|\s)[+\-~?]?all\s*$/i.test(trimmed)
    ? trimmed.replace(/(^|\s)[+\-~?]?all\s*$/i, " -all")
    : `${trimmed} -all`;
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function emailDnsChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const dns: DnsRecords | null = ctx.dns;

  /* ---------------------------------------------------------------------- */
  /* 0. Nothing to look at                                                   */
  /* ---------------------------------------------------------------------- */

  if (dns === null) {
    findings.push({
      id: "dns-unavailable",
      category: "email-dns",
      severity: "info",
      title: "DNS records could not be inspected",
      detail:
        "No DNS lookups completed for this host, so nothing in this section was evaluated. That is a limitation of the scan - a timeout, a blocked resolver or a host that could not be reduced to a registrable domain - and says nothing about whether SPF, DKIM, DMARC or CAA are configured. Treat this category as unmeasured rather than as a clean result.",
      fix: "Re-run the audit, or check the records directly with `dig TXT example.com`, `dig TXT _dmarc.example.com` and `dig CAA example.com`.",
      snippet: [
        "dig +short TXT example.com          # SPF lives here",
        "dig +short TXT _dmarc.example.com   # DMARC policy",
        "dig +short CAA example.com          # certificate issuance",
        "dig +short MX  example.com",
      ].join("\n"),
      docs: RFC_SPF,
      weight: 1,
    });
    return findings;
  }

  const domain = dns.domain.replace(/\.$/, "") || dns.host;

  /* ---------------------------------------------------------------------- */
  /* 1. Mail posture - computed first, because it changes SPF/DMARC stakes   */
  /* ---------------------------------------------------------------------- */

  const mxHosts = dns.mx.map(mxHost).filter((h) => h !== "");
  const hasNullMx = dns.mx.length > 0 && mxHosts.length === 0;
  /** The domain visibly participates in mail, so spoofing it is worth more. */
  const mailActive = mxHosts.length > 0;
  const mailProvider = mailProviderFor(mxHosts);

  /* ---------------------------------------------------------------------- */
  /* 2. SPF                                                                  */
  /* ---------------------------------------------------------------------- */

  const spfRaw = dns.spf;

  if (spfRaw === null || spfRaw.trim() === "") {
    findings.push({
      id: "dns-spf-missing",
      category: "email-dns",
      severity: mailActive ? "critical" : "warning",
      title: "No SPF record published",
      detail:
        `${domain} publishes no \`v=spf1\` TXT record, so nothing states which servers are allowed to send mail on its behalf. Anyone, anywhere, can put an address at this domain in the envelope sender and receivers have no published fact to weigh it against.` +
        (mailActive
          ? ` The domain has MX records and is actively in the mail business, which makes this worse in both directions: mail claiming to be from you is more plausible to a recipient, and your own legitimate mail is more likely to be scored as suspicious for lacking authentication.`
          : ` The domain has no MX records, so it receives no mail - but that does not stop anyone sending as it, which is exactly why a no-mail domain still wants an SPF record.`),
      fix: "Publish one SPF TXT record at the domain apex. Enumerate every system that legitimately sends as this domain first - the mail platform, the transactional provider, the CRM, the ticketing system, the monitoring alerts - because anything you leave out will start failing the moment you finish with `-all`. Start with `~all` while you confirm the list, then tighten.",
      snippet: [
        "; one TXT record at the apex, listing your real senders",
        `${zoneName(domain)}  IN  TXT  "v=spf1 include:_spf.google.com include:sendgrid.net -all"`,
        "",
        "; replace the include: list with your actual providers, e.g.",
        ";   Google Workspace   include:_spf.google.com",
        ";   Microsoft 365      include:spf.protection.outlook.com",
        ";   Amazon SES         include:amazonses.com",
        ";   Mailchimp          include:servers.mcsv.net",
      ].join("\n"),
      docs: RFC_SPF,
      weight: mailActive ? 5 : 3,
    });
  } else {
    const spfRecords = splitSpfRecords(spfRaw);

    /*
     * Duplicate detection, in order of preference.
     *
     * The apex TXT records are the authoritative source: a domain with two SPF
     * records has two entries beginning `v=spf1`, and counting them is a fact
     * rather than an inference. Fall back to inspecting the `spf` value itself
     * only when the TXT enumeration is unavailable or does not contain the SPF
     * record - losing the check entirely would be worse than a heuristic, and a
     * heuristic that fires is still evidence of two records having been joined.
     */
    const spfFromTxt = apexTxt(dns).filter(isSpfTxtRecord);
    const countedFromTxt = spfFromTxt.length > 0;
    const spfRecordCount = countedFromTxt
      ? spfFromTxt.length
      : Math.max(spfRecords.length, countOccurrences(spfRaw, /\bv=spf1\b/gi));

    if (spfRecordCount > 1) {
      findings.push({
        id: "dns-spf-multiple-records",
        category: "email-dns",
        severity: "critical",
        title: `More than one SPF record is published for ${domain}`,
        detail:
          (countedFromTxt
            ? `${pluralise(spfRecordCount, "TXT record")} on the apex of ${domain} begin with \`v=spf1\`.`
            : `The resolver returned what parses as ${pluralise(spfRecordCount, "SPF record")} for ${domain}. The apex TXT records were not enumerated, so the exact count is inferred from the returned value - the duplication is visible, the precise number may not be.`) +
          ` RFC 7208 permits exactly one: when a receiver finds two, evaluation stops with a permerror and neither record is applied. The domain behaves as though it had no SPF at all, which is a failure mode that hides well - each record looks correct in isolation, and the DNS console shows nothing wrong.`,
        fix: "Merge them into a single record. Take the include:, ip4: and ip6: terms from every copy, deduplicate them, keep one `all` mechanism at the end, and delete the other TXT records. Watch the lookup count while merging - combining two records is the usual way domains cross the limit of 10.",
        snippet: [
          "; wrong - two separate TXT records",
          `${zoneName(domain)}  IN  TXT  "v=spf1 include:_spf.google.com ~all"`,
          `${zoneName(domain)}  IN  TXT  "v=spf1 include:amazonses.com ~all"`,
          "",
          "; right - one record",
          `${zoneName(domain)}  IN  TXT  "v=spf1 include:_spf.google.com include:amazonses.com -all"`,
        ].join("\n"),
        value: truncate(countedFromTxt ? spfFromTxt.join(" | ") : spfRaw, 300),
        docs: RFC_SPF,
        weight: 5,
      });
    }

    const record = spfRecords[0] ?? spfRaw.trim();
    const spf = parseSpf(record);

    if (!spf.valid) {
      findings.push({
        id: "dns-spf-malformed",
        category: "email-dns",
        severity: "critical",
        title: "SPF record does not begin with v=spf1",
        detail: `The record found was "${truncate(record, 200)}". An SPF record must open with the exact version token \`v=spf1\`; without it receivers do not recognise the record as SPF and skip it entirely. Whatever the intent, this record is not doing anything.`,
        fix: "Rewrite the record so `v=spf1` is the first token, followed by the mechanisms and a terminating `all`.",
        snippet: `${zoneName(domain)}  IN  TXT  "v=spf1 include:_spf.google.com -all"`,
        value: truncate(record, 300),
        docs: RFC_SPF,
        weight: 4,
      });
    } else {
      /* --- the `all` mechanism: what happens to unlisted senders --------- */

      const all = spf.all;

      if (all === null) {
        if (spf.redirect !== null) {
          findings.push({
            id: "dns-spf-redirect-terminal",
            category: "email-dns",
            severity: "info",
            title: "SPF delegates its final verdict with redirect=",
            detail: `The record has no \`all\` mechanism and ends with \`redirect=${spf.redirect}\`, which is legitimate: evaluation continues in that domain's record and its \`all\` becomes the effective policy. It also means the strictness of this domain is decided by someone else's record - if ${spf.redirect} softens to \`~all\` or \`?all\`, so does ${domain}, silently.`,
            fix: `Confirm what \`${spf.redirect}\` publishes today, and re-check it whenever that provider changes. If you want to own the verdict yourself, replace the redirect with an explicit include: plus your own \`-all\`.`,
            snippet: `dig +short TXT ${spf.redirect}`,
            value: record,
            docs: RFC_SPF,
            weight: 1,
          });
        } else {
          findings.push({
            id: "dns-spf-all-missing",
            category: "email-dns",
            severity: "warning",
            title: "SPF record has no `all` mechanism",
            detail: `"${truncate(record, 200)}" lists senders but never says what to do with everyone else. With no terminating \`all\` and no \`redirect=\`, a sender that matches nothing in the record produces a neutral result - the same outcome as having no SPF record at all. The listed senders pass; nobody else is denied.`,
            fix: "Append a terminating mechanism. Use `-all` once you are confident the list is complete, or `~all` while you are still confirming it.",
            snippet: `${zoneName(domain)}  IN  TXT  "${hardenAll(record)}"`,
            value: record,
            docs: RFC_SPF,
            weight: 2,
          });
        }
      } else if (all.qualifier === "-") {
        findings.push({
          id: "dns-spf-all-hardfail",
          category: "email-dns",
          severity: "pass",
          title: "SPF ends in `-all` - unlisted senders are rejected",
          detail: `"${truncate(record, 200)}" terminates with a hard fail, so a receiver checking mail from a server you have not listed gets an explicit "not authorised" rather than a shrug. This is the posture SPF is meant to end at, and it is what lets DMARC act on an SPF failure with confidence.`,
          value: record,
          weight: 3,
        });
      } else if (all.qualifier === "~") {
        findings.push({
          id: "dns-spf-all-softfail",
          category: "email-dns",
          severity: "info",
          title: "SPF ends in `~all` (soft fail) rather than `-all`",
          detail: `"${truncate(record, 200)}" ends in a soft fail: mail from an unlisted server is marked as suspicious but still accepted. This is the normal, sensible posture while you are rolling SPF out or still discovering which systems send as you - it lets you find the senders you forgot without bouncing their mail. It is a staging position, not a destination: with \`~all\`, a spoofed message is delivered and merely scored.`,
          fix: "Once your DMARC aggregate reports show no legitimate senders failing, change the terminating mechanism to `-all`.",
          snippet: `${zoneName(domain)}  IN  TXT  "${hardenAll(record)}"`,
          value: record,
          docs: RFC_SPF,
          weight: 2,
        });
      } else {
        const isNeutral = all.qualifier === "?";
        findings.push({
          id: "dns-spf-all-permissive",
          category: "email-dns",
          severity: "critical",
          title: isNeutral ? "SPF ends in `?all` - every sender is neutral" : "SPF ends in `+all` - every sender is authorised",
          detail: isNeutral
            ? `"${truncate(record, 200)}" terminates with \`?all\`, the neutral qualifier. Neutral means "no assertion", and a receiver treats it identically to a domain with no SPF record: unlisted servers are neither authorised nor denied. The record looks like protection and provides none.`
            : `"${truncate(record, 200)}" terminates with \`+all\`, which explicitly authorises every host on the internet to send mail as ${domain}. This is worse than publishing nothing - the record actively vouches for spammers and phishers using your domain, and a receiver has been told by you to accept them.`,
          fix: "Change the terminating mechanism to `-all` (or `~all` while you finish enumerating senders). If some sender seemed to require `+all`, the real fix is to add that sender's ip4:/include: term, not to open the record to everyone.",
          snippet: `${zoneName(domain)}  IN  TXT  "${hardenAll(record)}"`,
          value: record,
          docs: RFC_SPF,
          weight: 5,
        });
      }

      /* --- the DNS lookup limit ----------------------------------------- */

      const lookups = spf.lookupCount;
      const lookupList = listOf(spf.lookupTerms, 12);

      if (lookups > 10) {
        findings.push({
          id: "dns-spf-lookup-limit-exceeded",
          category: "email-dns",
          severity: "critical",
          title: `SPF needs ${lookups} DNS lookups - the limit is 10`,
          detail: `RFC 7208 caps SPF evaluation at 10 DNS-querying terms. This record already contains ${lookups} before any nesting: ${lookupList}. A receiver that hits the cap abandons evaluation and returns permerror, which means SPF is not merely strict here - it is not evaluated at all. Legitimate mail starts failing authentication, DMARC has nothing to align against, and the record stops protecting you from spoofing. Nothing looks wrong in a DNS console, which is why this is the single most common SPF fault in the wild. The count can only grow from here: every \`include:\` expands into another record whose own lookups count against the same 10, so the true total is at least ${lookups}.`,
          fix: "Get back under 10. Remove senders that no longer exist - this alone usually fixes it. Replace an `include:` with the `ip4:`/`ip6:` ranges it resolves to where the provider publishes stable addresses. Where a provider offers a consolidated include, use it instead of several. Only free-standing `ip4:`, `ip6:` and `all` cost nothing.",
          snippet: [
            "; before - 12 lookups, permerror",
            '"v=spf1 include:a.example include:b.example include:c.example include:d.example \\',
            '        include:e.example include:f.example include:g.example include:h.example \\',
            '        include:i.example include:j.example include:k.example mx -all"',
            "",
            "; after - 4 lookups, the rest flattened to literal ranges",
            '"v=spf1 ip4:203.0.113.0/24 ip4:198.51.100.7 include:_spf.google.com \\',
            '        include:amazonses.com include:servers.mcsv.net include:sendgrid.net -all"',
            "",
            "; verify after every change:",
            `;   https://www.rfc-editor.org/rfc/rfc7208#section-4.6.4`,
          ].join("\n"),
          value: `${lookups} lookup terms: ${spf.lookupTerms.join(" ")}`,
          docs: RFC_SPF_LIMITS,
          weight: 5,
        });
      } else if (lookups >= 8) {
        findings.push({
          id: "dns-spf-lookup-limit-near",
          category: "email-dns",
          severity: "warning",
          title: `SPF uses ${lookups} of its 10 permitted DNS lookups`,
          detail: `The record's lookup-costing terms are: ${lookupList}. That is inside the RFC 7208 limit, but only just, and the number is not fully under your control: each \`include:\` resolves to a record whose own lookups count against the same ceiling, so a provider adding one include to their record can push you over without you touching anything. Crossing 10 turns into a permerror, at which point SPF silently stops working for the whole domain.`,
          fix: "Buy yourself headroom now rather than after mail starts failing. Drop senders you no longer use, and replace the most stable include: with the literal ip4:/ip6: ranges behind it. Re-count after each change.",
          snippet: [
            "; free terms - these cost no lookup at all",
            ";   ip4:   ip6:   all",
            "",
            "; costed terms - 10 maximum, counting everything inside your includes",
            ";   include:   a   mx   ptr   exists:   redirect=",
          ].join("\n"),
          value: `${lookups} lookup terms: ${spf.lookupTerms.join(" ")}`,
          docs: RFC_SPF_LIMITS,
          weight: 2,
        });
      } else {
        findings.push({
          id: "dns-spf-lookup-count-ok",
          category: "email-dns",
          severity: "pass",
          title: `SPF uses ${lookups} of its 10 permitted DNS lookups`,
          detail:
            lookups === 0
              ? "The record contains no terms that require a DNS lookup, so it evaluates in a single query and cannot hit the RFC 7208 limit of 10."
              : `Lookup-costing terms: ${lookupList}. That leaves comfortable headroom under the RFC 7208 limit of 10, above which evaluation fails with a permerror. Counted at the top level only - lookups nested inside an \`include:\` add to the same total, so the effective figure is at least ${lookups}.`,
          value: `${lookups} lookup terms`,
          weight: 2,
        });
      }

      /* --- deprecated and unrecognised terms ---------------------------- */

      if (spf.ptrTerms.length > 0) {
        findings.push({
          id: "dns-spf-ptr-mechanism",
          category: "email-dns",
          severity: "warning",
          title: "SPF uses the deprecated `ptr` mechanism",
          detail: `The record contains ${listOf(spf.ptrTerms)}. RFC 7208 §5.5 deprecates \`ptr\` outright: it forces the receiver into a reverse lookup followed by a forward confirmation for every check, it is slow and unreliable enough that several large receivers ignore it or treat the whole record as suspect, and it depends on reverse DNS you frequently do not control. It also consumes one of your ten lookups for a result you cannot count on.`,
          fix: "Remove the `ptr` term and list those senders explicitly with `ip4:`/`ip6:` ranges, or with the provider's `include:`.",
          snippet: [
            "; before",
            '"v=spf1 mx ptr include:_spf.example.com -all"',
            "",
            "; after",
            '"v=spf1 mx ip4:203.0.113.0/24 include:_spf.example.com -all"',
          ].join("\n"),
          value: spf.ptrTerms.join(" "),
          docs: RFC_SPF_PTR,
          weight: 2,
        });
      }

      if (spf.unknownMechanisms.length > 0) {
        findings.push({
          id: "dns-spf-unknown-mechanism",
          category: "email-dns",
          severity: "warning",
          title: `SPF contains ${pluralise(spf.unknownMechanisms.length, "term")} that is not valid SPF syntax`,
          detail: `${listOf(spf.unknownMechanisms)} ${spf.unknownMechanisms.length === 1 ? "is" : "are"} neither a mechanism defined by RFC 7208 (all, include, a, mx, ptr, ip4, ip6, exists) nor a \`name=value\` modifier. An unrecognised mechanism is a permerror: a strict receiver stops evaluating and the record protects nothing. The usual causes are a typo, a stray character from a copy-paste, or a comma used where SPF wants a space.`,
          fix: "Correct or remove the term. SPF terms are separated by single spaces, never commas, and every mechanism argument follows a colon.",
          snippet: `${zoneName(domain)}  IN  TXT  "v=spf1 ip4:203.0.113.0/24 include:_spf.google.com -all"`,
          value: spf.unknownMechanisms.join(" "),
          docs: RFC_SPF,
          weight: 2,
        });
      }
    }

    /* --- string length -------------------------------------------------- */

    if (record.length > 255) {
      findings.push({
        id: "dns-spf-record-length",
        category: "email-dns",
        severity: "info",
        title: `SPF record is ${record.length} characters long`,
        detail: `A single character-string inside a TXT record cannot exceed 255 bytes. A record this long has to be published as several quoted strings inside one TXT record, which the resolver concatenates back together with no separator. Most DNS providers do this splitting for you and it works; the failure mode to watch for is a provider that truncates instead, or a split that inserts a space and corrupts a mechanism in the middle. Length is also a good signal that the lookup count deserves a look.`,
        fix: `Confirm the record reads back intact with \`dig +short TXT ${domain}\`. If your provider requires manual splitting, break it between terms - never inside one - and quote each chunk separately.`,
        snippet: [
          `${zoneName(domain)}  IN  TXT  ( "v=spf1 include:_spf.google.com include:amazonses.com "`,
          `                                "include:servers.mcsv.net include:sendgrid.net -all" )`,
        ].join("\n"),
        value: `${record.length} characters`,
        docs: RFC_SPF,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. DMARC                                                                */
  /* ---------------------------------------------------------------------- */

  const dmarcRaw = dns.dmarc;

  if (dmarcRaw === null || dmarcRaw.trim() === "") {
    findings.push({
      id: "dns-dmarc-missing",
      category: "email-dns",
      severity: mailActive ? "critical" : "warning",
      title: "No DMARC record published",
      detail:
        `Nothing is published at \`_dmarc.${domain}\`. This is the gap people most often miss after setting up SPF and DKIM, because it is easy to assume those two finish the job. They do not. SPF and DKIM produce a result; neither tells the receiver what to do with a failure, and neither one checks the From address the recipient actually sees - SPF validates the envelope sender, DKIM validates a signing domain, and a spoofer is free to pass both with their own domain while displaying yours. DMARC is the record that ties authentication to the visible From address and states a policy for failure.` +
        (mailActive ? ` With live MX records on this domain, that missing policy is being exercised: receivers currently have no instruction for mail that fails authentication in your name.` : ""),
      fix: "Start at `p=none` with an aggregate report address. That changes nothing about delivery - it only asks receivers to send you daily XML summaries of who is sending as you. Read them for two to four weeks until every legitimate stream authenticates, then move to `p=quarantine`, then to `p=reject`. Never start at reject: the reports exist precisely to show you the sender you forgot.",
      snippet: [
        "; step 1 - observe (safe, changes no delivery)",
        `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r"`,
        "",
        "; step 2 - after the reports are clean, a few weeks later",
        `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@${domain}"`,
        "",
        "; step 3 - enforcement",
        `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@${domain}; sp=reject"`,
      ].join("\n"),
      docs: RFC_DMARC,
      weight: mailActive ? 4 : 3,
    });
  } else {
    /*
     * Duplicate DMARC records are detected differently from duplicate SPF ones.
     *
     * `dns.txt` holds the records published at the *apex*, which is where SPF
     * lives - so duplicate SPF records can be counted directly there. DMARC does
     * not live at the apex: it is published at `_dmarc.<domain>`, a name the
     * apex TXT enumeration never covers. Counting `v=DMARC1` entries in
     * `dns.txt` would therefore always return zero and quietly disable the
     * check, so this stays with the heuristic on the resolved DMARC value: a
     * second version token, or a second line, means the resolver returned more
     * than one record for that name. Nothing here claims a duplicate that the
     * available data cannot show.
     */
    const dmarcRecords = dmarcRaw
      .split(/[\r\n]+/)
      .map((r) => r.trim())
      .filter((r) => r !== "");
    const versionTokens = countOccurrences(dmarcRaw, /\bv\s*=\s*DMARC1\b/gi);

    if (dmarcRecords.length > 1 || versionTokens > 1) {
      findings.push({
        id: "dns-dmarc-multiple",
        category: "email-dns",
        severity: "critical",
        title: `More than one DMARC record is published at _dmarc.${domain}`,
        detail: `${pluralise(Math.max(dmarcRecords.length, versionTokens), "record")} starting with \`v=DMARC1\` were returned. RFC 7489 requires exactly one: when a receiver finds several it discards all of them and applies no policy. Whatever enforcement you believe is in place is not being applied, and - like the duplicate-SPF case - each record looks perfectly valid on its own.`,
        fix: "Delete every copy but one. Merge the tags you need (policy, rua, sp, pct) into that single record. Duplicates usually appear when a second tool or a migration adds its own record beside the existing one.",
        snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@${domain}; sp=reject"`,
        value: truncate(dmarcRaw, 300),
        docs: RFC_DMARC,
        weight: 4,
      });
    }

    const dmarcRecord = dmarcRecords[0] ?? dmarcRaw.trim();
    const dmarc = parseDmarc(dmarcRecord);
    const policy = (dmarc.tags.get("p") ?? "").toLowerCase();
    const validPolicy = policy === "none" || policy === "quarantine" || policy === "reject";

    if (!dmarc.valid || !validPolicy || dmarc.malformed.length > 0) {
      const reasons: string[] = [];
      if (!dmarc.valid) reasons.push("the record does not open with the required `v=DMARC1` tag");
      if (policy === "") reasons.push("the mandatory `p=` policy tag is missing");
      else if (!validPolicy) reasons.push(`\`p=${policy}\` is not one of none, quarantine or reject`);
      if (dmarc.malformed.length > 0) reasons.push(`${listOf(dmarc.malformed, 4)} could not be read as \`tag=value\` pairs`);

      findings.push({
        id: "dns-dmarc-malformed",
        category: "email-dns",
        severity: "critical",
        title: "DMARC record is malformed and will be ignored",
        detail: `"${truncate(dmarcRecord, 200)}" - ${reasons.join("; ")}. DMARC parsing is unforgiving by design: a record that does not begin with \`v=DMARC1\` followed by a valid \`p=\` is discarded whole, and the domain is treated as having no DMARC policy at all. The record's presence provides a false sense of coverage while receivers apply nothing.`,
        fix: `Rewrite the record: \`v=DMARC1\` must come first, \`p=\` must be one of none, quarantine or reject, tags are separated by semicolons, and the whole thing is a single quoted TXT string at \`_dmarc.${domain}\`.`,
        snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@${domain}"`,
        value: truncate(dmarcRecord, 300),
        docs: RFC_DMARC,
        weight: 4,
      });
    } else {
      const rua = dmarc.tags.get("rua") ?? null;
      const pctRaw = dmarc.tags.get("pct") ?? null;
      const pct = pctRaw === null ? 100 : Number.parseInt(pctRaw, 10);
      const sp = (dmarc.tags.get("sp") ?? "").toLowerCase();
      const adkim = (dmarc.tags.get("adkim") ?? "r").toLowerCase();
      const aspf = (dmarc.tags.get("aspf") ?? "r").toLowerCase();

      if (policy === "none") {
        findings.push({
          id: "dns-dmarc-policy-none",
          category: "email-dns",
          severity: "warning",
          title: "DMARC policy is `p=none` - monitoring only, nothing is enforced",
          detail: `"${truncate(dmarcRecord, 200)}". \`p=none\` asks receivers to report on authentication results and to change nothing else. Mail that fails SPF and DKIM in your name is delivered to the inbox exactly as before. This is the correct place to *start* and the most common place for a domain to stop: the record exists, dashboards show DMARC "configured", and the spoofing protection people believe they bought was never switched on.${rua === null ? " With no `rua=` address either, the monitoring half is not happening either." : ""}`,
          fix: "Work through the aggregate reports until every legitimate sending stream shows SPF or DKIM aligned. Then move to `p=quarantine`, optionally with `pct=` to ramp, and finally to `p=reject`. Most domains can complete this in a month.",
          snippet: [
            `; ramp gradually`,
            `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@${domain}"`,
            `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${domain}"`,
            `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@${domain}; sp=reject"`,
          ].join("\n"),
          value: dmarcRecord,
          docs: RFC_DMARC,
          weight: 3,
        });
      } else if (policy === "quarantine") {
        findings.push({
          id: "dns-dmarc-policy-quarantine",
          category: "email-dns",
          severity: "info",
          title: "DMARC policy is `p=quarantine` - partway to enforcement",
          detail: `"${truncate(dmarcRecord, 200)}". Mail that fails DMARC is asked to be treated as suspicious, which in practice means the spam folder rather than the inbox. That is real protection and a sensible staging point, but a message in the spam folder has still been delivered, and a recipient who goes looking can still find and act on it. \`p=reject\` is the position where a spoofed message never reaches the mailbox at all.`,
          fix: "Watch the aggregate reports for a few more weeks. If nothing legitimate is being quarantined, move to `p=reject`.",
          snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@${domain}; sp=reject"`,
          value: dmarcRecord,
          docs: RFC_DMARC,
          weight: 2,
        });
      } else {
        findings.push({
          id: "dns-dmarc-policy-reject",
          category: "email-dns",
          severity: "pass",
          title: "DMARC policy is `p=reject` - spoofed mail is refused",
          detail: `"${truncate(dmarcRecord, 200)}". Receivers are instructed to refuse mail that claims to be from ${domain} and fails to authenticate with an aligned SPF or DKIM result. This is the end state of a DMARC rollout: a message forging your domain in the From address does not reach the recipient at all, spam folder included.`,
          value: dmarcRecord,
          weight: 4,
        });
      }

      if (rua === null) {
        findings.push({
          id: "dns-dmarc-rua-missing",
          category: "email-dns",
          severity: "warning",
          title: "DMARC has no `rua=` aggregate report address",
          detail: `"${truncate(dmarcRecord, 200)}" sets a policy but nominates nowhere to send aggregate reports. Those daily XML summaries are the only visibility you get into who is sending mail as your domain and whether it authenticates - including the systems inside your own organisation that nobody remembered. Without them you cannot safely tighten the policy${policy === "reject" ? ", and you will not find out that a legitimate sender has started being rejected until someone complains" : ", because you have no way to know which legitimate senders would break"}.`,
          fix: "Add a `rua=mailto:` address. Point it at a mailbox you actually read, or at a DMARC reporting service that renders the XML - the raw format is not meant for humans. If the address is at another domain, that domain must publish an authorisation record.",
          snippet: [
            `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}"`,
            "",
            "; if reports go to a mailbox on another domain, that domain must",
            "; authorise it, or receivers will refuse to send them:",
            `;   ${domain}._report._dmarc.reports.example.  IN  TXT  "v=DMARC1"`,
          ].join("\n"),
          value: dmarcRecord,
          docs: RFC_DMARC,
          weight: 2,
        });
      }

      if (pctRaw !== null && Number.isFinite(pct) && pct < 100) {
        findings.push({
          id: "dns-dmarc-pct-partial",
          category: "email-dns",
          severity: "info",
          title: `DMARC applies its policy to only ${pct}% of failing mail`,
          detail: `\`pct=${pctRaw}\` means receivers apply \`p=${policy}\` to roughly ${pct}% of the messages that fail DMARC and fall back to the next weaker treatment for the rest. That is the intended way to ramp a policy without a cliff edge. It is also easy to leave behind after the ramp is over, at which point ${100 - pct}% of spoofed mail is still being handled as though your policy were weaker than it reads.`,
          fix: `If the ramp is finished, remove the pct= tag (100 is the default) or set it explicitly to 100.`,
          snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=${policy}; rua=mailto:dmarc@${domain}"`,
          value: `pct=${pctRaw}`,
          docs: RFC_DMARC,
          weight: 2,
        });
      }

      if (policy === "reject" && sp === "") {
        findings.push({
          id: "dns-dmarc-subdomain-policy-missing",
          category: "email-dns",
          severity: "info",
          title: "No explicit `sp=` subdomain policy alongside `p=reject`",
          detail: `The record enforces \`p=reject\` for ${domain} but does not state a subdomain policy. By default subdomains inherit the organisational policy, so the practical effect today is that they are also rejected - the reason to state it anyway is that inheritance is silent and easy to break: a subdomain that later publishes its own weaker DMARC record overrides the parent, and \`mail.${domain}\` or \`billing.${domain}\` is exactly the shape a phisher wants. Being explicit records the intent where the next person will see it.`,
          fix: "Add `sp=reject` for the strictest posture. If a subdomain legitimately needs a weaker policy while it is being onboarded, give that subdomain its own record rather than loosening the parent.",
          snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@${domain}"`,
          value: dmarcRecord,
          docs: RFC_DMARC,
          weight: 1,
        });
      }

      if (adkim === "s" || aspf === "s") {
        const strict: string[] = [];
        if (aspf === "s") strict.push("`aspf=s` (SPF)");
        if (adkim === "s") strict.push("`adkim=s` (DKIM)");
        findings.push({
          id: "dns-dmarc-alignment-strict",
          category: "email-dns",
          severity: "info",
          title: `DMARC uses strict alignment for ${strict.join(" and ")}`,
          detail: `Strict alignment requires an exact match between the visible From domain and the authenticated domain - ${domain} and ${domain}, not \`mail.${domain}\`. It is the tighter setting and it is the right one when you know every sender, but it is also the usual cause of a legitimate stream suddenly failing DMARC: a transactional provider that signs as a subdomain, or bounces routed through \`bounces.${domain}\`, aligns under relaxed and fails under strict.`,
          fix: "Keep strict alignment if the aggregate reports show every legitimate stream passing. If a provider signs from a subdomain you control, relaxed alignment (`aspf=r`, `adkim=r`, the defaults) is a reasonable and still-secure choice.",
          snippet: `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=${policy}; adkim=${adkim}; aspf=${aspf}; rua=mailto:dmarc@${domain}"`,
          value: `adkim=${adkim}; aspf=${aspf}`,
          docs: RFC_DMARC,
          weight: 1,
        });
      }

    }
  }

  /* ---------------------------------------------------------------------- */
  /* 4. DKIM - necessarily partial evidence                                  */
  /* ---------------------------------------------------------------------- */

  const tested = dns.dkimTested;
  const found = dns.dkimFound;

  if (found.length > 0) {
    findings.push({
      id: "dns-dkim-found",
      category: "email-dns",
      severity: "pass",
      title: `DKIM keys published on ${pluralise(found.length, "selector")}`,
      detail: `Public keys were returned for ${listOf(found)} at \`<selector>._domainkey.${domain}\`. DKIM lets a receiver verify cryptographically that a message really was signed by this domain and was not altered in transit, and - unlike SPF - the signature survives forwarding and mailing lists, which is what makes it the more durable half of a DMARC setup.`,
      value: found.map((s) => `${s}._domainkey.${domain}`).join(", "),
      weight: 3,
    });
  } else {
    findings.push({
      id: "dns-dkim-none",
      category: "email-dns",
      severity: "info",
      title: "No DKIM key found on the selectors this scan probed - inconclusive",
      detail: `${tested.length > 0 ? `The selectors tried were ${listOf(tested, 12)}, and none of them returned a key at \`<selector>._domainkey.${domain}\`.` : "No DKIM selectors were probed for this domain."} This is genuinely inconclusive and should not be read as "the domain has no DKIM". A DKIM selector is an arbitrary label chosen by whoever set up signing - providers use anything from \`s1\` to \`k1\` to a per-key hash - and there is no way to enumerate the selectors a domain uses from DNS, because \`_domainkey\` cannot be listed. A scan can only guess common names. ${domain} may well be signing every message with a selector this tool never tried.`,
      fix: "Confirm it directly rather than from this result: open the raw headers of a message you have sent and look for the `DKIM-Signature` header - the `d=` tag is the signing domain and `s=` is the selector. If there is no such header, enable DKIM signing in your mail platform; it is a checkbox plus a published key in every major provider.",
      snippet: [
        "; find your real selector in the headers of a message you have sent:",
        `;   DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=selector1; ...`,
        "",
        "; then confirm that selector's key is published:",
        `dig +short TXT selector1._domainkey.${domain}`,
      ].join("\n"),
      value: tested.length > 0 ? `tested: ${tested.join(", ")}` : undefined,
      docs: RFC_DKIM,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. MX and overall mail posture                                          */
  /* ---------------------------------------------------------------------- */

  if (mailActive) {
    findings.push({
      id: "dns-mx-hosts",
      category: "email-dns",
      severity: "info",
      title: mailProvider === null
        ? `${pluralise(mxHosts.length, "MX record")} published`
        : `Mail is handled by ${mailProvider.label}`,
      detail: `${domain} accepts mail at ${listOf(mxHosts)}.${mailProvider === null ? " The hosts do not match a provider this tool recognises, so the records are reported as-is." : ` ${mailProvider.hint}`} This is reported so you know where to make the SPF, DKIM and DMARC changes above - the records live in DNS, but the keys and the sending permissions are configured in the mail platform.`,
      value: dns.mx.join(", "),
      docs: RFC_SPF,
      weight: 1,
    });
  } else if (hasNullMx) {
    findings.push({
      id: "dns-mx-null-declared",
      category: "email-dns",
      severity: "pass",
      title: "Domain declares a null MX - it explicitly accepts no mail",
      detail: `An MX record pointing at \`.\` is the RFC 7505 null MX: a positive statement that ${domain} receives no mail at all. Sending systems get an immediate, unambiguous rejection instead of waiting on a timeout or falling back to the A record, which is both faster for them and cleaner than simply having no MX record.`,
      value: dns.mx.join(", "),
      weight: 1,
    });
  } else {
    findings.push({
      id: "dns-mx-none",
      category: "email-dns",
      severity: "info",
      title: "No MX records - the domain does not receive mail",
      detail: `No MX records are published for ${domain}, so it accepts no inbound mail. That is perfectly normal for a domain used only for a website. The part worth knowing is that it does nothing to stop mail being *sent* in your name: spoofing needs no cooperation from the domain being spoofed, and a domain with no mail service and no published policy is a preferred target precisely because nobody is watching the bounces.`,
      fix: "Publish the no-mail posture explicitly: a null MX so senders fail fast, an SPF record that authorises nobody, and a DMARC record at reject. Three records, no ongoing maintenance, and forged mail from this domain stops being deliverable.",
      snippet: [
        `${zoneName(domain)}         IN  MX   0 .`,
        `${zoneName(domain)}         IN  TXT  "v=spf1 -all"`,
        `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@${domain}"`,
      ].join("\n"),
      docs: RFC_NULL_MX,
      weight: 1,
    });
  }

  if (!mailActive) {
    const spfLocked = spfRaw !== null && /(^|\s)-all\s*$/i.test(spfRaw.trim());
    const dmarcLocked = dmarcRaw !== null && /\bp\s*=\s*reject\b/i.test(dmarcRaw);

    if (spfLocked && dmarcLocked) {
      findings.push({
        id: "dns-no-mail-lockdown",
        category: "email-dns",
        severity: "pass",
        title: "Non-sending domain is locked down against spoofing",
        detail: `${domain} sends no mail and says so in both places that matter: SPF terminates in \`-all\` so no host is authorised, and DMARC is at \`p=reject\` so receivers refuse anything that claims to be from it. This is the complete posture for a website-only domain, and it is the configuration most such domains never get around to.`,
        value: `SPF: ${truncate(spfRaw ?? "", 80)} | DMARC: ${truncate(dmarcRaw ?? "", 80)}`,
        weight: 2,
      });
    } else {
      const gaps: string[] = [];
      if (!spfLocked) gaps.push(spfRaw === null ? "there is no SPF record at all" : "the SPF record does not end in `-all`");
      if (!dmarcLocked) gaps.push(dmarcRaw === null ? "there is no DMARC record" : "the DMARC policy is not `p=reject`");

      findings.push({
        id: "dns-no-mail-spoofable",
        category: "email-dns",
        severity: "warning",
        title: "Domain sends no mail but is not protected from being spoofed",
        detail: `${domain} has no MX records, so it is not in the mail business - yet ${gaps.join(" and ")}. This combination is the easiest spoofing target there is. Nobody at the domain will ever see a bounce or a complaint, there is no legitimate mail stream to break, and an attacker sending invoices or password resets "from" a domain with no policy gets full benefit of your brand at no cost. The fix carries essentially zero risk for exactly the same reason: there is no mail to disrupt.`,
        fix: "Publish the deny-everything posture. Because the domain sends nothing, there is no enumeration work and no ramp - you can go straight to `-all` and `p=reject` without a monitoring period.",
        snippet: [
          `${zoneName(domain)}         IN  TXT  "v=spf1 -all"`,
          `_dmarc.${zoneName(domain)}  IN  TXT  "v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@${domain}"`,
          `${zoneName(domain)}         IN  MX   0 .`,
        ].join("\n"),
        value: `SPF: ${spfRaw === null ? "none" : truncate(spfRaw, 80)} | DMARC: ${dmarcRaw === null ? "none" : truncate(dmarcRaw, 80)}`,
        docs: RFC_DMARC,
        weight: 3,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 6. CAA                                                                  */
  /* ---------------------------------------------------------------------- */

  const caa = parseCaa(dns.caa);

  if (caa.length === 0) {
    findings.push({
      id: "dns-caa-missing",
      category: "email-dns",
      severity: "info",
      title: "No CAA record - any certificate authority may issue for this domain",
      detail: `${domain} publishes no CAA record. Every publicly trusted CA is required to check CAA before issuing, so the record is the one lever you have over *which* of the hundred-odd trusted CAs is allowed to mint a certificate in your name. With no record, all of them are, and a mis-issuance anywhere in that set produces a certificate browsers will trust. CAA does not stop an attacker who controls your DNS - it stops the mis-issuance and social-engineering paths that do not.`,
      fix: "Publish a CAA record naming only the CAs you actually use, and add an `iodef` address so a CA that receives a request violating the policy can tell you about it.",
      snippet: [
        `${zoneName(domain)}  IN  CAA  0 issue "letsencrypt.org"`,
        `${zoneName(domain)}  IN  CAA  0 issuewild ";"`,
        `${zoneName(domain)}  IN  CAA  0 iodef "mailto:security@${domain}"`,
        "",
        "; common issuer identifiers:",
        ";   letsencrypt.org   digicert.com   sectigo.com   globalsign.com",
        ";   amazon.com (ACM)   pki.goog (Google Trust Services)",
      ].join("\n"),
      docs: RFC_CAA,
      weight: 1,
    });
  } else {
    const issuers = caa.filter((e) => e.tag === "issue" || e.tag === "issuewild");
    const iodef = caa.filter((e) => e.tag === "iodef");
    const authorised = issuers.map((e) => (e.value === ";" || e.value === "" ? "none (issuance forbidden)" : e.value));

    findings.push({
      id: "dns-caa-present",
      category: "email-dns",
      severity: "pass",
      title: `CAA restricts certificate issuance to ${listOf(Array.from(new Set(authorised)), 6)}`,
      detail: `${pluralise(caa.length, "CAA record")} published for ${domain}. Publicly trusted CAs must consult this before issuing, so any CA not named here is required to refuse a certificate request for this domain - which closes the mis-issuance route that a domain with no CAA leaves open to every CA on earth.${iodef.length > 0 ? ` Violation reports are directed to ${listOf(iodef.map((e) => e.value))}, so an attempted issuance that breaches the policy should reach you.` : ""}`,
      value: dns.caa.join(" | "),
      weight: 2,
    });

    if (iodef.length === 0) {
      findings.push({
        id: "dns-caa-iodef-missing",
        category: "email-dns",
        severity: "info",
        title: "CAA names issuers but has no `iodef` reporting address",
        detail: `The policy restricts who may issue, but nothing tells you when someone tries and is refused. An \`iodef\` property gives a CA somewhere to report a request that violated the policy - which is a low-noise, high-signal alert, since a legitimate request should never trigger one.`,
        fix: "Add an iodef property pointing at a monitored security address or an incident-reporting URL.",
        snippet: `${zoneName(domain)}  IN  CAA  0 iodef "mailto:security@${domain}"`,
        value: dns.caa.join(" | "),
        docs: RFC_CAA,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Nameservers                                                          */
  /* ---------------------------------------------------------------------- */

  const nameservers = dns.ns.map(normaliseHost).filter((h) => h !== "");

  if (nameservers.length === 0) {
    findings.push({
      id: "dns-ns-unavailable",
      category: "email-dns",
      severity: "info",
      title: "Nameserver records were not returned",
      detail: `No NS records came back for ${domain}. A domain that resolves at all must be delegated to nameservers, so this almost certainly means the NS query itself failed or was filtered rather than that the delegation is missing. Nothing about the domain's DNS resilience was measured.`,
      fix: `Check the delegation directly with \`dig NS ${domain}\` and, from the parent side, \`dig +trace ${domain}\`.`,
      snippet: `dig +short NS ${domain}`,
      docs: DNSSEC_ANALYZER,
      weight: 1,
    });
  } else {
    const providers = Array.from(new Set(nameservers.map(nameserverProvider)));

    findings.push({
      id: "dns-ns-list",
      category: "email-dns",
      severity: "info",
      title: `${domain} is delegated to ${pluralise(nameservers.length, "nameserver")}`,
      detail: `Authoritative nameservers: ${listOf(nameservers)}.${providers.length === 1 ? ` All of them are operated by ${providers[0]}.` : ` They span ${listOf(providers, 6)}.`} Everything in this section - SPF, DKIM, DMARC, CAA - is published here, so this is where the changes get made and whoever controls these nameservers controls the domain's mail authentication.`,
      value: nameservers.join(", "),
      weight: 1,
    });

    if (nameservers.length < 2) {
      findings.push({
        id: "dns-ns-insufficient",
        category: "email-dns",
        severity: "warning",
        title: `Only ${pluralise(nameservers.length, "nameserver")} is delegated`,
        detail: `The delegation lists ${listOf(nameservers)} and nothing else. RFC 1034 has expected at least two authoritative nameservers since 1987, and most registries require it, for the plain reason that a single one is a single point of failure: if it is unreachable, the domain does not resolve - the website, the mail, the certificate renewals, everything - and resolvers have nowhere else to ask.`,
        fix: "Add at least one more nameserver, ideally on separate infrastructure. Every managed DNS provider assigns several by default; a single NS usually means self-hosted DNS or a partly completed migration.",
        snippet: [
          `${zoneName(domain)}  IN  NS  ns1.provider.example.`,
          `${zoneName(domain)}  IN  NS  ns2.provider.example.`,
        ].join("\n"),
        value: nameservers.join(", "),
        docs: "https://www.rfc-editor.org/rfc/rfc1034",
        weight: 2,
      });
    } else if (providers.length === 1) {
      findings.push({
        id: "dns-ns-single-provider",
        category: "email-dns",
        severity: "info",
        title: `All ${nameservers.length} nameservers are operated by ${providers[0]}`,
        detail: `${listOf(nameservers)} all belong to a single operator. Several nameservers on one provider give you redundancy against a single machine failing, but not against that provider having a bad day - and when a managed DNS provider goes down, every domain on it goes down together, website and mail alike. This is a normal and widely accepted trade-off rather than a fault; it is worth knowing about in proportion to how much depends on the domain resolving.${providers[0] === "Amazon Route 53" || providers[0] === "Azure DNS" ? " (The nameservers are spread across several TLDs, which protects against one TLD's infrastructure failing, but they remain one operator.)" : ""}`,
        fix: "If the domain carries revenue or critical mail, consider secondary DNS with a second provider so the zone stays resolvable through a provider-level outage. For most sites, one good managed provider is a reasonable choice.",
        value: nameservers.join(", "),
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 8. DNSSEC - deferred to the registry when RDAP answered                 */
  /* ---------------------------------------------------------------------- */

  /*
   * The DNS layer genuinely cannot answer this: Node's stub resolver never
   * exposes the Authenticated Data bit, and this scan does no DNSKEY/DS/RRSIG
   * walk from the root. RDAP can - `secureDNS.delegationSigned` is the registry's
   * own record of whether a DS exists in the parent zone - so when the RDAP
   * lookup returned a verdict, the domain category reports it properly and this
   * finding stays out of the way rather than contradicting it with an "unknown".
   * It survives only for the cases RDAP could not cover.
   */
  if (typeof ctx.rdap?.dnssecSigned !== "boolean") {
    findings.push({
      id: "dns-dnssec-not-evaluated",
      category: "email-dns",
      severity: "info",
      title: "DNSSEC could not be determined",
      detail: `No DNSSEC verdict is reported for ${domain}, in either direction. The DNS layer cannot supply one: deciding whether a zone is signed and validating needs a resolver that returns the Authenticated Data bit, or a direct DNSKEY/DS/RRSIG walk from the root, and this scan performs neither. The registry can answer it authoritatively, so the lookup was attempted over RDAP - and came back without an answer, because ${ctx.rdap === null ? "no RDAP response was obtained for this domain at all (a fair number of ccTLDs run no RDAP service)" : "the registry's response omitted the optional `secureDNS` member"}. Read this as "unknown", not as "unsigned" and not as "signed". For context on why it matters: DNSSEC signs the answers a resolver receives, which is what stops a forged DNS response from redirecting your mail or your visitors, and it is the foundation the DANE/TLSA records used for mail transport security are built on.`,
      fix: "Check it with a validator that does the full chain walk - DNSViz or Verisign's DNSSEC Analyzer will show whether the zone is signed and whether the DS record at the parent matches. `dig +short DS` against the parent is the quick version. Most managed DNS providers now enable DNSSEC with one switch, but the DS record must also be published at your registrar or the signing has no effect.",
      snippet: [
        `# is the zone signed?`,
        `dig +dnssec +short DNSKEY ${domain}`,
        `# is the delegation signed at the parent?`,
        `dig +short DS ${domain}`,
        `# full chain analysis:  ${DNSSEC_ANALYZER}${domain}`,
      ].join("\n"),
      docs: DNSSEC_ANALYZER,
      weight: 1,
    });
  }

  return findings;
}
