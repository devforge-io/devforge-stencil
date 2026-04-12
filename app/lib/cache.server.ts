import { LRUCache } from "lru-cache";
import type { ContentFrontmatter, ParsedContent } from "./markdown.server";

const metaCache = new LRUCache<string, ContentFrontmatter>({
  max: 500,
  ttl: 1000 * 60 * 5, // 5 minutes
});

const fullCache = new LRUCache<string, ParsedContent>({
  max: 200,
  ttl: 1000 * 60 * 5,
});

function key(slug: string, sha: string) {
  return `${slug}:${sha}`;
}

export const contentCache = {
  getMeta(slug: string, sha: string): ContentFrontmatter | undefined {
    return metaCache.get(key(slug, sha));
  },

  setMeta(slug: string, sha: string, meta: ContentFrontmatter) {
    metaCache.set(key(slug, sha), meta);
  },

  getFull(slug: string, sha: string): ParsedContent | undefined {
    return fullCache.get(key(slug, sha));
  },

  setFull(slug: string, sha: string, parsed: ParsedContent) {
    fullCache.set(key(slug, sha), parsed);
  },

  invalidate(slug: string) {
    // LRU cache doesn't support prefix deletion, so we clear relevant entries
    // by iterating. For a small cache this is fine.
    for (const k of metaCache.keys()) {
      if (k.startsWith(`${slug}:`)) {
        metaCache.delete(k);
      }
    }
    for (const k of fullCache.keys()) {
      if (k.startsWith(`${slug}:`)) {
        fullCache.delete(k);
      }
    }
  },
};
