import { Form, Link, redirect, useNavigation } from "react-router";
import { useState } from "react";
import { getContent, saveContent } from "~/lib/content.server";
import { listWhiteboardsForPage } from "~/lib/whiteboard.server";
import { MarkdownEditor } from "~/components/markdown-editor";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }

  const { frontmatter, raw, html } = content;

  // Extract body markdown (everything after the closing ---)
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmMatch ? raw.slice(fmMatch[0].length).trimStart() : raw;

  const whiteboards = await listWhiteboardsForPage(params.slug);

  return {
    slug: content.slug,
    sha: content.sha,
    title: frontmatter.title,
    description: frontmatter.description ?? "",
    tags: frontmatter.tags?.join(", ") ?? "",
    publishedAt: frontmatter.publishedAt ?? "",
    draft: frontmatter.draft ?? false,
    body,
    bodyHtml: html,
    whiteboards,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const sha = formData.get("sha") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const tags = (formData.get("tags") as string)?.trim();
  const publishedAt = (formData.get("publishedAt") as string)?.trim();
  const draft = formData.get("draft") === "on";
  const body = (formData.get("body") as string) ?? "";

  if (!title) {
    return { error: "Title is required" };
  }

  const frontmatter = [
    "---",
    `title: "${title}"`,
    description ? `description: "${description}"` : null,
    tags ? `tags: [${tags.split(",").map((t) => `"${t.trim()}"`).join(", ")}]` : null,
    publishedAt ? `publishedAt: "${publishedAt}"` : null,
    `updatedAt: "${new Date().toISOString()}"`,
    draft ? `draft: true` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = `${frontmatter}\n\n${body}`;

  await saveContent(params.slug, raw, sha || undefined);

  return redirect(`/content/${params.slug}`);
}

export default function EditContent({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [body, setBody] = useState(loaderData.body);

  const insertWhiteboard = (wbSlug: string, imageUrl: string) => {
    const markdown = `\n\n![${wbSlug}](${imageUrl})\n\n`;
    setBody((current) => current + markdown);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Edit: {loaderData.title}</h1>
      </div>

      {/* Whiteboards panel */}
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
            No whiteboards for this page yet. Create one to embed it in the content.
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {loaderData.whiteboards.map((wb) => (
              <div
                key={wb.slug}
                className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden group"
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
                      title="Insert into content"
                    >
                      Insert
                    </button>
                    <Link
                      to={`/content/${loaderData.slug}/whiteboards/${wb.slug}`}
                      className="text-[10px] px-1.5 py-0.5 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      title="Edit whiteboard"
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

      <Form method="post" className="space-y-4">
        <input type="hidden" name="sha" value={loaderData.sha} />
        <input type="hidden" name="publishedAt" value={loaderData.publishedAt} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="title" className="block text-sm font-medium mb-1.5">
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
            <label htmlFor="description" className="block text-sm font-medium mb-1.5">
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
            <label htmlFor="tags" className="block text-sm font-medium mb-1.5">
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
          <MarkdownEditor value={body} onChange={setBody} name="body" initialHtml={loaderData.bodyHtml} />
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
    </div>
  );
}
