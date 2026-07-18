import { Form, useNavigation } from "react-router";
import { useState, useCallback } from "react";
import { getSettings, saveSettings, type StencilSettings } from "~/lib/settings.server";
import { listContent } from "~/lib/content.server";
import { requireRole } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { ImageUploadField } from "~/components/image-upload-field";
import { Checkbox } from "~/components/ui/checkbox";
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
  const tutorialRootTemplateSlug = (formData.get("tutorialRootTemplateSlug") as string || "").trim();
  const tutorialChapterTemplateSlug = (formData.get("tutorialChapterTemplateSlug") as string || "").trim();
  const siteName = (formData.get("siteName") as string || "").trim();
  const favicon = (formData.get("favicon") as string || "").trim();
  const enableMarkdown = formData.get("enableMarkdown") === "on";
  const enableWiki = formData.get("enableWiki") === "on";
  const sha = (formData.get("sha") as string) || undefined;

  // Merge onto existing settings so other fields (e.g. editorDarkMode) survive.
  const { settings: current } = await getSettings();
  const settings: StencilSettings = {
    ...current,
    bodyClasses,
    darkBodyClasses,
    fonts,
    articleTemplateSlug: articleTemplateSlug || undefined,
    tutorialRootTemplateSlug: tutorialRootTemplateSlug || undefined,
    tutorialChapterTemplateSlug: tutorialChapterTemplateSlug || undefined,
    siteName: siteName || undefined,
    favicon: favicon || undefined,
    enableMarkdown: enableMarkdown || undefined,
    enableWiki: enableWiki || undefined,
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
  const [tutorialRootTemplateSlug, setTutorialRootTemplateSlug] = useState<string>(
    typeof initial.tutorialRootTemplateSlug === "string" ? initial.tutorialRootTemplateSlug : ""
  );
  const [tutorialChapterTemplateSlug, setTutorialChapterTemplateSlug] = useState<string>(
    typeof initial.tutorialChapterTemplateSlug === "string" ? initial.tutorialChapterTemplateSlug : ""
  );
  const [siteName, setSiteName] = useState<string>(
    typeof initial.siteName === "string" ? initial.siteName : ""
  );
  const [favicon, setFavicon] = useState<string>(
    typeof initial.favicon === "string" ? initial.favicon : ""
  );
  const [enableMarkdown, setEnableMarkdown] = useState<boolean>(initial.enableMarkdown === true);
  const [enableWiki, setEnableWiki] = useState<boolean>(initial.enableWiki === true);
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
        <input type="hidden" name="tutorialRootTemplateSlug" value={tutorialRootTemplateSlug} />
        <input type="hidden" name="tutorialChapterTemplateSlug" value={tutorialChapterTemplateSlug} />

        {/* Site */}
        <Card>
          <CardContent className="pt-6 space-y-2">
            <Label className="text-sm font-semibold">Site Name</Label>
            <Input
              name="siteName"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="My Site"
              className="max-w-sm"
            />
            <p className="text-xs text-muted-foreground">
              Used as <code className="text-xs bg-muted px-1 py-0.5 rounded">og:site_name</code> on shared links (e.g. above the title on Discord).
            </p>

            <Label className="text-sm font-semibold pt-2">Favicon</Label>
            <ImageUploadField
              name="favicon"
              value={favicon}
              onChange={setFavicon}
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
            />
            <p className="text-xs text-muted-foreground">
              The browser-tab icon. PNG, SVG, or ICO — a square image (e.g. 32×32 or 512×512) works best.
            </p>
          </CardContent>
        </Card>

        {/* Content Types */}
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div>
              <Label className="text-sm font-semibold">Content Types</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Articles and Pages are always available. Enable additional authoring formats here —
                they appear in the “New Content” type picker. Existing content of a disabled type
                stays viewable and editable.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="enableMarkdown"
                name="enableMarkdown"
                value="on"
                checked={enableMarkdown}
                onCheckedChange={(v) => setEnableMarkdown(v === true)}
              />
              <Label htmlFor="enableMarkdown" className="font-normal">Markdown</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="enableWiki"
                name="enableWiki"
                value="on"
                checked={enableWiki}
                onCheckedChange={(v) => setEnableWiki(v === true)}
              />
              <Label htmlFor="enableWiki" className="font-normal">Wiki (Wikitext)</Label>
            </div>
          </CardContent>
        </Card>

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

        {/* Tutorial Templates */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-semibold">Tutorial Templates</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Optional <strong>pages</strong> used as the layout for tutorials. Build them in the page
                editor, drop the tutorial slot blocks where each part should render, and <strong>publish
                the page</strong> — like article templates, it's read from the published branch. Without a
                template, tutorials use a built-in default layout.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">
                Overview template <span className="text-muted-foreground font-mono">/tutorial/&lt;slug&gt;</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Drop a <strong>Tutorial Overview</strong> block where the title, description &amp; chapter list should go.
              </p>
              <select
                value={tutorialRootTemplateSlug}
                onChange={(e) => setTutorialRootTemplateSlug(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Built-in default —</option>
                {pages.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.title} ({p.slug})</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium">
                Chapter template <span className="text-muted-foreground font-mono">/tutorial/&lt;slug&gt;/&lt;chapter&gt;</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Drop a <strong>Chapter Menu</strong> block and a <strong>Chapter Content</strong> block where each should render.
              </p>
              <select
                value={tutorialChapterTemplateSlug}
                onChange={(e) => setTutorialChapterTemplateSlug(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Built-in default —</option>
                {pages.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.title} ({p.slug})</option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </Form>
    </div>
  );
}
