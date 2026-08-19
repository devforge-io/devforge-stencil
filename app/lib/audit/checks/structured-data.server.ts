/**
 * Structured data checks: JSON-LD, microdata and RDFa - the schema.org markup
 * that turns a plain blue link into a rich result.
 *
 * Self-contained by design - no shared helpers, so this module can evolve
 * independently of its sibling check modules.
 */

import type { Finding, PageContext } from "~/lib/audit/types";

type JsonObject = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                           */
/* -------------------------------------------------------------------------- */

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncate(value: string, max = 200): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/** Strip a schema.org prefix and any namespace so `schema:Article` -> `Article`. */
function normaliseType(value: string): string {
  const withoutHost = value.replace(/^https?:\/\/schema\.org\/?/i, "");
  const withoutNamespace = withoutHost.replace(/^schema:/i, "");
  const segments = withoutNamespace.split(/[/#]/);
  return (segments[segments.length - 1] ?? withoutNamespace).trim();
}

/** `@type` may be a string or an array of strings. */
function typesOf(node: JsonObject): string[] {
  const raw = node["@type"] ?? node["type"];
  if (typeof raw === "string") {
    const single = normaliseType(raw);
    return single.length > 0 ? [single] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is string => typeof entry === "string")
      .map(normaliseType)
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/** `@context` may be a string, an array, or an object with `@vocab`. */
function contextStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => contextStrings(entry, depth + 1));
  }
  if (isObject(value)) {
    return Object.values(value).flatMap((entry) => contextStrings(entry, depth + 1));
  }
  return [];
}

function isSchemaOrgContext(node: JsonObject): boolean {
  return contextStrings(node["@context"]).some((entry) =>
    /^https?:\/\/schema\.org\/?$/i.test(entry.trim()),
  );
}

interface GraphNode {
  value: JsonObject;
  /** True when the node came from inside an `@graph`, so it inherits the parent context. */
  fromGraph: boolean;
  /** True when the node exists only to wrap an `@graph` and describes nothing itself. */
  isContainer: boolean;
}

/** Top-level nodes: every parsed block, plus anything inside an `@graph`. */
function collectNodes(value: unknown, out: GraphNode[], fromGraph = false, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectNodes(entry, out, fromGraph, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  const hasGraph = value["@graph"] !== undefined;
  out.push({
    value,
    fromGraph,
    isContainer: hasGraph && typesOf(value).length === 0,
  });
  if (hasGraph) collectNodes(value["@graph"], out, true, depth + 1);
}

/** A property counts as present when it carries a non-empty value. */
function hasValue(node: JsonObject, key: string): boolean {
  const value = node[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  if (typeof value === "number") return true;
  if (typeof value === "boolean") return true;
  return false;
}

function missingProps(node: JsonObject, required: string[]): string[] {
  return required.filter((key) => !hasValue(node, key));
}

/** Depth-limited walk collecting string values of URL-shaped properties. */
function collectUrlValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectUrlValues(entry, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      (lower === "url" || lower === "logo" || lower === "image" || lower === "contenturl" || lower === "@id") &&
      typeof entry === "string"
    ) {
      out.push(entry);
    }
    collectUrlValues(entry, out, depth + 1);
  }
}

function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/* Type specifications                                                         */
/* -------------------------------------------------------------------------- */

const LOCAL_BUSINESS_TYPES = new Set(
  [
    "LocalBusiness",
    "Restaurant",
    "Store",
    "ProfessionalService",
    "Dentist",
    "Physician",
    "MedicalBusiness",
    "LegalService",
    "Attorney",
    "HomeAndConstructionBusiness",
    "AutomotiveBusiness",
    "FoodEstablishment",
    "Cafe",
    "Bakery",
    "BarOrPub",
    "HealthAndBeautyBusiness",
    "HairSalon",
    "RealEstateAgent",
    "TravelAgency",
    "Hotel",
    "Lodging",
    "LodgingBusiness",
    "FinancialService",
    "InsuranceAgency",
    "AccountingService",
    "Plumber",
    "Electrician",
    "GeneralContractor",
  ].map((entry) => entry.toLowerCase()),
);

const ARTICLE_TYPES = new Set(
  ["Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report", "LiveBlogPosting"].map(
    (entry) => entry.toLowerCase(),
  ),
);

interface TypeSpec {
  /** Slug fragment used in the finding id, e.g. "organization". */
  slug: string;
  label: string;
  matches: (types: string[]) => boolean;
  required: string[];
  /** At least one of these must be present, when supplied. */
  oneOf?: { label: string; props: string[] };
  docs: string;
  weight: number;
  why: string;
}

const TYPE_SPECS: TypeSpec[] = [
  {
    slug: "organization",
    label: "Organization",
    matches: (types) => types.some((type) => type.toLowerCase() === "organization" || type.toLowerCase() === "corporation" || type.toLowerCase() === "ngo"),
    required: ["name", "url", "logo"],
    docs: "https://developers.google.com/search/docs/appearance/structured-data/organization",
    weight: 2,
    why: "Organization markup is what feeds the knowledge panel and the logo shown beside your results.",
  },
  {
    slug: "website",
    label: "WebSite",
    matches: (types) => types.some((type) => type.toLowerCase() === "website"),
    required: ["name", "url"],
    docs: "https://developers.google.com/search/docs/appearance/site-names",
    weight: 2,
    why: "WebSite markup drives the site name shown above your result and enables the sitelinks search box.",
  },
  {
    slug: "article",
    label: "Article",
    matches: (types) => types.some((type) => ARTICLE_TYPES.has(type.toLowerCase())),
    required: ["headline", "image", "datePublished", "author"],
    docs: "https://developers.google.com/search/docs/appearance/structured-data/article",
    weight: 3,
    why: "Article markup supplies the thumbnail, byline and date that make an editorial result stand out.",
  },
  {
    slug: "product",
    label: "Product",
    matches: (types) => types.some((type) => type.toLowerCase() === "product" || type.toLowerCase() === "productgroup"),
    required: ["name", "image"],
    oneOf: { label: "offers, review or aggregateRating", props: ["offers", "review", "aggregateRating"] },
    docs: "https://developers.google.com/search/docs/appearance/structured-data/product",
    weight: 3,
    why: "Without price and availability a Product block cannot produce a merchant rich result.",
  },
  {
    slug: "breadcrumb",
    label: "BreadcrumbList",
    matches: (types) => types.some((type) => type.toLowerCase() === "breadcrumblist"),
    required: ["itemListElement"],
    docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb",
    weight: 2,
    why: "Breadcrumbs replace the raw URL in the search result with a readable site hierarchy.",
  },
  {
    slug: "faq",
    label: "FAQPage",
    matches: (types) => types.some((type) => type.toLowerCase() === "faqpage"),
    required: ["mainEntity"],
    docs: "https://developers.google.com/search/docs/appearance/structured-data/faqpage",
    weight: 2,
    why: "FAQPage markup with no mainEntity declares questions exist without ever listing them.",
  },
  {
    slug: "localbusiness",
    label: "LocalBusiness",
    matches: (types) => types.some((type) => LOCAL_BUSINESS_TYPES.has(type.toLowerCase())),
    required: ["name", "address", "telephone"],
    docs: "https://developers.google.com/search/docs/appearance/structured-data/local-business",
    weight: 3,
    why: "Local results depend on a machine-readable address and phone number.",
  },
  {
    slug: "person",
    label: "Person",
    matches: (types) => types.some((type) => type.toLowerCase() === "person"),
    required: ["name"],
    docs: "https://schema.org/Person",
    weight: 1,
    why: "A Person node without a name cannot be associated with an author or an entity.",
  },
];

/* -------------------------------------------------------------------------- */
/* Check                                                                       */
/* -------------------------------------------------------------------------- */

export function structuredDataChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;

  const siteName = (() => {
    const raw = doc.metaByProperty["og:site_name"];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    try {
      const host = new URL(ctx.origin).hostname.replace(/^www\./, "");
      const label = host.split(".")[0] ?? host;
      return label.charAt(0).toUpperCase() + label.slice(1);
    } catch {
      return "Your Site";
    }
  })();

  const organizationSnippet = [
    `<script type="application/ld+json">`,
    `{`,
    `  "@context": "https://schema.org",`,
    `  "@graph": [`,
    `    {`,
    `      "@type": "Organization",`,
    `      "@id": "${ctx.origin}/#organization",`,
    `      "name": "${siteName}",`,
    `      "url": "${ctx.origin}",`,
    `      "logo": "${ctx.origin}/logo.png"`,
    `    },`,
    `    {`,
    `      "@type": "WebSite",`,
    `      "@id": "${ctx.origin}/#website",`,
    `      "name": "${siteName}",`,
    `      "url": "${ctx.origin}",`,
    `      "publisher": { "@id": "${ctx.origin}/#organization" }`,
    `    }`,
    `  ]`,
    `}`,
    `</script>`,
  ].join("\n");

  const blocks = Array.isArray(doc.jsonLd) ? doc.jsonLd : [];
  const graphNodes: GraphNode[] = [];
  for (const block of blocks) collectNodes(block, graphNodes);
  /** Everything that actually describes an entity - `@graph` wrappers excluded. */
  const nodes: JsonObject[] = graphNodes
    .filter((entry) => !entry.isContainer)
    .map((entry) => entry.value);

  const jsonLdErrors = typeof doc.jsonLdErrors === "number" ? doc.jsonLdErrors : 0;
  const hasAnyStructuredData =
    blocks.length > 0 || jsonLdErrors > 0 || doc.hasMicrodata === true || doc.hasRdfa === true;

  /* ---------------------------------------------------------------------- */
  /* Nothing at all                                                          */
  /* ---------------------------------------------------------------------- */

  if (!hasAnyStructuredData) {
    findings.push({
      id: "sd-none",
      category: "structured-data",
      severity: "warning",
      title: "No structured data of any kind",
      detail:
        "The page carries no JSON-LD, no microdata and no RDFa. Search engines have to infer what this page is about entirely from prose, which rules out every rich result - logo, site name, breadcrumbs, ratings, FAQ accordions - and gives AI assistants no reliable entity data to cite.",
      fix: "Add a JSON-LD block declaring at minimum the Organization behind the site and the WebSite itself, then layer page-specific types (Article, Product, FAQPage, BreadcrumbList) on top.",
      snippet: organizationSnippet,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 4,
    });
    return findings;
  }

  /* ---------------------------------------------------------------------- */
  /* Parse failures                                                          */
  /* ---------------------------------------------------------------------- */

  if (jsonLdErrors > 0) {
    findings.push({
      id: "sd-jsonld-invalid",
      category: "structured-data",
      severity: "critical",
      title: "Malformed JSON-LD block",
      detail: `${jsonLdErrors} application/ld+json block${jsonLdErrors === 1 ? "" : "s"} failed to parse as JSON. Invalid JSON-LD is not partially read - the whole block is discarded, so all the markup inside it is invisible to Google while still costing you page weight.`,
      value: `${jsonLdErrors} unparseable ld+json block${jsonLdErrors === 1 ? "" : "s"}`,
      fix: "Run the block through the Rich Results Test to find the syntax error. The usual causes are a trailing comma, an unescaped double quote or apostrophe inside a string, single quotes instead of double, or a template variable that rendered as undefined.",
      docs: "https://search.google.com/test/rich-results",
      weight: 5,
    });
  }

  if (blocks.length > 0 && nodes.length === 0) {
    findings.push({
      id: "sd-jsonld-empty",
      category: "structured-data",
      severity: "warning",
      title: "JSON-LD blocks contain no entities",
      detail:
        "One or more ld+json blocks parsed successfully but produced no schema.org objects - typically an empty object, an empty array, or a bare string where a graph was expected.",
      fix: "Populate the block with at least one typed entity, or remove the empty script tag.",
      snippet: organizationSnippet,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Per-node hygiene: @context and @type                                    */
  /* ---------------------------------------------------------------------- */

  const allTypes = new Set<string>();
  let missingContext = 0;
  let nonSchemaContext = 0;
  let missingType = 0;
  const nonSchemaContextSamples: string[] = [];

  for (const entry of graphNodes) {
    const node = entry.value;
    const types = typesOf(node);
    for (const type of types) allTypes.add(type);
    if (types.length === 0 && !entry.isContainer) missingType += 1;

    if (node["@context"] === undefined) {
      // Nodes inside an @graph legitimately inherit the wrapper's context.
      if (!entry.fromGraph) missingContext += 1;
    } else if (!isSchemaOrgContext(node)) {
      nonSchemaContext += 1;
      const sample = contextStrings(node["@context"])[0];
      if (sample !== undefined && !nonSchemaContextSamples.includes(sample)) {
        nonSchemaContextSamples.push(sample);
      }
    }
  }

  if (missingContext > 0) {
    findings.push({
      id: "sd-context-missing",
      category: "structured-data",
      severity: "warning",
      title: "JSON-LD block has no @context",
      detail: `${missingContext} top-level JSON-LD node${missingContext === 1 ? " has" : "s have"} no @context. Without it the vocabulary is undefined, so consumers cannot tell that "name" means schema.org's name and the entire block is ignored.`,
      fix: 'Add "@context": "https://schema.org" as the first key of each top-level JSON-LD object.',
      snippet: `{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "${siteName}"\n}`,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 3,
    });
  }

  if (nonSchemaContext > 0) {
    findings.push({
      id: "sd-context-invalid",
      category: "structured-data",
      severity: "warning",
      title: "@context does not point at schema.org",
      detail: `${nonSchemaContext} JSON-LD node${nonSchemaContext === 1 ? " declares" : "s declare"} a context other than schema.org. Google only reads the schema.org vocabulary for rich results, so markup under another vocabulary is parsed and then discarded.`,
      value: nonSchemaContextSamples.join(", ") || undefined,
      fix: 'Set "@context" to "https://schema.org" (https, no trailing path). If you genuinely need another vocabulary, add schema.org alongside it in an array.',
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 3,
    });
  }

  if (missingType > 0) {
    findings.push({
      id: "sd-type-missing",
      category: "structured-data",
      severity: "warning",
      title: "JSON-LD entity with no @type",
      detail: `${missingType} node${missingType === 1 ? " has" : "s have"} no @type. An untyped entity tells search engines that something exists but not what it is, so none of its properties can be mapped to a rich result.`,
      fix: 'Give every entity an "@type" naming a schema.org class - Organization, WebSite, Article, Product, BreadcrumbList and so on.',
      docs: "https://schema.org/docs/full.html",
      weight: 3,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Inventory of what was found                                             */
  /* ---------------------------------------------------------------------- */

  const typeList = Array.from(allTypes).sort((a, b) => a.localeCompare(b));

  if (typeList.length > 0) {
    findings.push({
      id: "sd-types-found",
      category: "structured-data",
      severity: "pass",
      title: `Structured data found: ${typeList.length} schema type${typeList.length === 1 ? "" : "s"}`,
      detail: `Valid JSON-LD is present on the page describing ${typeList.length === 1 ? "this entity" : "these entities"}. Each type is a chance at a different rich result treatment.`,
      value: typeList.join(", "),
      docs: "https://validator.schema.org/",
      weight: 3,
    });
  }

  if (blocks.length > 0 && nodes.length > 0 && jsonLdErrors === 0) {
    findings.push({
      id: "sd-jsonld-valid",
      category: "structured-data",
      severity: "pass",
      title: "All JSON-LD parses cleanly",
      detail: `${blocks.length} ld+json block${blocks.length === 1 ? "" : "s"} parsed without error, yielding ${nodes.length} entit${nodes.length === 1 ? "y" : "ies"}.`,
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Type-specific required properties                                       */
  /* ---------------------------------------------------------------------- */

  for (const spec of TYPE_SPECS) {
    const matching = nodes.filter((node) => spec.matches(typesOf(node)));
    if (matching.length === 0) continue;

    const missing = new Set<string>();
    let incomplete = 0;

    for (const node of matching) {
      const gaps = missingProps(node, spec.required);
      let failsOneOf = false;
      if (spec.oneOf !== undefined) {
        failsOneOf = !spec.oneOf.props.some((prop) => hasValue(node, prop));
      }
      if (gaps.length > 0 || failsOneOf) {
        incomplete += 1;
        for (const gap of gaps) missing.add(gap);
        if (failsOneOf && spec.oneOf !== undefined) missing.add(spec.oneOf.label);
      }
    }

    if (incomplete > 0) {
      const missingList = Array.from(missing).join(", ");
      findings.push({
        id: `sd-${spec.slug}-incomplete`,
        category: "structured-data",
        severity: "warning",
        title: `${spec.label} markup is missing required properties`,
        detail: `${incomplete} of ${matching.length} ${spec.label} node${matching.length === 1 ? "" : "s"} omit properties Google needs: ${missingList}. ${spec.why} Incomplete blocks are usually ignored wholesale rather than partially honoured.`,
        value: `missing: ${missingList}`,
        fix: `Add ${missingList} to the ${spec.label} block, then re-test the page in the Rich Results Test to confirm the result type is eligible.`,
        docs: spec.docs,
        weight: spec.weight,
      });
    } else {
      findings.push({
        id: `sd-${spec.slug}-ok`,
        category: "structured-data",
        severity: "pass",
        title: `${spec.label} markup is complete`,
        detail: `${matching.length} ${spec.label} node${matching.length === 1 ? "" : "s"} carr${matching.length === 1 ? "ies" : "y"} every required property (${spec.required.join(", ")}${spec.oneOf !== undefined ? `, ${spec.oneOf.label}` : ""}).`,
        docs: spec.docs,
        weight: spec.weight,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* WebSite: sitelinks search box                                           */
  /* ---------------------------------------------------------------------- */

  const websiteNodes = nodes.filter((node) =>
    typesOf(node).some((type) => type.toLowerCase() === "website"),
  );
  if (websiteNodes.length > 0 && !websiteNodes.some((node) => hasValue(node, "potentialAction"))) {
    findings.push({
      id: "sd-website-no-searchaction",
      category: "structured-data",
      severity: "info",
      title: "WebSite markup declares no SearchAction",
      detail:
        "The WebSite entity has no potentialAction. A SearchAction is what makes Google render a search box inside your sitelinks, letting people query your site directly from the results page.",
      fix: "Add a SearchAction pointing at your on-site search URL with a {search_term_string} placeholder. Only add it if you actually have a working search endpoint.",
      snippet: [
        `"potentialAction": {`,
        `  "@type": "SearchAction",`,
        `  "target": {`,
        `    "@type": "EntryPoint",`,
        `    "urlTemplate": "${ctx.origin}/search?q={search_term_string}"`,
        `  },`,
        `  "query-input": "required name=search_term_string"`,
        `}`,
      ].join("\n"),
      docs: "https://developers.google.com/search/docs/appearance/structured-data/sitelinks-searchbox",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* BreadcrumbList: empty itemListElement                                   */
  /* ---------------------------------------------------------------------- */

  const breadcrumbNodes = nodes.filter((node) =>
    typesOf(node).some((type) => type.toLowerCase() === "breadcrumblist"),
  );
  for (const node of breadcrumbNodes) {
    const items = node["itemListElement"];
    if (Array.isArray(items) && items.length === 1) {
      findings.push({
        id: "sd-breadcrumb-single-item",
        category: "structured-data",
        severity: "info",
        title: "Breadcrumb trail has only one item",
        detail:
          "The BreadcrumbList contains a single element. Google needs at least two levels before it will replace the URL in the search result with a breadcrumb trail, so a one-item list has no effect.",
        fix: "Include every ancestor from the home page down to the current page, each with a position, name and item URL.",
        docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb",
        weight: 1,
      });
      break;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Date and URL hygiene inside the graph                                   */
  /* ---------------------------------------------------------------------- */

  const badDates: string[] = [];
  for (const node of nodes) {
    for (const key of ["datePublished", "dateModified", "uploadDate", "startDate", "endDate"]) {
      const value = asString(node[key]);
      if (value !== null && !looksLikeIsoDate(value)) badDates.push(`${key}="${truncate(value, 40)}"`);
    }
  }
  if (badDates.length > 0) {
    findings.push({
      id: "sd-date-format-invalid",
      category: "structured-data",
      severity: "warning",
      title: "Dates in structured data are not ISO 8601",
      detail:
        "One or more date properties use a human-readable format. Schema.org date fields must be ISO 8601, and Google drops properties it cannot parse - which for Article markup means losing the publication date shown in the result.",
      value: badDates.slice(0, 5).join(", "),
      fix: 'Format dates as "2026-01-15" or, better, with a time and offset: "2026-01-15T09:00:00+10:00".',
      docs: "https://developers.google.com/search/docs/appearance/structured-data/article",
      weight: 2,
    });
  }

  const urlValues: string[] = [];
  collectUrlValues(blocks, urlValues);
  const relativeUrls = Array.from(
    new Set(urlValues.filter((value) => value.trim().length > 0 && !hasScheme(value) && !value.startsWith("#"))),
  );
  if (relativeUrls.length > 0) {
    findings.push({
      id: "sd-relative-urls",
      category: "structured-data",
      severity: "warning",
      title: "Structured data contains relative URLs",
      detail:
        "URL, logo, image or @id properties use relative paths. Schema.org URL values are expected to be absolute, and parsers that read the JSON-LD outside the context of the page - including AI crawlers working from a cached copy - cannot resolve them.",
      value: relativeUrls.slice(0, 5).map((value) => truncate(value, 60)).join(", "),
      fix: `Prefix every URL, logo, image and @id with the origin, e.g. "${ctx.origin}/logo.png".`,
      docs: "https://schema.org/URL",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Entity coverage gaps                                                    */
  /* ---------------------------------------------------------------------- */

  const lowerTypes = new Set(typeList.map((type) => type.toLowerCase()));
  const hasArticleSchema = Array.from(lowerTypes).some((type) => ARTICLE_TYPES.has(type));
  const looksEditorial = doc.landmarks.includes("article") || doc.wordCount > 700;

  if (!hasArticleSchema && looksEditorial) {
    findings.push({
      id: "sd-article-content-without-schema",
      category: "structured-data",
      severity: "info",
      title: "Editorial content with no Article markup",
      detail: `The page ${doc.landmarks.includes("article") ? "uses an <article> landmark" : `runs to ${doc.wordCount} words`} but declares no Article or BlogPosting schema. Article markup is what supplies the thumbnail, byline and publication date in search results and is heavily used by AI assistants for attribution.`,
      fix: "Add an Article (or BlogPosting) block with headline, image, datePublished, dateModified and an author entity that links to a real bio page.",
      snippet: [
        `<script type="application/ld+json">`,
        `{`,
        `  "@context": "https://schema.org",`,
        `  "@type": "Article",`,
        `  "headline": "${truncate(typeof doc.title === "string" ? doc.title : "Page headline", 110)}",`,
        `  "image": ["${ctx.origin}/article-image.jpg"],`,
        `  "datePublished": "2026-01-15T09:00:00+10:00",`,
        `  "dateModified": "2026-01-15T09:00:00+10:00",`,
        `  "author": { "@type": "Person", "name": "Author Name", "url": "${ctx.origin}/about" },`,
        `  "publisher": { "@type": "Organization", "name": "${siteName}", "logo": { "@type": "ImageObject", "url": "${ctx.origin}/logo.png" } },`,
        `  "mainEntityOfPage": "${ctx.finalUrl}"`,
        `}`,
        `</script>`,
      ].join("\n"),
      docs: "https://developers.google.com/search/docs/appearance/structured-data/article",
      weight: 2,
    });
  }

  const hasIdentityEntity = Array.from(lowerTypes).some(
    (type) =>
      type === "organization" ||
      type === "corporation" ||
      type === "ngo" ||
      type === "person" ||
      LOCAL_BUSINESS_TYPES.has(type),
  );
  if (nodes.length > 0 && !hasIdentityEntity) {
    findings.push({
      id: "sd-identity-missing",
      category: "structured-data",
      severity: "info",
      title: "No entity describing who publishes this site",
      detail:
        "There is structured data on the page, but nothing declares the Organization, LocalBusiness or Person behind it. That entity is what search engines and AI assistants attach a knowledge panel, a logo and a set of social profiles to.",
      fix: "Add an Organization (or Person, for a personal site) block with name, url, logo and sameAs links to your official social profiles, and reference it by @id from other entities.",
      snippet: organizationSnippet,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/organization",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Format preferences: microdata / RDFa                                    */
  /* ---------------------------------------------------------------------- */

  const jsonLdUsable = nodes.length > 0;

  if (!jsonLdUsable && (doc.hasMicrodata === true || doc.hasRdfa === true)) {
    const format = doc.hasMicrodata === true && doc.hasRdfa === true ? "microdata and RDFa" : doc.hasMicrodata === true ? "microdata" : "RDFa";
    findings.push({
      id: "sd-microdata-only",
      category: "structured-data",
      severity: "info",
      title: `Structured data is ${format} only`,
      detail: `Schema.org markup is expressed as ${format} inline in the HTML with no JSON-LD equivalent. Google reads all three formats but explicitly recommends JSON-LD, because it lives in one block, survives template refactors, and can be emitted server-side without touching presentational markup.`,
      value: format,
      fix: "Move the equivalent entities into a single application/ld+json script in the head. You can leave the inline attributes in place during the transition - duplicate declarations of the same entity are tolerated.",
      snippet: organizationSnippet,
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 2,
    });
  } else if (jsonLdUsable && (doc.hasMicrodata === true || doc.hasRdfa === true)) {
    findings.push({
      id: "sd-mixed-formats",
      category: "structured-data",
      severity: "info",
      title: "Both JSON-LD and inline markup are present",
      detail:
        "The page carries JSON-LD as well as microdata or RDFa. That is legal and Google merges them, but two sources of truth for the same entity drift apart over time and produce contradictory values that are hard to debug.",
      fix: "Pick JSON-LD as the single source of truth and strip the inline itemscope/itemprop or vocab/typeof attributes once the JSON-LD covers the same entities.",
      docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
      weight: 1,
    });
  }

  return findings;
}
