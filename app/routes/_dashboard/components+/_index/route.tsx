import { Link, Form, redirect, useNavigation } from "react-router";
import { useState } from "react";
import { listComponents, saveComponent } from "~/lib/component.server";
import { emptySpec } from "~/lib/conditional/types";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import type { Route } from "./+types/route";

export async function loader() {
  const components = await listComponents();
  return { components };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const slug = (formData.get("slug") as string)?.trim();
  const name = (formData.get("name") as string)?.trim();
  const isConditional = formData.get("type") === "conditional";
  const category = (formData.get("category") as string)?.trim() || (isConditional ? "Logic" : "Custom");
  const description = (formData.get("description") as string)?.trim();

  if (!slug || !name) return { error: "Slug and name are required" };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { error: "Invalid slug" };

  if (isConditional) {
    // The body is generated from the spec — start with no branches.
    await saveComponent(slug, {
      name, category, description, html: "", css: "",
      type: "conditional", spec: emptySpec(),
    });
  } else {
    await saveComponent(slug, {
      name, category, description,
      html: `<div data-pb-name="${name}" class="p-4 border border-gray-200 dark:border-gray-700 rounded-lg"><p>New component: ${name}</p></div>`,
      css: "",
    });
  }
  return redirect(`/components/${slug}`);
}

export default function ComponentsList({ loaderData, actionData }: Route.ComponentProps) {
  const { components } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const categories = Array.from(new Set(components.map((c) => c.category))).sort();

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Components</h1>
          <p className="text-sm text-muted-foreground mt-1">Custom reusable blocks for the page builder</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" render={<Link to="/content" />}>Content</Button>
          <Button size="sm" onClick={() => setShowNew(!showNew)}>{showNew ? "Cancel" : "+ New"}</Button>
        </div>
      </div>

      {showNew && (
        <Card className="mb-6"><CardContent className="pt-6">
          <Form method="post" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label htmlFor="name">Name</Label><Input id="name" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Hero Banner" /></div>
              <div className="space-y-2"><Label htmlFor="slug">Slug</Label><Input id="slug" name="slug" required defaultValue={slugify(name)} key={name} placeholder="hero-banner" /></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label htmlFor="category">Category</Label><Input id="category" name="category" placeholder="Custom" /></div>
              <div className="space-y-2"><Label htmlFor="description">Description</Label><Input id="description" name="description" placeholder="A reusable hero section" /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <select id="type" name="type" defaultValue="static"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm">
                <option value="static">Static — fixed markup</option>
                <option value="conditional">Conditional — show a branch based on rules</option>
              </select>
            </div>
            {actionData?.error && <p className="text-sm text-destructive">{actionData.error}</p>}
            <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating..." : "Create"}</Button>
          </Form>
        </CardContent></Card>
      )}

      {components.length === 0 && !showNew ? (
        <Card><CardContent className="py-12 text-center">
          <p className="text-muted-foreground mb-4">No custom components yet.</p>
          <Button size="sm" onClick={() => setShowNew(true)}>Create your first component</Button>
        </CardContent></Card>
      ) : (
        <div className="space-y-4">
          {categories.map((cat) => (
            <div key={cat}>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">{cat}</h2>
              <div className="grid grid-cols-3 gap-3">
                {components.filter((c) => c.category === cat).map((comp) => (
                  <Link key={comp.slug} to={`/components/${comp.slug}`} className="block">
                    <Card className="hover:border-primary/50 transition-colors"><CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div><p className="text-sm font-medium">{comp.name}</p><code className="text-[10px] text-muted-foreground font-mono">{comp.slug}</code></div>
                        <Badge variant={comp.type === "conditional" ? "default" : "secondary"} className="text-[10px]">{comp.type === "conditional" ? "Conditional" : comp.category}</Badge>
                      </div>
                      {comp.description && <p className="text-xs text-muted-foreground mt-1.5">{comp.description}</p>}
                    </CardContent></Card>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
