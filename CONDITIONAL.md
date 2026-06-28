# Conditional Components

A design + phased plan for adding **runtime logic to page-builder components** —
e.g. "if logged in show a profile menu, else show a login button", "if
`query.plan > 5` show the upgrade banner".

The end goal is a new **conditional component**: a logic wrapper that composes
other components and chooses which one to display at render time. The eventual
authoring surface is a drag-drop flow canvas; the underlying data model is small
and is what makes the canvas "just an editor" rather than a rewrite.

---

## Mental model

A conditional component stores a **rule set** instead of fixed HTML:

```
branches: [
  { when: <condition>, show: <target> },   // if
  { when: <condition>, show: <target> },   // else-if
  { else: true,        show: <target> },   // otherwise (optional)
]
```

- It **inherits / composes other components** because each branch's `show` is a
  reference to an existing component (by slug). The conditional just picks one.
- It is itself **a real component** — stored like the others, draggable from the
  palette, droppable into any page.
- The **canvas** (Phase 2) and a **simple branch editor** (Phase 1) produce the
  exact same rule JSON, so Phase 1 is never thrown away.

---

## Data model

### Condition tree (structured, not code — safe + serializable + server-evaluable)

```ts
type Condition =
  | { all: Condition[] }                                  // AND
  | { any: Condition[] }                                  // OR
  | { not: Condition }                                    // negate
  | { signal: string; op: Operator; value?: unknown };    // leaf

type Operator =
  | "is" | "is-not"
  | "gt" | "lt" | "gte" | "lte"
  | "contains" | "matches" | "exists";
```

Example: logged-in AND `plan > 5`

```json
{ "all": [
  { "signal": "auth.loggedIn", "op": "is",  "value": true },
  { "signal": "query.plan",    "op": "gt",  "value": 5 }
] }
```

### Branch + rule set

```ts
interface Branch {
  id: string;
  condition?: Condition;     // omitted on the `else` branch
  else?: boolean;
  show: BranchTarget;
}

type BranchTarget =
  | { kind: "component"; slug: string }   // inherit/compose an existing component
  | { kind: "inline"; html: string; css?: string }; // future: inline subtree

interface ConditionalSpec {
  branches: Branch[];        // evaluated top-to-bottom; first match wins
  fallback?: "none" | "empty"; // what to render if nothing matches and no else
}
```

### Signal registry (the variables a condition can reference)

A small, explicit registry that grows over time. Each signal resolves from the
request **context** at render time. Starting set:

| Signal            | Source                                  | Notes |
|-------------------|-----------------------------------------|-------|
| `auth.loggedIn`   | `__stencil_session` cookie (admin today)| Becomes visitor-aware if/when visitor auth exists |
| `auth.username`   | session                                 | |
| `query.<param>`   | URL query string                        | string; coerced for numeric ops |
| `data.<key>`      | page frontmatter / page-scoped data     | author-supplied values |
| `device`          | UA / viewport hint                      | coarse: `mobile` \| `desktop` |

> Conditions are evaluated against a **context object** assembled per request, so
> adding a new signal = adding a resolver, not changing the rule format.

---

## Rendering (server-side evaluation)

Chosen direction: **server-side, at render time.**

- A conditional component drops a placeholder into the page HTML, e.g.
  `<div data-pb-conditional="<slug>"></div>`.
- At serve time, `renderPublicPageResponse` (`app/lib/public-page.server.ts`)
  builds a **context** from the `request` (available via the splat loader
  `app/routes/$/route.tsx` and the `/` middleware `app/routes/_index/route.tsx`),
  finds each `data-pb-conditional` placeholder with **`jsdom`** (already a
  dependency), evaluates the rule set, and replaces the placeholder with the
  chosen branch component's HTML (+ merges its CSS).
- **Caching:** pages containing a conditional opt out of `Cache-Control: public`
  (serve `private, no-store` or vary); non-conditional pages stay cached as today.
- **Security:** hidden branches are **never sent** to the client — a logged-out
  visitor never receives the profile-menu markup. (This is the main reason for
  server-side over client-side toggling.)

Why not client-side: it would keep pages cacheable but leaks all variant markup
into page source and causes a flash of wrong content. Revisit only if a CDN-cache
requirement forces it.

---

## How it fits the current architecture

| Concern | Today | Change needed |
|---|---|---|
| Node attributes | `PBNode.attributes` is free-form; serializer preserves all (`app/lib/page-builder/types.ts`, `serializer.ts`) | none — placeholder is just an attribute |
| Component storage | `ComponentData { html, css, projectData, sha }` (`app/lib/component.server.ts`); listed via `/api/components` | add a `type: "static" \| "conditional"` + `spec` (the rule set) |
| Palette | custom components loaded in `app/components/page-editor-v2.tsx` | conditional components appear as draggable blocks too |
| Serve | `renderPublicPageResponse` static HTML | add context build + placeholder resolution pass |
| Auth | `__stencil_session`, admin-only (`app/lib/auth.server.ts`) | `auth.*` signals read it; visitor auth is a separate future track |

---

## Phases

### Phase 1 — Engine + simple branch editor (MVP)

Goal: conditional components are real and usable end-to-end. "If logged in show
A, else show B" works when published.

- [x] **Types** — `Condition`, `Operator`, `Branch`, `ConditionalSpec` in a shared
      module (`app/lib/conditional/types.ts`).
- [x] **Evaluator** — pure `evaluate(condition, context): boolean` + tests
      (`app/lib/conditional/evaluate.ts`, `evaluate.test.ts`). No `eval`; structured
      ops only; coercion fails closed on NaN/invalid regex.
- [x] **Signal/context builder** — `buildContext(request, page)`
      (`app/lib/conditional/context.server.ts`) resolving the starting signal set
      (`auth`, `query`, `data`, `device`).
- [x] **Component type** — `ComponentData` extended with `type` + `spec`
      (`app/lib/component.server.ts`); conditional components stored/served via
      existing component storage; placeholder body is auto-generated and excluded
      from propagation/sync.
- [x] **Render pass** — `resolveConditionals` (`app/lib/conditional/resolve.server.ts`)
      called from `renderPublicPageResponse`; resolves `data-pb-conditional`
      placeholders with `jsdom`; `request` threaded through the splat loader and
      `/` middleware; chosen component CSS merged.
- [x] **Caching** — conditional pages served `private, no-store` (others stay
      `public` + SWR).
- [x] **Authoring UI** — branch editor (if / else-if / otherwise rows): per branch a
      condition builder (signal → operator → value, with AND/ANY groups) and a
      component picker, in the properties-panel style
      (`app/lib/page-builder/properties-panel.tsx` → `ConditionalEditor`).
- [x] **Palette** — conditional components draggable into pages like custom ones
      (`app/components/page-editor-v2.tsx`); created via the components dashboard
      type selector.
- [x] **Verify** — verified via automated integration tests
      (`resolve.server.test.ts`): correct branch renders for logged-in vs anonymous
      and hidden branch markup/CSS is absent from output. (A live publish needs
      GitHub credentials + running server.)

### Phase 2 — Flow canvas

Goal: the drag-drop node graph. Pure editor upgrade over the **same** `spec`.

- [x] Node-graph editor (React Flow): condition nodes wired to component nodes;
      branch ordering via the graph — drag a condition node up/down to change
      precedence (`app/lib/page-builder/conditional-flow.tsx`). Lazy-loaded
      client-only. **Opening a conditional component (`/components/<slug>`) loads
      straight into this flow editor** (a conditional has no markup of its own, so
      it skips the page-builder canvas — `components+/$slug/route.tsx` dispatches
      on `type`). The "⤢ Open flow editor" button in `ConditionalEditor` still
      opens it as a modal when a conditional placeholder is selected on a page.
- [x] Bidirectional mapping between the graph and `ConditionalSpec` via the shared
      `EditBranch[]` model (`app/lib/page-builder/conditional-model.ts` →
      `specToBranches`/`branchesToSpec`), so the simple list editor and the flow
      canvas read/write the same data with no loss when switching.
- [x] Live preview: a sample-context panel (auth / query / data / device) that
      highlights the active branch + path in green using the pure evaluator
      (`activeBranchId` + `sampleToContext`).
- [x] Nested conditionals: a branch target may be another conditional; the render
      pass resolves them recursively with a cycle/depth guard
      (`resolve.server.ts`), and conditionals are selectable as targets in the
      editor (marked "(conditional)").
- [x] Authoring enhancements: a draggable palette of pre-filled condition
      templates ("Logged in", "On mobile", "A/B group A", …) that drop onto the
      canvas — drop height sets precedence — and an outcome that can be **designed
      visually** in an embedded page-builder (`component-designer.tsx`), not just
      picked, with a one-click "Save as reusable component".

### Phase 3 — Richer signals (optional / as needed)

- [x] Visitor auth track (real end-user accounts) → `auth.*` is visitor-aware.
      `app/lib/visitor.server.ts` (signed `__stencil_visitor` cookie, scrypt
      password hashing, GitHub-backed per-user store) + `/api/visitor`,
      `/api/visitor/register|login|logout`. `buildContext` resolves `auth.*`
      (loggedIn, username, id, roles, attributes) from the visitor session,
      falling back to the CMS-admin session.
- [x] Time windows, A/B buckets, geo, user attributes — pure resolvers in
      `app/lib/conditional/signals.ts` (`time.*` UTC, `geo.*` from CDN headers,
      `ab.bucket`/`ab.group` from a stable seed) wired into `buildContext`;
      user attributes via `auth.attributes.*` and `auth.roles`. New rule format
      not required — just new resolvers + signal suggestions.
- [x] Inline (non-component) branch targets authored in the page builder — the
      `TargetEditor` (`app/lib/page-builder/target-editor.tsx`) lets a branch
      render either a selected component or an inline subtree, which can be built
      with the full visual page-builder via the embedded **component designer**
      (`component-designer.tsx`) or hand-edited as raw HTML/CSS. The render pass
      already emits inline targets. A branch that points at an **existing reusable
      component** can also be **edited in place** from its outcome node — the
      designer opens on that component and writes back through the components API
      (now incl. `projectData`, so cross-page propagation keeps working); a warning
      notes the edit applies everywhere the component is used.

---

## Open questions / decisions

- **Signal set for v1** — proposed: `auth` + `query` + `data` (+ coarse `device`).
  Confirm.
- **Eval location** — server-side (recommended). Confirm no hard CDN-cache need
  that would force client-side.
- **`data.*` source** — page frontmatter only, or a separate page-scoped data bag?
- **Value typing** — `query.*` is string; numeric ops coerce. Decide coercion
  rules (e.g. `gt` parses numbers, fails closed on NaN).
- **No-match behavior** — render nothing vs an explicit `else`. Default: nothing.
- **Visitor auth** — ✅ delivered in Phase 3 (`visitor.server.ts`). `auth.*`
  resolves the `__stencil_visitor` session first and falls back to the CMS-admin
  session, so the original "login/profile" example keeps working.

---

## Status

**Phases 1, 2 & 3 complete.** Engine, server-side render pass (incl. nested
conditionals), caching, the simple branch editor, the React Flow drag-drop flow
canvas with live preview, the visitor auth track, richer signals
(`auth.*`/`time.*`/`geo.*`/`ab.*`/`auth.attributes.*`), and inline branch
targets are all implemented and unit/integration tested (`npm test`). Every
addition layered on top of the same `ConditionalSpec` data model — the rule
format never changed, only resolvers and editors.
