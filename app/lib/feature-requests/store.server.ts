/**
 * Data access for the feature-requests tool, on Anvil DB's document store.
 *
 *   fr_projects  key = project id   {id, ownerId, ownerEmail, name, intro, origins[],
 *                                    boardEnabled, accent, buttonLabel, createdAt, updatedAt}
 *   fr_requests  key = request id   {id, projectId, title, details, status, votes,
 *                                    origin, ipHash, createdAt, updatedAt}
 *   fr_votes     key = vote id       {id, requestId, projectId,
 *                                    userId, voter, createdAt}
 *
 * Ids are server-minted UUIDs reserved through Anvil's POST /db/uuid. One vote
 * per person per request is enforced by looking the vote up by identity
 * (userId, or the legacy browser key) before writing; votes created before
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
import { sanitizeDetails } from "./details";
import { MAX_ATTACHMENTS_PER_REQUEST, deleteObject } from "./storage.server";
export { DEFAULT_ACCENT, DEFAULT_BUTTON_LABEL, LIMITS, STATUSES, STATUS_LABEL, isStatus, type RequestStatus };

const PROJECTS = "fr_projects";
const REQUESTS = "fr_requests";
const VOTES = "fr_votes";
const COMMENTS = "fr_comments";
const ATTACHMENTS = "fr_attachments";

let collectionsReady: Promise<void> | null = null;

/** Creates the three collections on first use (idempotent, cached). */
function ensureCollections(): Promise<void> {
  collectionsReady ??= Promise.all([docEnsureCollection(PROJECTS), docEnsureCollection(REQUESTS), docEnsureCollection(VOTES), docEnsureCollection(COMMENTS), docEnsureCollection(ATTACHMENTS)])
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
  submitterId: string;
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
    submitterId: str(r.submitterId),
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
    submitterId: r.submitterId,
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
  // Details may be rich (widget v9): sanitize to the allowlisted HTML subset
  // and measure the text, not the markup.
  const clean = sanitizeDetails(input.details);
  const details = clean.html;
  const email = (input.email ?? "").trim();
  if (title.length < 3) return { ok: false, error: "Give the request a title (at least 3 characters)." };
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` };
  if (clean.text.length > LIMITS.details || details.length > LIMITS.details * 4) return { ok: false, error: `Keep the details under ${LIMITS.details} characters.` };
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
    submitterId: input.submitterId ?? "",
    status: "new",
    votes: 0,
    origin: (input.origin ?? "").slice(0, 200),
    createdAt: now,
    updatedAt: now,
  };
  await docPut(REQUESTS, req.id, requestBody(req, input.ip ? hashIp(input.ip) : ""), { ifNotExists: true });
  return req;
}

async function putRequest(req: FeatureRequest): Promise<void> {
  const doc = await docGet(REQUESTS, req.id);
  await docPut(REQUESTS, req.id, { ...(doc?.body ?? {}), ...requestBody(req, str(doc?.body.ipHash)) });
}

/**
 * Creator edit: the person who submitted a request (identified by the same
 * Anvil user id as the stored submitterId) can rewrite the details to build
 * the idea out. Requests submitted without a resolvable account have no
 * editable claim.
 */
export async function updateRequestDetails(requestId: string, editorUserId: string, details: string): Promise<FeatureRequest | null> {
  const req = await getRequest(requestId);
  if (!req || req.status === "declined") return null;
  if (!editorUserId || req.submitterId !== editorUserId) throw new AnvilError("Only the person who submitted this request can edit it", 403);
  const clean = sanitizeDetails(details);
  if (clean.text.length > LIMITS.details || clean.html.length > LIMITS.details * 4) throw new AnvilError(`Keep the details under ${LIMITS.details} characters.`, 400);
  const next = { ...req, details: clean.html, updatedAt: Date.now() };
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
  const comments = await docQuery(COMMENTS, { op: "eq", field: "requestId", value: rid }, 100_000);
  for (const c of comments) await docDelete(COMMENTS, c.key);
  const files = await docQuery(ATTACHMENTS, { op: "eq", field: "requestId", value: rid }, 1000);
  for (const f of files) {
    await deleteObject(str(f.body.storageKey));
    await docDelete(ATTACHMENTS, f.key);
  }
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
 * Who is voting. The Anvil user id is the person-level identity (one vote per
 * account, whatever the browser; the doc links to :User in the graph); the
 * anonymous voter key remains as a fallback for the hosted board.
 */
export type VoterIdentity = { userId?: string; voter?: string };

const hasUserId = (identity: VoterIdentity): boolean => typeof identity.userId === "string" && identity.userId.length > 0;

/** The condition that finds a person's votes: by user id when known, else by browser key. */
function identityFilter(identity: VoterIdentity): DocFilter {
  return hasUserId(identity)
    ? { op: "eq", field: "userId", value: identity.userId }
    : { op: "eq", field: "voter", value: identity.voter };
}

function validIdentity(identity: VoterIdentity): boolean {
  return hasUserId(identity) || isVoterKey(identity.voter);
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
    const id = await reserveUuid();
    await docPut(VOTES, id, {
      id,
      requestId: req.id,
      projectId: req.projectId,
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
/* Comments                                                                */
/* ---------------------------------------------------------------------- */

export type Comment = {
  id: string;
  requestId: string;
  projectId: string;
  name: string;
  userId: string;
  body: string;
  createdAt: number;
};

function toComment(doc: AnvilDocument): Comment {
  const c = doc.body;
  return {
    id: str(c.id, doc.key),
    requestId: str(c.requestId),
    projectId: str(c.projectId),
    name: str(c.name),
    userId: str(c.userId),
    body: str(c.body),
    createdAt: num(c.createdAt),
  };
}

export async function listComments(requestId: string): Promise<Comment[]> {
  await ensureCollections();
  const docs = await docQuery(COMMENTS, { op: "eq", field: "requestId", value: ident(requestId, "request id") }, LIMITS.commentsPerRequest * 2);
  return docs.map(toComment).sort((a, b) => a.createdAt - b.createdAt);
}

/** Comments belong to a person too: the Anvil user id is the identity. */
export async function createComment(
  requestId: string,
  input: { body: string; name?: string; userId: string; ip?: string },
): Promise<Comment> {
  const req = await getRequest(requestId);
  if (!req || req.status === "declined") throw new AnvilError("Unknown request", 404);
  const body = (input.body ?? "").trim();
  if (!body) throw new AnvilError("Write a comment first.", 400);
  if (body.length > LIMITS.commentBody) throw new AnvilError(`Keep the comment under ${LIMITS.commentBody} characters.`, 400);
  if (!input.userId) throw new AnvilError("Sign in to comment", 401);
  if ((await listComments(req.id)).length >= LIMITS.commentsPerRequest) throw new AnvilError("This request has reached its comment limit.", 400);
  const comment: Comment = {
    id: await reserveUuid(),
    requestId: req.id,
    projectId: req.projectId,
    name: (input.name ?? "").trim().slice(0, LIMITS.commentName),
    userId: input.userId,
    body,
    createdAt: Date.now(),
  };
  await docPut(COMMENTS, comment.id, {
    ...comment,
    ipHash: input.ip ? hashIp(input.ip) : "",
  }, { ifNotExists: true });
  return comment;
}

export function publicComment(c: Comment) {
  return { id: c.id, name: c.name || "Anonymous", body: c.body, createdAt: c.createdAt };
}

/* ---------------------------------------------------------------------- */
/* Attachments                                                             */
/* ---------------------------------------------------------------------- */

export type Attachment = {
  id: string;
  /** "" while pending (uploaded, not yet attached to a request). */
  requestId: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  storageKey: string;
  userId: string;
  createdAt: number;
};

function toAttachment(doc: AnvilDocument): Attachment {
  const a = doc.body;
  return {
    id: str(a.id, doc.key),
    requestId: str(a.requestId),
    projectId: str(a.projectId),
    name: str(a.name),
    mime: str(a.mime),
    size: num(a.size),
    storageKey: str(a.storageKey),
    userId: str(a.userId),
    createdAt: num(a.createdAt),
  };
}

/** Records an uploaded file as pending; the object is already in the bucket. */
export async function createAttachment(
  projectId: string,
  input: { name: string; mime: string; size: number; storageKey: string; userId: string },
): Promise<Attachment> {
  await ensureCollections();
  const a: Attachment = {
    id: await reserveUuid(),
    requestId: "",
    projectId: ident(projectId, "project id"),
    name: input.name,
    mime: input.mime,
    size: input.size,
    storageKey: input.storageKey,
    userId: input.userId,
    createdAt: Date.now(),
  };
  await docPut(ATTACHMENTS, a.id, { ...a }, { ifNotExists: true });
  return a;
}

export async function getAttachment(id: string): Promise<Attachment | null> {
  await ensureCollections();
  const doc = await docGet(ATTACHMENTS, ident(id, "attachment id"));
  return doc ? toAttachment(doc) : null;
}

/**
 * Binds pending uploads to a freshly created request. Only the uploader's own
 * pending files count (matched by Anvil user id); anything else in the list is
 * ignored, and at most MAX_ATTACHMENTS_PER_REQUEST are taken.
 */
export async function claimAttachments(requestId: string, projectId: string, userId: string, ids: string[]): Promise<Attachment[]> {
  if (!userId) return [];
  const out: Attachment[] = [];
  for (const id of ids.slice(0, MAX_ATTACHMENTS_PER_REQUEST * 2)) {
    if (out.length >= MAX_ATTACHMENTS_PER_REQUEST) break;
    let a: Attachment | null = null;
    try {
      a = await getAttachment(id);
    } catch {
      continue; // malformed id in the list: skip, never sink the submission
    }
    if (!a || a.requestId || a.projectId !== projectId || a.userId !== userId) continue;
    const next = { ...a, requestId };
    await docPut(ATTACHMENTS, a.id, { ...next });
    out.push(next);
  }
  return out;
}

/** Deletes a pending upload (its object too). Claimed files stay. */
export async function deletePendingAttachment(id: string, userId: string): Promise<boolean> {
  const a = await getAttachment(id);
  if (!a || a.requestId || !userId || a.userId !== userId) return false;
  await deleteObject(a.storageKey);
  await docDelete(ATTACHMENTS, a.id);
  return true;
}

export async function listAttachments(requestId: string): Promise<Attachment[]> {
  await ensureCollections();
  const docs = await docQuery(ATTACHMENTS, { op: "eq", field: "requestId", value: ident(requestId, "request id") }, 100);
  return docs.map(toAttachment).sort((a, b) => a.createdAt - b.createdAt);
}

export function publicAttachment(a: Attachment) {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size };
}

/* ---------------------------------------------------------------------- */
/* Public shapes                                                           */
/* ---------------------------------------------------------------------- */

export function publicProject(p: Project) {
  return { id: p.id, name: p.name, intro: p.intro, boardEnabled: p.boardEnabled, accent: p.accent, buttonLabel: p.buttonLabel };
}

export function publicRequest(r: FeatureRequest, voted = false) {
  // `details` is the plain-text rendering (previews, clamps); `detailsHtml`
  // is the sanitized markup. Legacy plain-text rows pass through unchanged.
  const clean = sanitizeDetails(r.details);
  return { id: r.id, title: r.title, details: clean.text, detailsHtml: clean.html, status: r.status, votes: r.votes, createdAt: r.createdAt, voted };
}
