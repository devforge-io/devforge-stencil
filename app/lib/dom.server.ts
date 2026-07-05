import { parseHTML } from "linkedom";

/**
 * Parse an HTML fragment and return the document whose <body> holds it. Uses
 * linkedom (not jsdom): it's lightweight and, crucially, has no CommonJS→ESM
 * `require` dependencies — jsdom's do, which breaks on serverless runtimes that
 * don't support `require(esm)` (e.g. Vercel's bytecode runtime).
 */
export function parseFragment(html: string): Document {
  return parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`)
    .document as unknown as Document;
}

/** Collect every text node under `root`, in document order. */
export function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out.push(child as Text);
      else walk(child);
    }
  };
  walk(root);
  return out;
}
