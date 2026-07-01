import { getGitHubConfig } from "./github.server";
import { Octokit } from "octokit";

export interface StencilSettings {
  bodyClasses: string[];
  darkBodyClasses: string[];
  fonts: string[];
  editorDarkMode?: boolean;
  /** Slug of the page used as the layout template for all article pages. */
  articleTemplateSlug?: string;
  [key: string]: unknown;
}

const DEFAULT_SETTINGS: StencilSettings = {
  bodyClasses: ["min-h-screen", "bg-white", "text-gray-900", "antialiased", "font-sans"],
  darkBodyClasses: ["dark:bg-gray-950", "dark:text-gray-100"],
  fonts: [],
  editorDarkMode: false,
};

const SETTINGS_PATH = "settings.json";

function getOctokit(token: string) {
  return new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2022-11-28" } },
  });
}

let cachedSettings: { settings: StencilSettings; sha: string } | null = null;

export async function getSettings(): Promise<{ settings: StencilSettings; sha: string }> {
  if (cachedSettings) return cachedSettings;

  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);

  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: SETTINGS_PATH,
      ref: config.branch,
    });

    if (Array.isArray(data) || data.type !== "file") {
      return { settings: DEFAULT_SETTINGS, sha: "" };
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const parsed = JSON.parse(content) as Partial<StencilSettings>;
    const settings: StencilSettings = { ...DEFAULT_SETTINGS, ...parsed };
    cachedSettings = { settings, sha: data.sha };
    return cachedSettings;
  } catch {
    return { settings: DEFAULT_SETTINGS, sha: "" };
  }
}

export async function saveSettings(
  settings: StencilSettings,
  sha?: string
): Promise<{ sha: string }> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);

  let existingSha = sha;
  if (!existingSha) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: config.owner,
        repo: config.repo,
        path: SETTINGS_PATH,
        ref: config.branch,
      });
      if (!Array.isArray(data) && data.type === "file") {
        existingSha = data.sha;
      }
    } catch {
      // doesn't exist
    }
  }

  const content = Buffer.from(JSON.stringify(settings, null, 2)).toString("base64");

  const { data: result } = await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: SETTINGS_PATH,
    message: "Update Stencil settings",
    content,
    branch: config.branch,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  cachedSettings = { settings, sha: result.content?.sha ?? "" };
  return { sha: result.content?.sha ?? "" };
}

export function invalidateSettingsCache() {
  cachedSettings = null;
}
