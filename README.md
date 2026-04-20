# Stencil

A headless CMS that stores content as Markdown in a GitHub repository. Edit, preview, and publish with full version history. Embed content anywhere via API or script tag.

Built with React Router 7, remix-flat-routes, and the GitHub API.

## Setup

### Prerequisites

- Node.js 22+
- A GitHub repository to store content (must exist with at least one commit)
- A GitHub Personal Access Token with **Contents: Read and write** and **Metadata: Read** permissions on the content repository

### Installation

```bash
npm install
```

### Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | | GitHub PAT with `repo` or fine-grained `contents:write` + `metadata:read` |
| `GITHUB_OWNER` | Yes | | GitHub user or organization that owns the content repo |
| `GITHUB_REPO` | Yes | | Name of the content repository |
| `GITHUB_BRANCH` | No | `draft` | Working branch — admin edits go here |
| `GITHUB_PUBLISH_BRANCH` | No | `main` | Publish branch — public API serves content from here |
| `GITHUB_CONTENT_PATH` | No | `content` | Directory within the repo where markdown files are stored |
| `SESSION_SECRET` | Yes | | Random string used to encrypt session cookies |

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## Content Model

Content files are Markdown with YAML frontmatter, stored in `GITHUB_CONTENT_PATH/` as `{slug}.md`:

```markdown
---
title: "My Post"
description: "A short summary"
tags: ["docs", "tutorial"]
publishedAt: "2026-04-12T00:00:00Z"
draft: false
---

Your markdown content here.
```

| Frontmatter Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Display title |
| `description` | string | No | Short summary, shown in listings and API |
| `tags` | string[] | No | Used for filtering in the API |
| `publishedAt` | string | No | ISO 8601 date, used for sorting |
| `updatedAt` | string | No | ISO 8601 date |
| `draft` | boolean | No | Drafts are hidden from public API by default |

## Admin UI

The admin interface is behind cookie-based authentication. Log in at `/login` with your GitHub PAT.

| Route | Description |
|---|---|
| `/content` | List all content |
| `/content/new` | Create a new post |
| `/content/:slug` | View a post with rendered HTML |
| `/content/:slug/edit` | Edit the post with WYSIWYG editor, frontmatter fields, and whiteboards panel |
| `/content/:slug/history` | View git commit history with side-by-side diff and published-version marker |
| `/content/:slug/whiteboards` | List whiteboards associated with this page |
| `/content/:slug/whiteboards/:wb` | Edit an individual whiteboard (Excalidraw) |

## Whiteboards

Stencil integrates [Excalidraw](https://excalidraw.com/) for drawing diagrams and sketches. Every whiteboard is **associated with a content page** — there are no standalone whiteboards.

### How it works

From the content edit page, a **Whiteboards** panel shows all whiteboards for the current page. Each whiteboard has:

- **+ New** — create a new whiteboard for this page
- **Insert** — append the whiteboard image to the markdown body
- **Edit** — open the Excalidraw editor to modify the whiteboard

When you save a whiteboard, two things are committed to the content repo:

1. **Project file** (the editable scene) at `content/whiteboards/{pageSlug}/{wbSlug}.excalidraw` — full JSON containing elements, app state, and embedded assets. You can download and open this in the Excalidraw web app.
2. **Rendered PNG** at `content/assets/whiteboard-{pageSlug}-{wbSlug}.png` — the exported image used for embedding.

### Embedding whiteboards

Whiteboard images are referenced as regular assets via their URL:

```markdown
![Architecture](/api/assets/whiteboard-hello-world-architecture.png)
```

Unlike normal image uploads, whiteboard references are **not commit-pinned**. When you edit a whiteboard, every page that embeds it automatically shows the updated version (no re-embedding needed).

### Storage layout

```
content/
├── {slug}.md                                  # content pages
├── assets/
│   ├── {filename}                             # uploaded files (images, PDFs)
│   └── whiteboard-{pageSlug}-{wbSlug}.png     # rendered whiteboard images
└── whiteboards/
    └── {pageSlug}/
        └── {wbSlug}.excalidraw                # whiteboard project files
```

## Publishing Workflow

Stencil uses a two-branch model:

- **`draft` branch** — where all admin edits land. Every save commits to this branch.
- **`main` branch** (or `GITHUB_PUBLISH_BRANCH`) — what the public API serves. Only updated when you explicitly publish.

On the content view page:
- **Publish** — copies the current draft version to the publish branch
- **Publish Changes** — shown when draft has updates ahead of published
- **Unpublish** — removes the file from the publish branch

The content listing shows status badges: **Draft**, **Published**, or **Unpublished changes**.

The history page shows the git commit log and marks the currently published commit with a green row and checkmark icon. Select two commits to see a side-by-side diff.

## Asset Uploads

Images and files can be uploaded from the markdown editor:

- **Image toolbar button** — opens a picker with three tabs: Browse existing assets, Upload new file, or Insert from URL
- **Drag and drop** — drop files directly into the editor
- **Paste** — paste an image from clipboard to upload and insert

Allowed: PNG, JPEG, GIF, WebP, SVG, PDF. Max file size: 10 MB.

Uploaded assets are written to `content/assets/{filename}` on both the draft and publish branches simultaneously (since assets are immutable). Filenames are preserved with `-1`, `-2` suffixes appended only on collision.

Image references in the markdown are pinned to a commit SHA:

```markdown
![photo](/api/assets/my-photo.png?ref=abc123def)
```

This guarantees the image is immutable — even if someone uploads a new file with the same name, existing references continue to resolve to the original version.

### Image sizing and alignment

Click an image in the editor to show a toolbar with:

- **Alignment**: Left, Center, Right, Float L, Float R
- **Size presets**: 25%, 50%, 75%, 100%, Auto
- **Drag resize**: grab the right edge of the image

Size and alignment are encoded in the markdown title field to keep the output clean:

```markdown
![photo](/api/assets/my-photo.png "width=50% align=center")
```

The markdown renderer parses these attributes and applies them via inline styles on render.

## Headless API

All API and embed endpoints are public, read-only, and include CORS headers (`Access-Control-Allow-Origin: *`). Drafts are excluded by default.

### List content

```
GET /api/content
```

Query parameters:

| Param | Description |
|---|---|
| `tag` | Filter by tag (e.g. `?tag=docs`) |
| `draft` | Set to `true` to include drafts |

Response:

```json
{
  "items": [
    {
      "slug": "getting-started",
      "title": "Getting Started",
      "description": "A guide to...",
      "tags": ["docs"],
      "publishedAt": "2026-04-12T00:00:00Z",
      "draft": false
    }
  ],
  "total": 1
}
```

### Get single content

```
GET /api/content/:slug
```

Response:

```json
{
  "meta": {
    "slug": "getting-started",
    "title": "Getting Started",
    "description": "A guide to...",
    "tags": ["docs"],
    "publishedAt": "2026-04-12T00:00:00Z",
    "draft": false
  },
  "html": "<h1>Getting Started</h1><p>...</p>",
  "raw": "---\ntitle: \"Getting Started\"\n---\n\n# Getting Started\n...",
  "sha": "abc123"
}
```

### Get rendered HTML only

```
GET /api/content/:slug?format=html
```

Returns the rendered HTML string with `Content-Type: text/html`.

### Assets

```
GET /api/assets/:filename
```

Serves a file from `content/assets/`. Supports `?ref=<commitSha>` to pin to a specific git commit (used when images are inserted from the editor for immutability).

```
GET /api/assets
```

Lists all uploaded assets with their URLs and commit SHAs. Used internally by the asset picker in the editor.

```
POST /api/assets/upload
```

Upload a new file via `multipart/form-data`. Requires authentication. Returns `{ url, filename, commitSha }`.

### Preview

```
POST /api/preview
```

Renders raw markdown to HTML. Used by the WYSIWYG editor for the preview tab. Accepts `text/plain` body.

### Health check

```
GET /api/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-04-12T00:00:00.000Z",
  "github": true
}
```

## Embedding Content

### Script tag (easiest)

Drop this into any HTML page. It creates an auto-resizing iframe:

```html
<div>
  <script src="https://your-stencil-instance.com/embed/my-post.js"></script>
</div>
```

### iframe

```html
<iframe
  src="https://your-stencil-instance.com/embed/my-post"
  style="width: 100%; border: none;"
></iframe>
```

The embed page includes a `postMessage`-based resize script. Listen for it to auto-size the iframe:

```js
window.addEventListener("message", (e) => {
  if (e.data?.type === "stencil-resize") {
    document.querySelector("iframe").style.height = e.data.height + "px";
  }
});
```

### Fetch and render

For full control, fetch the JSON API and render the HTML yourself:

```js
const res = await fetch("https://your-stencil-instance.com/api/content/my-post");
const { html } = await res.json();
document.getElementById("content").innerHTML = html;
```

## Route Structure

Uses [remix-flat-routes](https://github.com/kiliman/remix-flat-routes) with the directory+ convention. Every route is a directory containing a `route.tsx` file.

```
app/routes/
  _index/route.tsx                              /                           Landing page
  _auth/route.tsx                               (pathless layout)           Auth wrapper
  _auth+/login/route.tsx                        /login                      Login form
  _auth+/logout/route.tsx                       /logout                     Destroy session

  content+/route.tsx                            /content                    Layout (auth required)
  content+/_index/route.tsx                     /content                    Content listing
  content+/new/route.tsx                        /content/new                Create content
  content+/$slug/route.tsx                      /content/:slug              View + publish/unpublish
  content+/$slug_.edit/route.tsx                /content/:slug/edit         Edit (WYSIWYG + whiteboards panel)
  content+/$slug_.history/route.tsx             /content/:slug/history      Git history with diff viewer
  content+/$slug_.delete/route.tsx              /content/:slug/delete       Delete (action only)
  content+/$slug_.whiteboards/route.tsx         /content/:slug/whiteboards  List whiteboards for page
  content+/$slug_.whiteboards_.new/route.tsx    /content/:slug/whiteboards/new  Create whiteboard form
  content+/$slug_.whiteboards_.$wb/route.tsx    /content/:slug/whiteboards/:wb  Edit whiteboard (Excalidraw)

  api+/health/route.tsx                         /api/health                 Health check
  api+/content/route.tsx                        /api/content                JSON list (published only)
  api+/content.$slug/route.tsx                  /api/content/:slug          JSON single (published only)
  api+/content.$slug.version.$sha/route.tsx     /api/content/:slug/version/:sha  Version content + diff
  api+/preview/route.tsx                        /api/preview                Live markdown render (POST)
  api+/assets/route.tsx                         /api/assets                 List all uploaded assets
  api+/assets.$filename/route.tsx               /api/assets/:filename       Serve an asset (supports ?ref=)
  api+/assets.upload/route.tsx                  /api/assets/upload          Upload new asset (POST)

  embed+/$slug/route.tsx                        /embed/:slug                Embeddable HTML page
  embed+/$slug[.js]/route.tsx                   /embed/:slug.js             JS embed widget
```

## Tech Stack

- [React Router 7](https://reactrouter.com/) (framework mode, SSR)
- [remix-flat-routes](https://github.com/kiliman/remix-flat-routes) (directory+ routing)
- [Octokit](https://github.com/octokit/octokit.js) (GitHub API client)
- [TipTap](https://tiptap.dev/) + ProseMirror (WYSIWYG markdown editor)
- [Excalidraw](https://excalidraw.com/) (embedded whiteboard editor)
- [unified](https://unifiedjs.com/) / remark / rehype (Markdown to HTML pipeline)
- [gray-matter](https://github.com/jonschlinkert/gray-matter) (frontmatter parsing)
- [turndown](https://github.com/mixmark-io/turndown) (HTML to markdown serialization)
- [diff](https://github.com/kpdecker/jsdiff) (version diffing)
- [Tailwind CSS 4](https://tailwindcss.com/)
- TypeScript
