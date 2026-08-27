/**
 * Data access for the feature-requests tool, on Anvil DB's document store.
 *
 *   fr_projects  key = project id   {id, ownerId, ownerEmail, name, intro, origins[],
 *                                    boardEnabled, accent, buttonLabel, createdAt, updatedAt}
 *   fr_requests  key = request id   {id, projectId, title, details, email, status, votes,
 *                                    origin, ipHash, createdAt, updatedAt}
 *   fr_votes     key = vote id       {id, requestId, projectId, email, emailLower,
 *                                    userId, voter, createdAt}
 *
 * Ids are server-minted UUIDs reserved through Anvil's POST /db/uuid. One vote
 * per person per request is enforced by looking the vote up by identity
 * (emailLower, or the legacy browser key) before writing; votes created before
 * the UUID switch keep their old requestId--voter composite keys and are found
 * by the same query.
 *
 * Documents round-trip JSON faithfully (real arrays, no Cypher escaping), and
 * the graph representation is produced by Anvil's document-graph sync, not by
 * this code. Queries filter on body fields; sorting and capping happen here.
 */

import { createHash } from "node:crypto";
import type { DocFilter } from "./anvil.server";
import {
  AnvilError,
  docDelete,
  docEnsureCollection,
  docGet,
  docPut,
  docQuery,
  ident,
  reserveUuid,
  type AnvilDocument,
} from "./anvil.server";
import { DEFAULT_ACCENT, DEFAULT_BUTTON_LABEL, LIMITS, STATUSES, STATUS_LABEL, isStatus, type RequestStatus } from "./shared";
export { DEFAULT_ACCENT, DEFAULT_BUTTON_LABEL, LIMITS, STATUSES, STATUS_LABEL, isStatus, type RequestStatus };

const PROJECTS = "fr_projects";
const REQUESTS = "fr_requests";
const VOTES = "fr_votes";

let collectionsReady: Promise<void> | null = null;

/** Creates the three collections on first use (idempotent, cached). */
function ensureCollections(): Promise<void> {
  collectionsReady ??= Promise.all([docEnsureCollection(PROJECTS), docEnsureCollection(REQUESTS), docEnsureCollection(VOTES)])
    .then(() => undefined)
    .catch((err) => {
      collectionsReady = null;
      throw err;
    });
  return collectionsReady;
}

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

/* ---------------------------------------------------------------------- */
/* Helpers                                                                 */
/* ---------------------------------------------------------------------- */

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);

function readOrigins(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.origins)) return body.origins.filter((x): x is string => typeof x === "string");
  // Graph-era rows stored the list as a JSON string; tolerate them.
  if (typeof body.originsJson === "string") {
    try {
      const arr = JSON.parse(body.originsJson) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
    } catch {
      /* fall through */
    }
  }
  return [];
}

function toProject(doc: AnvilDocument): Project {
  const p = doc.body;
  return {
    id: str(p.id, doc.key),
    ownerId: str(p.ownerId),
    ownerEmail: str(p.ownerEmail),
    name: str(p.name),
    intro: str(p.intro),
    origins: readOrigins(p),
    boardEnabled: bool(p.boardEnabled, true),
    accent: str(p.accent, DEFAULT_ACCENT) || DEFAULT_ACCENT,
    buttonLabel: str(p.buttonLabel, DEFAULT_BUTTON_LABEL) || DEFAULT_BUTTON_LABEL,
    createdAt: num(p.createdAt),
    updatedAt: num(p.updatedAt),
  };
}

function projectBody(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    ownerId: p.ownerId,
    ownerEmail: p.ownerEmail,
    name: p.name,
    intro: p.intro,
    origins: p.origins,
    boardEnabled: p.boardEnabled,
    accent: p.accent,
    buttonLabel: p.buttonLabel,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toRequest(doc: AnvilDocument): FeatureRequest {
  const r = doc.body;
  const status = str(r.status, "new");
  return {
    id: str(r.id, doc.key),
    projectId: str(r.projectId),
    title: str(r.title),
    details: str(r.details),
    email: str(r.email),
    status: isStatus(status) ? status : "new",
    votes: num(r.votes),
    origin: str(r.origin),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
}

function requestBody(r: FeatureRequest, ipHash: string): Record<string, unknown> {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    details: r.details,
    email: r.email,
    status: r.status,
    votes: r.votes,
    origin: r.origin,
    ipHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
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
  await ensureCollections();
  const docs = await docQuery(PROJECTS, { op: "eq", field: "ownerId", value: ident(ownerId, "owner") }, LIMITS.projectsPerUser * 2);
  return docs.map(toProject).sort(byNewest);
}

export async function getProject(id: string): Promise<Project | null> {
  await ensureCollections();
  const doc = await docGet(PROJECTS, ident(id, "project id"));
  return doc ? toProject(doc) : null;
}

/** The project only if `ownerId` owns it. */
export async function getOwnedProject(id: string, ownerId: string): Promise<Project | null> {
  const p = await getProject(id);
  return p && p.ownerId === ownerId ? p : null;
}

export type Manager = { id: string; email: string };

const sameEmail = (a: string, b: string) => Boolean(a) && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The project if this person manages it: matching Anvil user id, or matching
 * ownerEmail. Email is the durable claim; ids stop matching when accounts move
 * between Anvil servers while the project documents survive.
 */
export async function getManagedProject(id: string, manager: Manager): Promise<Project | null> {
  const p = await getProject(id);
  if (!p) return null;
  if (p.ownerId === manager.id) return p;
  return sameEmail(p.ownerEmail, manager.email) ? p : null;
}

/** Every project this person manages, by user id or ownerEmail, deduplicated. */
export async function listManagedProjects(manager: Manager): Promise<Project[]> {
  await ensureCollections();
  const byId = manager.id ? await docQuery(PROJECTS, { op: "eq", field: "ownerId", value: manager.id }, LIMITS.projectsPerUser * 2) : [];
  const byEmail = manager.email
    ? (await docQuery(PROJECTS, null, 10_000)).filter((d) => sameEmail(String(d.body.ownerEmail ?? ""), manager.email))
    : [];
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const doc of [...byId, ...byEmail]) {
    const project = toProject(doc);
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    out.push(project);
  }
  return out.sort(byNewest);
}

export async function createProject(
  owner: { id: string; email: string },
  input: { name: string; intro?: string; origins?: string[] },
): Promise<Project> {
  const existing = await listProjects(owner.id);
  if (existing.length >= LIMITS.projectsPerUser) throw new AnvilError(`You can have up to ${LIMITS.projectsPerUser} projects`, 400);
  const now = Date.now();
  const project: Project = {
    id: await reserveUuid(),
    ownerId: owner.id,
    ownerEmail: owner.email,
    name: input.name.trim().slice(0, LIMITS.projectName),
    intro: (input.intro ?? "").trim().slice(0, LIMITS.intro),
    origins: (input.origins ?? []).slice(0, LIMITS.origins),
    boardEnabled: true,
    accent: DEFAULT_ACCENT,
    buttonLabel: DEFAULT_BUTTON_LABEL,
    createdAt: now,
    updatedAt: now,
  };
  await docPut(PROJECTS, project.id, projectBody(project), { ifNotExists: true });
  return project;
}

export async function updateProject(
  id: string,
  manager: Manager,
  patch: Partial<Pick<Project, "name" | "intro" | "origins" | "boardEnabled" | "accent" | "buttonLabel">>,
): Promise<Project | null> {
  const current = await getManagedProject(id, manager);
  if (!current) return null;
  const next: Project = { ...current, updatedAt: Date.now() };
  if (patch.name !== undefined) next.name = patch.name.trim().slice(0, LIMITS.projectName);
  if (patch.intro !== undefined) next.intro = patch.intro.trim().slice(0, LIMITS.intro);
  if (patch.origins !== undefined) next.origins = patch.origins.slice(0, LIMITS.origins);
  if (patch.boardEnabled !== undefined) next.boardEnabled = patch.boardEnabled;
  if (patch.accent !== undefined) next.accent = normalizeAccent(patch.accent);
  if (patch.buttonLabel !== undefined) next.buttonLabel = patch.buttonLabel.trim().slice(0, LIMITS.buttonLabel) || DEFAULT_BUTTON_LABEL;
  await docPut(PROJECTS, current.id, projectBody(next));
  return next;
}

/** Removes the project and everything under it. */
export async function deleteProject(id: string, manager: Manager): Promise<boolean> {
  const current = await getManagedProject(id, manager);
  if (!current) return false;
  const votes = await docQuery(VOTES, { op: "eq", field: "projectId", value: current.id }, 100_000);
  for (const v of votes) await docDelete(VOTES, v.key);
  const requests = await docQuery(REQUESTS, { op: "eq", field: "projectId", value: current.id }, LIMITS.requestsPerProject * 2);
  for (const r of requests) await docDelete(REQUESTS, r.key);
  await docDelete(PROJECTS, current.id);
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
  await ensureCollections();
  const docs = await docQuery(REQUESTS, { op: "eq", field: "projectId", value: ident(projectId, "project id") }, LIMITS.requestsPerProject * 2);
  let list = docs.map(toRequest);
  if (!opts.includeDeclined) list = list.filter((x) => x.status !== "declined");
  if (opts.sort === "newest") list.sort(byNewest);
  else list.sort((a, b) => b.votes - a.votes || b.createdAt - a.createdAt);
  return list;
}

export async function getRequest(id: string): Promise<FeatureRequest | null> {
  await ensureCollections();
  const doc = await docGet(REQUESTS, ident(id, "request id"));
  return doc ? toRequest(doc) : null;
}

export async function countRequests(projectId: string): Promise<number> {
  return (await listRequests(projectId, { includeDeclined: true })).length;
}

export type NewRequestInput = { title: string; details?: string; email?: string; submitterId?: string; origin?: string; ip?: string };

export function validateRequestInput(
  input: NewRequestInput,
): { ok: true; value: Required<Pick<NewRequestInput, "title" | "details" | "email">> } | { ok: false; error: string } {
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
    id: await reserveUuid(),
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
  await docPut(
    REQUESTS,
    req.id,
    { ...requestBody(req, input.ip ? hashIp(input.ip) : ""), submitterId: input.submitterId ?? "" },
    { ifNotExists: true },
  );
  return req;
}

async function putRequest(req: FeatureRequest): Promise<void> {
  const doc = await docGet(REQUESTS, req.id);
  await docPut(REQUESTS, req.id, { ...(doc?.body ?? {}), ...requestBody(req, str(doc?.body.ipHash)) });
}

/**
 * Creator edit: the person who submitted a request (identified by the same
 * email they gave with it) can rewrite the details to build the idea out.
 * Requests submitted without an email have no editable claim.
 */
export async function updateRequestDetails(requestId: string, email: string, details: string): Promise<FeatureRequest | null> {
  const req = await getRequest(requestId);
  if (!req || req.status === "declined") return null;
  if (!isEmail(email) || !sameEmail(req.email, email)) throw new AnvilError("Only the person who submitted this request can edit it", 403);
  const trimmed = details.trim();
  if (trimmed.length > LIMITS.details) throw new AnvilError(`Keep the details under ${LIMITS.details} characters.`, 400);
  const next = { ...req, details: trimmed, updatedAt: Date.now() };
  await putRequest(next);
  return next;
}

export async function setRequestStatus(projectId: string, requestId: string, status: RequestStatus): Promise<FeatureRequest | null> {
  if (!isStatus(status)) throw new AnvilError("Unknown status", 400);
  const pid = ident(projectId, "project id");
  const req = await getRequest(requestId);
  if (!req || req.projectId !== pid) return null;
  const next = { ...req, status, updatedAt: Date.now() };
  await putRequest(next);
  return next;
}

export async function deleteRequest(projectId: string, requestId: string): Promise<void> {
  const pid = ident(projectId, "project id");
  const rid = ident(requestId, "request id");
  const req = await getRequest(rid);
  if (!req || req.projectId !== pid) return;
  const votes = await docQuery(VOTES, { op: "eq", field: "requestId", value: rid }, 100_000);
  for (const v of votes) await docDelete(VOTES, v.key);
  await docDelete(REQUESTS, rid);
}

/* ---------------------------------------------------------------------- */
/* Votes                                                                   */
/* ---------------------------------------------------------------------- */

const VOTER = /^[A-Za-z0-9_-]{8,64}$/;

export function isVoterKey(v: unknown): v is string {
  return typeof v === "string" && VOTER.test(v);
}

export const isEmail = (v: unknown): v is string => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= LIMITS.email;

/**
 * Who is voting. Email is the person-level identity (one vote per address,
 * whatever the browser); the anonymous voter key remains as a fallback for
 * surfaces that have not collected an email.
 */
export type VoterIdentity = { email?: string; userId?: string; voter?: string };

/** The condition that finds a person's votes: by email when known, else by browser key. */
function identityFilter(identity: VoterIdentity): DocFilter {
  return isEmail(identity.email)
    ? { op: "eq", field: "emailLower", value: (identity.email as string).trim().toLowerCase() }
    : { op: "eq", field: "voter", value: identity.voter };
}

function validIdentity(identity: VoterIdentity): boolean {
  return isEmail(identity.email) || isVoterKey(identity.voter);
}

export async function votedRequestIds(projectId: string, identity: VoterIdentity): Promise<Set<string>> {
  if (!validIdentity(identity)) return new Set();
  await ensureCollections();
  const pid = ident(projectId, "project id");
  const docs = await docQuery(
    VOTES,
    { op: "and", conditions: [{ op: "eq", field: "projectId", value: pid }, identityFilter(identity)] },
    LIMITS.requestsPerProject * 2,
  );
  return new Set(docs.map((d) => str(d.body.requestId)));
}

/** Adds or removes this person's vote; returns the new count and state. */
export async function toggleVote(requestId: string, identity: VoterIdentity): Promise<{ votes: number; voted: boolean } | null> {
  if (!validIdentity(identity)) throw new AnvilError("Invalid voter identity", 400);
  const req = await getRequest(requestId);
  if (!req || req.status === "declined") return null;
  // One vote per person per request, looked up by identity (also finds
  // pre-uuid votes, whose keys were requestId--voter composites).
  const mine = await docQuery(
    VOTES,
    { op: "and", conditions: [{ op: "eq", field: "requestId", value: req.id }, identityFilter(identity)] },
    10,
  );
  if (mine.length > 0) {
    for (const d of mine) await docDelete(VOTES, d.key);
  } else {
    const email = isEmail(identity.email) ? identity.email.trim() : "";
    const id = await reserveUuid();
    await docPut(VOTES, id, {
      id,
      requestId: req.id,
      projectId: req.projectId,
      email,
      emailLower: email.toLowerCase(),
      userId: identity.userId ?? "",
      voter: identity.voter ?? "",
      createdAt: Date.now(),
    }, { ifNotExists: true });
  }
  // Recount from the vote documents rather than trusting the cached counter.
  const count = (await docQuery(VOTES, { op: "eq", field: "requestId", value: req.id }, 100_000)).length;
  await putRequest({ ...req, votes: count, updatedAt: Date.now() });
  return { votes: count, voted: mine.length === 0 };
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
