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

Quick check from a shell:

```bash
curl -s $ANVIL_URL/health
curl -s -X POST $ANVIL_URL/db/query -H "authorization: Bearer $ANVIL_SERVICE_KEY" \
  -H 'content-type: application/json' -d '{"query":"MATCH (p:FRProject) RETURN count(p)"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $ANVIL_URL/auth/register \
  -H "authorization: Bearer $ANVIL_SERVICE_KEY" -H 'content-type: application/json' -d '{}'
# 400 = admin (payload rejected), 403 = not admin
```

## Data model (flat on purpose)

```
(:FRProject {id, ownerId, ownerEmail, name, intro, originsJson, boardEnabled, accent,
             buttonLabel, createdAt, updatedAt})
(:FRRequest {id, projectId, title, details, email, status, votes, origin, ipHash,
             createdAt, updatedAt})
(:FRVote    {id, requestId, projectId, voter, createdAt})
```

`ownerId` is the Anvil user id (`sub` of the JWT). Statuses: `new`, `planned`,
`in_progress`, `done`, `declined` (declined never appears publicly). Sorting and
capping happen in `store.server.ts`.

### Anvil 0.1.0 quirks the code works around

- Query parameters only bind inside MATCH map patterns: values are inlined through
  `lit()` (strict literal encoder) and ids through `ident()`. `lit()` also picks the
  quote delimiter per value because an escaped quote followed by `//` or `/*` is read
  as a comment by the lexer.
- List properties do not round-trip; `\uXXXX` escapes are not decoded (other control
  characters are dropped).
- `CREATE ... RETURN` returns a summary row, `MATCH ... CREATE` chains do not create,
  relationships do not traverse reliably, `ORDER BY`/`LIMIT` is unreliable: hence
  flat ids as properties and sorting in the app.
- Naming the database in the query body changes the schema context; leave
  `ANVIL_DATABASE` empty for the default.

## HTTP surface

| Route | What |
| --- | --- |
| `/tools/feature-requests` | Landing; signed-in people go to their projects. |
| `/sign-in`, `/sign-up`, `/sign-out` | Password (Anvil `/auth/login`, `/auth/register`) and emailed code (`/auth/otp/*`). |
| `/projects`, `/projects/:id` | Project list + create; dashboard with triage, embed snippets, settings, delete. |
| `/p/:id` | Hosted public board; works without JavaScript. |
| `/embed.js` | The widget (see `app/lib/feature-requests/embed-script.ts`). |
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
- Integration checks against a running Anvil (local: `anvil start --foreground
  --data-dir ./data --http-port 7475`, default admin `admin`/`anvil`) are scripts, not
  part of `npm test`, because they need a server.
