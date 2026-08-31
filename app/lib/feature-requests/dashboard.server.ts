/**
 * Shared loader/action logic for a project dashboard, used by both
 * /tools/feature-requests/projects/:id and /project/:id. Access is by
 * manager: the Anvil user id (the only owner claim since 2026-08-31).
 */

import { redirect } from "react-router";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { ensureCsrfToken, validateCsrf } from "~/lib/csrf.server";
import { docQuery, type AnvilError } from "./anvil.server";
import { requireFrUser } from "./session.server";
import { STATUSES, isStatus, type RequestStatus } from "./shared";
import {
  deleteProject,
  deleteRequest,
  getManagedProject,
  listRequests,
  parseOriginList,
  setRequestStatus,
  updateProject,
  type FeatureRequest,
  type Project,
  type RequestSort,
} from "./store.server";

export type DashboardData = {
  csrfToken: string;
  chrome: Awaited<ReturnType<typeof getSiteChrome>>;
  user: { email: string };
  project: Project;
  requests: FeatureRequest[];
  /** Anvil user id -> email, for showing who submitted what. */
  submitterEmails: Record<string, string>;
  counts: Record<string, number>;
  filter: string;
  sort: RequestSort;
  origin: string;
};

export async function loadProjectDashboard(
  request: Request,
  projectId: string,
  signInPath: string,
): Promise<Response | DashboardData> {
  const user = await requireFrUser(request, signInPath);
  const project = await getManagedProject(projectId, { id: user.id }).catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const filter = url.searchParams.get("status") ?? "all";
  const sort: RequestSort = url.searchParams.get("sort") === "newest" ? "newest" : "top";
  const [{ token, setCookie }, chrome, all] = await Promise.all([
    ensureCsrfToken(request),
    getSiteChrome(),
    listRequests(project.id, { includeDeclined: true, sort }),
  ]);
  // Requests store only the submitter's user id; resolve emails for display.
  const submitterEmails: Record<string, string> = {};
  const wantedIds = new Set(all.map((r) => r.submitterId).filter(Boolean));
  if (wantedIds.size > 0) {
    try {
      for (const doc of await docQuery("auth.users", null, 100_000)) {
        const id = typeof doc.body.id === "string" ? doc.body.id : "";
        if (id && wantedIds.has(id) && typeof doc.body.email === "string") submitterEmails[id] = doc.body.email;
      }
    } catch {
      // Display-only: the dashboard still works without the emails.
    }
  }
  const counts: Record<string, number> = { all: all.length };
  for (const s of STATUSES) counts[s] = all.filter((r) => r.status === s).length;
  const requests = filter === "all" ? all : all.filter((r) => r.status === filter);
  const origin = (process.env.PUBLIC_ORIGIN || url.origin).replace(/\/+$/, "");
  const data: DashboardData = { csrfToken: token, chrome, user: { email: user.email }, project, requests, submitterEmails, counts, filter, sort, origin };
  return setCookie ? Response.json(data, { headers: { "Set-Cookie": setCookie } }) : data;
}

export async function actOnProjectDashboard(
  request: Request,
  projectId: string,
  signInPath: string,
  afterDeletePath: string,
): Promise<Response | { ok: true; saved?: boolean }> {
  const user = await requireFrUser(request, signInPath);
  const manager = { id: user.id };
  const form = await request.formData();
  await validateCsrf(request, form);
  const project = await getManagedProject(projectId, manager).catch(() => null);
  if (!project) throw new Response("Not found", { status: 404 });
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "status") {
      const status = String(form.get("status") ?? "");
      if (!isStatus(status)) return Response.json({ error: "Unknown status." }, { status: 400 });
      await setRequestStatus(project.id, String(form.get("requestId") ?? ""), status as RequestStatus);
      return { ok: true };
    }
    if (intent === "delete-request") {
      await deleteRequest(project.id, String(form.get("requestId") ?? ""));
      return { ok: true };
    }
    if (intent === "settings") {
      await updateProject(project.id, manager, {
        name: String(form.get("name") ?? project.name),
        intro: String(form.get("intro") ?? ""),
        origins: parseOriginList(String(form.get("origins") ?? "")),
        boardEnabled: form.get("boardEnabled") === "on",
        accent: String(form.get("accent") ?? ""),
        buttonLabel: String(form.get("buttonLabel") ?? ""),
      });
      return { ok: true, saved: true };
    }
    if (intent === "delete-project") {
      if (String(form.get("confirm") ?? "").trim() !== project.name) {
        return Response.json({ error: "Type the project name exactly to confirm deletion." }, { status: 400 });
      }
      await deleteProject(project.id, manager);
      return redirect(afterDeletePath);
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    const e = err as AnvilError;
    return Response.json({ error: e.message || "That did not work." }, { status: e.status && e.status >= 400 ? e.status : 500 });
  }
}
