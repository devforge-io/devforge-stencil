/**
 * Rich-text details for feature requests.
 *
 * The widget's suggest form and edit box are contenteditable (widget v9), so
 * `details` holds a small HTML subset. This sanitizer is the single gate: it
 * runs on every write (store.server.ts) and on every read that renders HTML
 * (publicRequest, the hosted pages), so legacy plain-text details and anything
 * a client posts both come out safe. Allowlist only, all attributes dropped.
 * Plain module on purpose: route components may import it.
 */

const ALLOWED = new Set(["b", "strong", "i", "em", "u", "s", "p", "div", "br", "ul", "ol", "li"]);
const BLOCK = new Set(["p", "div", "li", "ul", "ol"]);
const VOID = new Set(["br"]);
const ALIAS: Record<string, string> = { strike: "s" };

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type CleanDetails = {
  /** Safe HTML: allowlisted tags, no attributes, balanced. */
  html: string;
  /** Plain-text rendering, block tags as newlines. Use for previews and length checks. */
  text: string;
};

export function sanitizeDetails(input: string | null | undefined): CleanDetails {
  const src = (input ?? "").trim();
  let html = "";
  let text = "";
  const open: string[] = [];
  const parts = src.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const part of parts) {
    if (part[0] !== "<") {
      html += escapeText(part);
      text += part;
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)[^>]*>$/.exec(part);
    if (!m) continue; // comments, doctypes, mangled tags: dropped
    const closing = m[1] === "/";
    let name = m[2].toLowerCase();
    name = ALIAS[name] ?? name;
    if (!ALLOWED.has(name)) continue; // tag dropped, its inner text kept
    if (VOID.has(name)) {
      if (!closing) {
        html += "<br>";
        text += "\n";
      }
      continue;
    }
    if (!closing) {
      html += `<${name}>`;
      open.push(name);
    } else {
      // Close up to the matching tag; a stray close tag is dropped.
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) {
        const n = open.pop() as string;
        html += `</${n}>`;
        if (BLOCK.has(n) && text && !text.endsWith("\n")) text += "\n";
      }
    }
  }
  while (open.length > 0) {
    const n = open.pop() as string;
    html += `</${n}>`;
    if (BLOCK.has(n) && text && !text.endsWith("\n")) text += "\n";
  }
  // Drop leading/trailing empty blocks the editors like to leave behind.
  html = html.replace(/^(<(?:p|div)>(?:\s|<br>)*<\/(?:p|div)>)+/, "").replace(/(<(?:p|div)>(?:\s|<br>)*<\/(?:p|div)>)+$/, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { html: "", text: "" };
  return { html, text };
}
