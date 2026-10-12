import { Form, Link, useNavigation } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { listContent, publishAllChanged } from "~/lib/content.server";
import { getSettings } from "~/lib/settings.server";
import { requireAuth, requireRole, can } from "~/lib/auth.server";
import { selectUnpublishedChanges } from "~/lib/publish-all";
import { formatDate } from "~/lib/format";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const [{ role }, items, { settings }] = await Promise.all([requireAuth(request), listContent(), getSettings()]);
  const templateSlug = typeof settings.articleTemplateSlug === "string" ? settings.articleTemplateSlug : null;
  return {
    items,
    templateSlug,
    enableMarkdown: settings.enableMarkdown === true,
    enableWiki: settings.enableWiki === true,
    canManage: can.publish(role),
  };
}

export async function action({ request }: Route.ActionArgs) {
  // Publishing is moderator+, the same bar as the per-page Publish button.
  await requireRole(request, "moderator");
  const formData = await request.formData();
  if (formData.get("intent") !== "publish-all") {
    throw new Response("Bad Request", { status: 400 });
  }
  return publishAllChanged();
}

// Singular labels for the content types (+ the derived "template" type).
const TYPE_LABEL: Record<string, string> = {
  article: "Article",
  page: "Page",
  template: "Template",
  tutorial: "Tutorial",
  markdown: "Markdown",
  wikipedia: "Wiki",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function ContentIndex({ loaderData, actionData }: Route.ComponentProps) {
  const { items, templateSlug, enableMarkdown, enableWiki, canManage } = loaderData;
  const [selected, setSelected] = useState<string | null>(null);
  const [showPublishAll, setShowPublishAll] = useState(false);
  const [resultDismissed, setResultDismissed] = useState(false);

  const navigation = useNavigation();
  // Stays true through the revalidation that follows the submit, so the
  // button and dialog only release once the badges below are current.
  const isPublishingAll =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "publish-all";

  // Items wearing the "Unpublished changes" badge: what Publish All will push.
  const pending = useMemo(() => selectUnpublishedChanges(items), [items]);

  // When a batch finishes, close the dialog and show its outcome.
  useEffect(() => {
    if (actionData && !isPublishingAll) {
      setShowPublishAll(false);
      setResultDismissed(false);
    }
  }, [actionData, isPublishingAll]);

  // The page designated as the article template is shown as its own "template"
  // type rather than a plain "page".
  const displayType = (it: (typeof items)[number]) =>
    it.contentType === "page" && it.slug === templateSlug ? "template" : it.contentType;

  // Content types disabled in Settings never get a tab — even if content of
  // that type still exists (it just isn't listed here).
  const hiddenTypes = useMemo(() => {
    const h = new Set<string>();
    if (!enableMarkdown) h.add("markdown");
    if (!enableWiki) h.add("wikipedia");
    return h;
  }, [enableMarkdown, enableWiki]);

  // One tab per (display) type actually present, each with a count.
  const tabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const t = it.contentType === "page" && it.slug === templateSlug ? "template" : it.contentType;
      if (hiddenTypes.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const order = ["article", "page", "template", "tutorial", "markdown", "wikipedia"];
    const present = [...counts.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return present.map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t, count: counts.get(t) ?? 0 }));
  }, [items, templateSlug, hiddenTypes]);

  // Default to the first tab when nothing is explicitly selected.
  const active = selected ?? tabs[0]?.value ?? "";
  const filtered = items.filter((it) => displayType(it) === active);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Content</h1>
        <div className="flex items-center gap-2">
          {canManage && pending.length > 0 && (
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={isPublishingAll}
              onClick={() => setShowPublishAll(true)}
            >
              {isPublishingAll ? "Publishing..." : `Publish All (${pending.length})`}
            </Button>
          )}
          <Button render={<Link to="/content/new" />}>New Post</Button>
        </div>
      </div>

      {/* Publish All confirmation */}
      {showPublishAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="max-w-md w-full mx-4">
            <CardContent className="pt-6 space-y-4">
              <h2 className="text-lg font-semibold">Publish all unpublished changes?</h2>
              <p className="text-sm text-muted-foreground">
                This publishes {plural(pending.length, "item")} to the live site, one after another.
                Assets they reference and compiled page CSS go with them. Drafts that were never
                published are left alone.
              </p>
              <ul className="max-h-60 overflow-y-auto text-sm space-y-1">
                {pending.map((it) => (
                  <li key={it.slug} className="flex items-center gap-2">
                    <span className="font-medium">{it.meta.title}</span>
                    <Badge variant="outline" className="text-xs font-normal">
                      {TYPE_LABEL[displayType(it)] ?? displayType(it)}
                    </Badge>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isPublishingAll}
                  onClick={() => setShowPublishAll(false)}
                >
                  Cancel
                </Button>
                <Form method="post">
                  <Button
                    type="submit"
                    name="intent"
                    value="publish-all"
                    size="sm"
                    className="bg-green-600 hover:bg-green-700 text-white"
                    disabled={isPublishingAll}
                  >
                    {isPublishingAll ? "Publishing..." : `Publish ${plural(pending.length, "item")}`}
                  </Button>
                </Form>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Outcome of the last Publish All */}
      {actionData && !resultDismissed && !isPublishingAll && (
        <Card
          className={
            actionData.failed.length > 0
              ? "mb-4 border-yellow-500/40"
              : "mb-4 border-green-500/40"
          }
        >
          <CardContent className="flex items-start justify-between gap-4 py-4 text-sm">
            <div className="space-y-1">
              {actionData.published.length > 0 && (
                <p>
                  Published {plural(actionData.published.length, "item")}:{" "}
                  {actionData.published.map((p) => p.title).join(", ")}.
                </p>
              )}
              {actionData.failed.length > 0 && (
                <div>
                  <p>Could not publish {plural(actionData.failed.length, "item")}:</p>
                  <ul className="list-disc pl-5">
                    {actionData.failed.map((f) => (
                      <li key={f.slug}>
                        <span className="font-medium">{f.title}</span>
                        <span className="text-muted-foreground"> ({f.error})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {actionData.published.length === 0 && actionData.failed.length === 0 && (
                <p>Nothing to publish: every published item is already up to date.</p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setResultDismissed(true)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {tabs.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4 border-b pb-2">
          {tabs.map((t) => (
            <Button
              key={t.value}
              variant={active === t.value ? "secondary" : "ghost"}
              size="sm"
              className="cursor-pointer"
              onClick={() => setSelected(t.value)}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
            </Button>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <p className="text-muted-foreground mb-4">
              No content yet. Create your first post to get started.
            </p>
            <Button render={<Link to="/content/new" />}>Create First Post
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => (
            <Link key={item.slug} to={`/content/${item.slug}`} className="block">
              <Card className="hover:border-primary/50 transition-colors">
                <CardContent className="flex items-start justify-between py-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-semibold">{item.meta.title}</h2>
                      <Badge
                        variant={
                          displayType(item) === "template"
                            ? "default"
                            : item.contentType === "page"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {TYPE_LABEL[displayType(item)] ?? displayType(item)}
                      </Badge>
                      {item.published ? (
                        item.upToDate ? (
                          <Badge variant="default" className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20">
                            Published
                          </Badge>
                        ) : (
                          <Badge variant="default" className="bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20">
                            Unpublished changes
                          </Badge>
                        )
                      ) : (
                        <Badge variant="secondary">Draft</Badge>
                      )}
                      {item.meta.path && (
                        <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
                          {item.meta.path}
                        </code>
                      )}
                    </div>
                    {item.meta.description && (
                      <p className="text-sm text-muted-foreground">
                        {item.meta.description}
                      </p>
                    )}
                    {item.meta.tags && item.meta.tags.length > 0 && (
                      <div className="flex gap-1.5 mt-2">
                        {item.meta.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs font-normal">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  {item.meta.publishedAt && (
                    <time className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                      {formatDate(item.meta.publishedAt)}
                    </time>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
