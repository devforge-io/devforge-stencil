import { Link } from "react-router";
import { listContent } from "~/lib/content.server";
import { formatDate } from "~/lib/format";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import type { Route } from "./+types/route";

export async function loader() {
  const items = await listContent();
  return { items };
}

export default function ContentIndex({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Content</h1>
        <Button render={<Link to="/content/new" />}>New Post</Button>
      </div>

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
          {items.map((item) => (
            <Link key={item.slug} to={`/content/${item.slug}`} className="block">
              <Card className="hover:border-primary/50 transition-colors">
                <CardContent className="flex items-start justify-between py-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-semibold">{item.meta.title}</h2>
                      <Badge variant={item.contentType === "page" ? "secondary" : "outline"}>
                        {item.contentType === "page" ? "Page" : "Article"}
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
