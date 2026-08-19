/**
 * Dependency-free HTML extraction for the website audit.
 *
 * We deliberately do not pull in cheerio / node-html-parser: the audit only ever
 * needs a flat inventory of head tags, links, images and text, never a mutable
 * DOM. A hand-rolled scanner keeps the server bundle small and, more usefully,
 * lets us stay deliberately permissive - real-world pages are full of unquoted
 * attributes, stray `<`, unclosed tags and `>` characters inside attribute
 * values, and a strict parser would throw where we want a best-effort answer.
 *
 * The scanner is a single left-to-right pass that produces a flat token stream
 * (`text` and `tag` tokens). No tree is built; the handful of places that need
 * inner text (headings, anchors) peek forward through the token stream instead.
 *
 * Server-only by filename convention - it is pure and has no Node imports, but
 * it is only ever used by the fetcher.
 */

import type {
  AnchorTag,
  FormField,
  Heading,
  ImageTag,
  LinkTag,
  ParsedDocument,
  ScriptTag,
  StylesheetTag,
} from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Elements whose content is raw text, not markup. The scanner jumps straight to
 * the matching close tag for these so that `if (a < b)` inside a `<script>` or
 * `content: ">"` inside a `<style>` cannot manufacture phantom tags. `title` and
 * `textarea` are RCDATA rather than true rawtext, but treating them the same way
 * is close enough: neither may contain child elements.
 */
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea"]);

/** Elements that never have a close tag, so `<img>` must not open a scope. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Reported in this order so the field is stable regardless of document order. */
const LANDMARK_TAGS = ["main", "nav", "header", "footer", "article", "aside", "section"];
const LANDMARK_LOOKUP = new Set(LANDMARK_TAGS);

/**
 * Inner-text collection is bounded: an unclosed `<a>` in a badly broken document
 * would otherwise make every anchor scan to the end of the file, turning the
 * extraction into O(n^2) on exactly the pages most likely to be broken.
 */
const INNER_TEXT_TOKEN_LIMIT = 2000;
const INNER_TEXT_CHAR_LIMIT = 2000;

/**
 * Only the entities that actually show up in titles, descriptions and body copy.
 * A full HTML5 entity table is ~2000 entries and would dwarf this module for no
 * practical gain - numeric escapes cover everything else.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  laquo: "«",
  raquo: "»",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  prime: "′",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  larr: "←",
  rarr: "→",
  harr: "↔",
  darr: "↓",
  uarr: "↑",
  infin: "∞",
  ne: "≠",
  le: "≤",
  ge: "≥",
  minus: "−",
  star: "☆",
  check: "✓",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  agrave: "à",
  egrave: "è",
  ccedil: "ç",
  ntilde: "ñ",
  ouml: "ö",
  auml: "ä",
  uuml: "ü",
  szlig: "ß",
  oslash: "ø",
  aring: "å",
  aelig: "æ"
};

/**
 * Matches `key="v"`, `key='v'`, `key=v`, `key=` and bare `key`.
 *
 * The name class excludes the characters that can only terminate a name, so an
 * attribute run keeps matching across newlines (`\s` covers those) - attributes
 * spanning lines are common in hand-formatted `<meta>` blocks. The unquoted
 * value class uses `*` rather than `+` so `key=` yields an empty string instead
 * of silently dropping the attribute.
 */
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** `null` when the attribute is absent; the (possibly empty) value when present. */
function attrOrNull(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

/**
 * Decodes the entity forms that matter for text and attribute values.
 *
 * Unknown named entities are left verbatim rather than dropped, so prose like
 * "AT&T" and "Fish & Chips" survives untouched.
 */
function decodeEntities(input: string): string {
  // Fast path: the overwhelming majority of attribute values contain no "&".
  if (!input.includes("&")) return input;

  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (match: string, body: string): string => {
      if (body.startsWith("#")) {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = isHex ? body.slice(2) : body.slice(1);
        const code = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        // Lone surrogates are unpaired garbage; String.fromCodePoint accepts them
        // but they corrupt downstream JSON, so leave the escape alone.
        if (code >= 0xd800 && code <= 0xdfff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? match : named;
    }
  );
}

/**
 * Parses an attribute list.
 *
 * Accepts either a whole tag (`<a href=x>`) or just the region after the element
 * name, since the scanner already has the name in hand. Names are lowercased and
 * the first declaration of a duplicated attribute wins, matching how browsers
 * resolve `<a href="a" href="b">`.
 */
function parseAttrs(tagSource: string): Record<string, string> {
  let source = tagSource.trim();
  if (source.startsWith("<")) {
    source = source.replace(/^<\/?[a-zA-Z][^\s/>]*/, "").replace(/\/?>$/, "");
  }

  const attrs: Record<string, string> = {};
  if (!source.trim()) return attrs;

  for (const match of source.matchAll(ATTR_RE)) {
    const key = match[1].toLowerCase();
    // A stray "/" from a self-closing tag matches nothing useful.
    if (!key || key === "/") continue;
    if (key in attrs) continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[key] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * Resolves an href/src against the document URL.
 *
 * Fragment-only values are kept verbatim: `new URL("#top", base)` would expand to
 * the full page URL and destroy the "this is a same-page jump" signal that the
 * link checks depend on. Every other scheme survives `new URL` intact
 * (`mailto:`, `tel:` and `javascript:` all round-trip), so only `#` needs a case.
 */
function resolveUrl(raw: string | undefined, baseUrl: string): string | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return "";
  if (value.startsWith("#")) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

/** True only for same-host http(s) links; fragments and non-web schemes are not internal. */
function isInternalUrl(resolved: string | null, baseHost: string): boolean {
  if (!resolved || !baseHost) return false;
  if (resolved.startsWith("#")) return false;
  try {
    const url = new URL(resolved);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.host === baseHost;
  } catch {
    return false;
  }
}

/** `<script type="application/ld+json">` bodies are often wrapped for XHTML safety. */
function stripCdata(input: string): string {
  return input
    .trim()
    .replace(/^(?:\/\/|\/\*)?\s*<!\[CDATA\[\s*(?:\*\/)?/i, "")
    .replace(/(?:\/\/|\/\*)?\s*\]\]>\s*(?:\*\/)?$/i, "")
    .trim();
}

function bumpCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function toFieldTag(name: string): FormField["tag"] | null {
  return name === "input" || name === "select" || name === "textarea" ? name : null;
}

/** `user-scalable=no` and any `maximum-scale` under 2 defeat pinch-zoom. */
function detectViewportBlocksZoom(content: string | undefined): boolean {
  if (!content) return false;
  const normalised = content.toLowerCase().replace(/\s+/g, "");
  if (normalised.includes("user-scalable=no") || normalised.includes("user-scalable=0")) {
    return true;
  }
  const maximumScale = /maximum-scale=([0-9.]+)/.exec(normalised);
  if (maximumScale) {
    const scale = Number.parseFloat(maximumScale[1]);
    if (Number.isFinite(scale) && scale < 2) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Scanner                                                                     */
/* -------------------------------------------------------------------------- */

interface TagToken {
  kind: "tag";
  /** Lowercased element name. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
  /** Raw body for `RAW_TEXT_TAGS` opening tags; `""` for everything else. */
  rawText: string;
}

interface TextToken {
  kind: "text";
  text: string;
}

type Token = TagToken | TextToken;

/**
 * Finds the `>` that closes a tag, starting just after the element name.
 *
 * Naive `/<[^>]*>/` scanning breaks on `<a title="a > b">`, which is common in
 * hand-written copy. Quotes are only treated as opening a value when the last
 * significant character was `=`; that keeps `<a title=it's>` (an unquoted value
 * containing an apostrophe) from swallowing the rest of the document.
 */
function findTagEnd(html: string, from: number): number {
  let quote = "";
  let afterEquals = false;
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      if (afterEquals) {
        quote = char;
        afterEquals = false;
      }
      continue;
    }
    if (char === ">") return i;
    if (char === "=") {
      afterEquals = true;
      continue;
    }
    // Whitespace is allowed between `=` and the value, so it must not clear the flag.
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\f") {
      afterEquals = false;
    }
  }
  return -1;
}

/**
 * Locates the close tag for a rawtext element. Returns the offsets of `<` and of
 * the character after `>`, or `null` when the element is never closed.
 */
function findRawTextEnd(
  html: string,
  lowerHtml: string,
  name: string,
  from: number
): { start: number; end: number } | null {
  const needle = `</${name}`;
  let cursor = from;
  while (cursor < html.length) {
    const start = lowerHtml.indexOf(needle, cursor);
    if (start === -1) return null;
    const after = html[start + needle.length];
    // Guard against `</scriptfoo`: the name must be followed by a terminator.
    if (after === undefined || after === ">" || after === "/" || /\s/.test(after)) {
      const gt = html.indexOf(">", start + needle.length);
      return { start, end: gt === -1 ? html.length : gt + 1 };
    }
    cursor = start + needle.length;
  }
  return null;
}

/** Single left-to-right pass turning HTML into a flat `text` / `tag` token stream. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end <= textStart) return;
    const slice = html.slice(textStart, end);
    // Whitespace-only runs carry no information and would dominate the token
    // count on pretty-printed markup.
    if (/\S/.test(slice)) tokens.push({ kind: "text", text: slice });
  };

  while (cursor < html.length) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) break;

    const next = html[lt + 1];

    // Comments, doctype, CDATA and processing instructions: skipped whole, and
    // their contents never reach the text stream.
    if (next === "!" || next === "?") {
      flushText(lt);
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        cursor = end === -1 ? html.length : end + 3;
      } else {
        const end = findTagEnd(html, lt + 2);
        cursor = end === -1 ? html.length : end + 1;
      }
      textStart = cursor;
      continue;
    }

    const closing = next === "/";
    const nameStart = closing ? lt + 2 : lt + 1;
    // A `<` not followed by a letter is literal text ("5 < 10", "a <- b"), which
    // is exactly how browsers treat it.
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameStart, nameStart + 128));
    if (!nameMatch) {
      cursor = lt + 1;
      continue;
    }

    const attrsStart = nameStart + nameMatch[0].length;
    const gt = findTagEnd(html, attrsStart);
    if (gt === -1) {
      // Unterminated tag: treat the `<` as text and carry on.
      cursor = lt + 1;
      continue;
    }

    flushText(lt);

    const name = nameMatch[0].toLowerCase();
    const attrsSource = html.slice(attrsStart, gt);
    const attrs = closing ? {} : parseAttrs(attrsSource);
    const selfClosing = attrsSource.trimEnd().endsWith("/") || VOID_TAGS.has(name);

    let rawText = "";
    cursor = gt + 1;

    if (!closing && !selfClosing && RAW_TEXT_TAGS.has(name)) {
      const bounds = findRawTextEnd(html, lowerHtml, name, cursor);
      if (bounds) {
        rawText = html.slice(cursor, bounds.start);
        cursor = bounds.end;
      } else {
        // Unclosed `<script>` swallows the remainder, same as a browser.
        rawText = html.slice(cursor);
        cursor = html.length;
      }
    }

    tokens.push({ kind: "tag", name, closing, selfClosing, attrs, rawText });
    textStart = cursor;
  }

  flushText(html.length);
  return tokens;
}

/**
 * Collects the visible text of the element opened at `openIndex`.
 *
 * Nested `img` alt text is folded in because it contributes to an anchor's
 * accessible name - without it every icon-only link looks like an empty link.
 */
function collectInnerText(tokens: Token[], openIndex: number, name: string): string {
  const parts: string[] = [];
  let depth = 1;
  let length = 0;
  const limit = Math.min(tokens.length, openIndex + 1 + INNER_TEXT_TOKEN_LIMIT);

  for (let i = openIndex + 1; i < limit; i++) {
    const token = tokens[i];
    if (token.kind === "text") {
      parts.push(token.text);
      length += token.text.length;
      if (length > INNER_TEXT_CHAR_LIMIT) break;
      continue;
    }
    if (token.name === "img" && !token.closing) {
      const alt = token.attrs.alt;
      if (alt) parts.push(alt);
      continue;
    }
    if (token.name !== name) continue;
    if (token.closing) {
      depth--;
      if (depth === 0) break;
    } else if (!token.selfClosing) {
      depth++;
    }
  }

  return collapseWhitespace(decodeEntities(parts.join(" ")));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extracts everything the audit checks need from a page's HTML.
 *
 * `baseUrl` is the *final* URL of the document (post-redirect), and is used both
 * to resolve relative URLs and to decide which links are internal.
 */
export function parseHtml(html: string, baseUrl: string): ParsedDocument {
  const tokens = tokenize(html);

  let baseHost = "";
  try {
    baseHost = new URL(baseUrl).host;
  } catch {
    // A malformed base only costs us internal/external classification.
  }

  const metaByName: Record<string, string> = {};
  const metaByProperty: Record<string, string> = {};
  const metaCounts: Record<string, number> = {};
  const links: LinkTag[] = [];
  const headings: Heading[] = [];
  const images: ImageTag[] = [];
  const anchors: AnchorTag[] = [];
  const scripts: ScriptTag[] = [];
  const stylesheets: StylesheetTag[] = [];
  const formFields: FormField[] = [];
  const jsonLd: unknown[] = [];
  const iframes: { src: string | null; title: string | null }[] = [];
  const roles = new Set<string>();
  const landmarks = new Set<string>();
  const textParts: string[] = [];

  /** Every `<label for="…">` target in the document, resolved after the pass. */
  const labelTargets = new Set<string>();

  let title: string | null = null;
  let lang: string | null = null;
  let charset: string | null = null;
  let jsonLdErrors = 0;
  let hasMicrodata = false;
  let hasRdfa = false;
  let hasNoscript = false;
  let hasDir = false;
  /** Depth of open `<label>` elements, so wrapped fields count as labelled. */
  let labelDepth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token.kind === "text") {
      textParts.push(token.text);
      continue;
    }

    const { name, attrs } = token;

    if (token.closing) {
      if (name === "label" && labelDepth > 0) labelDepth--;
      continue;
    }

    /* Signals worth harvesting from any element ------------------------------ */

    if ("itemscope" in attrs || "itemprop" in attrs) hasMicrodata = true;
    // `property` is excluded on `<meta>`, where it is Open Graph rather than RDFa.
    if ("vocab" in attrs || "typeof" in attrs || (name !== "meta" && "property" in attrs)) {
      hasRdfa = true;
    }
    if (attrs.role) {
      for (const role of attrs.role.trim().toLowerCase().split(/\s+/)) {
        if (role) roles.add(role);
      }
    }
    if (LANDMARK_LOOKUP.has(name)) landmarks.add(name);

    const headingMatch = /^h([1-6])$/.exec(name);
    if (headingMatch) {
      headings.push({
        level: Number.parseInt(headingMatch[1], 10),
        text: collectInnerText(tokens, index, name)
      });
      continue;
    }

    const fieldTag = toFieldTag(name);
    if (fieldTag) {
      formFields.push({
        tag: fieldTag,
        type: attrOrNull(attrs.type),
        id: attrOrNull(attrs.id),
        name: attrOrNull(attrs.name),
        ariaLabel: attrOrNull(attrs["aria-label"]),
        ariaLabelledBy: attrOrNull(attrs["aria-labelledby"]),
        placeholder: attrOrNull(attrs.placeholder),
        // Provisional: `<label for>` may still appear later in the document.
        hasLabel: labelDepth > 0
      });
      continue;
    }

    switch (name) {
      case "html": {
        if (lang === null && attrs.lang) lang = attrs.lang.trim() || null;
        if ("dir" in attrs) hasDir = true;
        break;
      }

      case "body": {
        if ("dir" in attrs) hasDir = true;
        break;
      }

      case "title": {
        if (title === null) {
          const text = collapseWhitespace(decodeEntities(token.rawText));
          title = text === "" ? null : text;
        }
        break;
      }

      case "meta": {
        if (charset === null && attrs.charset) {
          charset = attrs.charset.trim().toLowerCase() || null;
        }
        if (charset === null && attrs["http-equiv"]?.trim().toLowerCase() === "content-type") {
          const declared = /charset\s*=\s*"?([\w-]+)/i.exec(attrs.content ?? "");
          if (declared) charset = declared[1].toLowerCase();
        }
        // An empty `content` is recorded rather than dropped so checks can tell
        // "no description tag" apart from "description tag with nothing in it".
        const content = (attrs.content ?? "").trim();
        const nameKey = attrs.name?.trim().toLowerCase();
        const propertyKey = attrs.property?.trim().toLowerCase();
        if (nameKey) {
          metaByName[nameKey] = content;
          bumpCount(metaCounts, nameKey);
        }
        if (propertyKey) {
          metaByProperty[propertyKey] = content;
          bumpCount(metaCounts, propertyKey);
        }
        break;
      }

      case "link": {
        const rel = (attrs.rel ?? "").trim().toLowerCase();
        const href = resolveUrl(attrs.href, baseUrl);
        links.push({
          rel,
          href,
          type: attrOrNull(attrs.type),
          hreflang: attrOrNull(attrs.hreflang),
          sizes: attrOrNull(attrs.sizes),
          media: attrOrNull(attrs.media),
          title: attrOrNull(attrs.title)
        });
        if (rel.split(/\s+/).includes("stylesheet")) {
          stylesheets.push({ href, media: attrOrNull(attrs.media) });
        }
        break;
      }

      case "img": {
        images.push({
          src: resolveUrl(attrs.src, baseUrl),
          // `alt` must distinguish absent (null) from empty/decorative ("").
          alt: attrOrNull(attrs.alt),
          width: attrOrNull(attrs.width),
          height: attrOrNull(attrs.height),
          loading: attrOrNull(attrs.loading),
          srcset: attrOrNull(attrs.srcset)
        });
        break;
      }

      case "a": {
        const href = resolveUrl(attrs.href, baseUrl);
        const inner = collectInnerText(tokens, index, name);
        anchors.push({
          href,
          // Fall back to the accessible name - AnchorTag has nowhere else to put it.
          text: inner || (attrs["aria-label"] ?? "").trim() || (attrs.title ?? "").trim(),
          rel: attrOrNull(attrs.rel),
          target: attrOrNull(attrs.target),
          internal: isInternalUrl(href, baseHost)
        });
        break;
      }

      case "script": {
        const src = resolveUrl(attrs.src, baseUrl);
        const type = attrOrNull(attrs.type);
        const normalisedType = (type ?? "").trim().toLowerCase();
        scripts.push({
          src,
          type,
          async: "async" in attrs,
          defer: "defer" in attrs,
          module: normalisedType === "module",
          inlineLength: src ? 0 : token.rawText.length
        });
        if (normalisedType === "application/ld+json" || normalisedType === "application/json+ld") {
          try {
            // Some sites legitimately put an array at the top level; store the
            // parsed value exactly as authored and let the checks flatten it.
            jsonLd.push(JSON.parse(stripCdata(token.rawText)) as unknown);
          } catch {
            jsonLdErrors++;
          }
        }
        break;
      }

      case "iframe": {
        iframes.push({
          src: resolveUrl(attrs.src, baseUrl),
          title: attrOrNull(attrs.title)
        });
        break;
      }

      case "noscript": {
        hasNoscript = true;
        break;
      }

      case "label": {
        const target = attrs.for?.trim();
        if (target) labelTargets.add(target);
        if (!token.selfClosing) labelDepth++;
        break;
      }

      default:
        break;
    }
  }

  // Resolve `<label for>` now that the whole document has been seen - labels
  // frequently appear after the field they describe.
  for (const field of formFields) {
    if (!field.hasLabel && field.id && labelTargets.has(field.id)) field.hasLabel = true;
  }

  const metaDuplicates: Record<string, number> = {};
  for (const [key, count] of Object.entries(metaCounts)) {
    if (count >= 2) metaDuplicates[key] = count;
  }

  const textContent = collapseWhitespace(decodeEntities(textParts.join(" ")));
  const wordCount = textContent === "" ? 0 : textContent.split(/\s+/).filter(Boolean).length;
  const htmlLength = html.length;
  const textToHtmlRatio =
    htmlLength > 0 ? Math.min(1, Math.max(0, textContent.length / htmlLength)) : 0;

  return {
    title,
    lang,
    charset,
    metaByName,
    metaByProperty,
    metaDuplicates,
    links,
    headings,
    images,
    anchors,
    scripts,
    stylesheets,
    formFields,
    jsonLd,
    jsonLdErrors,
    hasMicrodata,
    hasRdfa,
    textContent,
    wordCount,
    htmlLength,
    textToHtmlRatio,
    hasNoscript,
    landmarks: LANDMARK_TAGS.filter((tag) => landmarks.has(tag)),
    roles: Array.from(roles),
    hasDir,
    iframes,
    viewportBlocksZoom: detectViewportBlocksZoom(metaByName.viewport)
  };
}
