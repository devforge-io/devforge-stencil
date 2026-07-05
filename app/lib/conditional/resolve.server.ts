import { getComponent, type ComponentData } from "../component.server";
import type { AnyContentItem } from "../content.server";
import { parseFragment } from "../dom.server";
import { buildContext } from "./context.server";
import { pickBranch } from "./evaluate";
import type { BranchTarget, ConditionContext } from "./types";

// Guards against cycles in nested conditionals (A → B → A under one context).
const MAX_DEPTH = 20;

export interface ResolveResult {
  html: string;
  /** Extra CSS to merge into the page, collected from chosen branch components. */
  css: string;
  /** True when the page actually contained a conditional placeholder. */
  resolved: boolean;
}

/**
 * Seams for testing — production code never passes these, so the real
 * `getComponent`/`buildContext` are used. Tests inject in-memory versions to
 * exercise the DOM swap without GitHub or a session cookie.
 */
export interface ResolveDeps {
  loadComponent?: (slug: string) => Promise<ComponentData | null>;
  context?: ConditionContext;
}

/**
 * Resolve every `data-pb-conditional="<slug>"` placeholder in `html` by
 * evaluating the referenced conditional component's rule set against the request
 * context and swapping in the chosen branch's markup.
 *
 * This runs server-side so that **hidden branches are never sent to the client**:
 * a logged-out visitor never receives the logged-in variant's markup. Unmatched
 * placeholders are removed (or emptied) per the spec's `fallback`.
 */
export async function resolveConditionals(
  html: string,
  request: Request,
  content?: AnyContentItem,
  deps?: ResolveDeps
): Promise<ResolveResult> {
  // Cheap string guard before paying for DOM parsing.
  if (!html.includes("data-pb-conditional")) {
    return { html, css: "", resolved: false };
  }

  const doc = parseFragment(html);
  const placeholders = Array.from(doc.querySelectorAll("[data-pb-conditional]"));
  if (placeholders.length === 0) {
    return { html, css: "", resolved: false };
  }

  const context = deps?.context ?? (await buildContext(request, content));
  const loader = deps?.loadComponent ?? getComponent;
  const cssChunks = new Set<string>();

  // Memoize component lookups within a single render (a branch target and the
  // conditional itself may be requested more than once).
  const cache = new Map<string, ComponentData | null>();
  const load = async (slug: string): Promise<ComponentData | null> => {
    if (!cache.has(slug)) cache.set(slug, await loader(slug));
    return cache.get(slug) ?? null;
  };

  // Render a chosen branch target to markup. When the target is itself a
  // conditional component, recurse: evaluate its rule set and render *its*
  // chosen branch. Returns the markup, "" for an explicit empty-box fallback, or
  // null for "render nothing".
  const renderTarget = async (target: BranchTarget, depth: number): Promise<string | null> => {
    if (depth > MAX_DEPTH) return null;
    if (target.kind === "inline") {
      if (target.css) cssChunks.add(target.css);
      return target.html;
    }
    const comp = await load(target.slug);
    if (!comp) return null;
    if (comp.type === "conditional" && comp.spec) {
      const inner = pickBranch(comp.spec, context);
      if (!inner) return comp.spec.fallback === "empty" ? "" : null;
      return renderTarget(inner, depth + 1);
    }
    if (comp.css) cssChunks.add(comp.css);
    return comp.html;
  };

  for (const el of placeholders) {
    const slug = el.getAttribute("data-pb-conditional");
    if (!slug) {
      el.remove();
      continue;
    }

    const conditional = await load(slug);
    if (!conditional?.spec) {
      el.remove();
      continue;
    }

    const target = pickBranch(conditional.spec, context);

    // `null` = render nothing; `""` = keep an empty box; otherwise swap in markup.
    let result: string | null;
    if (target) {
      result = await renderTarget(target, 1);
    } else {
      // No branch matched at the top level — apply this conditional's fallback.
      result = conditional.spec.fallback === "empty" ? "" : null;
    }

    if (result === null) {
      el.remove();
    } else if (result === "") {
      el.innerHTML = "";
      el.removeAttribute("data-pb-conditional");
    } else {
      const tpl = doc.createElement("template");
      tpl.innerHTML = result;
      el.replaceWith(...Array.from(tpl.content.childNodes));
    }
  }

  return {
    html: doc.body.innerHTML,
    css: Array.from(cssChunks).join("\n"),
    resolved: true,
  };
}
