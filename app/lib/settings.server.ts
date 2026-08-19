import { getGitHubConfig } from "./github.server";
import { Octokit } from "octokit";

export interface StencilSettings {
  bodyClasses: string[];
  darkBodyClasses: string[];
  fonts: string[];
  editorDarkMode?: boolean;
  /** Slug of the page used as the layout template for all article pages. */
  articleTemplateSlug?: string;
  /** Page slug used as the layout for the /tutorial/<slug> overview. */
  tutorialRootTemplateSlug?: string;
  /** Page slug used as the layout for /tutorial/<slug>/<chapter> pages. */
  tutorialChapterTemplateSlug?: string;
  /** Site name — used for og:site_name on shared pages. */
  siteName?: string;
  /** Favicon URL (asset path or absolute), emitted as <link rel="icon">. */
  favicon?: string;
  /**
   * Absolute site origin, e.g. "https://devforge.io". Used for og:url and the
   * canonical link. Falls back to the request origin, which is usually right but
   * can be an internal host behind some proxies.
   */
  siteUrl?: string;
  /** Share image used when a page declares no ogImage/headerImage. */
  defaultOgImage?: string;
  /** @handle for twitter:site, e.g. "@devforge". */
  twitterSite?: string;
  /** og:locale value, e.g. "en_AU". Defaults to en_US at the scraper. */
  locale?: string;
  /** Organisation name for the JSON-LD emitted on every page. */
  organisationName?: string;
  /** Slug of a published page served (with HTTP 404) for unmatched public URLs. */
  notFoundPageSlug?: string;
  /** Show the Markdown content type in the "New Content" picker. Off by default. */
  enableMarkdown?: boolean;
  /** Show the Wiki (Wikitext) content type in the "New Content" picker. Off by default. */
  enableWiki?: boolean;
  /** Contact form (POST /contact) — recipient + SMTP transport. */
  contact?: {
    /** Where contact-form submissions are emailed. */
    toEmail?: string;
    smtp?: {
      host?: string;
      port?: number;
      /** true for implicit TLS (port 465); false for STARTTLS (587/25). */
      secure?: boolean;
      user?: string;
      /** SMTP password. Stored in settings.json; the SMTP_PASSWORD env var overrides it. */
      pass?: string;
      /** From address (defaults to the SMTP user). */
      from?: string;
    };
  };
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
