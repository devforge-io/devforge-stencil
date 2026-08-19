/**
 * Audit orchestrator.
 *
 * Fetches the target page, runs every check module against the resulting
 * `PageContext`, scores the findings, and folds everything into a serialisable
 * `AuditReport`.
 */

import {
  CATEGORY_META,
  CATEGORY_ORDER,
  type AuditReport,
  type AuditResult,
  type CategoryId,
  type CategoryResult,
  type CheckFn,
  type Finding,
  type Grade,
  type PageContext,
  type PagePreview,
  type Severity,
  type SeverityCounts,
} from "~/lib/audit/types";
import { fetchPageContext, normaliseUrl } from "~/lib/audit/fetch.server";
import { metaChecks } from "~/lib/audit/checks/meta.server";
import { opengraphChecks } from "~/lib/audit/checks/opengraph.server";
import { structuredDataChecks } from "~/lib/audit/checks/structured-data.server";
import { seoChecks } from "~/lib/audit/checks/seo.server";
import { accessibilityChecks } from "~/lib/audit/checks/accessibility.server";
import { technicalChecks } from "~/lib/audit/checks/technical.server";
import { aiChecks } from "~/lib/audit/checks/ai.server";
import { securityChecks } from "~/lib/audit/checks/security.server";
import { performanceChecks } from "~/lib/audit/checks/performance.server";
import { tlsChecks } from "~/lib/audit/checks/tls.server";
import { exposureChecks } from "~/lib/audit/checks/exposure.server";
import { emailDnsChecks } from "~/lib/audit/checks/email-dns.server";
import { domainChecks } from "~/lib/audit/checks/domain.server";

/** Every check module, in no particular order - findings carry their own category. */
const CHECKS: { name: string; fn: CheckFn }[] = [
  { name: "meta", fn: metaChecks },
  { name: "opengraph", fn: opengraphChecks },
  { name: "structured-data", fn: structuredDataChecks },
  { name: "seo", fn: seoChecks },
  { name: "accessibility", fn: accessibilityChecks },
  { name: "technical", fn: technicalChecks },
  { name: "ai", fn: aiChecks },
  { name: "security", fn: securityChecks },
  { name: "performance", fn: performanceChecks },
  { name: "tls", fn: tlsChecks },
  { name: "exposure", fn: exposureChecks },
  { name: "email-dns", fn: emailDnsChecks },
  { name: "domain", fn: domainChecks },
];

/**
 * How much credit a finding earns toward its category score.
 *
 * Credit-based rather than penalty-based so that categories with wildly
 * different check counts stay comparable: a category is scored on the weighted
 * share of its checks that passed, not on an arbitrary running deduction.
 * Severity of an individual issue is expressed through `Finding.weight`.
 */
const CREDIT: Record<Severity, number> = {
  pass: 1,
  info: 0.9,
  warning: 0.4,
  critical: 0,
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  pass: 3,
};

export async function runAudit(rawUrl: string): Promise<AuditResult> {
  const normalised = normaliseUrl(rawUrl);
  if (!normalised) {
    return {
      ok: false,
      code: "invalid-url",
      message: "That doesn't look like a valid web address. Try something like example.com.",
    };
  }

  const fetched = await fetchPageContext(normalised);
  if (!fetched.ok) return fetched;

  return { ok: true, report: buildReport(fetched.ctx) };
}

function buildReport(ctx: PageContext): AuditReport {
  const findings = collectFindings(ctx);
  const categories = buildCategories(findings);

  return {
    requestedUrl: ctx.requestedUrl,
    finalUrl: ctx.finalUrl,
    finalStatus: ctx.finalStatus,
    fetchedAt: new Date().toISOString(),
    score: overallScore(categories),
    grade: toGrade(overallScore(categories)),
    categories,
    counts: countSeverities(findings),
    preview: buildPreview(ctx),
    redirects: ctx.redirects,
    timings: ctx.timings,
    stats: {
      htmlBytes: ctx.bytes,
      wordCount: ctx.doc.wordCount,
      imageCount: ctx.doc.images.length,
      linkCount: ctx.doc.anchors.length,
      scriptCount: ctx.doc.scripts.length,
      textToHtmlRatio: ctx.doc.textToHtmlRatio,
    },
  };
}

/**
 * Runs every check, isolating failures. A single check module throwing on
 * unusual markup must not cost the user their whole report.
 */
function collectFindings(ctx: PageContext): Finding[] {
  const all: Finding[] = [];
  const seen = new Set<string>();

  for (const { name, fn } of CHECKS) {
    let produced: Finding[] = [];
    try {
      produced = fn(ctx) ?? [];
    } catch (error) {
      console.error(`[audit] check module "${name}" threw:`, error);
      continue;
    }

    for (const finding of produced) {
      // Ids are meant to be globally unique; de-duplicate defensively so a
      // collision between modules can't render the same issue twice.
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      all.push(finding);
    }
  }

  return all;
}

function buildCategories(findings: Finding[]): CategoryResult[] {
  return CATEGORY_ORDER.map((id) => {
    const own = findings
      .filter((f) => f.category === id)
      .sort(bySeverityThenWeight);

    const meta = CATEGORY_META[id];

    return {
      id,
      label: meta.label,
      blurb: meta.blurb,
      score: categoryScore(own),
      weight: meta.weight,
      findings: own,
      counts: countSeverities(own),
    };
  });
}

function bySeverityThenWeight(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return (b.weight ?? 1) - (a.weight ?? 1);
}

/** Weighted share of a category's checks that passed, 0–100. */
function categoryScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  let earned = 0;
  let possible = 0;

  for (const finding of findings) {
    const weight = finding.weight ?? 1;
    earned += weight * CREDIT[finding.severity];
    possible += weight;
  }

  if (possible === 0) return 100;
  return clampScore(Math.round((earned / possible) * 100));
}

function overallScore(categories: CategoryResult[]): number {
  // Categories that produced no findings are excluded rather than counted as
  // a free 100 - otherwise a site we couldn't analyse deeply scores well by
  // virtue of having been analysed shallowly.
  const scored = categories.filter((c) => c.findings.length > 0);
  if (scored.length === 0) return 0;

  let earned = 0;
  let possible = 0;
  for (const category of scored) {
    earned += category.score * category.weight;
    possible += category.weight;
  }

  return clampScore(Math.round(earned / possible));
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function toGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function countSeverities(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0, pass: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function buildPreview(ctx: PageContext): PagePreview {
  const { doc } = ctx;
  const prop = (key: string) => doc.metaByProperty[key] ?? null;
  // Twitter tags are conventionally `name=` but plenty of sites use `property=`.
  const named = (key: string) => doc.metaByName[key] ?? doc.metaByProperty[key] ?? null;

  const iconRels = new Set(["icon", "shortcut icon", "apple-touch-icon"]);
  const iconHref =
    doc.links.find((link) => iconRels.has(link.rel.toLowerCase()))?.href ?? null;

  let displayUrl = ctx.finalUrl;
  try {
    const url = new URL(ctx.finalUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    displayUrl = [url.host, ...segments].join(" › ");
  } catch {
    // Keep the raw URL when it somehow doesn't parse.
  }

  return {
    title: doc.title,
    description: doc.metaByName.description ?? null,
    ogTitle: prop("og:title"),
    ogDescription: prop("og:description"),
    ogImage: absolutise(prop("og:image"), ctx.finalUrl),
    twitterCard: named("twitter:card"),
    twitterImage: absolutise(named("twitter:image"), ctx.finalUrl),
    siteName: prop("og:site_name"),
    favicon: absolutise(iconHref, ctx.finalUrl),
    displayUrl,
  };
}

function absolutise(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}
