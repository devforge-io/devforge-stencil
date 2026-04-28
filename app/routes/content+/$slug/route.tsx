import { Link, Form, useNavigation } from "react-router";
import { formatDate } from "~/lib/format";
import {
  getContent,
  getContentPublishStatus,
  getPageCompiledCss,
  publishContent,
  unpublishContent,
} from "~/lib/content.server";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }
  const publishStatus = await getContentPublishStatus(params.slug, content.contentType);

  let compiledCss: string | null = null;
  if (content.contentType === "page") {
    const { getGitHubConfig } = await import("~/lib/github.server");
    compiledCss = await getPageCompiledCss(params.slug, getGitHubConfig().branch);
  }

  return { content, publishStatus, compiledCss };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const contentType = (formData.get("contentType") as "markdown" | "page" | "wikipedia") ?? "markdown";

  if (intent === "publish") {
    await publishContent(params.slug, contentType);
  } else if (intent === "unpublish") {
    await unpublishContent(params.slug, contentType);
  }

  return { ok: true };
}

export default function ContentView({ loaderData }: Route.ComponentProps) {
  const { content, publishStatus, compiledCss } = loaderData;
  const navigation = useNavigation();
  const isPublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "publish";
  const isUnpublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "unpublish";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {content.frontmatter.title}
            </h1>
            {publishStatus.published ? (
              publishStatus.upToDate ? (
                <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20">
                  Published
                </Badge>
              ) : (
                <Badge className="bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20">
                  Unpublished changes
                </Badge>
              )
            ) : (
              <Badge variant="secondary">Draft</Badge>
            )}
          </div>
          {content.frontmatter.description && (
            <p className="text-muted-foreground">{content.frontmatter.description}</p>
          )}
          <code className="text-xs text-muted-foreground font-mono">
            {content.sha.slice(0, 7)}
          </code>
        </div>
        <div className="flex gap-2">
          <Form method="post">
            <input type="hidden" name="contentType" value={content.contentType} />
            {publishStatus.published && publishStatus.upToDate ? (
              <Button
                type="submit"
                name="intent"
                value="unpublish"
                variant="destructive"
                size="sm"
                disabled={isUnpublishing}
              >
                {isUnpublishing ? "Unpublishing..." : "Unpublish"}
              </Button>
            ) : (
              <Button
                type="submit"
                name="intent"
                value="publish"
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                disabled={isPublishing}
              >
                {isPublishing
                  ? "Publishing..."
                  : publishStatus.published
                    ? "Publish Changes"
                    : "Publish"}
              </Button>
            )}
          </Form>
          <Button variant="outline" size="sm" render={<Link to={`/content/${content.slug}/history`} />}>
            History
          </Button>
          <Button size="sm" render={<Link to={`/content/${content.slug}/edit`} />}>
            Edit
          </Button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {content.frontmatter.tags?.map((tag) => (
          <Badge key={tag} variant="outline" className="font-normal">
            {tag}
          </Badge>
        ))}
        {content.frontmatter.publishedAt && (
          <span className="text-xs text-muted-foreground flex items-center">
            Created {formatDate(content.frontmatter.publishedAt)}
          </span>
        )}
      </div>

      {content.contentType === "page" && "css" in content ? (
        <Card className="overflow-hidden">
          <iframe
            srcDoc={`<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"><\/script><style>${compiledCss || (content as { css: string }).css}</style></head><body>${content.html}</body></html>`}
            className="w-full min-h-[500px] border-0"
            title={content.frontmatter.title}
          />
        </Card>
      ) : content.contentType === "wikipedia" ? (
        <Card>
          <CardContent className="p-8">
            <article
              className="prose max-w-none wiki-content"
              dangerouslySetInnerHTML={{ __html: content.html }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-8">
            <article
              className="prose max-w-none"
              dangerouslySetInnerHTML={{ __html: content.html }}
            />
          </CardContent>
        </Card>
      )}

      {publishStatus.published && (
        <p className="mt-4 text-xs text-muted-foreground">
          Embed:{" "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
            /api/content/{content.slug}
          </code>
          {" | "}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
            /embed/{content.slug}
          </code>
        </p>
      )}
    </div>
  );
}
