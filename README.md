# Stencil

A Git-backed CMS **and visual site builder**. Content lives as plain files in a GitHub repository — Markdown, articles, wiki markup, and drag‑and‑drop pages — edited through a rich admin UI, versioned by Git, and served (or embedded) anywhere.

Think of it as a headless CMS with a **visual page builder** bolted on: you author content and design layouts visually, everything is stored as human‑readable files in your repo, and there's no database.

Built with React Router 7, remix‑flat‑routes, and the GitHub API.

---

## Highlights

- **Four content types** — Markdown, **Articles**, **Pages** (visual builder), and **Wikipedia/Wikitext**.
- **Visual page builder** — drag‑and‑drop blocks, a layers tree, live class/style editing, responsive canvas, and custom URL paths — the output is your own clean HTML.
- **Reusable components** — build a component once, drop it into any page; edits propagate.
- **Conditional components** — components that render different branches per visitor based on **auth, geo, time, device, query params, A/B bucket, or page data**, resolved on the server per request. Edited in a visual flow editor.
- **Articles** — first‑class blog/news content with header + social images, tags, git‑derived created/updated dates, an `articles.json` index, ready‑made grid/card/featured/tag‑filter blocks, per‑article layout templates, share buttons, and social/OpenGraph metadata.
- **Rich Markdown editor** — WYSIWYG (TipTap) with raw‑markdown toggle, image resize/align, code blocks with **syntax highlighting** + language picker, tasks, tables, and Excalidraw whiteboards.
- **GitHub OAuth login with roles** — Admin / Moderator / Editor derived from each user's permission on the content repo.
- **Two‑branch publishing** — drafts on one branch, published content on another, with full history and side‑by‑side diffs.
- **Text variables** — `{username}`, `{query.ref}`, `{geo.country}`, `{data.*}` … substituted at render time.
- **Anonymous‑by‑default public site** with edge caching, plus a headless JSON API and iframe embeds.

---

## Setup

### Prerequisites

- **Node.js 22+** (`require(esm)` support is needed for some deps; the repo pins `engines.node: 22.x`)
- A **GitHub repository** to store content (must exist with at least one commit)
- A **GitHub OAuth App** for sign‑in (see below)
- Optionally, a **GitHub token** for a shared service account (see `GITHUB_TOKEN`)

### Generating GitHub credentials

You need two things: an **OAuth App** (so people can sign in) and, optionally, a **token** (a shared service account for git operations). All of these live under **GitHub → Settings → Developer settings**.

#### `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` (required — sign‑in)

Sign‑in uses GitHub OAuth, and each user's role is derived from their permission on the content repo.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → [New OAuth App](https://github.com/settings/applications/new)**.
2. Fill in:
   - **Application name** — anything (e.g. "My Stencil CMS").
   - **Homepage URL** — your site's origin (e.g. `http://localhost:5174` in dev, or your production URL).
   - **Authorization callback URL** — `<your-site-origin>/auth/github/callback` (e.g. `http://localhost:5174/auth/github/callback`).
3. Click **Register application**. Copy the **Client ID** → `GITHUB_OAUTH_CLIENT_ID`.
4. Click **Generate a new client secret**, copy it immediately (it's shown once) → `GITHUB_OAUTH_CLIENT_SECRET`.

> An OAuth App allows **one** callback URL, so use a separate app per environment (dev/prod), or create a **GitHub App** instead — use its **Client ID** + a generated **client secret** the same way (the App's *private key* is **not** needed for this login flow).

Role mapping (from the signed‑in user's permission on the repo): `admin → Admin`, `maintain → Moderator`, `write → Editor`. Anything below write access can't sign in to the CMS.

#### `GITHUB_TOKEN` (optional — shared service account)

If set, all git operations use this token instead of each signed‑in user's own token. **Required** if your content repo is **private** and you want anonymous visitors to see the published site (anonymous requests have no user token to fall back to). Use a **fine‑grained** token scoped to just the content repo:

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine‑grained tokens → [Generate new token](https://github.com/settings/personal-access-tokens/new)**.
2. Set **Resource owner** to the account/org that owns the content repo, and **Repository access → Only select repositories → \<your content repo\>**.
3. Under **Permissions → Repository permissions**, grant:
   - **Contents** → **Read and write** (read/commit content & assets)
   - **Metadata** → **Read‑only** (mandatory)
   - **Administration** → **Read‑only** *(optional — lets the token look up collaborators' roles for sign‑in; not needed if the OAuth login already resolves roles)*
4. **Generate token** and copy it → `GITHUB_TOKEN`.

> Prefer the simplest thing that works: a **classic** token (Developer settings → *Tokens (classic)*) with the **`repo`** scope also works, but grants broad access — fine‑grained is recommended. Leave `GITHUB_TOKEN` unset for a public repo to have commits attributed to whoever is signed in.

### Installation & configuration

```bash
npm install
cp .env.example .env   # then fill in the values
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_OWNER` | Yes | | GitHub user/org that owns the content repo |
| `GITHUB_REPO` | Yes | | Content repository name |
| `GITHUB_OAUTH_CLIENT_ID` | Yes | | OAuth App client ID (for "Login with GitHub") |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | | OAuth App client secret |
| `SESSION_SECRET` | Yes | | Random string used to encrypt session cookies |
| `GITHUB_TOKEN` | No | | Shared service token. **If set**, all git ops use it. **If unset**, ops use the signed‑in user's own token (commits are attributed to them). A **private** repo still needs a token for anonymous public serving. |
| `GITHUB_BRANCH` | No | `draft` | Working branch — admin edits land here |
| `GITHUB_PUBLISH_BRANCH` | No | `main` | Publish branch — the public site/API serve from here |
| `GITHUB_CONTENT_PATH` | No | `content` | Directory for content files and assets |
| `GITHUB_COMPONENT_PATH` | No | `components` | Directory for reusable components |
| `API_TOKEN` | No | | If set, the JSON API/embeds require `Authorization: Bearer <token>` or `?token=`. Leave unset for a fully public API. |

### Development / production

```bash
npm run dev      # dev server
npm run build && npm start   # production
npm run typecheck
npm test
```

---

## Authentication & roles

Public pages are **anonymous** — only published content is visible to visitors. The CMS (`/content/*`, `/components/*`, settings) requires sign‑in.

| Capability | Admin | Moderator | Editor |
|---|:--:|:--:|:--:|
| Create / edit content & components | ✓ | ✓ | ✓ |
| Publish / unpublish · Delete | ✓ | ✓ | — |
| Settings · manage | ✓ | — | — |

Guards are enforced server‑side (route loaders/actions) and mirrored in the UI (buttons/nav hidden for lower roles). There's also a separate **visitor** auth track (`/api/visitor/*`) for real end‑user accounts, which is what the conditional `auth.*` signals read.

---

## Content types

Content files live in `GITHUB_CONTENT_PATH/` as `{slug}.<ext>`, each with YAML frontmatter:

| Type | Extension | Editor | Public URL |
|---|---|---|---|
| **Markdown** | `.md` | WYSIWYG + raw markdown | assign a path |
| **Article** | `.article` | Markdown editor + article fields | `/articles/<slug>` |
| **Page** | `.page` | Visual page builder | assign a path (or `/`) |
| **Wikipedia** | `.wikipedia` | Wikitext editor | assign a path |

Common frontmatter: `title`, `description`, `tags`, `headerImage`, `ogImage`, `ogTitle`, `ogDescription`, `path` (custom public URL), `publishedAt`, `updatedAt`, `draft`.

Create content at **`/content/new`** (Article · Markdown · Page · Wiki). The content list at **`/content`** has per‑type tabs and shows each item's assigned URI.

---

## Visual page builder (Pages)

`.page` content opens in a drag‑and‑drop builder that produces clean, self‑hosted HTML:

- **Blocks palette** — Layout, Basic, Components, Articles categories, plus your custom components and conditionals.
- **Canvas** — drag blocks in, select/nest elements, resize the viewport to test screen sizes.
- **Layers** — a tree view with drag‑to‑reorder / drag‑into‑container.
- **Properties** — edit attributes, Tailwind classes, and inline styles per element; images upload to the content assets.
- **Body classes** come from **Settings** and are applied to the public `<body>` at render time (change them once, every page updates).

Pages are served at their assigned `path` (e.g. `/about`), or at the site **root `/`**. Public pages load the Tailwind runtime so utility classes render without a build step.

---

## Components & conditional components

**Components** (`/components`) are reusable page‑builder fragments stored under `GITHUB_COMPONENT_PATH/`. Build one (e.g. a nav/header), then drop it into pages from the blocks palette — instances carry a `data-pb-component` marker and stay in sync.

**Conditional components** render **one of several branches** depending on the current request, evaluated server‑side:

- **Signals** — `auth.*` (logged in, username, roles, attributes), `query.<param>`, `data.<key>` (page frontmatter), `device` (mobile/desktop), `time.*` (UTC), `geo.*` (country/region/city), `ab.*` (stable A/B bucket).
- **Editing** — a visual **flow editor** (React Flow) shows the condition branches and their target components, with live "test signals" preview.
- **Rendering** — a placeholder (`data-pb-conditional`) is swapped for the chosen branch's markup at serve time. Personalized pages are served `private, no-store` so per‑visitor markup is never shared‑cached.

---

## Articles

Articles are blog/news posts with extra structure:

- **Header image** (required) and an optional **social share image** with an in‑browser **crop tool** (locked to 1200×630, re‑encoded under 1 MB) — falls back to the header image for OpenGraph/Twitter.
- **Social overrides** — `ogTitle` / `ogDescription` for share cards, separate from the page title/description.
- **`articles.json`** — a lightweight index of every article (title, tags, header image, dates) kept in sync on the publish branch, so public listing blocks read it in a single request.
- **Article blocks** — drop **Article Grid / Card / Featured / Tag‑filter** blocks into any page; they render server‑side from `articles.json` (with `?tag=` filtering, published‑only or include‑drafts).
- **Article template** — designate a Page (with an "Article Content" slot block) in Settings; every article renders inside that layout.
- **Public article** — `/articles/<slug>` shows the title, header image, a Git‑derived **Created / Updated** byline, **social share buttons** (X, Facebook, LinkedIn, Instagram, copy), and an **Edit** button for signed‑in editors.

---

## Markdown editor

The WYSIWYG editor (TipTap/ProseMirror) is used for Markdown and Article bodies, with a **Raw** markdown toggle:

- **Formatting** — headings, bold/italic, lists, tasks, tables, blockquotes, links, horizontal rules.
- **Code blocks** — syntax highlighting via lowlight/highlight.js (GitHub‑dark theme) with a **language picker**; the language round‑trips through Markdown and the published page (`rehype-highlight`).
- **Images** — upload/drag/paste; click to set **alignment** (left/center/right/float) and **size** (25–100 % or drag‑resize). Size/alignment are encoded in the Markdown image title (`"width=50% align=center"`), and a sized image defaults to centered.
- **Sticky toolbar** — stays visible while scrolling long articles.
- **Whiteboards** — see below.

### Whiteboards

Every whiteboard is associated with a content page (no standalone whiteboards). From the edit page, the **Whiteboards** panel lets you create, edit (Excalidraw), and **Insert** a whiteboard image into the body. Saving commits the editable `.excalidraw` scene plus a rendered PNG; embeds reference the PNG and are **not** commit‑pinned, so edits propagate to every page that uses them.

```
content/whiteboards/{pageSlug}/{wbSlug}.excalidraw   # editable scene
content/assets/whiteboard-{pageSlug}-{wbSlug}.png    # rendered image
```

---

## Wikipedia / Wikitext

`.wikipedia` content is authored in **Wikitext** (MediaWiki markup) with a dedicated editor and a live preview (`/api/preview-wiki`) — useful for wiki‑style knowledge bases alongside Markdown and visual pages.

---

## Settings

**`/content/settings`** (Admin only) stores site‑wide config in `settings.json`:

- **Site Name** — used for `og:site_name` on shared links.
- **Favicon** — PNG/SVG/ICO, emitted as `<link rel="icon">` on public pages and the admin.
- **Body classes** (light + dark) — applied to the public `<body>` at render.
- **Fonts** — Google Fonts to load.
- **Article template** — the Page used as the layout for all articles.

---

## Publishing workflow

Two‑branch model:

- **`draft`** — every admin save commits here.
- **`main`** (`GITHUB_PUBLISH_BRANCH`) — what the public site/API serve; updated only when you publish.

From a content view: **Publish** / **Publish Changes** (when the draft is ahead) / **Unpublish**. Listings show **Draft**, **Published**, or **Unpublished changes** badges. **`/content/:slug/history`** shows the Git log, marks the published commit, and offers a side‑by‑side diff between any two commits.

---

## Assets

Uploaded from the editor (toolbar picker, drag‑and‑drop, or paste). Allowed: PNG, JPEG, GIF, WebP, SVG, ICO, PDF (max 10 MB). Files are written to `content/assets/<slug>/<filename>` (grouped per content item) on both branches and served via a splat route. Editor image references are **commit‑pinned** (`?ref=<sha>`) so they're immutable even if a same‑named file is uploaded later.

---

## Text variables

Any text can contain `{variable}` tokens, substituted server‑side at render against the same signals conditions use:

- `{username}` `{roles}` `{attributes.plan}` — the visitor (shorthands for `auth.*`)
- `{query.ref}` · `{data.title}` · `{geo.country}` · `{time.hour}` · `{device}`

Unknown tokens are left literal; a logged‑out `{username}` becomes empty. Values are inserted as text (no HTML injection), and pages using request‑specific variables become uncacheable.

---

## Headless API & embedding

Public API/embed endpoints are read‑only, CORS‑enabled, and serve published content (optionally gated by `API_TOKEN`).

| Endpoint | Description |
|---|---|
| `GET /api/content` | List content (`?tag=`, `?draft=true`) |
| `GET /api/content/:slug` | Single item — `{ meta, html, raw, sha }` (`?format=html` for HTML only) |
| `GET /api/content/:slug/version/:sha` | A specific version + diff |
| `GET /api/assets` · `GET /api/assets/*` | List / serve assets (`?ref=<sha>`) |
| `POST /api/assets/upload` | Upload (auth required) |
| `GET /api/components` · `/api/components/:slug` · `/api/components/:slug.css` | Component data + compiled CSS |
| `GET /api/me` | The current CMS user's role (used to reveal admin affordances on public pages) |
| `GET /api/health` | Health check |

### Embedding an article on another site

Renders the article body **with its styling but without the site template**, in an auto‑resizing iframe:

```html
<iframe src="https://your-site/embed/articles/<slug>" style="width:100%;border:0" scrolling="no"></iframe>
<script src="https://your-site/embed.js" async></script>
```

The embed posts its height and `embed.js` sizes the iframe to fit. The copy‑paste snippet is available on a published article's admin view.

---

## Caching

Public pages set `Cache-Control` with **`s-maxage`** so a shared cache / CDN (e.g. Vercel's edge) caches the rendered HTML — SSR runs at most once per TTL per URL, with `stale-while-revalidate` so visitors never block on a regeneration. Personalized/draft pages (conditionals, `{variables}`, include‑drafts) are `private, no-store`. The `/content/*` admin routes are `no-store` (see `vercel.json`).

---

## Route structure

Uses [remix‑flat‑routes](https://github.com/kiliman/remix-flat-routes) (`route.tsx` per directory; `+` folders are path segments, `$` params, `_` pathless layouts).

```
app/routes/
  _index/                          /                         Home / page assigned to "/"
  $/                               /*                        Public pages at custom paths
  articles+/$slug/                 /articles/:slug           Public article
  embed+/articles.$slug/           /embed/articles/:slug     Template-free article embed
  embed[.]js/                      /embed.js                 Iframe resizer script

  _auth+/login · logout            /login · /logout          Sign-in page / sign-out
  auth+/github · github.callback   /auth/github(/callback)   GitHub OAuth flow

  _dashboard/                      (auth layout)             CMS shell
    content+/_index                /content                  List (type tabs)
    content+/new                   /content/new              Create
    content+/$slug                 /content/:slug            View + publish/unpublish + embed
    content+/$slug_.edit           /content/:slug/edit       Edit (WYSIWYG / builder / wikitext)
    content+/$slug_.history        /content/:slug/history    Git history + diff
    content+/$slug_.whiteboards…   …/whiteboards[/:wb]       Whiteboards (Excalidraw)
    content+/settings              /content/settings         Site settings (admin)
    components+/_index · $slug      /components[/:slug]       Components + conditional flow editor

  api+/…                           /api/*                    JSON API, assets, components, me, health, preview, visitor
```

---

## Tech stack

- [React Router 7](https://reactrouter.com/) (framework mode, SSR) + [remix‑flat‑routes](https://github.com/kiliman/remix-flat-routes)
- [Octokit](https://github.com/octokit/octokit.js) — GitHub API (content storage; no database)
- [TipTap](https://tiptap.dev/) / ProseMirror — WYSIWYG editor; [lowlight](https://github.com/wooorm/lowlight) — code highlighting
- [@xyflow/react](https://reactflow.dev/) (React Flow) — conditional‑component flow editor
- [Excalidraw](https://excalidraw.com/) — whiteboards; [react‑image‑crop](https://github.com/DominicTobias/react-image-crop) — social‑image cropping
- [unified](https://unifiedjs.com/) / remark / rehype — Markdown → HTML; [turndown](https://github.com/mixmark-io/turndown) — HTML → Markdown; [gray‑matter](https://github.com/jonschlinkert/gray-matter) — frontmatter
- [linkedom](https://github.com/WebReflection/linkedom) — lightweight server‑side DOM for the render passes (conditionals, article blocks, variables)
- [Tailwind CSS 4](https://tailwindcss.com/) · [lucide‑react](https://lucide.dev/) · TypeScript
