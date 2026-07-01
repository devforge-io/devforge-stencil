import { uploadAsset, assetExists } from "~/lib/github.server";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
]);

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// A safe single-segment subdirectory (the article/page slug); never a path.
function sanitizeDir(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request);

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: "File too large (max 10MB)" },
      { status: 400 }
    );
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return Response.json(
      { error: `File type ${file.type} not allowed` },
      { status: 400 }
    );
  }

  // Optional per-content subdirectory named after the article/page slug, so an
  // item's images are grouped under content/assets/<slug>/.
  const dir = sanitizeDir((formData.get("slug") as string) || "");
  const key = (name: string) => (dir ? `${dir}/${name}` : name);

  // Keep original name, sanitize for safety
  let filename = sanitizeFilename(file.name);

  // If a file with this name already exists (within the subdirectory), suffix it
  if (await assetExists(key(filename))) {
    const ext = filename.includes(".")
      ? `.${filename.split(".").pop()}`
      : "";
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let counter = 1;
    let candidate = `${base}-${counter}${ext}`;
    while (await assetExists(key(candidate))) {
      counter++;
      candidate = `${base}-${counter}${ext}`;
    }
    filename = candidate;
  }

  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const result = await uploadAsset(key(filename), base64);

  return Response.json({
    url: result.url,
    filename,
    commitSha: result.commitSha,
  });
}
