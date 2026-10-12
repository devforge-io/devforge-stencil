/**
 * Renders a block of CMS markup (the site header or footer lifted by
 * `site-chrome.server.ts`) inside a React route.
 *
 * Two things a bare `dangerouslySetInnerHTML` gets wrong here:
 *
 * 1. React compares the `{ __html }` object by identity, so a fresh literal on
 *    every render makes it assign `innerHTML` again on every re-render (React
 *    Router re-renders every route once right after hydration). That wipes
 *    whatever the header's inline script did to the DOM, such as swapping the
 *    Sign in link for the account menu, and `innerHTML` never runs scripts, so
 *    the menu does not come back. The object is memoised on the string instead.
 * 2. On a client-side mount (a route reached through a React Router redirect or
 *    navigation) the markup is inserted with `innerHTML`, so its inline scripts
 *    never run at all. They are re-created on mount so the browser executes
 *    them. After a server-rendered page load the parser has already run them,
 *    so chrome scripts must guard against running twice (the account menu
 *    marks its slot with `data-account-ready`).
 */

import { useEffect, useMemo, useRef } from "react";

export function CmsHtml({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useMemo(() => ({ __html: html }), [html]);
  useEffect(() => {
    const root = ref.current;
    if (root) runInlineScripts(root);
  }, [html]);
  return <div ref={ref} className={className} suppressHydrationWarning dangerouslySetInnerHTML={inner} />;
}

/** Replaces every `<script>` under `root` with an identical fresh element, which makes the browser execute it. */
export function runInlineScripts(root: ParentNode): number {
  const scripts = Array.from(root.querySelectorAll("script"));
  for (const old of scripts) {
    const fresh = old.ownerDocument.createElement("script");
    for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
    fresh.textContent = old.textContent;
    old.replaceWith(fresh);
  }
  return scripts.length;
}
