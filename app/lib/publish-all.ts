/**
 * Batch publish behind the content listing's "Publish All" button.
 *
 * Only items the listing badges "Unpublished changes" qualify: published
 * before, with a draft that now differs from the published copy. Drafts that
 * were never published stay out, so going live for the first time remains a
 * deliberate per-page act.
 *
 * Items are published one after another, never in parallel. Every publish
 * rewrites the shared index files on the publish branch (pages.json and
 * friends), and concurrent writes to one branch race on the branch head and
 * drop updates. One failure does not stop the rest; the caller gets both lists.
 *
 * Plain module (no server imports) so the route component can reuse the
 * selection rule for its count and the logic is unit-testable.
 */
export interface PublishableItem {
  slug: string;
  published: boolean;
  upToDate: boolean;
}

export interface PublishEachOutcome<T> {
  published: T[];
  failed: Array<{ item: T; error: string }>;
}

export function selectUnpublishedChanges<T extends PublishableItem>(items: T[]): T[] {
  return items.filter((it) => it.published && !it.upToDate);
}

export async function publishEach<T extends PublishableItem>(
  items: T[],
  publish: (item: T) => Promise<void>,
): Promise<PublishEachOutcome<T>> {
  const outcome: PublishEachOutcome<T> = { published: [], failed: [] };
  for (const item of items) {
    try {
      await publish(item);
      outcome.published.push(item);
    } catch (err) {
      outcome.failed.push({ item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcome;
}
