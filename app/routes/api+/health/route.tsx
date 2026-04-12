import { getGitHubConfig } from "~/lib/github.server";

export function loader() {
  let github = false;
  try {
    getGitHubConfig();
    github = true;
  } catch {
    // not configured
  }

  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    github,
  });
}
