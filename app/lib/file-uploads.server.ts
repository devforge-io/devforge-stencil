import {
  getGitHubConfig,
  getRepoFileRaw,
  saveRepoFileRaw,
  getRepoFileBytes,
  saveRepoFileBase64,
  deleteRepoFile,
} from "./github.server";

/**
 * A file uploaded through the dashboard and served at a custom URL path.
 * Files live on the publish branch and are reachable immediately (live on upload).
 */
export interface FileUploadEntry {
  /** Public URL path, e.g. "/foundry/install.sh". */
  path: string;
  /** Original uploaded filename. */
  filename: string;
  /** MIME type served with the file. */
  contentType: string;
  /** Size in bytes. */
  size: number;
  updatedAt: string;
}

const INDEX_NAME = "files.json";

/** App-owned path prefixes an uploaded file may never claim. */
export const RESERVED_PREFIXES = [
  "/content",
  "/api",
  "/embed",
  "/guide",
  "/login",
  "/logout",
  "/components",
  "/settings",
  "/articles",
  "/tutorial",
  "/files",
  "/.well-known",
];

export function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

const branch = () => getGitHubConfig().publishBranch;
const indexPath = () => `${getGitHubConfig().contentPath}/${INDEX_NAME}`;
/** Where a served URL path is stored in the repo, e.g. /foundry/install.sh -> content/files/foundry/install.sh */
const storagePath = (urlPath: string) => `${getGitHubConfig().contentPath}/files${urlPath}`;

/**
 * Normalize a public file URL path: leading slash, collapsed/loss of trailing
 * slashes, and safe segments only. Returns null for empty or unsafe input
 * (path traversal, empty segments, illegal characters).
 */
export function normalizeFilePath(input: string): string | null {
  let p = (input || "").trim();
  if (!p) return null;
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!p) return null;
  const segments = p.slice(1).split("/");
  const safe = /^[a-zA-Z0-9._-]+$/;
  if (segments.some((s) => !s || s === "." || s === ".." || !safe.test(s))) return null;
  return p;
}

const MIME: Record<string, string> = {
  // Text / scripts — served inline so `curl | bash` and browser-view both work
  sh: "text/plain; charset=utf-8",
  bash: "text/plain; charset=utf-8",
  zsh: "text/plain; charset=utf-8",
  ps1: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  rb: "text/plain; charset=utf-8",
  pl: "text/plain; charset=utf-8",
  lua: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  ini: "text/plain; charset=utf-8",
  conf: "text/plain; charset=utf-8",
  env: "text/plain; charset=utf-8",
  // Structured text
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv; charset=utf-8",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  // Documents / archives / binaries (downloaded)
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  dmg: "application/x-apple-diskimage",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  exe: "application/octet-stream",
  bin: "application/octet-stream",
};

/** MIME type for a filename; scripts/text are inline, unknown/binary download. */
export function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** All uploaded files (from the files.json index). Fast — a single read. */
export async function listFileUploads(): Promise<FileUploadEntry[]> {
  const raw = await getRepoFileRaw(indexPath(), branch());
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as FileUploadEntry[]) : [];
  } catch {
    return [];
  }
}

/** Resolve a request path to a stored file's bytes + content type (for serving). */
export async function resolveFileUpload(
  path: string
): Promise<{ content: Buffer; contentType: string; filename: string } | null> {
  const norm = normalizeFilePath(path);
  if (!norm) return null;
  const bytes = await getRepoFileBytes(storagePath(norm), branch());
  if (!bytes) return null;
  const filename = norm.split("/").pop() || "file";
  return { content: bytes.content, contentType: contentTypeFor(filename), filename };
}

/** Store an uploaded file at its URL path and upsert the index (live on upload). */
export async function saveFileUpload(params: {
  path: string;
  filename: string;
  base64: string;
  size: number;
}): Promise<FileUploadEntry> {
  const b = branch();
  await saveRepoFileBase64(storagePath(params.path), params.base64, `Upload file ${params.path}`, b);

  const entry: FileUploadEntry = {
    path: params.path,
    filename: params.filename,
    contentType: contentTypeFor(params.filename),
    size: params.size,
    updatedAt: new Date().toISOString(),
  };
  const entries = (await listFileUploads()).filter((e) => e.path !== params.path);
  entries.push(entry);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  await saveRepoFileRaw(indexPath(), JSON.stringify(entries, null, 2), "Update files index", b);
  return entry;
}

/** Remove a file and its index entry. */
export async function deleteFileUpload(path: string): Promise<void> {
  const norm = normalizeFilePath(path);
  if (!norm) return;
  const b = branch();
  await deleteRepoFile(storagePath(norm), `Delete file ${norm}`, b);
  const entries = (await listFileUploads()).filter((e) => e.path !== norm);
  await saveRepoFileRaw(indexPath(), JSON.stringify(entries, null, 2), "Update files index", b);
}
