import { Form, redirect, useNavigation } from "react-router";
import { useState } from "react";
import { saveContent, type ContentType } from "~/lib/content.server";
import { MarkdownEditor } from "~/components/markdown-editor";
import { buildPageRaw } from "~/lib/page.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const slug = (formData.get("slug") as string)?.trim();
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const tags = (formData.get("tags") as string)?.trim();
  const contentType = (formData.get("contentType") as ContentType) ?? "markdown";
  const body = (formData.get("body") as string) ?? "";
  const draft = formData.get("draft") === "on";

  if (!slug || !title) {
    return { error: "Slug and title are required" };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: "Slug must be lowercase alphanumeric with hyphens" };
  }

  let raw: string;

  if (contentType === "page") {
    const fm: Record<string, unknown> = { title };
    if (description) fm.description = description;
    if (tags) fm.tags = tags.split(",").map((t) => t.trim());
    fm.publishedAt = new Date().toISOString();
    if (draft) fm.draft = true;
    raw = buildPageRaw(fm, "{}", "", "");
  } else {
    const frontmatter = [
      "---",
      `title: "${title}"`,
      description ? `description: "${description}"` : null,
      tags
        ? `tags: [${tags.split(",").map((t) => `"${t.trim()}"`).join(", ")}]`
        : null,
      `publishedAt: "${new Date().toISOString()}"`,
      draft ? `draft: true` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    raw = `${frontmatter}\n\n${body}`;
  }

  await saveContent(slug, raw, undefined, contentType);

  return redirect(`/content/${slug}`);
}

export default function NewContent({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [contentType, setContentType] = useState<ContentType>("markdown");

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-6">New Content</h1>

      <Form method="post" className="space-y-4">
        <div className="flex gap-2 mb-2">
          {(
            [
              ["markdown", "Article (Markdown)"],
              ["page", "Page (Visual Builder)"],
            ] as const
          ).map(([type, label]) => (
            <Button
              key={type}
              type="button"
              variant={contentType === type ? "default" : "outline"}
              size="sm"
              onClick={() => setContentType(type)}
            >
              {label}
            </Button>
          ))}
        </div>
        <input type="hidden" name="contentType" value={contentType} />

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              required
              defaultValue={slugify(title)}
              key={title}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tags">Tags (comma-separated)</Label>
          <Input id="tags" name="tags" placeholder="docs, tutorial" />
        </div>

        {contentType === "markdown" && (
          <div className="space-y-2">
            <Label>Content (Markdown)</Label>
            <MarkdownEditor value={body} onChange={setBody} name="body" />
          </div>
        )}

        {contentType === "page" && (
          <Card>
            <CardContent className="py-4">
              <p className="text-sm text-muted-foreground">
                The visual page builder will open after you create this page.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center gap-2">
          <Checkbox id="draft" name="draft" value="on" />
          <Label htmlFor="draft" className="font-normal">Save as draft</Label>
        </div>

        {actionData?.error && (
          <p className="text-sm text-destructive">{actionData.error}</p>
        )}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create"}
        </Button>
      </Form>
    </div>
  );
}
