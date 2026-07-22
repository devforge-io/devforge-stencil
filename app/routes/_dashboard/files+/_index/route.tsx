import { Link, Form, useNavigation } from "react-router";
import { useState } from "react";
import { requireAuth } from "~/lib/auth.server";
import {
  listFileUploads,
  saveFileUpload,
  deleteFileUpload,
  normalizeFilePath,
  isReservedPath,
} from "~/lib/file-uploads.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import type { Route } from "./+types/route";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — GitHub Contents API ceiling headroom

export async function loader() {
  const files = await listFileUploads();
  return { files };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const path = (formData.get("path") as string) || "";
    await deleteFileUpload(path);
    return { ok: true };
  }

  // Upload
  const file = formData.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload." };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { error: "File too large (max 25MB)." };
  }

  // Target URL: explicit, or default to "/<filename>".
  const rawPath = ((formData.get("path") as string) || "").trim() || `/${file.name}`;
  const path = normalizeFilePath(rawPath);
  if (!path) {
    return { error: "Invalid URL path. Use letters, numbers, dots, dashes and slashes." };
  }
  if (isReservedPath(path)) {
    return { error: `"${path}" is reserved by the app and can't be used.` };
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  await saveFileUpload({ path, filename: file.name, base64, size: file.size });
  return { ok: true, uploaded: path };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesList({ loaderData, actionData }: Route.ComponentProps) {
  const { files } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [path, setPath] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const copyUrl = (p: string) => {
    const url = typeof window !== "undefined" ? window.location.origin + p : p;
    navigator.clipboard?.writeText(url);
    setCopied(p);
    setTimeout(() => setCopied((c) => (c === p ? null : c)), 1500);
  };

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Files</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a file and serve it at a custom URL — e.g. install scripts, downloads. Live immediately.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" render={<Link to="/content" />}>Content</Button>
        </div>
      </div>

      <Card className="mb-6"><CardContent className="pt-6">
        <Form method="post" encType="multipart/form-data" className="space-y-4">
          <div className="grid grid-cols-[1fr_1.4fr] gap-4">
            <div className="space-y-2">
              <Label htmlFor="file">File</Label>
              <Input
                id="file"
                name="file"
                type="file"
                required
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && !path) setPath(`/${f.name}`);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="path">Served at URL</Label>
              <Input
                id="path"
                name="path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/foundry/install.sh"
              />
            </div>
          </div>
          {actionData && "error" in actionData && actionData.error && (
            <p className="text-sm text-destructive">{actionData.error}</p>
          )}
          {actionData && "uploaded" in actionData && actionData.uploaded && (
            <p className="text-sm text-green-600 dark:text-green-500">
              Uploaded — live at <code className="font-mono">{actionData.uploaded}</code>
            </p>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Uploading..." : "Upload"}
          </Button>
        </Form>
      </CardContent></Card>

      {files.length === 0 ? (
        <Card><CardContent className="py-12 text-center">
          <p className="text-muted-foreground">No files uploaded yet.</p>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <Card key={f.path}>
              <CardContent className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <a href={f.path} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline break-all">
                    {f.path}
                  </a>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-[10px] text-muted-foreground font-mono truncate">{f.filename}</code>
                    <Badge variant="secondary" className="text-[10px]">{formatSize(f.size)}</Badge>
                    <span className="text-[10px] text-muted-foreground">{f.contentType.split(";")[0]}</span>
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => copyUrl(f.path)}>
                  {copied === f.path ? "Copied!" : "Copy URL"}
                </Button>
                <Form
                  method="post"
                  onSubmit={(e) => { if (!confirm(`Delete ${f.path}?`)) e.preventDefault(); }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="path" value={f.path} />
                  <Button type="submit" variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                    Delete
                  </Button>
                </Form>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
