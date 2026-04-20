import { Octokit } from "octokit";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  publishBranch: string;
  contentPath: string;
}

export interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
}

export interface GitHubFileContent {
  content: string;
  sha: string;
  path: string;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  date: string;
  author: string;
}

function getOctokit(token: string) {
  return new Octokit({ auth: token });
}

function getConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "draft";
  const publishBranch = process.env.GITHUB_PUBLISH_BRANCH || "main";
  const contentPath = process.env.GITHUB_CONTENT_PATH || "content";

  if (!token || !owner || !repo) {
    throw new Error(
      "Missing required environment variables: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO"
    );
  }

  return { token, owner, repo, branch, publishBranch, contentPath };
}

export type ContentType = "markdown" | "page";

const CONTENT_EXTENSIONS: Record<ContentType, string> = {
  markdown: ".md",
  page: ".page",
};

const ALL_CONTENT_EXTENSIONS = Object.values(CONTENT_EXTENSIONS);

export function contentFilePath(
  contentPath: string,
  slug: string,
  type: ContentType
): string {
  return `${contentPath}/${slug}${CONTENT_EXTENSIONS[type]}`;
}

export function isContentFile(filename: string): boolean {
  return ALL_CONTENT_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

export function typeFromFilename(filename: string): ContentType {
  if (filename.endsWith(".page")) return "page";
  return "markdown";
}

export function slugFromFilename(filename: string): string {
  for (const ext of ALL_CONTENT_EXTENSIONS) {
    if (filename.endsWith(ext)) {
      return filename.slice(0, -ext.length);
    }
  }
  return filename.replace(/\.[^.]+$/, "");
}

export function getGitHubConfig(): GitHubConfig {
  return getConfig();
}

export async function listContentFiles(): Promise<(GitHubFile & { contentType: ContentType })[]> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: config.contentPath,
      ref: config.branch,
    });

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(
        (item) => item.type === "file" && isContentFile(item.name)
      )
      .map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size ?? 0,
        contentType: typeFromFilename(item.name),
        type: item.type as "file",
      }));
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getFileContent(
  slug: string,
  type: ContentType = "markdown"
): Promise<GitHubFileContent | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: config.branch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");

    return {
      content,
      sha: data.sha,
      path: data.path,
    };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function createOrUpdateFile(
  slug: string,
  content: string,
  message: string,
  sha?: string,
  type: ContentType = "markdown"
): Promise<{ sha: string }> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  const params: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    branch: string;
    sha?: string;
  } = {
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
    branch: config.branch,
  };

  if (sha) {
    params.sha = sha;
  }

  try {
    const { data } = await octokit.rest.repos.createOrUpdateFileContents(params);
    return { sha: data.content?.sha ?? "" };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      throw new Error(
        `Repository ${config.owner}/${config.repo} (branch: ${config.branch}) not found. ` +
        `Ensure the repo exists on GitHub, has at least one commit, ` +
        `and your token has write access.`
      );
    }
    throw error;
  }
}

export async function deleteFile(
  slug: string,
  sha: string,
  message: string,
  type: ContentType = "markdown"
): Promise<void> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  await octokit.rest.repos.deleteFile({
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    message,
    sha,
    branch: config.branch,
  });
}

export async function getFileAtCommit(
  slug: string,
  commitSha: string,
  type: ContentType = "markdown"
): Promise<string | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: commitSha,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export async function getFileBlobShaAtCommit(
  slug: string,
  commitSha: string,
  type: ContentType = "markdown"
): Promise<string | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: commitSha,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    return data.sha; // This is the blob SHA
  } catch {
    return null;
  }
}

// --- Published (main branch) operations ---

export async function listPublishedFiles(): Promise<(GitHubFile & { contentType: ContentType })[]> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: config.contentPath,
      ref: config.publishBranch,
    });

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item) => item.type === "file" && isContentFile(item.name))
      .map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size ?? 0,
        type: item.type as "file",
        contentType: typeFromFilename(item.name),
      }));
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getPublishedFileContent(
  slug: string,
  type: ContentType = "markdown"
): Promise<GitHubFileContent | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: config.publishBranch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha, path: data.path };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function publishFile(slug: string, type: ContentType = "markdown"): Promise<void> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  // Get the file content from the draft branch
  const draftContent = await getFileContent(slug, type);
  if (!draftContent) {
    throw new Error(`File ${slug} not found on ${config.branch} branch`);
  }

  // Check if file exists on publish branch to get its SHA
  let existingSha: string | undefined;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: config.publishBranch,
    });
    if (!Array.isArray(data) && data.type === "file") {
      existingSha = data.sha;
    }
  } catch {
    // File doesn't exist on publish branch yet
  }

  // Write the draft content to the publish branch
  const params: {
    owner: string;
    repo: string;
    path: string;
    message: string;
    content: string;
    branch: string;
    sha?: string;
  } = {
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    message: `Publish ${slug}`,
    content: Buffer.from(draftContent.content).toString("base64"),
    branch: config.publishBranch,
  };

  if (existingSha) {
    params.sha = existingSha;
  }

  await octokit.rest.repos.createOrUpdateFileContents(params);
}

export async function unpublishFile(slug: string, type: ContentType = "markdown"): Promise<void> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  const published = await getPublishedFileContent(slug, type);
  if (!published) {
    return;
  }

  await octokit.rest.repos.deleteFile({
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    message: `Unpublish ${slug}`,
    sha: published.sha,
    branch: config.publishBranch,
  });
}

export async function getPublishStatus(
  slug: string,
  type: ContentType = "markdown"
): Promise<{ published: boolean; upToDate: boolean }> {
  const draft = await getFileContent(slug, type);
  const published = await getPublishedFileContent(slug, type);

  if (!published) {
    return { published: false, upToDate: false };
  }
  if (!draft) {
    return { published: true, upToDate: true };
  }

  const upToDate = draft.sha === published.sha;
  return { published: true, upToDate };
}

export async function getPublishedFileSha(
  slug: string,
  type: ContentType = "markdown"
): Promise<string | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: config.publishBranch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    return data.sha;
  } catch {
    return null;
  }
}

export async function getFileHistory(
  slug: string,
  branch?: string,
  type: ContentType = "markdown"
): Promise<GitHubCommit[]> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = contentFilePath(config.contentPath, slug, type);

  const { data } = await octokit.rest.repos.listCommits({
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    sha: branch ?? config.branch,
    per_page: 50,
  });

  return data.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    date: commit.commit.author?.date ?? "",
    author: commit.commit.author?.name ?? "Unknown",
  }));
}

// --- Whiteboard operations ---
// Whiteboards are scoped to content pages.
// Path: {contentPath}/whiteboards/{pageSlug}/{wbSlug}.excalidraw

function whiteboardPath(pageSlug: string, wbSlug: string): string {
  const config = getConfig();
  return `${config.contentPath}/whiteboards/${pageSlug}/${wbSlug}.excalidraw`;
}

export async function listWhiteboardFiles(
  pageSlug: string
): Promise<GitHubFile[]> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: `${config.contentPath}/whiteboards/${pageSlug}`,
      ref: config.branch,
    });

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(
        (item) => item.type === "file" && item.name.endsWith(".excalidraw")
      )
      .map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size ?? 0,
        type: item.type as "file",
      }));
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getWhiteboardFile(
  pageSlug: string,
  wbSlug: string
): Promise<{ content: string; sha: string } | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: whiteboardPath(pageSlug, wbSlug),
      ref: config.branch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function saveWhiteboardFile(
  pageSlug: string,
  wbSlug: string,
  sceneJson: string,
  sha?: string
): Promise<{ sha: string }> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  const { data } = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: whiteboardPath(pageSlug, wbSlug),
    message: `Save whiteboard ${pageSlug}/${wbSlug}`,
    content: Buffer.from(sceneJson).toString("base64"),
    branch: config.branch,
    ...(sha ? { sha } : {}),
  });

  return { sha: data.content?.sha ?? "" };
}

export async function deleteWhiteboardFile(
  pageSlug: string,
  wbSlug: string,
  sha: string
): Promise<void> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  await octokit.rest.repos.deleteFile({
    owner: config.owner,
    repo: config.repo,
    path: whiteboardPath(pageSlug, wbSlug),
    message: `Delete whiteboard ${pageSlug}/${wbSlug}`,
    sha,
    branch: config.branch,
  });
}

// --- Asset operations ---

export interface AssetFile extends GitHubFile {
  commitSha: string;
}

export async function listAssets(): Promise<AssetFile[]> {
  const config = getConfig();
  const octokit = getOctokit(config.token);

  let files: Array<{ name: string; path: string; sha: string; size: number; type: "file" }>;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: `${config.contentPath}/assets`,
      ref: config.branch,
    });

    if (!Array.isArray(data)) {
      return [];
    }

    files = data
      .filter((item) => item.type === "file")
      .map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        size: item.size ?? 0,
        type: item.type as "file",
      }));
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  // Get the latest commit SHA for each asset
  const results = await Promise.all(
    files.map(async (file) => {
      let commitSha = "";
      try {
        const { data: commits } = await octokit.rest.repos.listCommits({
          owner: config.owner,
          repo: config.repo,
          path: file.path,
          sha: config.branch,
          per_page: 1,
        });
        if (commits.length > 0) {
          commitSha = commits[0].sha;
        }
      } catch {
        // Ignore
      }
      return { ...file, commitSha };
    })
  );

  return results;
}

export async function uploadAsset(
  filename: string,
  base64Content: string
): Promise<{ url: string; commitSha: string }> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = `${config.contentPath}/assets/${filename}`;

  const uploadToBranch = async (branch: string) => {
    let existingSha: string | undefined;
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: config.owner,
        repo: config.repo,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(data) && data.type === "file") {
        existingSha = data.sha;
      }
    } catch {
      // File doesn't exist yet
    }

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      message: `Upload asset ${filename}`,
      content: base64Content,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });

    return data.commit.sha ?? "";
  };

  const [commitSha] = await Promise.all([
    uploadToBranch(config.branch),
    uploadToBranch(config.publishBranch),
  ]);

  return { url: `/api/assets/${filename}`, commitSha };
}

export async function assetExists(filename: string): Promise<boolean> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = `${config.contentPath}/assets/${filename}`;

  try {
    await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: config.branch,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getAssetContent(
  filename: string,
  branch?: string
): Promise<{ content: Buffer; sha: string } | null> {
  const config = getConfig();
  const octokit = getOctokit(config.token);
  const filePath = `${config.contentPath}/assets/${filename}`;

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: filePath,
      ref: branch ?? config.publishBranch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    const content = Buffer.from(data.content, "base64");
    return { content, sha: data.sha };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function validateToken(token: string): Promise<string | null> {
  try {
    const octokit = getOctokit(token);
    const { data } = await octokit.rest.users.getAuthenticated();
    return data.login;
  } catch {
    return null;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 404
  );
}
