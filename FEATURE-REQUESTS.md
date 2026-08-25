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

Documents in Anvil's document store (`/docs/*` REST API), one collection per type:

```
fr_projects  key = project id        {id, ownerId, ownerEmail, name, intro, origins[],
                                      boardEnabled, accent, buttonLabel, createdAt, updatedAt}
fr_requests  key = request id        {id, projectId, title, details, email, status, votes,
                                      origin, ipHash, createdAt, updatedAt}
fr_votes     key = requestId--voter  {id, requestId, projectId, voter, createdAt}
```

`ownerId` is the Anvil user id (`sub` of the JWT) captured at creation time; it
stops matching when accounts move to a fresh Anvil server, so `ownerEmail` is
the durable ownership claim and access checks accept either. Statuses: `new`, `planned`,
`in_progress`, `done`, `declined` (declined never appears publicly). Queries use
the document query endpoint with `eq`/`and` filters on body fields; sorting and
capping happen in `store.server.ts`. The vote key makes one vote per
(request, voter) true by construction. The graph representation comes from
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

Rule creation backfills existing rows in both directions; `SHOW SYNC RULES` and
`SHOW TRIGGERS` list what is active, `DROP SYNC RULE <id>` / `DROP TRIGGER <name>`
remove them. Deleting a document detach-deletes its node, so the edge goes with
it. Verified end to end: a request created through the app produces the
document, the synced :FRRequest node, and the FOR_PROJECT edge; a status change
syncs to the node; deleting the project removes nodes and edges. If votes
should appear in the graph too, the same pattern applies to `fr_votes`
(`SYNC LABEL FRVote TO COLLECTION fr_votes KEY id` plus a trigger to
`:FRRequest` via `NEW.requestId`).

## HTTP surface

| Route | What |
| --- | --- |
| `/tools/feature-requests` | Landing; signed-in people go to their projects. |
| `/sign-in`, `/sign-up`, `/sign-out` | Password (Anvil `/auth/login`, `/auth/register`) and emailed code (`/auth/otp/*`). |
| `/projects`, `/projects/:id` | Project list + create; dashboard with triage, embed snippets, settings, delete. |
| `/p/:id` | Hosted public board; works without JavaScript. |
| `/embed.js` | The widget (see `app/lib/feature-requests/embed-script.ts`). |
| `/project`, `/project/:id` | Owner self-serve area: emailed-code sign-in only, then every project whose `ownerEmail` matches the address (or whose `ownerId` matches the account). Same dashboard as the tools area (shared component). |
| `GET /api/projects/:id/board?voter=` | Public JSON: project info + visible requests. |
| `POST /api/projects/:id/requests` | Submit `{title, details, email, voter, website}`; `website` is a honeypot. |
| `POST /api/requests/:rid/vote` | Toggle `{voter}`'s vote. |

API responses are CORS-enabled. Reads are public; writes honour the project's origin
allow-list (exact origin match), and are rate limited per IP and per project in
memory (one instance). The widget identifies voters with a random key kept in
`localStorage`; the hosted board uses an HttpOnly cookie.

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
