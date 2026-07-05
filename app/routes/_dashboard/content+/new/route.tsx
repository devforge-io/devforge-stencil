import { Form, redirect, useNavigation } from "react-router";
import { useState } from "react";
import { saveContent, type ContentType } from "~/lib/content.server";
import { requireAuth } from "~/lib/auth.server";
import { upsertArticleIndex } from "~/lib/articles.server";
import { MarkdownEditor } from "~/components/markdown-editor";
import { ImageUploadField } from "~/components/image-upload-field";
import { WikipediaEditor } from "~/components/wikipedia-editor";
import { buildPageRaw } from "~/lib/page.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request); // any signed-in role (editor+) may create content
  const formData = await request.formData();
  const slug = (formData.get("slug") as string)?.trim();
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const tags = (formData.get("tags") as string)?.trim();
  const contentType = (formData.get("contentType") as ContentType) ?? "markdown";
  const body = (formData.get("body") as string) ?? "";
  const headerImage = (formData.get("headerImage") as string)?.trim();
  const ogImage = (formData.get("ogImage") as string)?.trim();
  const draft = formData.get("draft") === "on";
  const now = new Date().toISOString();

  if (!slug || !title) {
    return { error: "Slug and title are required" };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return { error: "Slug must be lowercase alphanumeric with hyphens" };
  }

  // Articles require a header image.
  if (contentType === "article" && !headerImage) {
    return { error: "Articles need a header image" };
  }

  const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

  let raw: string;

  if (contentType === "page") {
    const fm: Record<string, unknown> = { title };
    if (description) fm.description = description;
    if (tagList.length) fm.tags = tagList;
    fm.publishedAt = now;
    if (draft) fm.draft = true;
    raw = buildPageRaw(fm, "{}", "", "");
  } else {
    const frontmatter = [
      "---",
      `title: "${title}"`,
      description ? `description: "${description}"` : null,
      tagList.length ? `tags: [${tagList.map((t) => `"${t}"`).join(", ")}]` : null,
      headerImage ? `headerImage: "${headerImage}"` : null,
      ogImage ? `ogImage: "${ogImage}"` : null,
      `publishedAt: "${now}"`,
      draft ? `draft: true` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    raw = `${frontmatter}\n\n${body}`;
  }

  await saveContent(slug, raw, undefined, contentType);

  // Articles are also tracked in articles.json for quick listing.
  if (contentType === "article") {
    await upsertArticleIndex({
      slug,
      title,
      description: description || undefined,
      tags: tagList.length ? tagList : undefined,
      headerImage: headerImage || undefined,
      publishedAt: now,
      draft: draft || undefined,
      updatedAt: now,
    });
  }

  return redirect(`/content/${slug}`);
}

export default function NewContent({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [headerImage, setHeaderImage] = useState("");
  const [ogImage, setOgImage] = useState("");
  const [contentType, setContentType] = useState<ContentType>("article");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  // Auto-derive the slug from the title until the user edits it. Images uploaded
  // before save are stored under content/assets/<this slug>/.
  const effectiveSlug = slugTouched ? slug : slugify(title);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-6">New Content</h1>

      <Form method="post" className="space-y-4">
        <div className="flex gap-2 mb-2">
          {(
            [
              ["article", "Article"],
              ["markdown", "Markdown"],
              ["page", "Page (Visual Builder)"],
              ["wikipedia", "Wiki (Wikipedia)"],
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
              value={effectiveSlug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
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

        {contentType === "article" && (
          <>
            <div className="space-y-2">
              <Label>Header image <span className="text-destructive">*</span></Label>
              <ImageUploadField name="headerImage" value={headerImage} onChange={setHeaderImage} slug={effectiveSlug} />
            </div>
            <div className="space-y-2">
              <Label>Social share image</Label>
              <ImageUploadField name="ogImage" value={ogImage} onChange={setOgImage} slug={effectiveSlug} crop={{ width: 1200, height: 630 }} />
              <p className="text-xs text-muted-foreground">
                Used for OpenGraph/Twitter previews. Ideally 1200×630 (1.91:1), under 1&nbsp;MB. Falls back to the header image if empty.
              </p>
            </div>
          </>
        )}

        {(contentType === "markdown" || contentType === "article") && (
          <div className="space-y-2">
            <Label>Content (Markdown)</Label>
            <MarkdownEditor value={body} onChange={setBody} name="body" slug={effectiveSlug} />
          </div>
        )}

        {contentType === "wikipedia" && (
          <div className="space-y-2">
            <Label>Content (Wikitext)</Label>
            <WikipediaEditor value={body} onChange={setBody} name="body" slug={effectiveSlug} />
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
