# Feature requests tool

`/tools/feature-requests` lets anyone create a project, drop one script tag on their
site, and collect feature requests with a public board and upvotes. Accounts and
data live in Anvil DB; this app talks to Anvil over its HTTP API.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANVIL_URL` | yes | Anvil HTTP API origin, for example `https://vultr.anvildb.com:7474` (not the Hammer UI host). |
| `ANVIL_SERVICE_KEY` | one of | Service-account API key (`anvil_sk_...`). Preferred. |
| `ANVIL_ADMIN_USER` / `ANVIL_ADMIN_PASSWORD` | one of | Fallback: the app logs in as this user and caches the token. |
| `ANVIL_DATABASE` | no | Only for a non-default database. On Anvil 0.1.0 naming it also switches the schema context. |
| `SESSION_SECRET` | yes | Signs the tool's `_fr_session` cookie (shared with the rest of Stencil). |
| `PUBLIC_ORIGIN` | no | Origin printed in the embed snippets (defaults to the request origin). |

Never commit the key; it belongs in `.env` locally and in the deployment's environment.

### What the service principal needs

- Cypher read/write on the `FRProject`, `FRRequest` and `FRVote` labels (reader + writer
  roles are enough for the data itself).
- **Admin role** for password sign-up: `/auth/register` is admin-only in Anvil. With a
  non-admin key the sign-up page explains that and points people to the emailed code.
- **Usernames are Anvil's business** (since 2026-08-26): the app registers with
  `{email, password}` only and Anvil assigns the username (email local part, hex
  suffix only on collision, in a single call). A caller-provided username that is
  taken is a hard 409; clients must not probe for free names. Duplicate emails are
  rejected. Password login accepts the email; Anvil resolves it to the stored
  username. Requires an Anvil build with this contract: deploy Anvil before
  deploying the app change, or sign-up fails with a missing-username 422.
- For the emailed-code path: Anvil must have email configured (`/auth/otp/request`
  returns 503 otherwise) and `allow_otp_registration = true` so a code can create an
  account that does not exist yet. Existing accounts can always use the code.
  `/project` relies on this entirely: a person whose email is set as a project's
  `ownerEmail` but who has no Anvil account yet can only get in if
  `allow_otp_registration` is on.

Quick check from a shell:

```bash
curl -s $ANVIL_URL/health
curl -s -X POST $ANVIL_URL/db/query -H "authorization: Bearer $ANVIL_SERVICE_KEY" \
  -H 'content-type: application/json' -d '{"query":"MATCH (p:FRProject) RETURN count(p)"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $ANVIL_URL/auth/register \
  -H "authorization: Bearer $ANVIL_SERVICE_KEY" -H 'content-type: application/json' -d '{}'
# 400 = admin (payload rejected), 403 = not admin
```

## Data model

Documents in Anvil's document store (`/docs/*` REST API), one collection per type. Since 2026-09-02 everything lives in the Anvil app
`feature_requests` (schema `app_feature_requests`, see Anvil's APPS.md): the
collection names below are all prefixed `app_feature_requests.` and carry no
`fr_` prefix (the schema is the namespace; the old public `fr_*` names are
stuck as phantom registry entries on the hosted server, an Anvil
`drop_collection` bug now fixed for future drops but not repaired for
existing phantoms), the labels
are bound to that schema, and reads/writes through `/docs` pass the app
membership check (the service key's admin role grants implicit app-admin).
Registration and OTP requests carry `app: feature_requests` so Anvil can
apply per-app email templates and settings once configured:

```
projects     key = project id        {id, ownerId, name, intro, origins[],
                                      boardEnabled, accent, buttonLabel, createdAt, updatedAt}
requests     key = request id        {id, projectId, title, details, submitterId, status,
                                      votes, origin, ipHash, createdAt, updatedAt}
votes        key = vote id           {id, requestId, projectId, userId, voter, createdAt}
comments     key = comment id        {id, requestId, projectId, name, userId, body,
                                      ipHash, createdAt}
attachments  key = attachment id     {id, requestId, projectId, name, mime, size,
                                      storageKey, userId, createdAt}
```

Ids are server-minted UUIDs reserved through Anvil's `POST /db/uuid` (added
2026-08-27; requires editor or admin, which the service principal has). The
endpoint locks each UUID for 5 minutes via a TTL'd reservation document, so a
reserved id can never be handed out twice; `reserveUuid()` in `anvil.server.ts`
wraps it. Votes created before the switch keep their `requestId--voter`
composite keys; nothing migrates them.

`ownerId` is the Anvil user id (`sub` of the JWT) captured at creation time; it
stops matching when accounts move to a fresh Anvil server, so `ownerEmail` is
the durable ownership claim and access checks accept either. Statuses: `new`, `planned`,
`in_progress`, `done`, `declined` (declined never appears publicly). Queries use
the document query endpoint with `eq`/`and` filters on body fields; sorting and
capping happen in `store.server.ts`. One vote per (request, person) is enforced
by querying for the person's existing vote (by `emailLower`, or the legacy
browser key) before writing, which finds old composite-key votes too. Two
simultaneous first votes could in principle both pass the check; the recount
that follows keeps the total honest, and the pair collapses on the next toggle. The graph representation comes from
Anvil's document-graph sync, configured on the server, not from this code.
The collections are created automatically on first use.

### Anvil notes

- The Cypher client (`cypher()`, `lit()`, `ident()`) remains in
  `anvil.server.ts` for auth flows, migrations and tooling. If you write
  Cypher against Anvil 0.1.0, mind the old quirks recorded in git history:
  parameters only bind in MATCH map patterns, `ORDER BY`/`LIMIT` was
  unreliable, and unpatched servers dropped relationships created between
  MATCHed nodes.
- Setting `ANVIL_DATABASE` switches the schema context on 0.1.0; leave it
  empty for the default.

Details are rich text (widget v9, 2026-08-31): the suggest form and the
modal's edit box are contenteditable with a small toolbar (bold, italic,
underline, strikethrough, lists), a basic version of Stencil's page editor
text tools. The server is the only gate: `details.ts` sanitizes to an
allowlist (b i u s p div br ul ol li, attributes dropped, tags balanced) on
every write and on every read that renders HTML, so legacy plain-text rows and
hostile payloads both come out safe. `publicRequest` returns `details` (plain
text, for previews and clamps) plus `detailsHtml`. `LIMITS.details` applies to
the text; the stored markup may be up to 4x that.

Attachments (widget v11, 2026-08-31): requests can carry up to 4 files, 5MB
each, stored in the private Anvil storage bucket `feature-requests`
(`storage.server.ts` creates it on first use: public=false,
file_size_limit=5242880, allowed_mime_types pinned; created on the hosted
instance 2026-08-31). Only images (png, jpg, gif, webp), PDF and plain text
(txt, md, csv, json, log) are accepted: the fork validates extension, declared
MIME and magic bytes, and the served type comes from the extension, never the
client. No executables, scripts, HTML, SVG or archives. Uploads require the
widget bearer token; files upload ahead of the submission
(`POST /api/projects/:id/uploads`, multipart) as pending `fr_attachments` docs
and the submission claims them by id (uploader email must match). Downloads
stream through `GET /api/attachments/:id` (nosniff, sandbox CSP, inline for
images/PDF, attachment otherwise); `DELETE /api/attachments/:id` removes a
still-pending upload only. Orphaned pending uploads are not auto-purged; they
are invisible and capped by the upload rate limit.

## Graph sync

The app writes documents only. On the Anvil server, sync rules mirror the
collections into graph nodes and triggers add the relationship, so Hammer shows
a real graph. This is server configuration (run once per Anvil instance, as
admin; applied to the hosted instance on 2026-08-25):

```cypher
SYNC LABEL FRProject TO COLLECTION fr_projects KEY id
SYNC LABEL FRRequest TO COLLECTION fr_requests KEY id

CREATE OR REPLACE TRIGGER fr_request_link_insert
  AFTER INSERT ON COLLECTION fr_requests
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRRequest {id: NEW.id})-[:FOR_PROJECT]->(:FRProject {id: NEW.projectId}) }

CREATE OR REPLACE TRIGGER fr_request_link_update
  AFTER UPDATE ON COLLECTION fr_requests
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRRequest {id: NEW.id})-[:FOR_PROJECT]->(:FRProject {id: NEW.projectId}) }
```

Votes are synced the same way (applied 2026-08-26); no update trigger is needed
because vote documents are only ever created and deleted:

```cypher
SYNC LABEL FRVote TO COLLECTION fr_votes KEY id

CREATE OR REPLACE TRIGGER fr_vote_link_insert
  AFTER INSERT ON COLLECTION fr_votes
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRVote {id: NEW.id})-[:FOR_REQUEST]->(:FRRequest {id: NEW.requestId}) }
```

Requests and votes also link back to the person (applied 2026-08-26). The vote
and request documents carry the Anvil user id (`submitterId` / `userId`, written
by the app at submission time), and these triggers draw the edge to the `:User`
node that Anvil mirrors into the graph at registration. MERGE RELATIONSHIP only
connects nodes that already exist, so a row whose id is empty (saved before the
person's registration succeeded) is a logged no-op, never a stub `:User`; the
update triggers heal such rows on their next write:

```cypher
CREATE OR REPLACE TRIGGER fr_request_user_link_insert
  AFTER INSERT ON COLLECTION fr_requests
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRRequest {id: NEW.id})-[:SUBMITTED_BY]->(:User {id: NEW.submitterId}) }

CREATE OR REPLACE TRIGGER fr_request_user_link_update
  AFTER UPDATE ON COLLECTION fr_requests
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRRequest {id: NEW.id})-[:SUBMITTED_BY]->(:User {id: NEW.submitterId}) }

CREATE OR REPLACE TRIGGER fr_vote_user_link_insert
  AFTER INSERT ON COLLECTION fr_votes
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRVote {id: NEW.id})-[:CAST_BY]->(:User {id: NEW.userId}) }

CREATE OR REPLACE TRIGGER fr_vote_user_link_update
  AFTER UPDATE ON COLLECTION fr_votes
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRVote {id: NEW.id})-[:CAST_BY]->(:User {id: NEW.userId}) }
```

Comments are synced the same way (applied to the hosted instance 2026-08-28,
as sync rule #8 plus the two insert triggers; rule creation backfilled the
existing comment and both edges resolved):

```cypher
SYNC LABEL FRComment TO COLLECTION fr_comments KEY id

CREATE OR REPLACE TRIGGER fr_comment_link_insert
  AFTER INSERT ON COLLECTION fr_comments
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRComment {id: NEW.id})-[:ON_REQUEST]->(:FRRequest {id: NEW.requestId}) }

CREATE OR REPLACE TRIGGER fr_comment_user_link_insert
  AFTER INSERT ON COLLECTION fr_comments
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRComment {id: NEW.id})-[:WRITTEN_BY]->(:User {id: NEW.userId}) }
```

Projects link to their owner (applied to the hosted instance 2026-08-28; on
this Anvil version trigger creation also backfilled the existing project, and
the `(:FRProject)-[:OWNED_BY]->(:User)` edge resolved). Projects created by
email-only owners through `/project` may have an empty `ownerId`, for which the
MERGE is a logged no-op:

```cypher
CREATE OR REPLACE TRIGGER fr_project_owner_link_insert
  AFTER INSERT ON COLLECTION fr_projects
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRProject {id: NEW.id})-[:OWNED_BY]->(:User {id: NEW.ownerId}) }

CREATE OR REPLACE TRIGGER fr_project_owner_link_update
  AFTER UPDATE ON COLLECTION fr_projects
  FOR EACH ROW AS { MERGE RELATIONSHIP (:FRProject {id: NEW.id})-[:OWNED_BY]->(:User {id: NEW.ownerId}) }
```

Attachments are synced the same way (applied to the hosted instance
2026-08-31, as sync rule #9 plus triggers 10-12): `SYNC LABEL FRAttachment TO
COLLECTION fr_attachments KEY id`, insert+update triggers for
`(:FRAttachment)-[:ON_REQUEST]->(:FRRequest)` (update because claiming a
pending upload sets `requestId`), and an insert trigger for
`(:FRAttachment)-[:UPLOADED_BY]->(:User)`.

Rule creation backfills existing rows in both directions; `SHOW SYNC RULES` and
`SHOW TRIGGERS` list what is active, `DROP SYNC RULE <id>` / `DROP TRIGGER <name>`
remove them. Deleting a document detach-deletes its node, so edges go with it,
which is also what removes a :FRVote when someone un-votes. Verified end to end:
the full chain (:FRVote)-[:FOR_REQUEST]->(:FRRequest)-[:FOR_PROJECT]->(:FRProject)
resolves for app-written data.

## HTTP surface

| Route | What |
| --- | --- |
| `/tools/feature-requests` | Landing; signed-in people go to their projects. |
| `/sign-in`, `/sign-up`, `/sign-out` | Password (Anvil `/auth/login`, `/auth/register`) and emailed code (`/auth/otp/*`). |
| `/projects`, `/projects/:id` | Project list + create; dashboard with triage, embed snippets, settings, delete. |
| `/p/:id` | Hosted public board; works without JavaScript. |
| `/p/:id/r/:rid` | One request on its own page: full details, vote, and a creator edit form (email must match the submitter's). Works without JavaScript. |
| `/embed.js` | The widget (see `app/lib/feature-requests/embed-script.ts`). |
| `/api/projects/:id/uploads` | POST (CORS, bearer token): upload one attachment ahead of a submission. |
| `/api/attachments/:aid` | GET streams the file; DELETE removes a pending upload (uploader only). |
| `/api/auth` | Widget sign-in (CORS): `intent` otp-request (registers unknown addresses first) or otp-verify; returns the bearer token. |
| `/project`, `/project/:id` | Owner self-serve area: emailed-code sign-in only, then every project whose `ownerId` matches the account. Same dashboard as the tools area (shared component). |
| `GET /api/projects/:id/board?voter=` | Public JSON: project info + visible requests. |
| `POST /api/projects/:id/requests` | Submit `{title, details, email, voter, website}`; `website` is a honeypot. |
| `POST /api/requests/:rid/vote` | Toggle `{voter}`'s vote. |
| `GET /api/requests/:rid?voter=&email=` | One request in full, plus `voted` and `canEdit` (email matches the submitter's). |
| `POST /api/requests/:rid` | Creator edit: `{email, details, voter}`. 403 unless the email matches the request's submitter email. |
| `POST /api/requests/:rid/comments` | Add a comment: `{body, name?, email, voter, website}`. Email required (same person-claim as votes); name is the only public identity, "Anonymous" when blank. |

API responses are CORS-enabled. Reads are public; writes honour the project's origin
allow-list (exact origin match), and are rate limited per IP and per project in
memory (one instance). Identity is the Anvil user id (Ben's call, 2026-08-31): request, vote,
comment and attachment documents carry only `submitterId`/`userId`, which the
graph links to `:User`; no email copies (the pre-cutover rows on the hosted
instance were rewritten 2026-08-31 to drop `email`/`emailLower`/`ownerEmail`
too). Submitting an idea still asks for an email: it resolves to
the account via `registerVisitor` (registration sends the verification email
when the mailer is configured) and only the resulting user id is stored, so a
submission whose registration fails has no edit claim. The hosted board's
no-JS forms resolve typed emails the same way (`lookupUserIdByEmail` for the
edit claim). The dashboard shows submitter emails by resolving ids against
`auth.users` at load time.

Since 2026-08-28 (widget v8) voting, commenting and editing require a signed-in
account. The list shows a read-only vote count per request once signed in; each row opens a
centered modal, entirely inside the embed (Ben's calls: no links out to
devforge.io, full context, not full screen): a dimmed backdrop with a card up to
600px wide that scrolls internally (host page scroll locked while open; Esc, the
backdrop, or the back link closes). Signed out, nothing vote- or comment-related shows at all (no count in the
list or the modal, no comment thread); the modal shows the title, date and
details, followed by a sign-in panel. Sign in and
register are one flow (Ben's call, 2026-08-28): email in, emailed code back,
no password. `POST /api/auth` (`otp-request`) registers unknown addresses
best-effort first (same `registerVisitor` as the suggest form) and then asks
Anvil for the code; `otp-verify` swaps the code for the bearer token. Anvil
needs email configured for this to work at all. Signed in, it
shows the vote button, the comment form (the optional name is the only public
identity), a "Signed in as ... Sign out" line and, when the account email matches
the submitter's, an edit box for the details (`LIMITS.details` is 5000). The
suggest form hides its email field for signed-in people and submits under the
account email.

The widget session is a bearer token (`embed-auth.server.ts`: HMAC-SHA256 over a
JSON payload with `SESSION_SECRET`, 30 days) kept in `localStorage`
(`devforge-fr-session`) and sent as `Authorization: Bearer` on every API call.
The token is the only identity the vote, comment and edit endpoints trust; they
answer `401 {signIn: true}` without one and the widget then drops its stored
session and shows the panel again. Votes stay keyed per email (one vote per
address across browsers). The hosted board still falls back to its anonymous
HttpOnly cookie voter; align it the same way if anonymous votes there become a
problem.

## Embed

```html
<script src="https://devforge.io/tools/feature-requests/embed.js" data-project="ID" async></script>
<!-- or inline -->
<div id="feature-requests"></div>
<script src="https://devforge.io/tools/feature-requests/embed.js" data-project="ID"
        data-mode="inline" data-target="#feature-requests" async></script>
```

Optional: `data-label`, `data-color`, `data-position="left"`, `data-theme="light"`.
Everything renders inside a shadow root.

## Tests

- `npm test` covers the literal encoder and the embed script.
- Integration checks run against the configured Anvil (`ANVIL_URL` + key) as
  ad-hoc scripts, not as part of `npm test`, because they need the server and
  they create and delete test nodes.
