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
| `GITHUB_BRANCH` | No | `main` | Branch to read/write content |
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
| `/content/:slug/edit` | Edit the raw markdown + frontmatter |
| `/content/:slug/history` | View git commit history for the file |

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
  _index/route.tsx                    /                  Landing page
  _auth/route.tsx                     (pathless layout)  Auth layout wrapper
  _auth+/login/route.tsx              /login             Login form
  _auth+/logout/route.tsx             /logout            Destroy session
  content+/route.tsx                  /content           Layout (auth required)
  content+/_index/route.tsx           /content            Content listing
  content+/new/route.tsx              /content/new        Create content
  content+/$slug/route.tsx            /content/:slug      View content
  content+/$slug_.edit/route.tsx      /content/:slug/edit Edit content
  content+/$slug_.history/route.tsx   /content/:slug/history  Git history
  content+/$slug_.delete/route.tsx    /content/:slug/delete   Delete (action only)
  api+/health/route.tsx               /api/health         Health check
  api+/content/route.tsx              /api/content         JSON list
  api+/content.$slug/route.tsx        /api/content/:slug   JSON single
  embed+/$slug/route.tsx              /embed/:slug         Embeddable HTML page
  embed+/$slug[.js]/route.tsx         /embed/:slug.js      JS embed widget
```

## Tech Stack

- [React Router 7](https://reactrouter.com/) (framework mode, SSR)
- [remix-flat-routes](https://github.com/kiliman/remix-flat-routes) (directory+ routing)
- [Octokit](https://github.com/octokit/octokit.js) (GitHub API client)
- [unified](https://unifiedjs.com/) / remark / rehype (Markdown to HTML pipeline)
- [gray-matter](https://github.com/jonschlinkert/gray-matter) (frontmatter parsing)
- [Tailwind CSS 4](https://tailwindcss.com/)
- TypeScript
