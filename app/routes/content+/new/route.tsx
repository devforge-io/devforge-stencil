import { Form, redirect, useNavigation } from "react-router";
import { useState } from "react";
import { saveContent } from "~/lib/content.server";
import { MarkdownEditor } from "~/components/markdown-editor";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const slug = (formData.get("slug") as string)?.trim();
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const tags = (formData.get("tags") as string)?.trim();
  const body = (formData.get("body") as string) ?? "";
  const draft = formData.get("draft") === "on";

  if (!slug || !title) {
    return { error: "Slug and title are required" };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: "Slug must be lowercase alphanumeric with hyphens" };
  }

  const frontmatter = [
    "---",
    `title: "${title}"`,
    description ? `description: "${description}"` : null,
    tags ? `tags: [${tags.split(",").map((t) => `"${t.trim()}"`).join(", ")}]` : null,
    `publishedAt: "${new Date().toISOString()}"`,
    draft ? `draft: true` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = `${frontmatter}\n\n${body}`;

  await saveContent(slug, raw);

  return redirect(`/content/${slug}`);
}

export default function NewContent({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">New Content</h1>

      <Form method="post" className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="title" className="block text-sm font-medium mb-1.5">
              Title
            </label>
            <input
              id="title"
              name="title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label htmlFor="slug" className="block text-sm font-medium mb-1.5">
              Slug
            </label>
            <input
              id="slug"
              name="slug"
              required
              defaultValue={slugify(title)}
              key={title}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium mb-1.5">
            Description
          </label>
          <input
            id="description"
            name="description"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label htmlFor="tags" className="block text-sm font-medium mb-1.5">
            Tags (comma-separated)
          </label>
          <input
            id="tags"
            name="tags"
            placeholder="docs, tutorial"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">
            Content (Markdown)
          </label>
          <MarkdownEditor value={body} onChange={setBody} name="body" />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="draft"
            name="draft"
            type="checkbox"
            className="rounded border-gray-300 dark:border-gray-700"
          />
          <label htmlFor="draft" className="text-sm">
            Save as draft
          </label>
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
            {isSubmitting ? "Saving..." : "Create"}
          </button>
        </div>
      </Form>
    </div>
  );
}
