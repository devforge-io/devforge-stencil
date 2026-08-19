/**
 * AI readiness checks.
 *
 * "AI readiness" asks a single question: if an LLM crawler, an AI search engine
 * or an autonomous agent arrives at this URL, can it (a) fetch the page at all,
 * (b) understand what is on it without executing JavaScript, and (c) cite it
 * back to a user with the right URL, the right title and the right date?
 *
 * Blocking AI crawlers is a legitimate editorial choice, so access findings are
 * framed neutrally: a deliberate-looking opt-out is reported as `info` with the
 * trade-off spelled out, and only patterns that look accidental are escalated.
 */

import type {
  Finding,
  PageContext,
  RobotsGroup,
  RobotsResource,
} from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Bot registry                                                                */
/* -------------------------------------------------------------------------- */

type BotPurpose = "training" | "search" | "user-fetch" | "mixed";

interface AiBot {
  /** Canonical casing, as published by the vendor. */
  token: string;
  purpose: BotPurpose;
  /** What this specific agent does, in one clause. */
  role: string;
}

interface BotVendor {
  /** Suffix of the finding id, e.g. "openai" -> "ai-crawler-openai". */
  key: string;
  label: string;
  /** What the user loses if every bot here is blocked. */
  stake: string;
  docs: string;
  bots: AiBot[];
}

const VENDORS: BotVendor[] = [
  {
    key: "openai",
    label: "OpenAI (ChatGPT)",
    stake: "ChatGPT cannot browse, index or cite your pages",
    docs: "https://platform.openai.com/docs/bots",
    bots: [
      { token: "GPTBot", purpose: "training", role: "crawls pages that may be used to train future models" },
      { token: "OAI-SearchBot", purpose: "search", role: "builds the ChatGPT search index used to surface and link your site" },
      { token: "ChatGPT-User", purpose: "user-fetch", role: "fetches a page live when a ChatGPT user asks about it" },
    ],
  },
  {
    key: "anthropic",
    label: "Anthropic (Claude)",
    stake: "Claude cannot read or cite your pages",
    docs: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview",
    bots: [
      { token: "ClaudeBot", purpose: "training", role: "general crawler for Anthropic" },
      { token: "Claude-User", purpose: "user-fetch", role: "fetches a page live when a Claude user shares or asks about the URL" },
      { token: "Claude-SearchBot", purpose: "search", role: "indexes pages so Claude can find and cite them in answers" },
      { token: "anthropic-ai", purpose: "mixed", role: "legacy Anthropic user-agent still seen in the wild" },
    ],
  },
  {
    key: "perplexity",
    label: "Perplexity",
    stake: "Perplexity answers will not link to you",
    docs: "https://docs.perplexity.ai/guides/bots",
    bots: [
      { token: "PerplexityBot", purpose: "search", role: "builds the Perplexity answer index" },
      { token: "Perplexity-User", purpose: "user-fetch", role: "fetches a page live in response to a user question" },
    ],
  },
  {
    key: "google",
    label: "Google (Gemini & AI Overviews)",
    stake: "your content is excluded from Gemini grounding and Vertex AI training",
    docs: "https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers",
    bots: [
      {
        token: "Google-Extended",
        purpose: "mixed",
        role: "opt-out token for Gemini grounding and Vertex AI training - it does not affect normal Google Search ranking",
      },
    ],
  },
  {
    key: "apple",
    label: "Apple Intelligence",
    stake: "Apple Intelligence and Siri summaries will skip your content",
    docs: "https://support.apple.com/en-us/119829",
    bots: [
      {
        token: "Applebot-Extended",
        purpose: "training",
        role: "opt-out token for Apple foundation-model training - normal Applebot indexing for Siri and Spotlight is unaffected",
      },
    ],
  },
  {
    key: "microsoft",
    label: "Microsoft (Bing & Copilot)",
    stake: "Bing and Microsoft Copilot lose their source for your site",
    docs: "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0",
    bots: [
      { token: "Bingbot", purpose: "search", role: "powers Bing search and, through it, Microsoft Copilot answers" },
      { token: "msnbot", purpose: "search", role: "legacy Bing user-agent" },
    ],
  },
  {
    key: "commoncrawl",
    label: "Common Crawl",
    stake: "you drop out of the open web corpus that most open models are trained on",
    docs: "https://commoncrawl.org/ccbot",
    bots: [
      {
        token: "CCBot",
        purpose: "training",
        role: "Common Crawl - the shared open dataset behind a large share of all LLM training corpora",
      },
    ],
  },
  {
    key: "other",
    label: "Other AI crawlers",
    stake: "these assistants and datasets will not see your site",
    docs: "https://darkvisitors.com/agents",
    bots: [
      { token: "Meta-ExternalAgent", purpose: "training", role: "Meta AI training and product crawler" },
      { token: "Bytespider", purpose: "training", role: "ByteDance / Doubao crawler" },
      { token: "Amazonbot", purpose: "mixed", role: "Amazon crawler feeding Alexa and Rufus" },
      { token: "cohere-ai", purpose: "mixed", role: "Cohere retrieval and training crawler" },
      { token: "Diffbot", purpose: "training", role: "knowledge-graph extraction service resold to AI products" },
      { token: "Timpibot", purpose: "training", role: "Timpi decentralised index" },
      { token: "YouBot", purpose: "search", role: "You.com answer engine" },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* robots.txt evaluation                                                       */
/* -------------------------------------------------------------------------- */

type AccessStatus = "allowed" | "blocked";

interface BotVerdict {
  bot: AiBot;
  status: AccessStatus;
  /** The rule line that decided it, e.g. "Disallow: /". */
  rule: string | null;
  /** The user-agent group that applied, e.g. "gptbot" or "*". */
  matchedAgent: string | null;
  /** True when only the catch-all `*` group applied. */
  viaWildcard: boolean;
  /** True when the blocking rule is a whole-site `Disallow: /`. */
  blanket: boolean;
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Robots path matching per RFC 9309: `*` is a wildcard, a trailing `$` anchors
 * the end, everything else is a literal prefix match.
 */
function ruleMatches(rule: string, path: string): boolean {
  const trimmed = rule.trim();
  if (trimmed === "") return false;
  const anchored = trimmed.endsWith("$");
  const body = anchored ? trimmed.slice(0, -1) : trimmed;
  const pattern = body.split("*").map(escapeRe).join(".*");
  const re = new RegExp(`^${pattern}${anchored ? "$" : ""}`);
  return re.test(path);
}

/** Length of a rule ignoring wildcards, used for longest-match precedence. */
function ruleSpecificity(rule: string): number {
  return rule.trim().replace(/\$$/, "").length;
}

/**
 * Pick the group that applies to `token`, mirroring how real crawlers resolve
 * groups: exact user-agent match wins, then a prefix match such as `googlebot`
 * for `googlebot-news`, then the catch-all `*`.
 */
function selectGroup(
  groups: RobotsGroup[],
  token: string,
): { group: RobotsGroup; agent: string; viaWildcard: boolean } | null {
  const lower = token.toLowerCase();
  let prefixHit: { group: RobotsGroup; agent: string } | null = null;
  let wildcard: { group: RobotsGroup; agent: string } | null = null;

  for (const group of groups) {
    for (const ua of group.userAgents) {
      const agent = ua.trim().toLowerCase();
      if (agent === "") continue;
      if (agent === lower) return { group, agent, viaWildcard: false };
      if (agent === "*") {
        if (!wildcard) wildcard = { group, agent };
        continue;
      }
      if (lower.startsWith(`${agent}-`) || lower.startsWith(`${agent}/`)) {
        if (!prefixHit || agent.length > prefixHit.agent.length) {
          prefixHit = { group, agent };
        }
      }
    }
  }

  if (prefixHit) return { ...prefixHit, viaWildcard: false };
  if (wildcard) return { ...wildcard, viaWildcard: true };
  return null;
}

/** Decide whether `token` may fetch `path` given the parsed robots.txt. */
function evaluateBot(
  robots: RobotsResource | null,
  bot: AiBot,
  path: string,
): BotVerdict {
  if (!robots || !robots.ok || robots.status >= 400) {
    return { bot, status: "allowed", rule: null, matchedAgent: null, viaWildcard: false, blanket: false };
  }

  const selected = selectGroup(robots.groups, bot.token);
  if (!selected) {
    return { bot, status: "allowed", rule: null, matchedAgent: null, viaWildcard: false, blanket: false };
  }

  let bestDisallow: string | null = null;
  let bestAllow: string | null = null;

  for (const rule of selected.group.disallow) {
    if (!ruleMatches(rule, path)) continue;
    if (bestDisallow === null || ruleSpecificity(rule) > ruleSpecificity(bestDisallow)) {
      bestDisallow = rule;
    }
  }
  for (const rule of selected.group.allow) {
    if (!ruleMatches(rule, path)) continue;
    if (bestAllow === null || ruleSpecificity(rule) > ruleSpecificity(bestAllow)) {
      bestAllow = rule;
    }
  }

  // Longest match wins; an equally specific Allow beats Disallow.
  const blocked =
    bestDisallow !== null &&
    (bestAllow === null || ruleSpecificity(bestAllow) < ruleSpecificity(bestDisallow));

  return {
    bot,
    status: blocked ? "blocked" : "allowed",
    rule: blocked ? `Disallow: ${bestDisallow}` : bestAllow ? `Allow: ${bestAllow}` : null,
    matchedAgent: selected.agent,
    viaWildcard: selected.viaWildcard,
    blanket: blocked && bestDisallow !== null && bestDisallow.trim() === "/",
  };
}

/* -------------------------------------------------------------------------- */
/* Small parsing helpers                                                       */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten @graph and common nested node references into a single node list. */
function flattenJsonLd(nodes: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const nested = [
    "@graph",
    "mainEntity",
    "mainEntityOfPage",
    "author",
    "publisher",
    "hasPart",
    "itemListElement",
    "about",
    "creator",
  ];

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    out.push(node);
    for (const key of nested) {
      if (key in node) visit(node[key], depth + 1);
    }
  };

  visit(nodes, 0);
  return out;
}

/** Read `@type` as a lowercased list - it may be a string or an array. */
function typesOf(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
  }
  return [];
}

/** Read a string-ish property, following `{ "@value": ... }` and name objects. */
function stringProp(node: Record<string, unknown>, key: string): string | null {
  const raw = node[key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (isRecord(raw)) {
    const value = raw["@value"];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    const name = raw.name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim() !== "") return item.trim();
      if (isRecord(item)) {
        const name = item.name;
        if (typeof name === "string" && name.trim() !== "") return name.trim();
      }
    }
  }
  return null;
}

function countMatches(haystack: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (re.exec(haystack) !== null) {
    count += 1;
    if (count > 100000) break;
  }
  return count;
}

/** Split a comma/space separated directive list into lowercased tokens. */
function directiveTokens(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "");
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function aiChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;
  const html = ctx.html;
  const path = pathOf(ctx.finalUrl);
  const robots = ctx.robots;
  const hasRobots = robots !== null && robots.ok && robots.status < 400;

  const siteTitle = doc.title?.trim() ?? "";
  const description =
    doc.metaByName.description?.trim() ||
    doc.metaByProperty["og:description"]?.trim() ||
    "";

  /* ---------------------------------------------------------------------- */
  /* 1. robots.txt availability                                              */
  /* ---------------------------------------------------------------------- */

  if (!hasRobots) {
    findings.push({
      id: "ai-robots-absent",
      category: "ai",
      severity: "info",
      title: "No robots.txt - every AI crawler is allowed by default",
      detail:
        robots === null
          ? "No robots.txt was found at the site root. Absence means permission: every AI crawler, training bot and answer engine is free to fetch this page. Many site owners do not realise this is the default."
          : `robots.txt returned HTTP ${robots.status}, so crawlers treat the site as fully open. Every AI crawler and training bot may fetch this page.`,
      fix: "If that is what you want, nothing to do - but add a robots.txt anyway so the choice is explicit and so you can point crawlers at your sitemap. If you want to opt specific AI crawlers out, add per-user-agent groups.",
      snippet: [
        "# https://example.com/robots.txt",
        "User-agent: *",
        "Allow: /",
        "",
        "# Opt out of AI training while staying citable in AI search:",
        "# User-agent: GPTBot",
        "# Disallow: /",
        "# User-agent: CCBot",
        "# Disallow: /",
        "",
        `Sitemap: ${ctx.origin}/sitemap.xml`,
      ].join("\n"),
      value: robots === null ? "not found" : `HTTP ${robots.status}`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-robots-present",
      category: "ai",
      severity: "pass",
      title: "robots.txt is published and parseable",
      detail: `robots.txt was fetched from ${robots.url} and parsed into ${pluralise(robots.groups.length, "user-agent group")}. AI crawlers read this file before every fetch, so it is your primary control surface.`,
      value: `${robots.groups.length} groups, ${robots.bytes} bytes`,
      docs: "https://www.rfc-editor.org/rfc/rfc9309.html",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Per-vendor AI crawler access                                         */
  /* ---------------------------------------------------------------------- */

  const allVerdicts: BotVerdict[] = [];

  for (const vendor of VENDORS) {
    const verdicts = vendor.bots.map((bot) => evaluateBot(robots, bot, path));
    allVerdicts.push(...verdicts);

    const blocked = verdicts.filter((v) => v.status === "blocked");
    const allowed = verdicts.filter((v) => v.status === "allowed");
    const id = `ai-crawler-${vendor.key}`;

    if (blocked.length === 0) {
      findings.push({
        id,
        category: "ai",
        severity: "pass",
        title: `${vendor.label}: all ${verdicts.length === 1 ? "crawler traffic" : `${verdicts.length} crawlers`} allowed`,
        detail: `${verdicts.map((v) => v.bot.token).join(", ")} ${verdicts.length === 1 ? "is" : "are"} permitted by robots.txt for ${path}. ${hasRobots ? "No rule blocks them." : "No robots.txt exists, so access is open by default."}`,
        value: verdicts.map((v) => v.bot.token).join(", "),
        docs: vendor.docs,
        weight: vendor.key === "openai" || vendor.key === "anthropic" ? 2 : 1,
      });
      continue;
    }

    // A block written into a bot-specific stanza reads as a deliberate choice.
    // A whole-site `Disallow: /` inherited from the catch-all `*` group does not.
    const namedBlocked = blocked.filter((v) => !v.viaWildcard);
    const blanketBlocked = blocked.filter((v) => v.viaWildcard && v.blanket);
    const pathBlocked = blocked.filter((v) => v.viaWildcard && !v.blanket);
    const deliberate = namedBlocked.length === blocked.length;
    const severity: Finding["severity"] = blanketBlocked.length > 0 ? "warning" : "info";
    const lines = blocked.map(
      (v) => `${v.bot.token} - blocked by "${v.rule}" in the "${v.matchedAgent}" group`,
    );

    const optOutSnippet = [
      "# Opt out of training, stay citable in AI search:",
      ...vendor.bots
        .filter((b) => b.purpose === "search" || b.purpose === "user-fetch")
        .flatMap((b) => [`User-agent: ${b.token}`, "Allow: /", ""]),
      ...vendor.bots
        .filter((b) => b.purpose === "training")
        .flatMap((b) => [`User-agent: ${b.token}`, "Disallow: /", ""]),
    ]
      .join("\n")
      .trim();
    const admitSnippet = vendor.bots
      .flatMap((b) => [`User-agent: ${b.token}`, "Allow: /", ""])
      .join("\n")
      .trim();

    const blockedCount =
      blocked.length === verdicts.length
        ? verdicts.length === 1
          ? "its only crawler"
          : `all ${verdicts.length} crawlers`
        : `${blocked.length} of ${verdicts.length} crawlers`;
    const title = deliberate
      ? `${vendor.label}: ${blockedCount} deliberately blocked`
      : blanketBlocked.length > 0
        ? `${vendor.label}: blocked site-wide by a catch-all rule`
        : `${vendor.label}: blocked from this URL by a catch-all rule`;

    const parts: string[] = [];
    if (namedBlocked.length > 0) {
      parts.push(
        `robots.txt names ${namedBlocked.map((v) => v.bot.token).join(", ")} explicitly, so ${namedBlocked.length === 1 ? "that block looks" : "those blocks look"} intentional.`,
      );
    }
    if (blanketBlocked.length > 0) {
      parts.push(
        `${blanketBlocked.map((v) => v.bot.token).join(", ")} ${blanketBlocked.length === 1 ? "is" : "are"} not named anywhere - ${blanketBlocked.length === 1 ? "it inherits" : "they inherit"} a whole-site "Disallow: /" from the "${blanketBlocked[0].matchedAgent}" group, which is usually collateral damage rather than a decision about AI.`,
      );
    }
    if (pathBlocked.length > 0) {
      parts.push(
        `${pathBlocked.map((v) => v.bot.token).join(", ")} fall under the "${pathBlocked[0].matchedAgent}" group, whose "${pathBlocked[0].rule}" covers ${path} - a path-scoped exclusion that applies to every crawler, not just AI.`,
      );
    }
    parts.push(
      allowed.length > 0
        ? `Still allowed: ${allowed.map((v) => v.bot.token).join(", ")}. What you give up is specifically ${blocked.map((v) => `${v.bot.token}, which ${v.bot.role}`).join("; and ")}.`
        : `Every agent from this vendor is blocked, so ${vendor.stake}.`,
    );
    const detail = parts.join(" ");

    findings.push({
      id,
      category: "ai",
      severity,
      title,
      detail,
      fix: deliberate
        ? "No action needed if this is what you intended. If you want to stay citable in AI answers while still opting out of model training, allow the search-purpose agents and block only the training crawlers."
        : "Add an explicit group for these agents so their access is a decision rather than a side-effect of a rule written for someone else.",
      snippet: deliberate ? optOutSnippet || admitSnippet : admitSnippet,
      value: lines.join(" | "),
      docs: vendor.docs,
      weight: vendor.key === "openai" || vendor.key === "anthropic" ? 2 : 1,
    });
  }

  const blockedBots = allVerdicts.filter((v) => v.status === "blocked");
  const allowedBots = allVerdicts.filter((v) => v.status === "allowed");
  const accidentalBlocks = blockedBots.filter((v) => v.viaWildcard && v.blanket);
  const pathScopedBlocks = blockedBots.filter((v) => v.viaWildcard && !v.blanket);

  /* ---------------------------------------------------------------------- */
  /* 3. Blanket disallow                                                     */
  /* ---------------------------------------------------------------------- */

  if (robots?.blocksAllCrawlers) {
    findings.push({
      id: "ai-robots-blanket-disallow",
      category: "ai",
      severity: "warning",
      title: "robots.txt disallows every crawler on the whole site",
      detail:
        "A group matching `User-agent: *` contains `Disallow: /`. That takes out AI assistants, AI search engines and conventional search engines in one line. This pattern is most often left over from a staging environment rather than a considered policy.",
      fix: "If the site is live and you want it found, replace the blanket rule with `Allow: /` and block only the specific paths or agents you actually want excluded.",
      snippet: ["User-agent: *", "Allow: /", "Disallow: /admin/", "", `Sitemap: ${ctx.origin}/sitemap.xml`].join("\n"),
      value: "User-agent: * / Disallow: /",
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt",
      weight: 4,
    });
  }

  if (accidentalBlocks.length > 0 && !robots?.blocksAllCrawlers) {
    findings.push({
      id: "ai-crawler-collateral-block",
      category: "ai",
      severity: "warning",
      title: `${accidentalBlocks.length} AI crawlers blocked by a rule that was not aimed at them`,
      detail: `These agents are never named in robots.txt; they inherit a whole-site "Disallow: /" from a catch-all group. Blocking AI crawlers is a perfectly reasonable choice - inheriting the block by accident, from a rule written for something else entirely, is not: ${accidentalBlocks.map((v) => v.bot.token).join(", ")}.`,
      fix: "Decide explicitly. Either narrow the catch-all rule so it only covers the paths you meant, or add named groups for the AI agents you are happy to admit.",
      snippet: [`# Explicitly admit the agents you want:`, `User-agent: OAI-SearchBot`, `Allow: ${path}`, "", `User-agent: Claude-SearchBot`, `Allow: ${path}`].join("\n"),
      value: accidentalBlocks.map((v) => `${v.bot.token}: ${v.rule}`).join(" | "),
      docs: "https://www.rfc-editor.org/rfc/rfc9309.html",
      weight: 2,
    });
  } else if (pathScopedBlocks.length > 0 && !robots?.blocksAllCrawlers) {
    findings.push({
      id: "ai-crawler-path-excluded",
      category: "ai",
      severity: "info",
      title: `This URL is excluded from all crawlers, AI included`,
      detail: `${pluralise(pathScopedBlocks.length, "AI crawler")} cannot fetch ${path} because a catch-all group disallows it (${pathScopedBlocks[0].rule}). The rule is path-scoped rather than site-wide, so this is likely a deliberate exclusion of this section - worth confirming that excluding it from AI answers was part of the intent.`,
      fix: "If this page should be citable, narrow the disallow to the paths that genuinely need it, or add an Allow rule for this path in the groups that matter.",
      snippet: ["User-agent: *", `Allow: ${path}`, "Disallow: /admin/"].join("\n"),
      value: `${pathScopedBlocks[0].rule} in the "${pathScopedBlocks[0].matchedAgent}" group`,
      docs: "https://www.rfc-editor.org/rfc/rfc9309.html",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. llms.txt                                                             */
  /* ---------------------------------------------------------------------- */

  const llms = ctx.llmsTxt;
  const llmsPresent = llms !== null && llms.ok && llms.status < 400 && llms.body.trim() !== "";

  if (!llmsPresent) {
    const starter = [
      `# ${siteTitle || new URL(ctx.origin).hostname}`,
      "",
      `> ${description || "One sentence describing what this site is and who it is for."}`,
      "",
      "Optional free-form context an LLM should know before reading further: what you sell, who you serve, any naming or terminology quirks.",
      "",
      "## Core pages",
      "",
      `- [Home](${ctx.origin}/): What visitors find on the landing page.`,
      `- [About](${ctx.origin}/about): Who is behind the site.`,
      `- [Contact](${ctx.origin}/contact): How to get in touch.`,
      "",
      "## Optional",
      "",
      `- [Sitemap](${ctx.origin}/sitemap.xml): Full URL list.`,
    ].join("\n");

    findings.push({
      id: "ai-llms-txt-missing",
      category: "ai",
      severity: "info",
      title: "No /llms.txt - no curated map for language models",
      detail:
        llms === null
          ? "No /llms.txt was found. It is an emerging convention (llmstxt.org): a single markdown file at the site root that tells an LLM, in plain prose and curated links, what this site is and which pages actually matter. It is advisory - no crawler is required to read it - but it costs one file and it is being picked up quickly."
          : `/llms.txt returned HTTP ${llms.status}. Language models fetching it get nothing back.`,
      fix: "Publish /llms.txt at the site root as plain markdown: an H1 with the site name, a blockquote summary, then linked sections pointing at your genuinely important pages with a short description each.",
      snippet: starter,
      value: llms === null ? "not found" : `HTTP ${llms.status}`,
      docs: "https://llmstxt.org/",
      weight: 2,
    });
  } else {
    const body = llms.body;
    const lines = body.split(/\r?\n/);
    const h1 = lines.find((line) => /^#\s+\S/.test(line.trim()));
    const bodyAfterTitle = lines
      .filter((line) => !/^#\s+/.test(line.trim()))
      .join("\n")
      .trim();
    const linkCount = countMatches(body, /\[[^\]]*\]\([^)]+\)/g);
    const looksHtml = /<html|<!doctype/i.test(body.slice(0, 400));
    const problems: string[] = [];

    if (looksHtml) problems.push("the response is HTML, not markdown - the server is probably serving your SPA shell or a 404 page for this path");
    if (!h1) problems.push("there is no `# Title` H1 line, which the format requires as the site name");
    if (bodyAfterTitle.length < 80) problems.push("there is almost no content beyond the title");
    if (linkCount === 0) problems.push("it links to no pages, so a model gets a name but no map");

    if (problems.length > 0) {
      findings.push({
        id: "ai-llms-txt-invalid",
        category: "ai",
        severity: "warning",
        title: "/llms.txt exists but does not follow the format",
        detail: `The file was fetched (${llms.bytes} bytes, ${llms.contentType ?? "no content-type"}) but ${problems.join("; ")}.`,
        fix: "Serve it as `text/plain` or `text/markdown`, open with a single `#` H1 naming the site, follow with a `>` blockquote summary, then `##` sections of markdown links with one-line descriptions.",
        snippet: [
          `# ${siteTitle || new URL(ctx.origin).hostname}`,
          "",
          `> ${description || "One sentence describing the site."}`,
          "",
          "## Core pages",
          "",
          `- [Home](${ctx.origin}/): What this page covers.`,
        ].join("\n"),
        value: problems.join("; "),
        docs: "https://llmstxt.org/",
        weight: 2,
      });
    } else {
      findings.push({
        id: "ai-llms-txt-valid",
        category: "ai",
        severity: "pass",
        title: "/llms.txt is published and well-formed",
        detail: `A valid llms.txt was found: ${h1 ? `titled "${h1.replace(/^#\s+/, "").trim()}"` : "titled"}, ${llms.bytes} bytes, linking to ${pluralise(linkCount, "page")}. Language models that support the convention get a curated view of the site rather than guessing from the nav.`,
        value: `${llms.bytes} bytes, ${linkCount} links`,
        docs: "https://llmstxt.org/",
        weight: 2,
      });
    }

    findings.push({
      id: "ai-llms-full-txt",
      category: "ai",
      severity: "info",
      title: "Consider /llms-full.txt as a companion to /llms.txt",
      detail:
        "The convention has a second, larger file: `/llms-full.txt` contains the full expanded content of your key pages inlined as markdown, so a model can ingest your documentation in a single fetch instead of crawling page by page.",
      fix: "Generate /llms-full.txt at build time by concatenating your main pages as markdown, each under an H2 heading with its canonical URL.",
      snippet: [
        `# ${siteTitle || "Site"} - full text`,
        "",
        `## Home (${ctx.origin}/)`,
        "",
        "Full markdown content of the page...",
      ].join("\n"),
      docs: "https://llmstxt.org/",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Legibility without JavaScript                                        */
  /* ---------------------------------------------------------------------- */

  const externalScripts = doc.scripts.filter((s) => s.src !== null).length;
  const totalScripts = doc.scripts.length;
  const ratio = doc.textToHtmlRatio;
  const ratioPct = `${(ratio * 100).toFixed(1)}%`;
  const shellSignals = ratio < 0.05 && totalScripts >= 4 && doc.wordCount < 200;
  const thinSignals = !shellSignals && (ratio < 0.1 || doc.wordCount < 250);

  if (shellSignals) {
    const mitigated = doc.hasNoscript && doc.wordCount > 50;
    findings.push({
      id: "ai-js-rendered-shell",
      category: "ai",
      severity: mitigated ? "warning" : "critical",
      title: "The page looks like a client-rendered shell - AI crawlers see almost nothing",
      detail: `The raw HTML response contains only ${pluralise(doc.wordCount, "word")} of text (${ratioPct} of the document is text) alongside ${pluralise(totalScripts, "script tag")}. Almost every AI crawler - GPTBot, ClaudeBot, PerplexityBot, CCBot - fetches HTML and does not execute JavaScript. What they store is this empty shell, not what a browser shows.${doc.hasNoscript ? " A <noscript> block is present, which may soften the blow if it carries real content." : ""} This is the single highest-impact AI-readiness problem on the page.`,
      fix: "Server-render or pre-render the page so the primary content is in the initial HTML response. In React Router 7 that means keeping the route's data in a `loader` and rendering it server-side rather than fetching it in a client `useEffect`. Verify by running `curl -s <url> | wc -w` - if the word count is tiny, so is what the AI sees.",
      snippet: [
        "# What an AI crawler actually receives:",
        `curl -sL -A "GPTBot" ${ctx.finalUrl} | sed -e 's/<[^>]*>//g' | tr -s '[:space:]' ' ' | wc -w`,
      ].join("\n"),
      value: `${doc.wordCount} words, ${ratioPct} text ratio, ${totalScripts} scripts`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics",
      weight: 5,
    });
  } else if (thinSignals) {
    findings.push({
      id: "ai-server-rendered-content-thin",
      category: "ai",
      severity: "warning",
      title: "Little text reaches crawlers that do not run JavaScript",
      detail: `The server response carries ${pluralise(doc.wordCount, "word")} at a ${ratioPct} text-to-HTML ratio. AI crawlers read this response as-is; anything rendered later by JavaScript is invisible to them. There is enough here to identify the page but probably not enough to answer a question from it.`,
      fix: "Move the main body copy into the server-rendered HTML. A useful floor for a page you want cited is roughly 300 words of substantive text present before any script runs.",
      value: `${doc.wordCount} words, ${ratioPct} text ratio`,
      docs: "https://web.dev/articles/rendering-on-the-web",
      weight: 3,
    });
  } else {
    findings.push({
      id: "ai-server-rendered-content",
      category: "ai",
      severity: "pass",
      title: "Content is present in the server-rendered HTML",
      detail: `${pluralise(doc.wordCount, "word")} of text arrive in the initial HTML response (${ratioPct} text-to-HTML ratio). Crawlers that do not execute JavaScript - which is most AI crawlers - see the real content.`,
      value: `${doc.wordCount} words, ${ratioPct} text ratio, ${externalScripts} external scripts`,
      docs: "https://web.dev/articles/rendering-on-the-web",
      weight: 3,
    });
  }

  if (!doc.hasNoscript && (shellSignals || thinSignals)) {
    findings.push({
      id: "ai-noscript-fallback-missing",
      category: "ai",
      severity: "info",
      title: "No <noscript> fallback on a JavaScript-dependent page",
      detail:
        "The page depends on JavaScript for its content but offers no <noscript> block. A short noscript summary is a cheap safety net: it gives non-executing crawlers and text-mode agents something factual to read.",
      fix: "Add a <noscript> block near the top of <body> with the page's headline, a two-sentence summary and a link to a static version if you have one.",
      snippet: [
        "<noscript>",
        `  <h1>${siteTitle || "Page title"}</h1>`,
        `  <p>${description || "A plain-text summary of this page for clients that do not run JavaScript."}</p>`,
        "</noscript>",
      ].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/noscript",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Semantic structure for extraction                                    */
  /* ---------------------------------------------------------------------- */

  const landmarks = new Set(doc.landmarks.map((l) => l.toLowerCase()));
  const roles = new Set(doc.roles.map((r) => r.toLowerCase()));
  const hasMain = landmarks.has("main") || roles.has("main");
  const hasArticle = landmarks.has("article") || roles.has("article");

  if (hasMain) {
    findings.push({
      id: "ai-landmark-main",
      category: "ai",
      severity: "pass",
      title: "A <main> landmark marks the primary content",
      detail:
        "Content-extraction pipelines (Readability, Trafilatura, and the boilerplate strippers most AI crawlers run) look for <main> first. Having one means your body copy is what gets kept and your nav and footer are what get discarded.",
      value: doc.landmarks.join(", ") || "main",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/main",
      weight: 2,
    });
  } else {
    findings.push({
      id: "ai-landmark-main-missing",
      category: "ai",
      severity: "warning",
      title: "No <main> element - extractors have to guess what the content is",
      detail: `The page exposes ${doc.landmarks.length > 0 ? `landmarks: ${doc.landmarks.join(", ")}` : "no semantic landmarks at all"}, but no <main>. Boilerplate-removal algorithms fall back to heuristics like "biggest text block", which routinely keeps the nav and drops the article - so the model ends up storing your menu instead of your point.`,
      fix: "Wrap the primary content of the page in a single <main> element, outside the header, nav and footer.",
      snippet: ["<body>", "  <header>...</header>", "  <main>", "    <article>…primary content…</article>", "  </main>", "  <footer>...</footer>", "</body>"].join("\n"),
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/main",
      weight: 2,
    });
  }

  const paragraphCount = countMatches(html, /<p\b/gi);
  const listCount = countMatches(html, /<(ul|ol)\b/gi);
  const tableCount = countMatches(html, /<table\b/gi);
  const divCount = countMatches(html, /<div\b/gi);

  if (paragraphCount === 0 && doc.wordCount > 80) {
    findings.push({
      id: "ai-div-soup",
      category: "ai",
      severity: "warning",
      title: "Body copy is not in paragraphs - div soup extracts badly",
      detail: `The page has ${pluralise(doc.wordCount, "word")} of text and ${pluralise(divCount, "<div>")} but not a single <p> element. LLM ingestion chunks documents on block-level semantics; text that lives only in divs and spans gets concatenated into one shapeless run, and quotes pulled from it tend to splice unrelated sentences together.`,
      fix: "Emit real paragraphs. Prose goes in <p>, enumerations in <ul>/<ol>, comparisons in <table>. This is free structure that every extractor understands.",
      value: `${paragraphCount} <p>, ${divCount} <div>`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/p",
      weight: 2,
    });
  } else if (paragraphCount > 0) {
    findings.push({
      id: "ai-block-semantics",
      category: "ai",
      severity: "pass",
      title: "Content uses real block-level semantics",
      detail: `Found ${pluralise(paragraphCount, "paragraph")}, ${pluralise(listCount, "list")} and ${pluralise(tableCount, "table")}. These are the boundaries LLM chunkers split on, so passages retrieved from this page will keep their meaning.`,
      value: `${paragraphCount} <p>, ${listCount} lists, ${tableCount} tables`,
      weight: 1,
    });
  }

  if (hasArticle) {
    findings.push({
      id: "ai-landmark-article",
      category: "ai",
      severity: "pass",
      title: "An <article> element bounds the self-contained content",
      detail:
        "<article> tells an extractor that everything inside is one syndicatable unit. It is the strongest hint available for where a quotable passage starts and stops.",
      value: "article",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article",
      weight: 1,
    });
  } else if (doc.wordCount > 300) {
    findings.push({
      id: "ai-landmark-article-missing",
      category: "ai",
      severity: "info",
      title: "No <article> element around the main content",
      detail: `This page carries ${pluralise(doc.wordCount, "word")} - enough that it reads as a document rather than a UI. Wrapping it in <article> marks the boundary of the self-contained piece, which helps models decide how much of the page to quote as one unit.`,
      fix: "Wrap the standalone content (post, guide, product description) in <article> inside <main>.",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Heading outline and anchors                                          */
  /* ---------------------------------------------------------------------- */

  const headings = doc.headings;
  const skips: string[] = [];
  let previousLevel = 0;
  for (const heading of headings) {
    if (previousLevel !== 0 && heading.level > previousLevel + 1) {
      skips.push(`h${previousLevel} → h${heading.level} ("${heading.text.slice(0, 40)}")`);
    }
    previousLevel = heading.level;
  }

  const wordsPerHeading = headings.length > 0 ? Math.round(doc.wordCount / headings.length) : doc.wordCount;

  if (headings.length === 0 && doc.wordCount > 150) {
    findings.push({
      id: "ai-heading-outline-missing",
      category: "ai",
      severity: "warning",
      title: "No headings - the page is one undifferentiated block to a model",
      detail: `${pluralise(doc.wordCount, "word")} of text with no <h1>–<h6> at all. Retrieval systems chunk long documents at heading boundaries and use the heading text as the chunk's label; with none, the page is split arbitrarily and the fragments arrive unlabelled.`,
      fix: "Add an <h1> for the page subject and <h2> headings for each distinct topic. Write them as the question the section answers.",
      value: "0 headings",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements",
      weight: 2,
    });
  } else if (skips.length > 0) {
    findings.push({
      id: "ai-heading-outline-skips",
      category: "ai",
      severity: "info",
      title: "Heading levels skip, blurring the document outline",
      detail: `${pluralise(skips.length, "level jump")} in the outline: ${skips.slice(0, 3).join("; ")}. Models infer the parent-child relationship between sections from heading depth; a jump makes a subsection look like a sibling, so retrieved chunks can lose the context they belonged under.`,
      fix: "Step heading levels one at a time. If you need a smaller heading for visual reasons, change the CSS rather than the tag.",
      value: skips.join("; "),
      docs: "https://www.w3.org/WAI/tutorials/page-structure/headings/",
      weight: 1,
    });
  } else if (headings.length > 0 && doc.wordCount > 400 && wordsPerHeading > 600) {
    findings.push({
      id: "ai-heading-density-low",
      category: "ai",
      severity: "info",
      title: "Long stretches of text between headings",
      detail: `About ${wordsPerHeading} words per heading across ${pluralise(headings.length, "heading")}. Long unbroken runs get chunked mid-argument, and the resulting fragment carries a heading that no longer describes it.`,
      fix: "Add a subheading roughly every 200–300 words so each chunk arrives with an accurate label.",
      value: `${wordsPerHeading} words per heading`,
      weight: 1,
    });
  } else if (headings.length > 0) {
    findings.push({
      id: "ai-heading-outline",
      category: "ai",
      severity: "pass",
      title: "Clean heading outline for chunking",
      detail: `${pluralise(headings.length, "heading")} form a consistent outline with no level skips (roughly ${wordsPerHeading} words per section). Retrieval systems can split this page into labelled, self-describing chunks.`,
      value: headings.slice(0, 5).map((h) => `h${h.level}: ${h.text.slice(0, 40)}`).join(" | "),
      weight: 1,
    });
  }

  const headingsWithIds = countMatches(html, /<h[1-6]\b[^>]*\sid\s*=/gi);
  if (headings.length >= 3) {
    if (headingsWithIds >= Math.ceil(headings.length / 2)) {
      findings.push({
        id: "ai-heading-anchors",
        category: "ai",
        severity: "pass",
        title: "Headings carry id anchors for deep linking",
        detail: `${headingsWithIds} of ${headings.length} headings have an id. AI answers increasingly cite a specific section with a #fragment URL; stable ids are what make that possible and what stop the citation from degrading to the page root.`,
        value: `${headingsWithIds}/${headings.length} headings with id`,
        weight: 1,
      });
    } else {
      findings.push({
        id: "ai-heading-anchors-missing",
        category: "ai",
        severity: "info",
        title: "Headings have no id anchors",
        detail: `Only ${headingsWithIds} of ${headings.length} headings carry an id. Assistants that want to cite one section of a long page can only link to the whole page, which makes the citation less useful and less likely to be shown.`,
        fix: "Emit a slugified id on every heading and keep them stable across edits - changing a slug breaks every citation pointing at it.",
        snippet: `<h2 id="how-pricing-works">How pricing works</h2>`,
        value: `${headingsWithIds}/${headings.length} headings with id`,
        docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/id",
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Freshness and authorship                                             */
  /* ---------------------------------------------------------------------- */

  const nodes = flattenJsonLd(doc.jsonLd);
  const jsonLdPublished = nodes.map((n) => stringProp(n, "datePublished")).find((v) => v !== null) ?? null;
  const jsonLdModified = nodes.map((n) => stringProp(n, "dateModified")).find((v) => v !== null) ?? null;
  const ogPublished = doc.metaByProperty["article:published_time"] ?? null;
  const ogModified = doc.metaByProperty["article:modified_time"] ?? null;
  const metaDate =
    doc.metaByName["date"] ?? doc.metaByName["last-modified"] ?? doc.metaByName["dc.date"] ?? null;
  const timeElements = countMatches(html, /<time\b[^>]*\sdatetime\s*=/gi);
  const publishedSignal = jsonLdPublished ?? ogPublished ?? metaDate;
  const modifiedSignal = jsonLdModified ?? ogModified ?? ctx.headers["last-modified"] ?? null;

  if (publishedSignal || modifiedSignal) {
    const parts: string[] = [];
    if (jsonLdPublished) parts.push(`JSON-LD datePublished: ${jsonLdPublished}`);
    if (jsonLdModified) parts.push(`JSON-LD dateModified: ${jsonLdModified}`);
    if (ogPublished) parts.push(`article:published_time: ${ogPublished}`);
    if (ogModified) parts.push(`article:modified_time: ${ogModified}`);
    if (!jsonLdModified && !ogModified && ctx.headers["last-modified"]) {
      parts.push(`Last-Modified header: ${ctx.headers["last-modified"]}`);
    }
    findings.push({
      id: "ai-freshness-signals",
      category: "ai",
      severity: "pass",
      title: "The page is dateable",
      detail: `Machine-readable dates were found (${parts.join("; ")}). AI answer engines strongly prefer sources they can date, and for anything time-sensitive an undated page loses to a dated competitor even when it is more accurate.`,
      value: parts.join("; "),
      docs: "https://developers.google.com/search/docs/appearance/publication-dates",
      weight: 2,
    });
  } else {
    findings.push({
      id: "ai-freshness-signals-missing",
      category: "ai",
      severity: "warning",
      title: "No machine-readable publish or update date",
      detail:
        "Nothing on the page states when this content was written or last changed - no JSON-LD datePublished/dateModified, no article:published_time, no Last-Modified. Answer engines rank recency heavily and generally will not present an undated page as current, so this page loses to dated alternatives on any question where time matters.",
      fix: "Emit both dates in ISO 8601 with a timezone, in JSON-LD, and mirror the visible date in a <time datetime> element.",
      snippet: [
        `<script type="application/ld+json">`,
        `{`,
        `  "@context": "https://schema.org",`,
        `  "@type": "Article",`,
        `  "headline": ${JSON.stringify(siteTitle || "Page title")},`,
        `  "datePublished": "2025-01-15T09:00:00+10:00",`,
        `  "dateModified": "2025-06-02T14:30:00+10:00"`,
        `}`,
        `</script>`,
      ].join("\n"),
      docs: "https://schema.org/dateModified",
      weight: 2,
    });
  }

  if (timeElements > 0) {
    findings.push({
      id: "ai-time-elements",
      category: "ai",
      severity: "pass",
      title: "Visible dates use <time datetime>",
      detail: `${pluralise(timeElements, "<time> element")} with a machine-readable datetime attribute. This resolves ambiguity that plain text cannot - "02/06/25" is two different dates depending on the reader's locale, and a model has to guess.`,
      value: `${timeElements} <time datetime> elements`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/time",
      weight: 1,
    });
  } else if (publishedSignal) {
    findings.push({
      id: "ai-time-elements-missing",
      category: "ai",
      severity: "info",
      title: "Dates are not marked up with <time>",
      detail:
        "Structured dates exist in the head but no <time datetime> element appears in the body. When the visible date and the metadata date disagree, extractors tend to trust the visible one - marking it up removes the ambiguity.",
      fix: "Wrap visible dates in <time datetime=\"YYYY-MM-DD\">.",
      snippet: `<time datetime="2025-06-02">2 June 2025</time>`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/time",
      weight: 1,
    });
  }

  const jsonLdAuthor = nodes.map((n) => stringProp(n, "author")).find((v) => v !== null) ?? null;
  const metaAuthor = doc.metaByName["author"] ?? doc.metaByProperty["article:author"] ?? null;
  const relAuthor = doc.links.some((l) => l.rel.toLowerCase().split(/\s+/).includes("author"));
  const bylineInText = /\b(by|written by|author:)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(doc.textContent.slice(0, 4000));

  if (jsonLdAuthor || metaAuthor) {
    findings.push({
      id: "ai-authorship",
      category: "ai",
      severity: "pass",
      title: "Authorship is machine-readable",
      detail: `An author is declared (${jsonLdAuthor ? `JSON-LD author: "${jsonLdAuthor}"` : `meta author: "${metaAuthor}"`}). Attribution is one of the signals answer engines use to decide whether a claim is worth repeating and who to credit alongside the link.`,
      value: jsonLdAuthor ?? metaAuthor ?? "",
      docs: "https://schema.org/author",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-authorship-missing",
      category: "ai",
      severity: "info",
      title: "No declared author",
      detail: `Neither JSON-LD nor a meta tag names an author${relAuthor ? " (a rel=\"author\" link exists but carries no name)" : ""}${bylineInText ? ", though the body text appears to contain a byline a model would have to guess at" : ""}. Unattributed content is treated as lower-trust by systems that weigh expertise, and you lose the named credit when an answer cites you.`,
      fix: "Add an author to your Article/BlogPosting JSON-LD as a Person with a `url` pointing at a real bio page, and show the byline visibly.",
      snippet: [
        `"author": {`,
        `  "@type": "Person",`,
        `  "name": "Jane Doe",`,
        `  "url": "${ctx.origin}/about"`,
        `}`,
      ].join("\n"),
      docs: "https://schema.org/Person",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Citability                                                           */
  /* ---------------------------------------------------------------------- */

  const canonicalLink = doc.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes("canonical"));
  const canonicalHref = canonicalLink?.href?.trim() ?? "";

  if (canonicalHref === "") {
    findings.push({
      id: "ai-canonical-missing",
      category: "ai",
      severity: "warning",
      title: "No canonical URL for a model to cite",
      detail:
        "There is no <link rel=\"canonical\">. When an assistant cites you it has to use whatever URL it happened to fetch - a tracking-parameter variant, an http:// version, a syndicated copy. Citations then fragment across near-duplicate URLs and none of them accumulates authority.",
      fix: "Emit a self-referencing absolute canonical on every page.",
      snippet: `<link rel="canonical" href="${ctx.finalUrl}">`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
      weight: 2,
    });
  } else if (!isAbsoluteHttpUrl(canonicalHref)) {
    findings.push({
      id: "ai-canonical-relative",
      category: "ai",
      severity: "warning",
      title: "Canonical URL is relative, not absolute",
      detail: `The canonical is "${canonicalHref}". Crawlers resolve it against the current URL, so the "canonical" identity changes depending on where the crawler arrived from - which is the opposite of what a canonical is for.`,
      fix: "Use a fully-qualified absolute URL including the scheme and host.",
      snippet: `<link rel="canonical" href="${ctx.finalUrl}">`,
      value: canonicalHref,
      docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
      weight: 2,
    });
  } else {
    findings.push({
      id: "ai-canonical-absolute",
      category: "ai",
      severity: "pass",
      title: "Absolute canonical URL - citations land on the right address",
      detail: `The page declares "${canonicalHref}" as its canonical URL, so every assistant that quotes it links to the same address regardless of how it arrived.`,
      value: canonicalHref,
      weight: 2,
    });
  }

  if (siteTitle === "") {
    findings.push({
      id: "ai-title-missing",
      category: "ai",
      severity: "critical",
      title: "No <title> - nothing to label a citation with",
      detail:
        "The page has no title element. AI answers render a source as a title plus a link; with no title the entry either falls back to the bare URL or gets dropped from the source list entirely.",
      fix: "Add a <title> that names the specific subject of this page and stands on its own out of context.",
      snippet: `<title>How pricing works - Example Co</title>`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/title",
      weight: 3,
    });
  } else {
    const generic = /^(home|index|untitled|document|new page|react app|welcome|page)$/i.test(siteTitle);
    if (generic || siteTitle.length < 15) {
      findings.push({
        id: "ai-title-not-self-contained",
        category: "ai",
        severity: "warning",
        title: "Title is too generic to work as a citation label",
        detail: `The title is "${siteTitle}". Pulled out of context into a list of sources it says nothing about what the page contains, so a user has no reason to click it and a model has little to match a question against.`,
        fix: "Write the title as a self-contained description of the page's subject, specific enough to be understood with no other context. 40–60 characters is the useful range.",
        value: siteTitle,
        weight: 2,
      });
    } else {
      findings.push({
        id: "ai-title-self-contained",
        category: "ai",
        severity: "pass",
        title: "Title works as a standalone citation label",
        detail: `"${siteTitle}" (${siteTitle.length} characters) reads as a description of this specific page, which is exactly how it will appear in an AI answer's source list.`,
        value: siteTitle,
        weight: 1,
      });
    }
  }

  if (description === "") {
    findings.push({
      id: "ai-summary-missing",
      category: "ai",
      severity: "warning",
      title: "No description for a model to summarise from",
      detail:
        "There is no meta description or og:description. A model asked to summarise the page has to derive one from the body text, which is slower, lossier and outside your control - and answer engines often display your description verbatim when they have one.",
      fix: "Write a 140–160 character description that states what the page contains as a factual claim, not marketing copy.",
      snippet: `<meta name="description" content="A plain statement of what this page covers and who it is for.">`,
      weight: 2,
    });
  } else {
    findings.push({
      id: "ai-summary-present",
      category: "ai",
      severity: "pass",
      title: "An author-controlled summary is available",
      detail: `A ${description.length}-character description gives assistants a summary you wrote rather than one they inferred: "${description.slice(0, 120)}${description.length > 120 ? "…" : ""}"`,
      value: description,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. Structured data as ground truth                                     */
  /* ---------------------------------------------------------------------- */

  const jsonLdTypes = Array.from(new Set(nodes.flatMap(typesOf))).filter((t) => t !== "");

  if (doc.jsonLd.length > 0) {
    findings.push({
      id: "ai-jsonld-ground-truth",
      category: "ai",
      severity: "pass",
      title: "JSON-LD gives models facts they do not have to infer",
      detail: `${pluralise(doc.jsonLd.length, "JSON-LD block")} declaring ${jsonLdTypes.length > 0 ? jsonLdTypes.join(", ") : "structured entities"}. This is the highest-fidelity channel you have: prices, dates, names and relationships arrive as data rather than as prose a model has to parse and can get wrong.`,
      value: jsonLdTypes.join(", ") || `${doc.jsonLd.length} blocks`,
      docs: "https://json-ld.org/",
      weight: 2,
    });
  } else if (doc.hasMicrodata || doc.hasRdfa) {
    findings.push({
      id: "ai-structured-data-legacy",
      category: "ai",
      severity: "info",
      title: `Structured data uses ${doc.hasMicrodata ? "microdata" : "RDFa"} rather than JSON-LD`,
      detail:
        "Machine-readable markup is present but embedded in the HTML attributes. Extraction pipelines handle JSON-LD far more reliably because it is a single self-contained object rather than something that has to be reassembled from the DOM.",
      fix: "Add an equivalent JSON-LD block in the head. You can keep the existing markup - they can coexist.",
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-jsonld-absent",
      category: "ai",
      severity: "warning",
      title: "No structured data - every fact has to be inferred from prose",
      detail:
        "The page contains no JSON-LD, microdata or RDFa. Anything a model reports about this page - what it is, who published it, what it costs, when it was written - comes from parsing sentences, which is where hallucinated details come from.",
      fix: "Add a JSON-LD block describing the page's primary entity. Even a minimal WebPage or Organization node is a large improvement over nothing.",
      snippet: [
        `<script type="application/ld+json">`,
        `{`,
        `  "@context": "https://schema.org",`,
        `  "@type": "WebPage",`,
        `  "name": ${JSON.stringify(siteTitle || "Page title")},`,
        `  "description": ${JSON.stringify(description || "What this page covers.")},`,
        `  "url": "${ctx.finalUrl}"`,
        `}`,
        `</script>`,
      ].join("\n"),
      docs: "https://schema.org/WebPage",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. Machine-readable alternates and discovery                           */
  /* ---------------------------------------------------------------------- */

  const feeds = doc.links.filter((l) => {
    const rels = l.rel.toLowerCase().split(/\s+/);
    const type = (l.type ?? "").toLowerCase();
    return rels.includes("alternate") && (type.includes("rss") || type.includes("atom") || type.includes("json"));
  });

  if (feeds.length > 0) {
    findings.push({
      id: "ai-feed-alternate",
      category: "ai",
      severity: "pass",
      title: "A machine-readable feed is advertised",
      detail: `${pluralise(feeds.length, "feed")} linked from the head (${feeds.map((f) => f.type ?? "feed").join(", ")}). Feeds are how agents and monitoring tools notice that you published something new without re-crawling the whole site.`,
      value: feeds.map((f) => f.href ?? "").filter((h) => h !== "").join(", "),
      docs: "https://www.rssboard.org/rss-specification",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-feed-alternate-missing",
      category: "ai",
      severity: "info",
      title: "No RSS/Atom/JSON feed advertised",
      detail:
        "No <link rel=\"alternate\"> feed was found. Feeds remain the cheapest way for an agent to poll for new content, and several AI research tools consume them directly in preference to crawling.",
      fix: "If the site publishes anything on a timeline, expose a feed and link it from the head of every page.",
      snippet: `<link rel="alternate" type="application/rss+xml" title="Example Co" href="${ctx.origin}/feed.xml">`,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel",
      weight: 1,
    });
  }

  const sitemapCount = robots?.sitemaps.length ?? 0;
  if (ctx.sitemap?.ok) {
    findings.push({
      id: "ai-sitemap-discovery",
      category: "ai",
      severity: "pass",
      title: "A sitemap tells crawlers what else exists",
      detail: `A ${ctx.sitemap.isIndex ? "sitemap index" : "sitemap"} with ${pluralise(ctx.sitemap.urlCount, "URL")} was found via ${ctx.sitemap.source}. AI crawlers have far smaller budgets than Googlebot; an explicit URL list is often the only way the long tail of your site gets fetched at all.`,
      value: `${ctx.sitemap.url} (${ctx.sitemap.urlCount} URLs)`,
      docs: "https://www.sitemaps.org/protocol.html",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-sitemap-missing",
      category: "ai",
      severity: "warning",
      title: "No usable sitemap for crawlers to work from",
      detail: `No sitemap was retrieved${sitemapCount > 0 ? ` even though robots.txt references ${pluralise(sitemapCount, "sitemap")}` : " and robots.txt does not reference one"}. AI crawlers visit far less often and far less deeply than search engines, so pages they cannot discover from a link on this page may never be fetched.`,
      fix: "Publish sitemap.xml with every canonical URL and a real lastmod, and reference it from robots.txt.",
      snippet: `Sitemap: ${ctx.origin}/sitemap.xml`,
      docs: "https://www.sitemaps.org/protocol.html",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 12. Licensing and AI usage policy                                       */
  /* ---------------------------------------------------------------------- */

  const robotsMeta = (doc.metaByName["robots"] ?? "").toLowerCase();
  const xRobotsTag = (ctx.headers["x-robots-tag"] ?? "").toLowerCase();
  const combinedRobotsDirectives = directiveTokens(`${robotsMeta} ${xRobotsTag}`);
  const noaiDirectives = combinedRobotsDirectives.filter((t) => t === "noai" || t === "noimageai");
  const explicitNoai = doc.metaByName["noai"] !== undefined || doc.metaByName["noimageai"] !== undefined;

  if (noaiDirectives.length > 0 || explicitNoai) {
    findings.push({
      id: "ai-noai-directive",
      category: "ai",
      severity: "info",
      title: "The page declares a noai / noimageai preference",
      detail: `Found ${noaiDirectives.length > 0 ? `"${noaiDirectives.join(", ")}" in the robots directives` : "a dedicated noai meta tag"}. This is a community convention with no formal standard behind it: some platforms honour it, most crawlers ignore it. It records your intent, which can matter, but it does not enforce anything.`,
      fix: "If the intent is enforcement rather than a statement, pair it with robots.txt rules for the specific training crawlers - those are actually obeyed by the major vendors.",
      snippet: ["User-agent: GPTBot", "Disallow: /", "", "User-agent: CCBot", "Disallow: /", "", "User-agent: Google-Extended", "Disallow: /"].join("\n"),
      value: noaiDirectives.join(", ") || "noai meta tag",
      docs: "https://platform.openai.com/docs/bots",
      weight: 1,
    });
  }

  const tdmHeader = ctx.headers["tdm-reservation"] ?? ctx.headers["tdm-policy"] ?? null;
  const tdmMeta = doc.metaByName["tdm-reservation"] ?? doc.metaByName["tdm-policy"] ?? null;
  if (tdmHeader || tdmMeta) {
    findings.push({
      id: "ai-tdm-reservation",
      category: "ai",
      severity: "info",
      title: "A TDM (text and data mining) reservation is declared",
      detail: `Found ${tdmHeader ? `the header "tdm-reservation: ${tdmHeader}"` : `a meta tag "${tdmMeta}"`}. Under the EU DSM Directive's Article 4 opt-out, a machine-readable reservation is the mechanism for withholding your content from commercial text and data mining. This is the closest thing to a legally-grounded AI opt-out that exists.`,
      value: tdmHeader ?? tdmMeta ?? "",
      docs: "https://www.w3.org/community/tdmrep/",
      weight: 1,
    });
  }

  const licenseLink = doc.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes("license"));
  if (licenseLink?.href) {
    findings.push({
      id: "ai-license-declared",
      category: "ai",
      severity: "pass",
      title: "Content licensing is machine-readable",
      detail: `A <link rel="license"> points at ${licenseLink.href}. Models and dataset builders that check licensing before reuse have an unambiguous answer instead of a guess, which makes permitted reuse more likely and unpermitted reuse harder to excuse.`,
      value: licenseLink.href,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-license-undeclared",
      category: "ai",
      severity: "info",
      title: "No machine-readable licence on the content",
      detail:
        "There is no rel=\"license\" link and no schema.org license property. Whatever your terms of use say in prose, nothing here communicates them to an automated consumer.",
      fix: "Add a rel=\"license\" link in the head and a `license` property to your JSON-LD, both pointing at a licence URL.",
      snippet: [
        `<link rel="license" href="${ctx.origin}/terms">`,
        `<!-- and in JSON-LD: -->`,
        `"license": "https://creativecommons.org/licenses/by/4.0/"`,
      ].join("\n"),
      docs: "https://schema.org/license",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 13. Snippet directives                                                  */
  /* ---------------------------------------------------------------------- */

  const restrictive = combinedRobotsDirectives.filter(
    (t) => t === "nosnippet" || t === "noarchive" || t === "max-snippet:0" || t === "none",
  );
  if (restrictive.length > 0) {
    findings.push({
      id: "ai-snippet-directives-restrictive",
      category: "ai",
      severity: "warning",
      title: "Snippet directives stop assistants quoting this page",
      detail: `The page sets "${restrictive.join(", ")}". These directives are honoured by Google's AI Overviews and by several answer engines: the page may be indexed but no text from it can be shown. In practice a source that cannot be quoted usually is not surfaced.`,
      fix: "If you want to appear in AI answers, remove nosnippet/noarchive or replace them with a bounded `max-snippet:160`, which limits the quote without forbidding it.",
      snippet: `<meta name="robots" content="index, follow, max-snippet:160, max-image-preview:large">`,
      value: `${robotsMeta || "(no meta robots)"} | x-robots-tag: ${xRobotsTag || "(none)"}`,
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 2,
    });
  } else if (combinedRobotsDirectives.length > 0) {
    findings.push({
      id: "ai-snippet-directives",
      category: "ai",
      severity: "pass",
      title: "Snippet directives allow quoting",
      detail: `Robots directives ("${combinedRobotsDirectives.join(", ")}") place no restriction on snippet length or archiving, so assistants may quote from this page when citing it.`,
      value: combinedRobotsDirectives.join(", "),
      docs: "https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 14. Answer-shaped content                                               */
  /* ---------------------------------------------------------------------- */

  const answerTypes = ["faqpage", "howto", "qapage", "question"];
  const hasAnswerSchema = nodes.some((n) => typesOf(n).some((t) => answerTypes.includes(t)));
  const questionHeadings = headings.filter((h) =>
    /\?$/.test(h.text.trim()) ||
    /^(what|why|how|when|where|who|which|can|does|do|is|are|should|will)\b/i.test(h.text.trim()),
  );
  const definitionLists = countMatches(html, /<dl\b/gi);

  if (hasAnswerSchema) {
    findings.push({
      id: "ai-answer-schema",
      category: "ai",
      severity: "pass",
      title: "Content is marked up in an answer shape",
      detail:
        "FAQ, Q&A or HowTo schema is present. These types map directly onto how an assistant structures a response, so the content can be lifted with its question-answer pairing intact rather than reconstructed from prose.",
      value: jsonLdTypes.filter((t) => answerTypes.includes(t)).join(", "),
      docs: "https://developers.google.com/search/docs/appearance/structured-data/faqpage",
      weight: 1,
    });
  } else if (questionHeadings.length >= 2) {
    findings.push({
      id: "ai-answer-schema-opportunity",
      category: "ai",
      severity: "info",
      title: "Question-shaped headings that are not marked up as Q&A",
      detail: `${pluralise(questionHeadings.length, "heading")} read as questions (e.g. "${questionHeadings[0].text.slice(0, 60)}") but there is no FAQPage or QAPage schema. The content is already in the right shape - the markup just is not there to say so.`,
      fix: "Wrap the question-and-answer pairs in FAQPage JSON-LD. The answer text must match what is visible on the page.",
      snippet: [
        `<script type="application/ld+json">`,
        `{`,
        `  "@context": "https://schema.org",`,
        `  "@type": "FAQPage",`,
        `  "mainEntity": [{`,
        `    "@type": "Question",`,
        `    "name": ${JSON.stringify(questionHeadings[0].text.slice(0, 100))},`,
        `    "acceptedAnswer": { "@type": "Answer", "text": "The answer, matching the visible copy." }`,
        `  }]`,
        `}`,
        `</script>`,
      ].join("\n"),
      value: questionHeadings.slice(0, 3).map((h) => h.text.slice(0, 50)).join(" | "),
      docs: "https://developers.google.com/search/docs/appearance/structured-data/faqpage",
      weight: 1,
    });
  } else {
    findings.push({
      id: "ai-answer-formats",
      category: "ai",
      severity: "info",
      title: "Little of the content is shaped like an answer",
      detail: `The page has ${pluralise(questionHeadings.length, "question-form heading")}, ${pluralise(definitionLists, "definition list")}, ${pluralise(tableCount, "table")} and ${pluralise(listCount, "list")}. Assistants preferentially reuse content that already reads as a direct answer: a question as a heading followed immediately by a short, complete response.`,
      fix: "Where you can, phrase a heading as the question a reader would actually type and answer it in the first two sentences underneath. Use tables for comparisons and definition lists for terminology.",
      value: `${questionHeadings.length} question headings, ${definitionLists} <dl>, ${tableCount} tables, ${listCount} lists`,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/faqpage",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 15. Bot-facing content parity                                           */
  /* ---------------------------------------------------------------------- */

  const varyHeader = ctx.headers["vary"] ?? "";
  if (/user-agent/i.test(varyHeader)) {
    findings.push({
      id: "ai-vary-user-agent",
      category: "ai",
      severity: "info",
      title: "The response varies by User-Agent",
      detail: `The server sends "Vary: ${varyHeader}", meaning different user-agents can receive different HTML. AI crawlers announce themselves honestly, so any UA-conditional logic - bot walls, paywalls, "upgrade your browser" interstitials - applies to them, and what they store may not be what you think you published.`,
      fix: "Fetch the page as GPTBot and ClaudeBot and diff it against a browser fetch. `curl -A \"GPTBot\" <url>` is enough to spot a wall.",
      value: varyHeader,
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Vary",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 16. Summary                                                             */
  /* ---------------------------------------------------------------------- */

  const totalBots = allVerdicts.length;
  const blockedNames = blockedBots.map((v) => v.bot.token);
  const deliberateOptOut = blockedBots.length >= 3 && accidentalBlocks.length === 0;

  const blockers: string[] = [];
  if (robots?.blocksAllCrawlers) {
    blockers.push("robots.txt disallows every crawler on the entire site");
  }
  if (shellSignals) {
    blockers.push("the page is a client-rendered shell, so crawlers that do not run JavaScript store an empty document");
  }
  if (accidentalBlocks.length > 0) {
    blockers.push(`${accidentalBlocks.length} AI crawlers are blocked site-wide by a catch-all robots.txt rule that was probably not aimed at them`);
  }
  if (siteTitle === "") blockers.push("there is no <title> to label a citation with");
  if (canonicalHref === "") blockers.push("there is no canonical URL, so citations will scatter across URL variants");
  if (!publishedSignal && !modifiedSignal) blockers.push("the content carries no date, which answer engines penalise heavily");
  if (thinSignals && !shellSignals) blockers.push("there is very little server-rendered text to quote from");

  let severity: Finding["severity"];
  let title: string;
  if (blockers.length === 0 && blockedBots.length === 0) {
    severity = "pass";
    title = "This site is visible to AI assistants";
  } else if (deliberateOptOut && blockers.length === 0) {
    severity = "info";
    title = "This site has deliberately opted out of some AI crawlers";
  } else if (shellSignals || robots?.blocksAllCrawlers) {
    severity = "critical";
    title = "AI assistants currently cannot use this page";
  } else {
    severity = "warning";
    title = "This site is reachable by AI assistants but hard for them to use well";
  }

  findings.push({
    id: "ai-visibility-summary",
    category: "ai",
    severity,
    title,
    detail:
      severity === "pass"
        ? `All ${totalBots} AI crawlers checked are permitted, the content is server-rendered, and the page carries the title, canonical URL and date signals an assistant needs to cite it correctly.`
        : deliberateOptOut && blockers.length === 0
          ? `${blockedBots.length} of ${totalBots} AI crawlers are blocked, by rules that either name them directly or scope a path deliberately (${blockedNames.slice(0, 6).join(", ")}${blockedNames.length > 6 ? ", …" : ""}). That reads as a decision rather than an accident, and it is a legitimate one - just be clear about the consequence: this content will not appear as a source in those assistants' answers. Everything else on the page is in good order.`
          : `${allowedBots.length} of ${totalBots} AI crawlers can reach this URL. The biggest blocker is that ${blockers[0]}.${blockers.length > 1 ? ` Also holding it back: ${blockers.slice(1).join("; ")}.` : ""}`,
    fix:
      severity === "pass" || (deliberateOptOut && blockers.length === 0)
        ? undefined
        : `Fix in this order: ${blockers.slice(0, 3).map((b, i) => `${i + 1}) ${b}`).join(", ")}.`,
    value: `${allowedBots.length}/${totalBots} AI crawlers allowed${blockedNames.length > 0 ? `; blocked: ${blockedNames.join(", ")}` : ""}`,
    docs: "https://llmstxt.org/",
    weight: 4,
  });

  return findings;
}
