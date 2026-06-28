import { createCookieSessionStorage } from "react-router";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Octokit } from "octokit";
import { getGitHubConfig } from "./github.server";

/**
 * Visitor auth track — real end-user accounts, separate from the CMS-admin
 * (`__stencil_session`) GitHub login. A signed `__stencil_visitor` cookie holds
 * the visitor's identity; accounts are persisted as per-user JSON files in the
 * content repo (consistent with how the rest of the CMS stores state).
 *
 * Passwords are scrypt-hashed with a per-user salt and compared in constant
 * time. The hash never leaves the server — only the public identity (id,
 * username, roles, attributes) is placed in the session cookie, so
 * `buildContext` resolves `auth.*` from the cookie without a repo read.
 */

const visitorSecret =
  process.env.VISITOR_SESSION_SECRET || process.env.SESSION_SECRET || "dev-visitor-secret-change-me";

const VISITOR_PATH = process.env.GITHUB_VISITOR_PATH || "_visitors";

/** Registration can be turned off without removing login. */
export function isVisitorRegistrationEnabled(): boolean {
  return process.env.VISITOR_REGISTRATION !== "disabled";
}

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__stencil_visitor",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
    sameSite: "lax",
    secrets: [visitorSecret],
    secure: process.env.NODE_ENV === "production",
  },
});

/** Public identity placed in the session cookie and exposed via `auth.*`. */
export interface VisitorIdentity {
  id: string;
  username: string;
  roles: string[];
  attributes: Record<string, unknown>;
}

/** On-disk record (includes the secret hash; never sent to the client). */
interface VisitorRecord extends VisitorIdentity {
  salt: string;
  passwordHash: string;
  createdAt: string;
}

// --- password hashing (exported for testing) -------------------------------

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Normalize a username to a safe, lowercase, file-name-able slug. */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/.test(s)) return null;
  return s;
}

// --- GitHub-backed store ---------------------------------------------------

function getOctokit(token: string) {
  return new Octokit({
    auth: token,
    request: { headers: { "X-GitHub-Api-Version": "2022-11-28" } },
  });
}

function visitorFilePath(username: string): string {
  return `${VISITOR_PATH}/${username}.json`;
}

async function readVisitorRecord(username: string): Promise<VisitorRecord | null> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: visitorFilePath(username),
      ref: config.branch,
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(content) as VisitorRecord;
  } catch {
    return null;
  }
}

async function writeVisitorRecord(record: VisitorRecord): Promise<void> {
  const config = getGitHubConfig();
  const octokit = getOctokit(config.token);
  const content = Buffer.from(JSON.stringify(record, null, 2)).toString("base64");
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: visitorFilePath(record.username),
    message: `Register visitor ${record.username}`,
    content,
    branch: config.branch,
  });
}

// --- public API ------------------------------------------------------------

export class VisitorError extends Error {}

/**
 * Create a new visitor account. Throws `VisitorError` for invalid input or a
 * taken username. Returns the public identity (the caller starts the session).
 */
export async function registerVisitor(input: {
  username: string;
  password: string;
  attributes?: Record<string, unknown>;
  roles?: string[];
}): Promise<VisitorIdentity> {
  if (!isVisitorRegistrationEnabled()) throw new VisitorError("Registration is disabled");

  const username = normalizeUsername(input.username);
  if (!username) throw new VisitorError("Invalid username");
  if (typeof input.password !== "string" || input.password.length < 8) {
    throw new VisitorError("Password must be at least 8 characters");
  }
  if (await readVisitorRecord(username)) throw new VisitorError("Username is taken");

  const salt = randomBytes(16).toString("hex");
  const record: VisitorRecord = {
    id: `v_${randomBytes(8).toString("hex")}`,
    username,
    roles: input.roles ?? ["member"],
    attributes: input.attributes ?? {},
    salt,
    passwordHash: hashPassword(input.password, salt),
    createdAt: new Date().toISOString(),
  };
  await writeVisitorRecord(record);
  return toIdentity(record);
}

/** Verify credentials. Returns the identity on success, null otherwise. */
export async function authenticateVisitor(
  usernameRaw: string,
  password: string
): Promise<VisitorIdentity | null> {
  const username = normalizeUsername(usernameRaw);
  if (!username || typeof password !== "string") return null;
  const record = await readVisitorRecord(username);
  if (!record) return null;
  if (!verifyPassword(password, record.salt, record.passwordHash)) return null;
  return toIdentity(record);
}

function toIdentity(r: VisitorRecord): VisitorIdentity {
  return { id: r.id, username: r.username, roles: r.roles, attributes: r.attributes };
}

// --- session ---------------------------------------------------------------

export async function getVisitorSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

/**
 * Read the logged-in visitor's identity from the session cookie. Never touches
 * GitHub, so it's cheap and safe even when the repo isn't configured.
 */
export async function getVisitor(request: Request): Promise<VisitorIdentity | null> {
  const session = await getVisitorSession(request);
  const identity = session.get("identity") as VisitorIdentity | undefined;
  return identity ?? null;
}

/** Build a Set-Cookie header that logs the given identity in. */
export async function commitVisitorIdentity(
  request: Request,
  identity: VisitorIdentity
): Promise<string> {
  const session = await getVisitorSession(request);
  session.set("identity", identity);
  return sessionStorage.commitSession(session);
}

export async function destroyVisitorSession(request: Request): Promise<string> {
  const session = await getVisitorSession(request);
  return sessionStorage.destroySession(session);
}
