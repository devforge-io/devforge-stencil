import { buildContext } from "../conditional/context.server";
import type { ConditionContext } from "../conditional/types";
import type { AnyContentItem } from "../content.server";

/**
 * Substitute `{variable}` tokens in text against the per-request context —
 * e.g. `{username}` → the logged-in visitor's name. Runs server-side at page
 * serve time (like the conditional resolver) so it works on public pages.
 *
 * Variables resolve against the same signals conditions use ({@link buildContext}):
 *   - `{username}` `{loggedIn}` `{id}` `{roles}` `{attributes.*}` — the visitor
 *     (shorthands for `auth.*`); `{auth.username}` also works.
 *   - `{query.<param>}` — URL query string
 *   - `{data.<key>}`    — page frontmatter `data:` (the only public-cacheable source)
 *   - `{device}` `{geo.country}` `{time.hour}` `{ab.group}` — request signals
 *
 * Only text nodes are touched (never attributes/classes), and values are inserted
 * as text so markup in a value can't inject HTML. An unknown token (typo, or a
 * non-primitive value) is left literal; a known-but-empty value (e.g. a logged-out
 * `{username}`) becomes an empty string.
 */
export interface VariableResolveResult {
  html: string;
  /** Whether any token was substituted. */
  resolved: boolean;
  /** True when a substituted value is request/visitor-specific (uncacheable). */
  private: boolean;
}

export interface VariableResolveDeps {
  /** Injected in tests to avoid building a real request context. */
  context?: ConditionContext;
}

// {username}, {auth.roles}, {query.ref}, {geo.country}, … — a leading
// letter/underscore then word chars/dots. Deliberately narrow so prose like
// "{ ... }" or `{"json": 1}` is left untouched.
const VAR_RE = /\{([a-zA-Z_][\w.]*)\}/g;

export async function resolveTextVariables(
  html: string,
  request: Request,
  content?: AnyContentItem,
  deps?: VariableResolveDeps
): Promise<VariableResolveResult> {
  // Cheap guard before paying for jsdom / context building.
  if (!html.includes("{")) return { html, resolved: false, private: false };

  const context = deps?.context ?? (await buildContext(request, content));
  // Hoist auth fields to the top level so `{username}` works as a shorthand,
  // while namespaces (`{query.x}`, `{geo.country}`) resolve via the full path.
  const vars: Record<string, unknown> = { ...context, ...context.auth };

  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const doc = dom.window.document;
  const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  let resolved = false;
  let isPrivate = false;

  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!text.includes("{")) continue;
    const next = text.replace(VAR_RE, (match, path: string) => {
      const display = toDisplay(resolvePath(vars, path));
      if (display === undefined) return match; // unknown/unsupported → leave literal
      resolved = true;
      // Everything except page `data:` varies per request/visitor.
      if (path.split(".")[0] !== "data") isPrivate = true;
      return display;
    });
    if (next !== text) node.textContent = next;
  }

  return { html: resolved ? doc.body.innerHTML : html, resolved, private: isPrivate };
}

/** Walk a dotted path (`auth.attributes.plan`) into the flattened var object. */
function resolvePath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Render a value for display: `undefined` means "leave the token literal"
 * (unknown var or a non-primitive we won't dump); `null` becomes "".
 */
function toDisplay(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return undefined; // objects — don't serialize JSON into the page
}
