import { Form, Link, redirect, useNavigation, useFetcher } from "react-router";
import { useState, useCallback, useRef, useEffect } from "react";
import { getContent, saveContent, type ContentType } from "~/lib/content.server";
import { listWhiteboardsForPage } from "~/lib/whiteboard.server";
import { buildPageRaw } from "~/lib/page.server";
import { MarkdownEditor } from "~/components/markdown-editor";
import { PageEditor } from "~/components/page-editor-v2";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  const { frontmatter, raw, html } = content;

  // Extract body (everything after the closing ---)
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmMatch ? raw.slice(fmMatch[0].length).trimStart() : raw;

  const whiteboards = await listWhiteboardsForPage(params.slug);

  return {
    slug: content.slug,
    sha: content.sha,
    contentType: content.contentType as ContentType,
    title: frontmatter.title,
    description: frontmatter.description ?? "",
    tags: frontmatter.tags?.join(", ") ?? "",
    publishedAt: frontmatter.publishedAt ?? "",
    draft: frontmatter.draft ?? false,
    body,
    bodyHtml: html,
    // For page type, pass the project data
    projectData:
      content.contentType === "page" && "projectData" in content
        ? (content.projectData as string)
        : undefined,
    css:
      content.contentType === "page" && "css" in content
        ? (content.css as string)
        : undefined,
    whiteboards,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const sha = formData.get("sha") as string;
  const contentType = (formData.get("contentType") as ContentType) ?? "markdown";
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const tags = (formData.get("tags") as string)?.trim();
  const publishedAt = (formData.get("publishedAt") as string)?.trim();
  const draft = formData.get("draft") === "on";

  if (!title) {
    return { error: "Title is required" };
  }

  let raw: string;

  if (contentType === "page") {
    const projectData = formData.get("projectData") as string;
    const html = formData.get("pageHtml") as string;
    const css = formData.get("pageCss") as string;

    const fm: Record<string, unknown> = { title };
    if (description) fm.description = description;
    if (tags) fm.tags = tags.split(",").map((t) => t.trim());
    if (publishedAt) fm.publishedAt = publishedAt;
    fm.updatedAt = new Date().toISOString();
    if (draft) fm.draft = true;

    raw = buildPageRaw(fm, projectData || "{}", html || "", css || "");
  } else {
    const body = (formData.get("body") as string) ?? "";
    const frontmatter = [
      "---",
      `title: "${title}"`,
      description ? `description: "${description}"` : null,
      tags
        ? `tags: [${tags.split(",").map((t) => `"${t.trim()}"`).join(", ")}]`
        : null,
      publishedAt ? `publishedAt: "${publishedAt}"` : null,
      `updatedAt: "${new Date().toISOString()}"`,
      draft ? `draft: true` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    raw = `${frontmatter}\n\n${body}`;
  }

  // For page type, always save the CSS file
  const compiledCss = contentType === "page"
    ? (formData.get("pageCss") as string) ?? ""
    : undefined;

  await saveContent(params.slug, raw, sha || undefined, contentType, compiledCss);

  return redirect(`/content/${params.slug}`);
}

export default function EditContent({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [body, setBody] = useState(loaderData.body);

  // Page editor state
  const [pageProjectData, setPageProjectData] = useState(loaderData.projectData ?? "{}");
  const [pageHtml, setPageHtml] = useState(loaderData.bodyHtml ?? "");
  const [pageCss, setPageCss] = useState(loaderData.css ?? "");
  const [pageTitle, setPageTitle] = useState(loaderData.title);
  const [pageDescription, setPageDescription] = useState(loaderData.description);
  const [pageTags, setPageTags] = useState(loaderData.tags);
  const [pageDraft, setPageDraft] = useState(loaderData.draft);

  const insertWhiteboard = (wbSlug: string, imageUrl: string) => {
    const markdown = `\n\n![${wbSlug}](${imageUrl})\n\n`;
    setBody((current) => current + markdown);
  };

  const pendingPageSave = useRef(false);

  const handlePageSave = useCallback(
    (projectData: string, html: string, css: string, meta?: { title: string; description: string; tags: string; draft: boolean }) => {
      pendingPageSave.current = true;
      setPageProjectData(projectData);
      setPageHtml(html);
      setPageCss(css);
      if (meta) {
        setPageTitle(meta.title);
        setPageDescription(meta.description);
        setPageTags(meta.tags);
        setPageDraft(meta.draft);
      }
    },
    []
  );

  // Submit form after state has flushed to DOM
  useEffect(() => {
    if (!pendingPageSave.current) return;
    pendingPageSave.current = false;
    const form = document.getElementById("edit-form") as HTMLFormElement;
    if (form) form.requestSubmit();
  }, [pageProjectData, pageHtml, pageCss, pageTitle, pageDescription, pageTags, pageDraft]);

  const isPage = loaderData.contentType === "page";

  return (
    <div>

      {/* Whiteboards panel — only for markdown articles */}
      {!isPage && (
        <div className="mb-6 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">Whiteboards</h2>
            <div className="flex gap-2">
              <Link
                to={`/content/${loaderData.slug}/whiteboards`}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                Manage all
              </Link>
              <Link
                to={`/content/${loaderData.slug}/whiteboards/whiteboard-${Date.now()}`}
                className="text-xs px-2 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 transition-colors"
              >
                + New
              </Link>
            </div>
          </div>

          {loaderData.whiteboards.length === 0 ? (
            <p className="text-xs text-gray-400">
              No whiteboards for this page yet.
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {loaderData.whiteboards.map((wb) => (
                <div
                  key={wb.slug}
                  className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden"
                >
                  <div className="aspect-video bg-gray-50 dark:bg-gray-950 flex items-center justify-center overflow-hidden">
                    <img
                      src={wb.imageUrl}
                      alt={wb.slug}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </div>
                  <div className="p-1.5 flex items-center justify-between gap-1 bg-gray-50 dark:bg-gray-900">
                    <span className="text-[11px] font-medium truncate flex-1">
                      {wb.slug}
                    </span>
                    <div className="flex gap-0.5">
                      <button
                        type="button"
                        onClick={() => insertWhiteboard(wb.slug, wb.imageUrl)}
                        className="text-[10px] px-1.5 py-0.5 bg-brand-600 text-white rounded hover:bg-brand-700 transition-colors"
                      >
                        Insert
                      </button>
                      <Link
                        to={`/content/${loaderData.slug}/whiteboards/${wb.slug}`}
                        className="text-[10px] px-1.5 py-0.5 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      >
                        Edit
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Page editor — form fields are inside PageEditor's Page Settings panel */}
      {isPage ? (
        <>
          <Form method="post" id="edit-form">
            <input type="hidden" name="sha" value={loaderData.sha} />
            <input type="hidden" name="contentType" value="page" />
            <input type="hidden" name="publishedAt" value={loaderData.publishedAt} />
            <input type="hidden" name="projectData" value={pageProjectData} />
            <input type="hidden" name="pageHtml" value={pageHtml} />
            <input type="hidden" name="pageCss" value={pageCss} />
            <input type="hidden" name="title" value={pageTitle} />
            <input type="hidden" name="description" value={pageDescription} />
            <input type="hidden" name="tags" value={pageTags} />
            <input type="hidden" name="draft" value={pageDraft ? "on" : ""} />
          </Form>

          {actionData?.error && (
            <p className="text-sm text-destructive mb-2">{actionData.error}</p>
          )}

          <PageEditor
            projectData={loaderData.projectData}
            meta={{
              title: loaderData.title,
              description: loaderData.description,
              tags: loaderData.tags,
              draft: loaderData.draft,
              slug: loaderData.slug,
              sha: loaderData.sha,
              publishedAt: loaderData.publishedAt,
            }}
            onSave={handlePageSave}
            saving={isSubmitting}
          />
        </>
      ) : (
        /* Markdown editor form */
        <Form method="post" className="space-y-4">
          <input type="hidden" name="sha" value={loaderData.sha} />
          <input type="hidden" name="contentType" value="markdown" />
          <input
            type="hidden"
            name="publishedAt"
            value={loaderData.publishedAt}
          />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="title"
                className="block text-sm font-medium mb-1.5"
              >
                Title
              </label>
              <input
                id="title"
                name="title"
                required
                defaultValue={loaderData.title}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label
                htmlFor="description"
                className="block text-sm font-medium mb-1.5"
              >
                Description
              </label>
              <input
                id="description"
                name="description"
                defaultValue={loaderData.description}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="tags"
                className="block text-sm font-medium mb-1.5"
              >
                Tags (comma-separated)
              </label>
              <input
                id="tags"
                name="tags"
                defaultValue={loaderData.tags}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex items-end pb-1">
              <div className="flex items-center gap-2">
                <input
                  id="draft"
                  name="draft"
                  type="checkbox"
                  defaultChecked={loaderData.draft}
                  className="rounded border-gray-300 dark:border-gray-700"
                />
                <label htmlFor="draft" className="text-sm">
                  Draft
                </label>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">
              Content (Markdown)
            </label>
            <MarkdownEditor
              value={body}
              onChange={setBody}
              name="body"
              initialHtml={loaderData.bodyHtml}
            />
          </div>

          {actionData?.error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {actionData.error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {isSubmitting ? "Saving..." : "Save Changes"}
            </button>
            <a
              href={`/content/${loaderData.slug}`}
              className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
            >
              Cancel
            </a>
          </div>
        </Form>
      )}
    </div>
  );
}
