import type { PBNode } from "./types";

export interface CompileOptions {
  /**
   * Disable Tailwind's `@tailwind base` preflight (CSS reset). Use for
   * components that get embedded into a page — the host page already
   * provides preflight, and including it again clobbers typography.
   */
  disablePreflight?: boolean;
  /**
   * If set, drop any compiled CSS rules whose selectors don't reference one
   * of these class names. Combined with `disablePreflight`, this leaves only
   * the rules for classes the component actually uses.
   */
  scopeToClasses?: Set<string>;
}

/**
 * Compile Tailwind CSS by rendering HTML in a hidden iframe with Tailwind CDN.
 * Waits for the CDN to generate styles, then extracts the compiled CSS.
 * Browser-only — relies on document.
 */
export function compileTailwindCss(
  html: string,
  styleUrls: string[],
  options: CompileOptions = {}
): Promise<string> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;";
    document.body.appendChild(iframe);

    const styleTags = styleUrls.map((u) => `<link rel="stylesheet" href="${u}" />`).join("\n");

    const doc = iframe.contentDocument;
    if (!doc) {
      iframe.remove();
      resolve("");
      return;
    }

    const tailwindConfig = JSON.stringify({
      darkMode: "class",
      ...(options.disablePreflight ? { corePlugins: { preflight: false } } : {}),
    });

    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  ${styleTags}
  <script src="https://cdn.tailwindcss.com"><\/script>
  <script>tailwind.config = ${tailwindConfig}<\/script>
</head>
<body>${html}</body>
</html>`);
    doc.close();

    const extract = () => {
      let css = "";
      try {
        for (const style of Array.from(doc.querySelectorAll("style"))) {
          const text = style.textContent ?? "";
          if (text.includes("--tw-") || text.length > 1000) {
            css = text;
            break;
          }
        }
      } catch {
        // cross-origin or other error
      }
      iframe.remove();
      if (options.scopeToClasses && css) {
        css = filterCssToClasses(css, options.scopeToClasses);
      }
      resolve(css);
    };

    let attempts = 0;
    const poll = () => {
      attempts++;
      try {
        const styles = doc.querySelectorAll("style");
        for (const style of Array.from(styles)) {
          const text = style.textContent ?? "";
          if (text.includes("--tw-") || text.length > 1000) {
            extract();
            return;
          }
        }
      } catch {
        // not ready yet
      }
      if (attempts < 30) {
        setTimeout(poll, 200);
      } else {
        extract();
      }
    };
    setTimeout(poll, 500);
  });
}

/**
 * Generate CSS rules for font-{name} classes from loaded Google Font URLs.
 */
export function generateFontCssRules(styleUrls: string[]): string {
  const rules: string[] = [];
  for (const url of styleUrls) {
    const match = url.match(/family=([^&:]+)/);
    if (!match) continue;
    const family = match[1].replace(/\+/g, " ");
    const key = family.toLowerCase().replace(/\s+/g, "-");
    rules.push(`.font-${key} { font-family: '${family}', sans-serif; }`);
  }
  return rules.join("\n");
}

/**
 * Walk a PBNode tree and emit CSS rules for any inline styles set on nodes,
 * keyed by data-pb-id. Used so styles persist into the served output.
 */
export function collectInlineStyles(node: PBNode): string {
  let css = "";
  const entries = Object.entries(node.styles);
  if (entries.length > 0) {
    const props = entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
    css += `[data-pb-id="${node.id}"] {\n${props}\n}\n`;
  }
  for (const child of node.children) {
    css += collectInlineStyles(child);
  }
  return css;
}

/**
 * Walk a PBNode tree and collect every class name applied anywhere in it.
 * Used to scope a component's compiled CSS to only its own classes.
 */
export function collectClassesFromTree(node: PBNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: PBNode) => {
    for (const c of n.classes) out.add(c);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

/**
 * Filter a Tailwind CDN-emitted stylesheet down to rules that reference any
 * of the provided class names. Drops preflight, base resets, and unrelated
 * utilities. Preserves @media / @supports / @keyframes wrappers around kept
 * rules and keeps `*, ::before, ::after { --tw-*: ... }` blocks since
 * Tailwind utilities reference those custom properties.
 */
function filterCssToClasses(css: string, classes: Set<string>): string {
  // Build a regex that matches `.<className>` with proper escaping for
  // characters Tailwind escapes (`:`, `/`, `.`, etc. → `\:`, `\/`, ...).
  // We just check whether the selector text contains `.<escaped-class>`.
  const escaped = Array.from(classes).map((c) =>
    c.replace(/[.*+?^${}()|[\]\\:/]/g, (m) => `\\${m}`)
  );
  const classMatcher = new RegExp(
    "\\.(?:" +
      escaped
        .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|") +
      ")(?![\\w-])"
  );

  // Tokenize at top level: emit `@<at-rule>{...}` blocks (recursively
  // filtered) and individual `selector { ... }` rules.
  const out: string[] = [];
  let i = 0;
  const n = css.length;

  const skipWhitespace = () => {
    while (i < n && /\s/.test(css[i])) i++;
  };

  const findMatchingBrace = (start: number): number => {
    let depth = 1;
    let j = start;
    while (j < n && depth > 0) {
      const ch = css[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) return j;
      j++;
    }
    return j;
  };

  while (i < n) {
    skipWhitespace();
    if (i >= n) break;

    if (css[i] === "@") {
      // At-rule. Find name and either ; (statement) or { (block).
      const start = i;
      while (i < n && css[i] !== ";" && css[i] !== "{") i++;
      const prelude = css.slice(start, i);
      if (i < n && css[i] === ";") {
        // Statement at-rule (e.g., @charset, @import) — keep
        out.push(prelude + ";");
        i++;
        continue;
      }
      // Block at-rule
      const blockStart = i + 1;
      const blockEnd = findMatchingBrace(blockStart);
      const inner = css.slice(blockStart, blockEnd);
      i = blockEnd + 1;

      const name = prelude.match(/^@([\w-]+)/)?.[1] ?? "";
      if (name === "keyframes" || name === "-webkit-keyframes" || name === "font-face") {
        // Drop — only keep if referenced; we lazily keep them all by default
        out.push(prelude + "{" + inner + "}");
      } else if (name === "media" || name === "supports" || name === "container" || name === "layer") {
        // Recursively filter inner
        const filteredInner = filterCssToClasses(inner, classes);
        if (filteredInner.trim()) out.push(prelude + "{" + filteredInner + "}");
      } else {
        // Unknown at-rule, keep as-is
        out.push(prelude + "{" + inner + "}");
      }
      continue;
    }

    // Plain rule: `selector { ... }`
    const ruleStart = i;
    while (i < n && css[i] !== "{") i++;
    if (i >= n) break;
    const selector = css.slice(ruleStart, i).trim();
    const blockStart = i + 1;
    const blockEnd = findMatchingBrace(blockStart);
    const body = css.slice(blockStart, blockEnd);
    i = blockEnd + 1;

    // Keep rules that reference one of our classes, plus the universal
    // --tw- custom-property declarations Tailwind emits on `*, ::before, ::after`.
    const isUniversalTwVars =
      /^\*\s*,\s*::before\s*,\s*::after$/.test(selector) && body.includes("--tw-");

    if (isUniversalTwVars || classMatcher.test(selector)) {
      out.push(`${selector} {${body}}`);
    }
  }

  return out.join("\n");
}

/**
 * Build the full compiled stylesheet for a page or component:
 *   - @import for each external stylesheet (fonts, etc.)
 *   - generated font-family classes
 *   - compiled Tailwind utilities
 *   - inline styles from nodes
 */
export async function buildCompiledCss(
  html: string,
  rootNode: PBNode,
  externalStyles: string[],
  options: CompileOptions = {}
): Promise<string> {
  const tailwindCss = await compileTailwindCss(html, externalStyles, options);
  const parts: string[] = [];

  for (const url of externalStyles) {
    parts.push(`@import url('${url}');`);
  }

  const fontRules = generateFontCssRules(externalStyles);
  if (fontRules) {
    parts.push("/* Font family classes */");
    parts.push(fontRules);
  }

  if (tailwindCss) {
    parts.push("/* Compiled Tailwind CSS */");
    parts.push(tailwindCss);
  }

  const inlineStyles = collectInlineStyles(rootNode);
  if (inlineStyles) {
    parts.push("/* Component styles */");
    parts.push(inlineStyles);
  }

  return parts.join("\n");
}
