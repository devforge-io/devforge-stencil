import { Link } from "react-router";
import { useMemo, useState } from "react";
import { listContent } from "~/lib/content.server";
import { getSettings } from "~/lib/settings.server";
import { formatDate } from "~/lib/format";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import type { Route } from "./+types/route";

export async function loader() {
  const [items, { settings }] = await Promise.all([listContent(), getSettings()]);
  const templateSlug = typeof settings.articleTemplateSlug === "string" ? settings.articleTemplateSlug : null;
  return {
    items,
    templateSlug,
    enableMarkdown: settings.enableMarkdown === true,
    enableWiki: settings.enableWiki === true,
  };
}

// Singular labels for the content types (+ the derived "template" type).
const TYPE_LABEL: Record<string, string> = {
  article: "Article",
  page: "Page",
  template: "Template",
  markdown: "Markdown",
  wikipedia: "Wiki",
};

export default function ContentIndex({ loaderData }: Route.ComponentProps) {
  const { items, templateSlug, enableMarkdown, enableWiki } = loaderData;
  const [selected, setSelected] = useState<string | null>(null);

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
    const order = ["article", "page", "template", "markdown", "wikipedia"];
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
        <Button render={<Link to="/content/new" />}>New Post</Button>
      </div>

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
