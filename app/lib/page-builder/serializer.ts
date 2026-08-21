import type { PBNode } from "./types";
import { createNode, createTextNode, generateId } from "./utils";

const VOID_TAGS = new Set(["img", "hr", "br", "input", "meta", "link"]);

/**
 * Render a PBNode tree to clean HTML string.
 */
export function renderToHtml(node: PBNode): string {
  if (node.type === "text") {
    const tag = node.tag || "span";
    const attrs: string[] = [];
    if (node.classes.length > 0) attrs.push(classAttr(node.classes));
    const styleStr = Object.entries(node.styles).map(([k, v]) => `${k}:${v}`).join(";");
    if (styleStr) attrs.push(`style="${styleStr}"`);
    for (const [k, v] of Object.entries(node.attributes)) {
      const value = attrValue(v);
      if (value === null) continue;
      attrs.push(value === "" ? k : `${k}="${escapeAttr(value)}"`);
    }
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    // <style>/<script> hold raw CSS/JS — escaping their text (e.g. `>` in a CSS
    // child selector) corrupts it, since entities aren't decoded inside them.
    const text = node.text ?? "";
    const body = tag === "style" || tag === "script" ? text : escapeHtml(text);
    return `<${tag}${attrStr}>${body}</${tag}>`;
  }

  const tag = node.tag;
  const attrs: string[] = [];

  if (node.classes.length > 0) {
    attrs.push(classAttr(node.classes));
  }

  const styleStr = Object.entries(node.styles)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  if (styleStr) {
    attrs.push(`style="${styleStr}"`);
  }

  for (const [k, v] of Object.entries(node.attributes)) {
    const value = attrValue(v);
    if (value === null) continue;
    if (value === "") {
      attrs.push(k);
    } else {
      attrs.push(`${k}="${escapeAttr(value)}"`);
    }
  }

  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";

  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrStr} />`;
  }

  const childrenHtml = node.children.map(renderToHtml).join("");
  return `<${tag}${attrStr}>${childrenHtml}</${tag}>`;
}

/**
 * Parse an HTML string into a PBNode tree.
 */
export function parseHtml(html: string): PBNode {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="__pb_parse_root">${html}</div>`,
    "text/html"
  );
  const root = doc.getElementById("__pb_parse_root");
  if (!root) {
    return createNode("div", { id: "pb-root", name: "Body" });
  }
  const result = createNode("div", {
    id: "pb-root",
    name: "Body",
    draggable: false,
    classes: ["min-h-screen"],
  });
  result.children = Array.from(root.childNodes)
    .map(domToNode)
    .filter((n): n is PBNode => n !== null);
  return result;
}

function domToNode(domNode: Node): PBNode | null {
  if (domNode.nodeType === 3) {
    const text = domNode.textContent?.trim();
    if (!text) return null;
    return createTextNode(text);
  }

  if (domNode.nodeType !== 1) return null;
  const el = domNode as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // Read classes from raw attribute to preserve encoded special chars in Tailwind arbitrary selectors
  const rawClassAttr = el.getAttribute("class") ?? "";
  const classes = rawClassAttr ? rawClassAttr.split(/\s+/).filter(Boolean).map(decodeClass) : [];
  const styles: Record<string, string> = {};
  for (let i = 0; i < el.style.length; i++) {
    const prop = el.style[i];
    styles[prop] = el.style.getPropertyValue(prop);
  }

  const attributes: Record<string, string> = {};
  let customName: string | undefined;
  let parentConstraint: string | undefined;
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === "class" || attr.name === "style") continue;
    if (attr.name === "data-pb-name") {
      customName = attr.value;
      continue;
    }
    if (attr.name === "data-pb-parent") {
      parentConstraint = attr.value;
      continue;
    }
    attributes[attr.name] = attr.value;
  }

  const node = createNode(tag, {
    classes,
    styles,
    attributes,
    name: customName ?? getDefaultName(tag),
    parentConstraint,
  });

  // If element only contains text (no child elements), store text directly
  const hasElementChildren = Array.from(el.childNodes).some(
    (n) => n.nodeType === 1
  );

  if (!hasElementChildren && el.textContent?.trim()) {
    node.type = "text";
    node.text = el.textContent.trim();
    node.editable = true;
    node.droppable = false;
    node.children = [];
    return node;
  }

  node.children = Array.from(el.childNodes)
    .map(domToNode)
    .filter((n): n is PBNode => n !== null);

  return node;
}

function getDefaultName(tag: string): string {
  const names: Record<string, string> = {
    div: "Box",
    section: "Section",
    header: "Header",
    footer: "Footer",
    nav: "Nav",
    main: "Main",
    article: "Article",
    aside: "Aside",
    h1: "Heading 1",
    h2: "Heading 2",
    h3: "Heading 3",
    h4: "Heading 4",
    h5: "Heading 5",
    h6: "Heading 6",
    p: "Paragraph",
    a: "Link",
    button: "Button",
    span: "Span",
    img: "Image",
    video: "Video",
    iframe: "Iframe",
    ul: "List",
    ol: "Ordered List",
    li: "List Item",
    form: "Form",
    input: "Input",
    textarea: "Textarea",
    label: "Label",
    hr: "Divider",
    br: "Break",
    i: "Icon",
    svg: "SVG",
    figure: "Figure",
    figcaption: "Caption",
    style: "Custom CSS",
    script: "Custom JavaScript",
    table: "Table",
    tr: "Row",
    td: "Cell",
    th: "Header Cell",
  };
  return names[tag] ?? tag.toUpperCase();
}

/**
 * Normalise a stored attribute value to the string the serializer emits.
 * Trees saved or edited outside the builder (scripts, hand edits, older
 * versions) can hold booleans or numbers, e.g. `required: true`, and calling
 * `.replace` on those crashed the whole render. `true` becomes a bare
 * attribute, `false`/`null`/`undefined` drop the attribute, anything else is
 * stringified.
 */
function attrValue(v: unknown): string | null {
  if (v === true) return "";
  if (v === false || v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return String(str).replace(/"/g, "&quot;");
}

// Encode special chars in Tailwind arbitrary selector classes for safe HTML output
function encodeClass(cls: string): string {
  return cls.replace(/"/g, "&quot;").replace(/>/g, "&gt;").replace(/</g, "&lt;");
}

function decodeClass(cls: string): string {
  return cls.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
}

function classAttr(classes: string[]): string {
  const encoded = classes.map(encodeClass).join(" ");
  return `class="${encoded}"`;
}
