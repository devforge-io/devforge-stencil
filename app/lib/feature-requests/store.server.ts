/**
 * Data access for the feature-requests tool, on Anvil DB.
 *
 * Flat model on purpose (see anvil.server.ts for why): every node carries the
 * ids it relates to as plain properties, and lists are stored as JSON strings.
 *
 *   (:FRProject {id, ownerId, ownerEmail, name, intro, originsJson, boardEnabled,
 *                accent, buttonLabel, createdAt, updatedAt})
 *   (:FRRequest {id, projectId, title, details, email, status, votes,
 *                origin, ipHash, createdAt, updatedAt})
 *   (:FRVote    {id, requestId, projectId, voter, createdAt})
 *
 * Sorting and capping happen here rather than in Cypher; a project's request
 * list is small and ORDER BY/LIMIT were not dependable on the target build.
 */

import { createHash } from "node:crypto";
import { cypher, ident, lit, mapLit, newId, nodes, scalar, setLit, AnvilError } from "./anvil.server";

export const STATUSES = ["new", "planned", "in_progress", "done", "declined"] as const;
export type RequestStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<RequestStatus, string> = {
  new: "New",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

export type Project = {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  intro: string;
  origins: string[];
  boardEnabled: boolean;
  accent: string;
  buttonLabel: string;
  createdAt: number;
  updatedAt: number;
};

export type FeatureRequest = {
  id: string;
  projectId: string;
  title: string;
  details: string;
  email: string;
  status: RequestStatus;
  votes: number;
  origin: string;
  createdAt: number;
  updatedAt: number;
};

export const LIMITS = {
  projectName: 80,
  intro: 280,
  origins: 20,
  title: 120,
  details: 2000,
  email: 200,
  buttonLabel: 40,
  projectsPerUser: 25,
  requestsPerProject: 2000,
};

export const DEFAULT_ACCENT = "#f5a524";
export const DEFAULT_BUTTON_LABEL = "Feature requests";

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);

function parseOrigins(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toProject(p: Record<string, unknown>): Project {
  return {
    id: str(p.id),
    ownerId: str(p.ownerId),
    ownerEmail: str(p.ownerEmail),
    name: str(p.name),
    intro: str(p.intro),
    origins: parseOrigins(p.originsJson),
    boardEnabled: bool(p.boardEnabled, true),
    accent: str(p.accent, DEFAULT_ACCENT) || DEFAULT_ACCENT,
    buttonLabel: str(p.buttonLabel, DEFAULT_BUTTON_LABEL) || DEFAULT_BUTTON_LABEL,
    createdAt: num(p.createdAt),
    updatedAt: num(p.updatedAt),
  };
}

function toRequest(r: Record<string, unknown>): FeatureRequest {
  const status = str(r.status, "new");
  return {
    id: str(r.id),
    projectId: str(r.projectId),
    title: str(r.title),
    details: str(r.details),
    email: str(r.email),
    status: (STATUSES as readonly string[]).includes(status) ? (status as RequestStatus) : "new",
    votes: num(r.votes),
    origin: str(r.origin),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

export function isStatus(v: unknown): v is RequestStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export function normalizeAccent(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : DEFAULT_ACCENT;
}

/** Parses a newline/comma separated list of origins into normalized, unique origins. */
export function parseOriginList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s.includes("://") ? s : `https://${s}`);
      const origin = `${u.protocol}//${u.host}`.toLowerCase();
      if (!out.includes(origin)) out.push(origin);
    } catch {
      /* skip unparsable entries */
    }
    if (out.length >= LIMITS.origins) break;
  }
  return out;
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(`fr:${ip}`).digest("hex").slice(0, 24);
}

const byNewest = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt;

/* ---------------------------------------------------------------------- */
/* Projects                                                                */
/* ---------------------------------------------------------------------- */

export async function listProjects(ownerId: string): Promise<Project[]> {
  const r = await cypher(`MATCH (p:FRProject {ownerId: ${lit(ident(ownerId, "owner"))}}) RETURN p`);
  return nodes(r).map(toProject).sort(byNewest);
}

export async function getProject(id: string): Promise<Project | null> {
  const r = await cypher(`MATCH (p:FRProject {id: ${lit(ident(id, "project id"))}}) RETURN p`);
  const row = nodes(r)[0];
  return row ? toProject(row) : null;
}

/** The project only if `ownerId` owns it. */
export async function getOwnedProject(id: string, ownerId: string): Promise<Project | null> {
  const p = await getProject(id);
  return p && p.ownerId === ownerId ? p : null;
}

export async function createProject(
  owner: { id: string; email: string },
  input: { name: string; intro?: string; origins?: string[] },
): Promise<Project> {
  const existing = await listProjects(owner.id);
  if (existing.length >= LIMITS.projectsPerUser) throw new AnvilError(`You can have up to ${LIMITS.projectsPerUser} projects`, 400);
  const now = Date.now();
  const project: Project = {
    id: newId(12),
    ownerId: owner.id,
    ownerEmail: owner.email,
    name: input.name.trim().slice(0, LIMITS.projectName),
    intro: (input.intro ?? "").trim().slice(0, LIMITS.intro),
    origins: input.origins ?? [],
    boardEnabled: true,
    accent: DEFAULT_ACCENT,
    buttonLabel: DEFAULT_BUTTON_LABEL,
    createdAt: now,
    updatedAt: now,
  };
  await cypher(
    `CREATE (p:FRProject ${mapLit({
      id: project.id,
      ownerId: project.ownerId,
      ownerEmail: project.ownerEmail,
      name: project.name,
      intro: project.intro,
      originsJson: JSON.stringify(project.origins),
      boardEnabled: true,
      accent: project.accent,
      buttonLabel: project.buttonLabel,
      createdAt: now,
      updatedAt: now,
    })}) RETURN p`,
  );
  return project;
}

export async function updateProject(
  id: string,
  ownerId: string,
  patch: Partial<Pick<Project, "name" | "intro" | "origins" | "boardEnabled" | "accent" | "buttonLabel">>,
): Promise<Project | null> {
  const current = await getOwnedProject(id, ownerId);
  if (!current) return null;
  const props: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.name !== undefined) props.name = patch.name.trim().slice(0, LIMITS.projectName);
  if (patch.intro !== undefined) props.intro = patch.intro.trim().slice(0, LIMITS.intro);
  if (patch.origins !== undefined) props.originsJson = JSON.stringify(patch.origins.slice(0, LIMITS.origins));
  if (patch.boardEnabled !== undefined) props.boardEnabled = patch.boardEnabled;
  if (patch.accent !== undefined) props.accent = normalizeAccent(patch.accent);
  if (patch.buttonLabel !== undefined) props.buttonLabel = patch.buttonLabel.trim().slice(0, LIMITS.buttonLabel) || DEFAULT_BUTTON_LABEL;
  await cypher(`MATCH (p:FRProject {id: ${lit(current.id)}}) ${setLit("p", props)} RETURN p`);
  return getProject(current.id);
}

/** Removes the project and everything under it. */
export async function deleteProject(id: string, ownerId: string): Promise<boolean> {
  const current = await getOwnedProject(id, ownerId);
  if (!current) return false;
  const pid = lit(current.id);
  await cypher(`MATCH (v:FRVote {projectId: ${pid}}) DETACH DELETE v RETURN count(v)`);
  await cypher(`MATCH (r:FRRequest {projectId: ${pid}}) DETACH DELETE r RETURN count(r)`);
  await cypher(`MATCH (p:FRProject {id: ${pid}}) DETACH DELETE p RETURN count(p)`);
  return true;
}

/* ---------------------------------------------------------------------- */
/* Requests                                                                */
/* ---------------------------------------------------------------------- */

export type RequestSort = "top" | "newest";

export async function listRequests(
  projectId: string,
  opts: { includeDeclined?: boolean; sort?: RequestSort } = {},
): Promise<FeatureRequest[]> {
  const r = await cypher(`MATCH (r:FRRequest {projectId: ${lit(ident(projectId, "project id"))}}) RETURN r`);
  let list = nodes(r).map(toRequest);
  if (!opts.includeDeclined) list = list.filter((x) => x.status !== "declined");
  if (opts.sort === "newest") list.sort(byNewest);
  else list.sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt);
  return list;
}

export async function getRequest(id: string): Promise<FeatureRequest | null> {
  const r = await cypher(`MATCH (r:FRRequest {id: ${lit(ident(id, "request id"))}}) RETURN r`);
  const row = nodes(r)[0];
  return row ? toRequest(row) : null;
}

export async function countRequests(projectId: string): Promise<number> {
  const r = await cypher(`MATCH (r:FRRequest {projectId: ${lit(ident(projectId, "project id"))}}) RETURN count(r)`);
  return num(scalar(r));
}

export type NewRequestInput = { title: string; details?: string; email?: string; origin?: string; ip?: string };

export function validateRequestInput(input: NewRequestInput): { ok: true; value: Required<Pick<NewRequestInput, "title" | "details" | "email">> } | { ok: false; error: string } {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  const details = (input.details ?? "").trim();
  const email = (input.email ?? "").trim();
  if (title.length < 3) return { ok: false, error: "Give the request a title (at least 3 characters)." };
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` };
  if (details.length > LIMITS.details) return { ok: false, error: `Keep the details under ${LIMITS.details} characters.` };
  if (email && (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: "That email address does not look right." };
  return { ok: true, value: { title, details, email } };
}

export async function createRequest(projectId: string, input: NewRequestInput): Promise<FeatureRequest> {
  const pid = ident(projectId, "project id");
  const v = validateRequestInput(input);
  if (!v.ok) throw new AnvilError(v.error, 400);
  if ((await countRequests(pid)) >= LIMITS.requestsPerProject) throw new AnvilError("This project has reached its request limit.", 400);
  const now = Date.now();
  const req: FeatureRequest = {
    id: newId(16),
    projectId: pid,
    title: v.value.title,
    details: v.value.details,
    email: v.value.email,
    status: "new",
    votes: 0,
    origin: (input.origin ?? "").slice(0, 200),
    createdAt: now,
    updatedAt: now,
  };
  await cypher(
    `CREATE (r:FRRequest ${mapLit({
      id: req.id,
      projectId: req.projectId,
      title: req.title,
      details: req.details,
      email: req.email,
      status: req.status,
      votes: 0,
      origin: req.origin,
      ipHash: input.ip ? hashIp(input.ip) : "",
      createdAt: now,
      updatedAt: now,
    })}) RETURN r`,
  );
  return req;
}

export async function setRequestStatus(projectId: string, requestId: string, status: RequestStatus): Promise<FeatureRequest | null> {
  if (!isStatus(status)) throw new AnvilError("Unknown status", 400);
  const pid = lit(ident(projectId, "project id"));
  const rid = lit(ident(requestId, "request id"));
  await cypher(`MATCH (r:FRRequest {id: ${rid}, projectId: ${pid}}) ${setLit("r", { status, updatedAt: Date.now() })} RETURN r`);
  return getRequest(requestId);
}

export async function deleteRequest(projectId: string, requestId: string): Promise<void> {
  const pid = lit(ident(projectId, "project id"));
  const rid = lit(ident(requestId, "request id"));
  await cypher(`MATCH (v:FRVote {requestId: ${rid}, projectId: ${pid}}) DETACH DELETE v RETURN count(v)`);
  await cypher(`MATCH (r:FRRequest {id: ${rid}, projectId: ${pid}}) DETACH DELETE r RETURN count(r)`);
}

/* ---------------------------------------------------------------------- */
/* Votes                                                                   */
/* ---------------------------------------------------------------------- */

const VOTER = /^[A-Za-z0-9_-]{8,64}$/;

export function isVoterKey(v: unknown): v is string {
  return typeof v === "string" && VOTER.test(v);
}

export async function votedRequestIds(projectId: string, voter: string): Promise<Set<string>> {
  if (!isVoterKey(voter)) return new Set();
  const r = await cypher(`MATCH (v:FRVote {projectId: ${lit(ident(projectId, "project id"))}, voter: ${lit(voter)}}) RETURN v`);
  return new Set(nodes(r).map((v) => str(v.requestId)));
}

/** Adds or removes this voter's vote; returns the new count and state. */
export async function toggleVote(requestId: string, voter: string): Promise<{ votes: number; voted: boolean } | null> {
  if (!isVoterKey(voter)) throw new AnvilError("Invalid voter key", 400);
  const req = await getRequest(requestId);
  if (!req || req.status === "declined") return null;
  const rid = lit(req.id);
  const existing = nodes(await cypher(`MATCH (v:FRVote {requestId: ${rid}, voter: ${lit(voter)}}) RETURN v`));
  let delta: number;
  if (existing.length) {
    await cypher(`MATCH (v:FRVote {requestId: ${rid}, voter: ${lit(voter)}}) DETACH DELETE v RETURN count(v)`);
    delta = -1;
  } else {
    await cypher(
      `CREATE (v:FRVote ${mapLit({ id: newId(16), requestId: req.id, projectId: req.projectId, voter, createdAt: Date.now() })}) RETURN v`,
    );
    delta = 1;
  }
  // Recount from the vote nodes rather than trusting the cached counter.
  const count = num(scalar(await cypher(`MATCH (v:FRVote {requestId: ${rid}}) RETURN count(v)`)));
  await cypher(`MATCH (r:FRRequest {id: ${rid}}) ${setLit("r", { votes: count, updatedAt: Date.now() })} RETURN r`);
  return { votes: count, voted: delta > 0 };
}

/* ---------------------------------------------------------------------- */
/* Public shapes                                                           */
/* ---------------------------------------------------------------------- */

export function publicProject(p: Project) {
  return { id: p.id, name: p.name, intro: p.intro, boardEnabled: p.boardEnabled, accent: p.accent, buttonLabel: p.buttonLabel };
}

export function publicRequest(r: FeatureRequest, voted = false) {
  return { id: r.id, title: r.title, details: r.details, status: r.status, votes: r.votes, createdAt: r.createdAt, voted };
}
