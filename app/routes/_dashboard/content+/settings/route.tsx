import { Form, useNavigation } from "react-router";
import { useState, useCallback } from "react";
import { getSettings, saveSettings, type StencilSettings } from "~/lib/settings.server";
import { listContent } from "~/lib/content.server";
import { requireRole } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "admin");
  const { settings, sha } = await getSettings();
  const pages = (await listContent())
    .filter((c) => c.contentType === "page")
    .map((c) => ({ slug: c.slug, title: c.meta.title ?? c.slug }));
  return { settings, sha, pages };
}

export async function action({ request }: Route.ActionArgs) {
  await requireRole(request, "admin");
  const formData = await request.formData();
  const bodyClasses = (formData.get("bodyClasses") as string || "").split(" ").filter(Boolean);
  const darkBodyClasses = (formData.get("darkBodyClasses") as string || "").split(" ").filter(Boolean);
  const fonts = (formData.get("fonts") as string || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const articleTemplateSlug = (formData.get("articleTemplateSlug") as string || "").trim();
  const sha = (formData.get("sha") as string) || undefined;

  // Merge onto existing settings so other fields (e.g. editorDarkMode) survive.
  const { settings: current } = await getSettings();
  const settings: StencilSettings = {
    ...current,
    bodyClasses,
    darkBodyClasses,
    fonts,
    articleTemplateSlug: articleTemplateSlug || undefined,
  };
  await saveSettings(settings, sha);
  return { saved: true };
}

const PRESET_BODY = [
  { group: "Background", options: ["bg-white", "bg-gray-50", "bg-gray-100", "bg-gray-900", "bg-gray-950", "bg-black"] },
  { group: "Text Color", options: ["text-gray-900", "text-gray-800", "text-gray-700", "text-gray-100", "text-white"] },
  { group: "Font", options: ["font-sans", "font-serif", "font-mono"] },
  { group: "Other", options: ["antialiased", "subpixel-antialiased", "min-h-screen"] },
];

const PRESET_DARK = [
  { group: "Dark Background", options: ["dark:bg-white", "dark:bg-gray-50", "dark:bg-gray-900", "dark:bg-gray-950", "dark:bg-black"] },
  { group: "Dark Text", options: ["dark:text-gray-900", "dark:text-gray-100", "dark:text-white"] },
];

export default function SettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { settings: initial, sha, pages } = loaderData;
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [bodyClasses, setBodyClasses] = useState<string[]>(initial.bodyClasses);
  const [darkBodyClasses, setDarkBodyClasses] = useState<string[]>(initial.darkBodyClasses);
  const [fonts, setFonts] = useState<string[]>(initial.fonts);
  const [articleTemplateSlug, setArticleTemplateSlug] = useState<string>(initial.articleTemplateSlug ?? "");
  const [newClass, setNewClass] = useState("");
  const [newDarkClass, setNewDarkClass] = useState("");

  const toggleClass = useCallback((list: string[], setList: (v: string[]) => void, cls: string) => {
    if (list.includes(cls)) setList(list.filter((c) => c !== cls));
    else setList([...list, cls]);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Global defaults for the page builder and component editor. Stored in <code className="text-xs bg-muted px-1 py-0.5 rounded">settings.json</code> in your repo.
          </p>
        </div>
      </div>

      {actionData && "saved" in actionData && (
        <div className="mb-4 px-3 py-2 text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
          Settings saved.
        </div>
      )}

      <Form method="post" className="space-y-6">
        <input type="hidden" name="sha" value={sha} />
        <input type="hidden" name="bodyClasses" value={bodyClasses.join(" ")} />
        <input type="hidden" name="darkBodyClasses" value={darkBodyClasses.join(" ")} />
        <input type="hidden" name="fonts" value={fonts.join("\n")} />
        <input type="hidden" name="articleTemplateSlug" value={articleTemplateSlug} />

        {/* Body Classes */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-semibold">Body Classes (Light Mode)</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Applied to the body element of every new page and component canvas.
              </p>
            </div>

            {bodyClasses.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {bodyClasses.map((cls) => (
                  <Badge key={cls} variant="secondary" className="text-xs font-mono px-2 py-0.5 gap-1">
                    {cls}
                    <button type="button" onClick={() => setBodyClasses(bodyClasses.filter((c) => c !== cls))} className="text-muted-foreground hover:text-destructive">x</button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input value={newClass} onChange={(e) => setNewClass(e.target.value)} placeholder="Add class..." className="h-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (newClass.trim()) { setBodyClasses([...bodyClasses, ...newClass.trim().split(/\s+/)]); setNewClass(""); } }
                }} />
              <Button type="button" variant="outline" size="sm" onClick={() => { if (newClass.trim()) { setBodyClasses([...bodyClasses, ...newClass.trim().split(/\s+/)]); setNewClass(""); } }}>Add</Button>
            </div>

            {PRESET_BODY.map(({ group, options }) => (
              <div key={group}>
                <p className="text-[10px] text-muted-foreground mb-1">{group}</p>
                <div className="flex flex-wrap gap-1">
                  {options.map((cls) => (
                    <button key={cls} type="button" onClick={() => toggleClass(bodyClasses, setBodyClasses, cls)}
                      className={cn("px-2 py-0.5 rounded text-xs font-mono transition-colors",
                        bodyClasses.includes(cls) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>
                      {cls}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Dark Body Classes */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-semibold">Dark Mode Classes</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Applied alongside body classes when dark mode is active.
              </p>
            </div>

            {darkBodyClasses.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {darkBodyClasses.map((cls) => (
                  <Badge key={cls} variant="secondary" className="text-xs font-mono px-2 py-0.5 gap-1">
                    {cls}
                    <button type="button" onClick={() => setDarkBodyClasses(darkBodyClasses.filter((c) => c !== cls))} className="text-muted-foreground hover:text-destructive">x</button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input value={newDarkClass} onChange={(e) => setNewDarkClass(e.target.value)} placeholder="dark:bg-gray-900..." className="h-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (newDarkClass.trim()) { setDarkBodyClasses([...darkBodyClasses, ...newDarkClass.trim().split(/\s+/)]); setNewDarkClass(""); } }
                }} />
              <Button type="button" variant="outline" size="sm" onClick={() => { if (newDarkClass.trim()) { setDarkBodyClasses([...darkBodyClasses, ...newDarkClass.trim().split(/\s+/)]); setNewDarkClass(""); } }}>Add</Button>
            </div>

            {PRESET_DARK.map(({ group, options }) => (
              <div key={group}>
                <p className="text-[10px] text-muted-foreground mb-1">{group}</p>
                <div className="flex flex-wrap gap-1">
                  {options.map((cls) => (
                    <button key={cls} type="button" onClick={() => toggleClass(darkBodyClasses, setDarkBodyClasses, cls)}
                      className={cn("px-2 py-0.5 rounded text-xs font-mono transition-colors",
                        darkBodyClasses.includes(cls) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground")}>
                      {cls}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Google Fonts */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-semibold">Google Fonts</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Font URLs loaded globally. One per line.
              </p>
            </div>
            <textarea
              value={fonts.join("\n")}
              onChange={(e) => setFonts(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
              rows={3}
              placeholder="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
              className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </CardContent>
        </Card>

        {/* Article Template */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-semibold">Article Template</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                A published <strong>page</strong> used as the layout for every article. Build it in the
                page editor, drop the <strong>Article Content</strong> block where the article body should
                appear, then publish it and select it here. Without one, articles use the default centered layout.
              </p>
            </div>
            <select
              value={articleTemplateSlug}
              onChange={(e) => setArticleTemplateSlug(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Default layout (no template) —</option>
              {pages.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title} ({p.slug})
                </option>
              ))}
            </select>
            {articleTemplateSlug && !pages.some((p) => p.slug === articleTemplateSlug) && (
              <p className="text-xs text-amber-600">
                Selected template “{articleTemplateSlug}” is no longer a page.
              </p>
            )}
          </CardContent>
        </Card>

        <Button type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </Form>
    </div>
  );
}
