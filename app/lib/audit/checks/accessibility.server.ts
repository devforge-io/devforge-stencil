/**
 * Accessibility checks.
 *
 * Everything here is derived from the static HTML: no browser, no rendering,
 * no computed styles. That bounds what can be verified - see the
 * `a11y-static-analysis-scope` finding, which is always emitted so a clean
 * result is never mistaken for a WCAG conformance claim.
 *
 * Some markup is inspected by other check modules too (the meta module reads
 * <html lang> and the viewport tag; the SEO module reads alt text and anchor
 * text). Those overlaps are intentional: the framing and finding ids here are
 * assistive-technology specific and deliberately distinct.
 */

import type { Finding, FormField, PageContext } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Local helpers                                                              */
/* -------------------------------------------------------------------------- */

function shorten(input: string, max = 160): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quoteList(values: string[], max = 5): string {
  const shown = values.slice(0, max).map((v) => `"${shorten(v, 60)}"`);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

function count(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

/** BCP-47 shape: primary subtag plus optional script/region/variant subtags. */
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Link text that tells a screen-reader user nothing when read out of context. */
const UNDESCRIPTIVE_LINK_TEXT = new Set([
  "click here",
  "click",
  "here",
  "read more",
  "more",
  "learn more",
  "link",
  "this",
  "this link",
  "continue",
  "go",
  "details",
  "download",
  "see more",
  "view more",
  "more info",
  "more information",
]);

function flattenLinkText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Input types that are not user-editable and therefore need no visible label. */
const UNLABELLABLE_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);

function needsLabel(field: FormField): boolean {
  if (field.tag !== "input") return true;
  const type = (field.type ?? "text").toLowerCase();
  return !UNLABELLABLE_INPUT_TYPES.has(type);
}

function describeField(field: FormField): string {
  const type = field.tag === "input" ? `input[type=${field.type ?? "text"}]` : field.tag;
  const identifier = field.name ?? field.id;
  return identifier ? `${type} "${identifier}"` : type;
}

/** Hrefs that conventionally target the start of the main content region. */
const SKIP_LINK_TARGETS = [
  "#main",
  "#content",
  "#main-content",
  "#maincontent",
  "#primary",
  "#skip",
  "#skip-to-content",
  "#page-content",
  "#site-content",
];

/* -------------------------------------------------------------------------- */
/* Check module                                                               */
/* -------------------------------------------------------------------------- */

export function accessibilityChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const doc = ctx.doc;

  /* ---------------------------------------------------------------------- */
  /* Document language                                                      */
  /* ---------------------------------------------------------------------- */

  const lang = doc.lang;
  if (!lang || lang.trim() === "") {
    findings.push({
      id: "a11y-lang-missing",
      category: "accessibility",
      severity: "critical",
      title: "<html> has no lang attribute",
      detail:
        "Screen readers choose a pronunciation voice from the document language. With no lang attribute the reader falls back to the user's system language, so English content can be read aloud with German or Spanish phonetics - often literally incomprehensible. This is a WCAG 2.2 Level A failure (3.1.1 Language of Page).",
      fix: "Set the language on the root element, using a BCP-47 tag that matches the page's primary content language.",
      snippet: '<html lang="en-AU">',
      docs: "https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html",
      weight: 3,
    });
  } else if (!BCP47.test(lang.trim())) {
    findings.push({
      id: "a11y-lang-malformed",
      category: "accessibility",
      severity: "warning",
      title: "Malformed lang attribute",
      detail:
        "The lang value is not a well-formed BCP-47 language tag, so assistive technology cannot map it to a voice and will fall back to the user's default. Common mistakes are underscores instead of hyphens, full language names, and country codes used as languages.",
      fix: 'Use a valid BCP-47 tag: a two- or three-letter language subtag, optionally followed by a region - "en", "en-GB", "pt-BR".',
      snippet: '<html lang="en-GB">',
      value: shorten(lang, 60),
      docs: "https://www.w3.org/International/questions/qa-html-language-declarations",
      weight: 2,
    });
  } else {
    findings.push({
      id: "a11y-lang-ok",
      category: "accessibility",
      severity: "pass",
      title: "Document language declared",
      detail: "Assistive technology can select the correct pronunciation voice for this page.",
      value: shorten(lang, 40),
      weight: 3,
    });
  }

  if (doc.hasDir) {
    findings.push({
      id: "a11y-dir-declared",
      category: "accessibility",
      severity: "info",
      title: "Text direction declared",
      detail:
        "The document sets an explicit dir attribute. That is what right-to-left languages need for correct bidirectional text ordering, and it is harmless on left-to-right pages.",
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/dir",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Images                                                                 */
  /* ---------------------------------------------------------------------- */

  const images = doc.images;
  const noAltAttribute = images.filter((img) => img.alt === null);
  const decorative = images.filter((img) => img.alt !== null && img.alt.trim() === "");
  const described = images.filter((img) => img.alt !== null && img.alt.trim() !== "");

  if (noAltAttribute.length > 0) {
    findings.push({
      id: "a11y-image-alt-missing",
      category: "accessibility",
      severity: "critical",
      title: `${noAltAttribute.length} ${count(noAltAttribute.length, "image", "images")} with no alt attribute`,
      detail:
        "When the alt attribute is absent entirely, screen readers fall back to announcing the filename - \"i-m-g underscore 4 8 2 1 dot j-p-g\" - or skip the image with no indication anything was there. Content conveyed only by these images is unavailable to blind users. WCAG 2.2 Level A failure (1.1.1 Non-text Content).",
      fix: "Give every <img> an alt attribute. Describe what the image conveys in context; if it conveys nothing (a divider, a decorative flourish), use an explicitly empty alt=\"\" so assistive tech skips it deliberately.",
      snippet: '<img src="/team.jpg" alt="Four engineers reviewing a wiring diagram">\n<img src="/divider.svg" alt="">',
      value: quoteList(noAltAttribute.map((img) => img.src ?? "(no src)")),
      docs: "https://www.w3.org/WAI/tutorials/images/",
      weight: 3,
    });
  } else if (images.length > 0) {
    findings.push({
      id: "a11y-image-alt-complete",
      category: "accessibility",
      severity: "pass",
      title: "Every image declares alt",
      detail: `All ${images.length} ${count(images.length, "image")} carry an alt attribute, so screen readers never announce a raw filename.`,
      value: `${described.length} descriptive, ${decorative.length} decorative`,
      weight: 3,
    });
  }

  if (decorative.length > 0) {
    findings.push({
      id: "a11y-image-decorative-marked",
      category: "accessibility",
      severity: "pass",
      title: `${decorative.length} decorative ${count(decorative.length, "image is", "images are")} correctly marked`,
      detail:
        'These images use alt="" - the correct way to hide purely presentational imagery from screen readers so it does not clutter the reading order. An empty alt is a deliberate decision, not a missing one.',
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Forms                                                                  */
  /* ---------------------------------------------------------------------- */

  const fields = doc.formFields.filter(needsLabel);
  const unlabelled = fields.filter(
    (f) => !f.hasLabel && !f.ariaLabel?.trim() && !f.ariaLabelledBy?.trim(),
  );
  const placeholderOnly = unlabelled.filter((f) => (f.placeholder ?? "").trim() !== "");
  const totallyUnlabelled = unlabelled.filter((f) => (f.placeholder ?? "").trim() === "");

  if (fields.length === 0) {
    findings.push({
      id: "a11y-form-fields-none",
      category: "accessibility",
      severity: "info",
      title: "No form fields on the page",
      detail: "There are no user-editable inputs, selects or textareas, so form labelling does not apply here.",
      weight: 1,
    });
  }

  if (totallyUnlabelled.length > 0) {
    findings.push({
      id: "a11y-form-field-unlabelled",
      category: "accessibility",
      severity: "critical",
      title: `${totallyUnlabelled.length} form ${count(totallyUnlabelled.length, "field has", "fields have")} no accessible name`,
      detail:
        "These fields have no associated <label>, no aria-label and no aria-labelledby. A screen reader announces them as just \"edit text\" or \"combo box\", leaving the user to guess what to type. Voice-control users cannot target them by name either. WCAG 2.2 Level A failure (1.3.1, 4.1.2).",
      fix: "Associate a visible <label> with each field via for/id. Where a visible label genuinely cannot be shown, use aria-label - but a visible label is better for everyone, including users with cognitive disabilities.",
      snippet: '<label for="email">Email address</label>\n<input id="email" name="email" type="email" autocomplete="email">',
      value: quoteList(totallyUnlabelled.map(describeField)),
      docs: "https://www.w3.org/WAI/tutorials/forms/labels/",
      weight: 3,
    });
  }

  if (placeholderOnly.length > 0) {
    findings.push({
      id: "a11y-form-placeholder-only",
      category: "accessibility",
      severity: "warning",
      title: `${placeholderOnly.length} ${count(placeholderOnly.length, "field", "fields")} labelled only by placeholder`,
      detail:
        "A placeholder is not a label. It disappears the moment the user types, so anyone who is interrupted mid-form loses the only description of the field. Placeholder text is also rendered in low-contrast grey by default, and several screen reader / browser combinations do not announce it at all.",
      fix: "Add a real <label> and keep the placeholder for example formatting only - or drop the placeholder entirely.",
      snippet: '<label for="phone">Phone number</label>\n<input id="phone" name="phone" type="tel" placeholder="04XX XXX XXX">',
      value: quoteList(placeholderOnly.map((f) => `${describeField(f)} - placeholder "${f.placeholder ?? ""}"`)),
      docs: "https://www.w3.org/WAI/tutorials/forms/instructions/#placeholder-text",
      weight: 2,
    });
  }

  if (fields.length > 0 && unlabelled.length === 0) {
    findings.push({
      id: "a11y-form-labels-ok",
      category: "accessibility",
      severity: "pass",
      title: `All ${fields.length} form ${count(fields.length, "field has", "fields have")} an accessible name`,
      detail: "Every editable field is labelled by a <label>, aria-label or aria-labelledby, so assistive technology can announce its purpose.",
      weight: 3,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Iframes                                                                */
  /* ---------------------------------------------------------------------- */

  const iframes = doc.iframes;
  const untitledIframes = iframes.filter((frame) => !frame.title || frame.title.trim() === "");
  if (untitledIframes.length > 0) {
    findings.push({
      id: "a11y-iframe-title-missing",
      category: "accessibility",
      severity: "warning",
      title: `${untitledIframes.length} <iframe> without a title`,
      detail:
        "Screen readers list embedded frames the way they list links and headings. Without a title attribute the frame is announced as just \"frame\", so a user navigating by frame has no idea whether it is a video, a map, an advert or the checkout.",
      fix: "Add a short title describing the embedded content's purpose. Frames that carry nothing for the user (tracking pixels, hidden sync frames) should instead be removed from the accessibility tree.",
      snippet: '<iframe src="https://www.youtube.com/embed/…" title="Product walkthrough video"></iframe>\n<iframe src="/pixel" title="" aria-hidden="true" tabindex="-1"></iframe>',
      value: quoteList(untitledIframes.map((frame) => frame.src ?? "(no src)")),
      docs: "https://www.w3.org/WAI/WCAG22/Techniques/html/H64",
      weight: 2,
    });
  } else if (iframes.length > 0) {
    findings.push({
      id: "a11y-iframe-title-ok",
      category: "accessibility",
      severity: "pass",
      title: `All ${iframes.length} ${count(iframes.length, "iframe is", "iframes are")} titled`,
      detail: "Every embedded frame declares a title, so screen reader users can identify it in the frame list.",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Heading structure (assistive navigation)                               */
  /* ---------------------------------------------------------------------- */

  const headings = doc.headings;
  if (headings.length === 0) {
    findings.push({
      id: "a11y-headings-none",
      category: "accessibility",
      severity: "warning",
      title: "No headings to navigate by",
      detail:
        "Jumping between headings is the single most-used screen reader navigation technique - surveys consistently put it above landmarks and links. A page with no headings forces users to read linearly from the top with no way to skim.",
      fix: "Mark up section titles as real headings rather than styled <div>s, starting with one <h1>.",
      docs: "https://www.w3.org/WAI/tutorials/page-structure/headings/",
      weight: 2,
    });
  }

  const orderBreaks: string[] = [];
  for (let i = 1; i < headings.length; i += 1) {
    const previous = headings[i - 1];
    const current = headings[i];
    if (current.level > previous.level + 1) {
      orderBreaks.push(`h${previous.level} → h${current.level} ("${shorten(current.text || "(empty)", 45)}")`);
    }
  }
  if (orderBreaks.length > 0) {
    findings.push({
      id: "a11y-heading-order-broken",
      category: "accessibility",
      severity: "warning",
      title: `Screen-reader outline skips ${orderBreaks.length} ${count(orderBreaks.length, "level", "levels")}`,
      detail:
        "Screen readers expose headings as a nested tree, and users navigate it by level (\"next heading at this level\", \"jump to h2\"). A jump from h1 to h3 makes the h3 look like a child of a section that does not exist, so the outline the user builds mentally does not match the page.",
      fix: "Never skip levels going down. Choose the level by position in the document hierarchy and control the size with CSS.",
      snippet: "<h2 class=\"text-sm\">Visually small, structurally correct</h2>",
      value: quoteList(orderBreaks, 4),
      docs: "https://www.w3.org/WAI/tutorials/page-structure/headings/",
      weight: 2,
    });
  }

  const emptyHeadings = headings.filter((h) => h.text.trim() === "");
  if (emptyHeadings.length > 0) {
    findings.push({
      id: "a11y-heading-empty-text",
      category: "accessibility",
      severity: "warning",
      title: `${emptyHeadings.length} empty ${count(emptyHeadings.length, "heading")}`,
      detail:
        "An empty heading still appears in the screen reader's heading list, announced as a nameless entry. Users navigating by heading land on nothing and have to work out where they are.",
      fix: "Remove the empty heading, or give it text. If the heading is visual-only, use a styled element instead of a heading tag.",
      value: quoteList(emptyHeadings.map((h) => `h${h.level}`)),
      docs: "https://www.w3.org/WAI/WCAG22/Techniques/failures/F43",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Landmarks                                                              */
  /* ---------------------------------------------------------------------- */

  const landmarks = doc.landmarks;
  const roles = doc.roles.map((r) => r.toLowerCase());
  const hasLandmark = (tag: string, role: string): boolean =>
    landmarks.includes(tag) || roles.includes(role);

  findings.push({
    id: "a11y-landmarks-summary",
    category: "accessibility",
    severity: "info",
    title: landmarks.length > 0 ? `${landmarks.length} semantic ${count(landmarks.length, "landmark")} found` : "No semantic landmark elements found",
    detail:
      "Landmark regions let screen reader users jump straight to the navigation, the main content or the footer instead of tabbing through the page. This is what was detected in the markup.",
    value:
      `elements: ${landmarks.length > 0 ? landmarks.join(", ") : "none"}` +
      (roles.length > 0 ? ` | roles: ${shorten(roles.join(", "), 200)}` : " | roles: none"),
    docs: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
    weight: 1,
  });

  if (!hasLandmark("main", "main")) {
    findings.push({
      id: "a11y-landmark-main-missing",
      category: "accessibility",
      severity: "warning",
      title: "No <main> landmark",
      detail:
        "There is no <main> element and no role=\"main\". <main> is the target every skip link and every screen reader \"jump to main content\" shortcut relies on, so without it users must tab through the entire header and navigation on every page.",
      fix: "Wrap the page's primary content in a single <main> element, outside the header, nav and footer.",
      snippet: '<main id="main">\n  <h1>Page title</h1>\n  …\n</main>',
      docs: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/main",
      weight: 2,
    });
  } else {
    findings.push({
      id: "a11y-landmark-main-ok",
      category: "accessibility",
      severity: "pass",
      title: "Main content region declared",
      detail: "A <main> landmark (or role=\"main\") marks the primary content, giving assistive technology a jump target.",
      weight: 2,
    });
  }

  if (!hasLandmark("nav", "navigation")) {
    findings.push({
      id: "a11y-landmark-nav-missing",
      category: "accessibility",
      severity: "info",
      title: "No <nav> landmark",
      detail:
        "No <nav> element or role=\"navigation\" was found. Screen reader users often jump directly to the navigation landmark to move around a site; a list of links inside a plain <div> is not exposed as one.",
      fix: "Wrap primary and secondary link groups in <nav>. Label each one when there is more than one.",
      snippet: '<nav aria-label="Primary">\n  <ul>…</ul>\n</nav>',
      docs: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
      weight: 1,
    });
  }

  const hasBanner = hasLandmark("header", "banner");
  const hasContentInfo = hasLandmark("footer", "contentinfo");
  if (!hasBanner || !hasContentInfo) {
    const missing = [!hasBanner ? "<header> / role=banner" : null, !hasContentInfo ? "<footer> / role=contentinfo" : null]
      .filter((v): v is string => v !== null)
      .join(" and ");
    findings.push({
      id: "a11y-landmark-header-footer-missing",
      category: "accessibility",
      severity: "info",
      title: "Page banner or footer landmark missing",
      detail: `${missing} was not found. These landmarks bound the repeated page furniture, letting assistive technology skip over it and letting users find contact details, legal links and site-wide information predictably.`,
      fix: "Use <header> for the site banner and <footer> for the site information region, both as direct children of <body> rather than nested inside <main>.",
      snippet: "<body>\n  <header>…</header>\n  <main>…</main>\n  <footer>…</footer>\n</body>",
      docs: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
      weight: 1,
    });
  } else {
    findings.push({
      id: "a11y-landmark-header-footer-ok",
      category: "accessibility",
      severity: "pass",
      title: "Banner and footer landmarks present",
      detail: "The page furniture is bounded by header and footer landmarks, so it can be skipped or targeted directly.",
      weight: 1,
    });
  }

  const landmarkRoles = roles.filter((r) =>
    ["main", "navigation", "banner", "contentinfo", "complementary", "search", "form", "region"].includes(r),
  );
  if (landmarkRoles.length > 0 && landmarks.length === 0) {
    findings.push({
      id: "a11y-landmark-roles-substituting",
      category: "accessibility",
      severity: "info",
      title: "ARIA roles used instead of semantic elements",
      detail:
        "Landmark roles are declared on generic elements while no semantic sectioning elements were found. The roles do work, but native elements carry the same semantics with less markup and no risk of the role and the element disagreeing.",
      fix: "Prefer <main>, <nav>, <header>, <footer> and <aside> over div + role. Keep explicit roles only where the native element is unavailable.",
      value: landmarkRoles.join(", "),
      docs: "https://www.w3.org/TR/using-aria/#rule1",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Zoom                                                                   */
  /* ---------------------------------------------------------------------- */

  if (doc.viewportBlocksZoom) {
    findings.push({
      id: "a11y-zoom-disabled",
      category: "accessibility",
      severity: "critical",
      title: "Pinch-to-zoom is disabled",
      detail:
        "The viewport meta tag sets user-scalable=no or caps maximum-scale, preventing zoom. Low-vision users routinely zoom to 200–400% to read; blocking that makes the page unusable for them. WCAG 2.2 Level AA failure (1.4.4 Resize Text).",
      fix: "Remove user-scalable=no and any maximum-scale below 5 from the viewport meta tag. If zoom was disabled to stop iOS double-tap zoom on inputs, set a font-size of at least 16px on form fields instead.",
      snippet: '<meta name="viewport" content="width=device-width, initial-scale=1">',
      value: shorten(doc.metaByName["viewport"] ?? "(viewport tag blocks scaling)", 120),
      docs: "https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html",
      weight: 3,
    });
  } else {
    findings.push({
      id: "a11y-zoom-allowed",
      category: "accessibility",
      severity: "pass",
      title: "Zoom is not blocked",
      detail: "The viewport configuration allows users to pinch-zoom and scale text, which low-vision users depend on.",
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Links from a screen-reader perspective                                 */
  /* ---------------------------------------------------------------------- */

  const anchors = doc.anchors;
  const linkedAnchors = anchors.filter((a) => a.href !== null && a.href.trim() !== "");

  const namelessLinks = linkedAnchors.filter((a) => a.text.trim() === "");
  if (namelessLinks.length > 0) {
    findings.push({
      id: "a11y-link-no-accessible-name",
      category: "accessibility",
      severity: "critical",
      title: `${namelessLinks.length} ${count(namelessLinks.length, "link has", "links have")} no text content`,
      detail:
        "These anchors contain no text. Unless they wrap an image with alt text or carry an aria-label - neither of which this static pass can confirm - a screen reader announces only \"link\", and the user has to follow it to find out where it goes. Icon-only buttons and social links are the usual culprits. WCAG 2.2 Level A (2.4.4 Link Purpose, 4.1.2 Name Role Value).",
      fix: "Give each link an accessible name: visible text, visually-hidden text inside the anchor, or an aria-label. If the link wraps an icon, the icon should be aria-hidden and the name supplied separately.",
      snippet: '<a href="https://x.com/acme" aria-label="Acme on X">\n  <svg aria-hidden="true" focusable="false">…</svg>\n</a>',
      value: quoteList(namelessLinks.map((a) => a.href ?? "")),
      docs: "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html",
      weight: 3,
    });
  }

  const vagueLinks = linkedAnchors.filter((a) => UNDESCRIPTIVE_LINK_TEXT.has(flattenLinkText(a.text)));
  if (vagueLinks.length > 0) {
    findings.push({
      id: "a11y-link-text-undescriptive",
      category: "accessibility",
      severity: "warning",
      title: `${vagueLinks.length} ${count(vagueLinks.length, "link", "links")} named "click here" or similar`,
      detail:
        "Screen reader users frequently pull up a list of every link on the page and tab through it out of context. A list of eleven entries all reading \"read more\" is useless - the surrounding sentence that made each one meaningful is not in that list.",
      fix: "Make each link's text describe its destination on its own. If the visible text must stay short, extend the accessible name with visually-hidden text.",
      snippet: '<a href="/pricing">Read more<span class="sr-only"> about our pricing</span></a>',
      value: quoteList(vagueLinks.map((a) => `${a.text.trim()} → ${a.href ?? ""}`)),
      docs: "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-link-only.html",
      weight: 2,
    });
  }

  if (linkedAnchors.length > 0 && namelessLinks.length === 0 && vagueLinks.length === 0) {
    findings.push({
      id: "a11y-link-names-ok",
      category: "accessibility",
      severity: "pass",
      title: "Links are named descriptively",
      detail: `All ${linkedAnchors.length} ${count(linkedAnchors.length, "link")} carry text that identifies the destination when read out of context.`,
      weight: 2,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Skip link                                                              */
  /* ---------------------------------------------------------------------- */

  const earlyAnchors = anchors.slice(0, 6);
  const skipLink = earlyAnchors.find((a) => {
    const href = (a.href ?? "").trim().toLowerCase();
    if (SKIP_LINK_TARGETS.includes(href)) return true;
    return href.startsWith("#") && /skip/.test(flattenLinkText(a.text));
  });

  if (skipLink) {
    findings.push({
      id: "a11y-skip-link-present",
      category: "accessibility",
      severity: "pass",
      title: "Skip link found",
      detail: "An in-page link near the top of the document lets keyboard users bypass the header and navigation.",
      value: shorten(`${skipLink.text.trim() || "(no text)"} → ${skipLink.href ?? ""}`, 120),
      weight: 1,
    });
  } else {
    findings.push({
      id: "a11y-skip-link-missing",
      category: "accessibility",
      severity: "info",
      title: "No skip link detected",
      detail:
        "No early in-page anchor pointing at #main or #content was found. Keyboard-only users then have to tab through every navigation link on every page before reaching the content. WCAG 2.2 Level A 2.4.1 offers landmarks as an alternative mechanism, so a <main> element partly covers this - but a skip link is what most keyboard users actually reach for.",
      fix: "Add a skip link as the first focusable element, visually hidden until focused, pointing at the id on your <main>.",
      snippet: '<a class="skip-link" href="#main">Skip to main content</a>\n\n.skip-link { position: absolute; left: -9999px; }\n.skip-link:focus { left: 1rem; top: 1rem; }',
      docs: "https://www.w3.org/WAI/WCAG22/Techniques/general/G1",
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Scope caveat - always emitted                                          */
  /* ---------------------------------------------------------------------- */

  findings.push({
    id: "a11y-static-analysis-scope",
    category: "accessibility",
    severity: "info",
    title: "Static analysis only - this is not a WCAG audit",
    detail:
      "Every check above reads the delivered HTML. It cannot see colour contrast, focus visibility or focus order, keyboard traps, motion and animation preferences, dynamically injected content, ARIA state correctness, or whether a custom widget actually behaves like the role it claims. Automated tooling of any kind catches roughly a third of WCAG issues; a clean result here means the machine-checkable markup is sound, not that the page is accessible.",
    fix: "Follow this up with a browser-based pass (axe DevTools or Lighthouse), a keyboard-only walkthrough of every interactive flow, and a screen reader test with a real user where possible.",
    docs: "https://www.w3.org/WAI/test-evaluate/",
    weight: 1,
  });

  return findings;
}
