import { Link } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import {
  LayoutGrid,
  GitBranch,
  Rocket,
  Boxes,
  Workflow,
  Newspaper,
  Link2,
  ArrowLeft,
} from "lucide-react";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const loggedIn = await isAuthenticated(request);
  return { loggedIn };
}

const ACCENT = "#d946ef"; // fuchsia — Stencil's accent

type Step = { text: string; code?: string };
type Section = {
  id: string;
  num: string;
  kicker: string;
  title: string;
  accent: string;
  icon: typeof GitBranch;
  intro: string;
  steps: Step[];
  note?: string;
};

const SECTIONS: Section[] = [
  {
    id: "git",
    num: "01",
    kicker: "SETUP",
    title: "Set up GitHub",
    accent: "#2dd4bf",
    icon: GitBranch,
    intro:
      "Stencil stores everything as files in a GitHub repository — there's no database. You need a content repo, an OAuth App so people can sign in, and (optionally) a token.",
    steps: [
      {
        text: "Create a GitHub repository for your content and make at least one commit (e.g. add a README) — an empty repo has no default branch. Note the owner and name for `GITHUB_OWNER` and `GITHUB_REPO`.",
      },
      {
        text: "Create an OAuth App for sign-in: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. Set the Authorization callback URL to `<your-site-origin>/auth/github/callback`. Copy the Client ID and generate a client secret.",
        code: "GITHUB_OAUTH_CLIENT_ID=<client id>\nGITHUB_OAUTH_CLIENT_SECRET=<client secret>",
      },
      {
        text: "Roles are derived from each signer's permission on the repo: admin → Admin, maintain → Moderator, write → Editor. Anything below write can't sign in.",
      },
      {
        text: "Optional: create a fine-grained token (Developer settings → Personal access tokens → Fine-grained) scoped to the content repo with Contents = Read and write and Metadata = Read. Required if the repo is private and you want anonymous visitors to see the published site; otherwise commits are attributed to whoever is signed in.",
        code: "GITHUB_TOKEN=github_pat_...   # optional",
      },
      {
        text: "Copy `.env.example` to `.env`, fill in the values above, and set a random `SESSION_SECRET`. Then install and run.",
        code: "cp .env.example .env\nnpm install\nnpm run dev",
      },
    ],
    note: "Open the app, click Sign in, and authorize with GitHub. You're now in the CMS.",
  },
  {
    id: "vercel",
    num: "02",
    kicker: "DEPLOY",
    title: "Deploy to Vercel",
    accent: "#818cf8",
    icon: Rocket,
    intro:
      "Deploy the Stencil app (this project) to Vercel. Your content lives in the separate GitHub content repo you set up above.",
    steps: [
      { text: "Push this project to its own GitHub repository (separate from your content repo)." },
      {
        text: "In Vercel: New Project → import that repo. The React Router build is detected automatically, and Node 22 is used (pinned in `package.json`).",
      },
      {
        text: "Add the same environment variables from your `.env` under Project → Settings → Environment Variables: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, plus optional `GITHUB_TOKEN` and `API_TOKEN`.",
      },
      {
        text: "Point your OAuth App's callback URL at production: `https://<your-domain>/auth/github/callback`. An OAuth App allows one callback URL — use a separate app (or a GitHub App) for dev vs prod.",
      },
      {
        text: "Deploy. Public pages are edge-cached (`s-maxage`), and the `/content` admin routes are already `no-store`.",
      },
    ],
  },
  {
    id: "pages",
    num: "03",
    kicker: "BUILD",
    title: "Create a page",
    accent: "#d946ef",
    icon: LayoutGrid,
    intro:
      "Pages are built with the drag-and-drop visual builder and output clean, self-hosted HTML.",
    steps: [
      { text: "Go to `/content` → New Post → choose Page (Visual Builder). Give it a title." },
      {
        text: "Drag blocks from the palette (Layout, Basic, Components, Articles) onto the canvas. Select any element to edit its Tailwind classes, inline styles, and attributes in the Properties panel; reorder in the Layers tree.",
      },
      {
        text: "Site-wide background and typography come from `/content/settings` (body classes) and apply to every page.",
      },
      { text: "Save (commits to the draft branch), then Publish when it's ready." },
    ],
  },
  {
    id: "url",
    num: "04",
    kicker: "BUILD",
    title: "Assign a page to a URL (and override /)",
    accent: "#06b6d4",
    icon: Link2,
    intro:
      "Any page can be served at a custom public path once published — including the site root.",
    steps: [
      {
        text: "In the page editor, open Page settings and set the URL Path field, e.g. `/about`. It serves publicly at that path once published.",
      },
      {
        text: "To make a page your home page, set the URL Path to `/`. The published page assigned to `/` overrides the default landing page.",
      },
      {
        text: "Publish, then open the path in a signed-out browser to confirm it's public. Reserved prefixes (`/content`, `/api`, `/articles`, `/embed`, `/login`, …) can't be used as a page path.",
      },
    ],
  },
  {
    id: "component",
    num: "05",
    kicker: "BUILD",
    title: "Create a reusable component",
    accent: "#a78bfa",
    icon: Boxes,
    intro:
      "Build a fragment once — a nav, a footer, a call-to-action — and drop it into any page. Edits propagate to every page that uses it.",
    steps: [
      {
        text: "Go to `/components` → + New. Enter a Name and Slug, pick a Category, and leave Type as Static. Create.",
      },
      { text: "You land in the component editor — build it with the same drag-and-drop blocks." },
      {
        text: "In any Page, open the blocks palette → Components category → drag your component in. Update the component later and every page picks up the change.",
      },
    ],
  },
  {
    id: "conditional",
    num: "06",
    kicker: "BUILD",
    title: "Create a conditional component",
    accent: "#818cf8",
    icon: Workflow,
    intro:
      "A conditional component renders a different branch per visitor, evaluated on the server at request time.",
    steps: [
      {
        text: "Go to `/components` → + New and set Type to “Conditional — show a branch based on rules”. Create.",
      },
      {
        text: "In the flow editor, add branches. Each condition is built from signals: `auth` (logged in, username, roles), `query.<param>`, `data.<key>` (page frontmatter), `device`, `time.*`, `geo.*`, and a stable `ab.*` bucket. Assign a target component to each branch, plus a default fallback.",
      },
      { text: "Use the test-signals preview to see which branch wins, then Save." },
      {
        text: "Drop the conditional component into a page from the Components palette. Pages that use conditionals are served uncached (`private, no-store`) so per-visitor markup is never shared.",
      },
    ],
  },
  {
    id: "article-template",
    num: "07",
    kicker: "BUILD",
    title: "Create an article template",
    accent: "#06b6d4",
    icon: Newspaper,
    intro:
      "Articles (served at /articles/<slug>) render inside a Page you designate as their layout, so every article shares your header, footer, and styling.",
    steps: [
      {
        text: "Create a Page for the layout (as in step 03) — add your nav, footer, sidebars, and any surrounding chrome.",
      },
      {
        text: "From the palette's Articles category, drag in the Article Content block where the article's header image + body should appear. Publish the page.",
      },
      {
        text: "Go to `/content/settings` → Article Template → select that page. Every article now renders inside it. Pick “Default layout (no template)” to revert to the plain centered layout.",
      },
    ],
    note: "Create an article itself via /content → New Post → Article (a header image is required).",
  },
];

function renderInline(text: string) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-white/10 px-1 py-0.5 text-[0.85em] text-fuchsia-300">
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function Guide({ loaderData }: Route.ComponentProps) {
  const { loggedIn } = loaderData;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04000e] text-white font-mono selection:bg-fuchsia-500/30">
      {/* Ambient grid + orb */}
      <div className="pointer-events-none fixed inset-0 [background-image:linear-gradient(rgba(217,70,239,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(217,70,239,0.02)_1px,transparent_1px)] [background-size:64px_64px]" />
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute top-[-10rem] right-1/3 h-[30rem] w-[30rem] rounded-full [filter:blur(150px)] [background:radial-gradient(circle,rgba(217,70,239,0.08)_0%,transparent_70%)]" />
      </div>

      {/* Nav */}
      <header className="relative z-10 border-b border-fuchsia-500/15">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ border: `1px solid ${ACCENT}45`, boxShadow: `0 0 18px ${ACCENT}25`, background: "rgba(0,0,0,0.4)" }}
            >
              <LayoutGrid size={16} style={{ color: ACCENT, filter: `drop-shadow(0 0 6px ${ACCENT})` }} />
            </span>
            <span className="text-lg font-bold tracking-tight" style={{ textShadow: `0 0 22px ${ACCENT}55` }}>
              Stencil
            </span>
          </Link>
          <nav className="flex items-center gap-1.5">
            <Link to="/" className="rounded-lg px-3 py-1.5 text-sm text-white/60 transition-colors hover:text-white">
              <span className="inline-flex items-center gap-1"><ArrowLeft size={13} /> Home</span>
            </Link>
            <Link
              to={loggedIn ? "/content" : "/login"}
              className="rounded-lg px-3 py-1.5 text-sm"
              style={{ color: ACCENT, border: `1px solid ${ACCENT}45`, boxShadow: `0 0 18px ${ACCENT}20` }}
            >
              {loggedIn ? "Dashboard" : "Sign in"}
            </Link>
          </nav>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl px-5">
        {/* Title */}
        <div className="pt-14 pb-8">
          <div className="mb-4 flex items-center gap-3">
            <span className="h-px w-5 flex-shrink-0" style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
            <span className="text-xs tracking-[0.3em]" style={{ color: `${ACCENT}99` }}>
              PLATFORM GUIDE
            </span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl" style={{ textShadow: `0 0 40px ${ACCENT}30` }}>
            How to use Stencil
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60">
            From connecting a GitHub repo and deploying, to building pages, components, conditional
            logic, and article templates — everything you need to run your site.
          </p>
        </div>

        <div className="grid gap-10 pb-24 lg:grid-cols-[200px_1fr]">
          {/* Section nav */}
          <aside className="hidden lg:block">
            <nav className="sticky top-8 space-y-1">
              <div className="mb-3 text-[10px] tracking-[0.25em] text-white/30">CONTENTS</div>
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-white/50 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <span className="text-[10px] tabular-nums" style={{ color: `${s.accent}99` }}>{s.num}</span>
                  {s.title}
                </a>
              ))}
            </nav>
          </aside>

          {/* Sections */}
          <div className="space-y-6">
            {SECTIONS.map((s) => (
              <section key={s.id} id={s.id} className="scroll-mt-20">
                <div
                  className="relative rounded-2xl"
                  style={{ padding: "1.5px", background: `linear-gradient(135deg, ${s.accent}55, ${s.accent}0d 55%, ${s.accent}40)` }}
                >
                  <div className="relative rounded-[14px] bg-[#08020f] p-6 sm:p-8">
                    <div
                      className="absolute inset-x-0 top-0 h-px"
                      style={{ background: `linear-gradient(90deg, transparent, ${s.accent}90, transparent)` }}
                    />
                    {/* Header */}
                    <div className="mb-5 flex items-start gap-4">
                      <span
                        className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl"
                        style={{ border: `1px solid ${s.accent}35`, boxShadow: `0 0 20px ${s.accent}20`, background: "rgba(0,0,0,0.5)" }}
                      >
                        <s.icon size={22} style={{ color: s.accent, filter: `drop-shadow(0 0 7px ${s.accent})` }} />
                      </span>
                      <div>
                        <div className="text-[10px] tracking-[0.25em]" style={{ color: `${s.accent}99` }}>
                          {s.num} / {s.kicker}
                        </div>
                        <h2 className="text-xl font-bold" style={{ textShadow: `0 0 18px ${s.accent}40` }}>
                          {s.title}
                        </h2>
                      </div>
                    </div>

                    <p className="mb-6 text-[13px] leading-relaxed text-white/60">{s.intro}</p>

                    {/* Steps */}
                    <ol className="space-y-4">
                      {s.steps.map((step, i) => (
                        <li key={i} className="flex gap-3">
                          <span
                            className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                            style={{ background: `${s.accent}18`, border: `1px solid ${s.accent}40`, color: s.accent }}
                          >
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] leading-relaxed text-white/75">{renderInline(step.text)}</p>
                            {step.code && (
                              <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 text-[12px] leading-relaxed text-fuchsia-200/90">
                                <code>{step.code}</code>
                              </pre>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>

                    {s.note && (
                      <div
                        className="mt-6 flex items-start gap-2 rounded-lg p-3 text-[12px] text-white/60"
                        style={{ background: `${s.accent}0d`, border: `1px solid ${s.accent}22` }}
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: s.accent, boxShadow: `0 0 5px ${s.accent}` }} />
                        {renderInline(s.note)}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      <footer className="relative z-10 border-t border-fuchsia-500/10">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-5 py-5 text-xs text-white/35">
          <span className="h-2 w-2 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
          Stencil — content lives in Git.
        </div>
      </footer>
    </div>
  );
}
