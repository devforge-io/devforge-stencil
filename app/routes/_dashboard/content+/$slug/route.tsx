import { Link, Form, useNavigation, redirect } from "react-router";
import { useState } from "react";
import { formatDate } from "~/lib/format";
import {
  getContent,
  getContentPublishStatus,
  getPageCompiledCss,
  publishContent,
  unpublishContent,
  removeContent,
} from "~/lib/content.server";
import { getSettings } from "~/lib/settings.server";
import { requireAuth, requireRole, can } from "~/lib/auth.server";
import { removePageFromAllComponentIndices } from "~/lib/component.server";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/route";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { role } = await requireAuth(request);
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }
  const publishStatus = await getContentPublishStatus(params.slug, content.contentType);

  const { getContentDates, getGitHubConfig } = await import("~/lib/github.server");
  // Created = initial commit, Updated = latest commit — from the draft branch's
  // history (the authoring timeline), not the frontmatter (which can drift).
  const dates = await getContentDates(params.slug, undefined, content.contentType).catch(
    () => ({ createdAt: null, updatedAt: null })
  );

  let compiledCss: string | null = null;
  if (content.contentType === "page") {
    compiledCss = await getPageCompiledCss(params.slug, getGitHubConfig().branch);
  }

  // Chapter list (slug + title) for the preview iframe's chapter switcher.
  let tutorialChapters: { slug: string; title: string }[] | null = null;
  if (content.contentType === "tutorial" && "chapters" in content) {
    tutorialChapters = content.chapters.map((c) => ({ slug: c.slug, title: c.title }));
  }

  const { settings } = await getSettings();
  const bodyClasses = [...settings.bodyClasses, ...settings.darkBodyClasses].join(" ");
  const editorDarkMode = settings.editorDarkMode ?? false;

  const origin = new URL(request.url).origin;
  return { content, publishStatus, compiledCss, bodyClasses, editorDarkMode, dates, origin, tutorialChapters, canManage: can.publish(role) };
}

export async function action({ request, params }: Route.ActionArgs) {
  // Publish/unpublish/delete are moderator+; editors can only edit content.
  await requireRole(request, "moderator");
  const formData = await request.formData();
  const intent = formData.get("intent");
  const contentType = (formData.get("contentType") as "markdown" | "page" | "wikipedia") ?? "markdown";

  if (intent === "publish") {
    await publishContent(params.slug, contentType);
  } else if (intent === "unpublish") {
    await unpublishContent(params.slug, contentType);
  } else if (intent === "delete") {
    const sha = formData.get("sha") as string;
    await removeContent(params.slug, sha, contentType);
    if (contentType === "page") {
      await removePageFromAllComponentIndices(params.slug);
    }
    return redirect("/content");
  }

  return { ok: true };
}

export default function ContentView({ loaderData }: Route.ComponentProps) {
  const { content, publishStatus, compiledCss, bodyClasses, editorDarkMode, dates, origin, tutorialChapters, canManage } = loaderData;
  const htmlClass = editorDarkMode ? "dark" : "";
  const headerImage = content.frontmatter.headerImage;
  const headerImageUrl = typeof headerImage === "string" ? headerImage.trim() : "";
  const headerImageHtml = headerImageUrl
    ? `<img src="${headerImageUrl.replace(/"/g, "&quot;")}" alt="" style="display:block;width:100%;height:auto;object-fit:cover;">`
    : "";
  const navigation = useNavigation();
  const isPublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "publish";
  const isUnpublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "unpublish";
  const isDeleting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "delete";
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
          {canManage && (
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
          )}
          <Button variant="outline" size="sm" render={<Link to={`/content/${content.slug}/history`} />}>
            History
          </Button>
          <Button size="sm" render={<Link to={`/content/${content.slug}/edit`} />}>
            Edit
          </Button>
          {canManage && (
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="max-w-sm w-full mx-4">
            <CardContent className="pt-6 space-y-4">
              <h2 className="text-lg font-semibold">Delete "{content.frontmatter.title}"?</h2>
              <p className="text-sm text-muted-foreground">
                This will permanently remove this content from the draft branch.
                {publishStatus.published && " The published version will also be removed."}
                {" "}This action cannot be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </Button>
                <Form method="post">
                  <input type="hidden" name="contentType" value={content.contentType} />
                  <input type="hidden" name="sha" value={content.sha} />
                  <Button
                    type="submit"
                    name="intent"
                    value="delete"
                    variant="destructive"
                    size="sm"
                    disabled={isDeleting}
                  >
                    {isDeleting ? "Deleting..." : "Delete"}
                  </Button>
                </Form>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {content.frontmatter.tags?.map((tag) => (
          <Badge key={tag} variant="outline" className="font-normal">
            {tag}
          </Badge>
        ))}
        {dates.createdAt && (
          <span className="text-xs text-muted-foreground flex items-center">
            Created {formatDate(dates.createdAt)}
          </span>
        )}
        {dates.updatedAt && dates.updatedAt !== dates.createdAt && (
          <span className="text-xs text-muted-foreground flex items-center">
            Updated {formatDate(dates.updatedAt)}
          </span>
        )}
      </div>

      {content.contentType === "page" && "css" in content ? (
        <Card className="overflow-hidden">
          <iframe
            srcDoc={`<!DOCTYPE html><html class="${htmlClass}"><head><script src="https://cdn.tailwindcss.com"><\/script><script>tailwind.config={darkMode:'class'}<\/script><style>${compiledCss || (content as { css: string }).css}</style></head><body class="${bodyClasses}">${headerImageHtml}${content.html}</body></html>`}
            className="w-full min-h-[500px] border-0"
            title={content.frontmatter.title}
          />
        </Card>
      ) : content.contentType === "tutorial" ? (
        <TutorialPreview
          slug={content.slug}
          chapters={tutorialChapters ?? []}
          published={publishStatus.published}
        />
      ) : content.contentType === "wikipedia" ? (
        <Card className={htmlClass}>
          <CardContent className="p-8">
            <article
              className={`prose max-w-none wiki-content ${bodyClasses}`}
              dangerouslySetInnerHTML={{ __html: content.html }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card
          className={`${htmlClass} ${
            content.contentType === "article" ? "mx-auto max-w-[800px]" : ""
          }`}
        >
          {/* Direct child of Card so it sits flush at the top with rounded top
              corners (Card: has-[>img:first-child]:pt-0 + rounded-t-xl). */}
          {headerImageUrl && (
            <img src={headerImageUrl} alt="" className="block w-full" />
          )}
          <CardContent className="p-8">
            <article
              // Articles drop the body background so the content matches the card;
              // `cn`/twMerge lets the override beat the bg in `bodyClasses`.
              className={cn(
                "prose max-w-none",
                bodyClasses,
                content.contentType === "article" && "bg-transparent dark:bg-transparent"
              )}
              dangerouslySetInnerHTML={{ __html: content.html }}
            />
          </CardContent>
        </Card>
      )}

      {publishStatus.published && content.contentType === "article" && (
        <EmbedSnippet origin={origin} slug={content.slug} title={content.frontmatter.title} />
      )}

      {publishStatus.published && typeof content.frontmatter.path === "string" && content.frontmatter.path && (
        <p className="mt-1 text-xs text-muted-foreground">
          Live at:{" "}
          <a
            href={content.frontmatter.path}
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 dark:text-brand-400 hover:underline font-mono"
          >
            {content.frontmatter.path}
          </a>
        </p>
      )}
    </div>
  );
}

function EmbedSnippet({ origin, slug, title }: { origin: string; slug: string; title: string }) {
  const snippet =
    `<iframe src="${origin}/embed/articles/${slug}" style="width:100%;border:0" scrolling="no" title="${title.replace(/"/g, "&quot;")}"></iframe>\n` +
    `<script src="${origin}/embed.js" async></script>`;
  const [copied, setCopied] = useState(false);
  return (
    <Card className="mt-4">
      <CardContent className="py-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Embed on another site</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(snippet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Article content + styling, without the site template. The iframe auto-sizes to the content
          (the <code className="bg-muted px-1 rounded">embed.js</code> script handles resizing).
        </p>
        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
          <code>{snippet}</code>
        </pre>
      </CardContent>
    </Card>
  );
}

function TutorialPreview({
  slug,
  chapters,
  published,
}: {
  slug: string;
  chapters: { slug: string; title: string }[];
  published: boolean;
}) {
  const [active, setActive] = useState(0);
  if (chapters.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">No chapters yet — add them in the editor.</p>
        </CardContent>
      </Card>
    );
  }
  const current = chapters[Math.min(active, chapters.length - 1)];
  return (
    <Card className="overflow-hidden">
      {/* Renders the real (draft) tutorial through the assigned template, so the
          preview matches what visitors will see once published. */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
            Preview
          </span>
          <select
            value={active}
            onChange={(e) => setActive(Number(e.target.value))}
            className="h-7 max-w-xs rounded border border-border bg-background px-2 text-sm"
          >
            {chapters.map((c, i) => (
              <option key={c.slug} value={i}>
                {String(i + 1).padStart(2, "0")} · {c.title || c.slug}
              </option>
            ))}
          </select>
        </div>
        {published && (
          <a
            href={`/tutorial/${slug}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-brand-600 dark:text-brand-400 hover:underline shrink-0"
          >
            Open published ↗
          </a>
        )}
      </div>
      <iframe
        title="Tutorial preview"
        src={`/api/tutorial-preview/${slug}/${current.slug}`}
        className="w-full border-0 bg-white dark:bg-gray-950"
        style={{ height: "72vh" }}
      />
    </Card>
  );
}
