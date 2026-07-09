import { Link } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import { getPublishedContentByPath } from "~/lib/content.server";
import { renderPublicPageResponse } from "~/lib/public-page.server";
import {
  LayoutGrid,
  Workflow,
  GitBranch,
  PenLine,
  Newspaper,
  Code2,
  ChevronRight,
} from "lucide-react";
import type { Route } from "./+types/route";

// If a published page is assigned the root path "/", serve it here and
// short-circuit the default home below. Guarded to document requests for "/"
// so client-side data requests (".data") fall through untouched.
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => {
    if (new URL(request.url).pathname === "/") {
      const page = await getPublishedContentByPath("/");
      if (page) return renderPublicPageResponse(page, request);
    }
    return next();
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const loggedIn = await isAuthenticated(request);
  return { loggedIn };
}

const ACCENT = "#d946ef"; // fuchsia — Stencil's accent

const FEATURES = [
  {
    icon: LayoutGrid,
    name: "Visual Page Builder",
    accent: "#d946ef",
    desc: "A drag-and-drop visual builder — blocks palette, layers tree, live Tailwind class/style editing — that outputs clean, self-hosted HTML.",
  },
  {
    icon: Workflow,
    name: "Conditional Components",
    accent: "#818cf8",
    desc: "Render a different branch per visitor — by auth, geo, time, device, query, A/B bucket, or page data — resolved server-side, edited in a flow diagram.",
  },
  {
    icon: GitBranch,
    name: "Git-Backed, No Database",
    accent: "#2dd4bf",
    desc: "Content lives as files in a GitHub repo. Every save is a real commit, with a draft → publish workflow, full history, and side-by-side diffs.",
  },
  {
    icon: PenLine,
    name: "Rich WYSIWYG Editor",
    accent: "#a78bfa",
    desc: "A TipTap editor for Markdown and articles — raw toggle, syntax-highlighted code, tables, image align/resize, and Excalidraw whiteboards.",
  },
  {
    icon: Newspaper,
    name: "Articles & Social",
    accent: "#06b6d4",
    desc: "First-class articles with header + cropped social images, OpenGraph metadata, ready-made listing blocks, and share buttons.",
  },
  {
    icon: Code2,
    name: "Headless API & Embeds",
    accent: "#f43f5e",
    desc: "An edge-cached public site plus a CORS JSON API and template-free iframe embeds — serve or embed your content anywhere.",
  },
];

/** Sci-fi HUD corner brackets (matches the portfolio card treatment). */
function HUDBrackets({ color, size = 12, inset = 10 }: { color: string; size?: number; inset?: number }) {
  const corners: React.CSSProperties[] = [
    { top: 0, left: 0, borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}` },
    { top: 0, right: 0, borderTop: `1px solid ${color}`, borderRight: `1px solid ${color}` },
    { bottom: 0, left: 0, borderBottom: `1px solid ${color}`, borderLeft: `1px solid ${color}` },
    { bottom: 0, right: 0, borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}` },
  ];
  return (
    <div className="pointer-events-none absolute" style={{ inset }}>
      {corners.map((s, i) => (
        <div key={i} className="absolute" style={{ ...s, width: size, height: size }} />
      ))}
    </div>
  );
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { loggedIn } = loaderData;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04000e] text-white font-mono selection:bg-fuchsia-500/30">
      <style>{`
        @keyframes stencil-fade-up { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
        .stencil-fade { animation: stencil-fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both; }
      `}</style>

      {/* Ambient grid */}
      <div className="pointer-events-none fixed inset-0 [background-image:linear-gradient(rgba(217,70,239,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(217,70,239,0.02)_1px,transparent_1px)] [background-size:64px_64px]" />
      {/* Ambient orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute top-[-8rem] right-1/4 h-[28rem] w-[28rem] rounded-full [filter:blur(140px)] [background:radial-gradient(circle,rgba(217,70,239,0.10)_0%,transparent_70%)]" />
        <div className="absolute bottom-[-6rem] left-1/4 h-96 w-96 rounded-full [filter:blur(120px)] [background:radial-gradient(circle,rgba(129,140,248,0.08)_0%,transparent_70%)]" />
      </div>

      {/* Nav */}
      <header className="relative z-10 border-b border-fuchsia-500/15">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ border: `1px solid ${ACCENT}45`, boxShadow: `0 0 18px ${ACCENT}25`, background: "rgba(0,0,0,0.4)" }}
            >
              <LayoutGrid size={16} style={{ color: ACCENT, filter: `drop-shadow(0 0 6px ${ACCENT})` }} />
            </span>
            <span className="text-lg font-bold tracking-tight" style={{ textShadow: `0 0 22px ${ACCENT}55` }}>
              Stencil
            </span>
          </div>
          <nav className="flex items-center gap-1.5">
            {loggedIn ? (
              <>
                <NavLink to="/content">Dashboard</NavLink>
                <NavLink to="/logout" muted>Logout</NavLink>
              </>
            ) : (
              <NavLink to="/login" primary>Sign in</NavLink>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto max-w-6xl px-5">
        <section className="stencil-fade pt-16 pb-10 sm:pt-16 sm:pb-14">
          <div className="mb-4 flex items-center gap-3">
            <span className="h-px w-5 shrink-0" style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
            <span className="text-xs tracking-[0.3em]" style={{ color: `${ACCENT}99` }}>
              GIT-BACKED CMS · VISUAL SITE BUILDER
            </span>
          </div>

          <h1
            className="w-full text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl"
            style={{ textShadow: `0 0 40px ${ACCENT}30` }}
          >
            Author content and design layouts —{" "}
            <span style={{ color: ACCENT }}>stored as files in Git.</span>
          </h1>

          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
            Stencil is a headless CMS with a visual page builder bolted on. Write Markdown,
            articles, and wiki markup, or drag-and-drop pages and reusable per-visitor components —
            all committed to your GitHub repository, versioned, and served or embedded anywhere.
            No database.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <CtaButton to={loggedIn ? "/content" : "/login"} primary>
              {loggedIn ? "Open the dashboard" : "Get started"}
              <ChevronRight size={16} />
            </CtaButton>
            <CtaButton to="/api/health" external>
              API status
            </CtaButton>
          </div>
        </section>

        {/* Feature cards */}
        <section className="pb-20">
          <div className="mb-6 flex items-center gap-3">
            <span className="h-px w-5 shrink-0 bg-indigo-400/70" />
            <span className="text-xs tracking-[0.3em] text-indigo-400/60">WHAT'S INSIDE</span>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div
                key={f.name}
                className="stencil-fade group relative"
                style={{ animationDelay: `${0.08 * i + 0.1}s` }}
              >
                {/* Hover glow halo */}
                <div
                  className="pointer-events-none absolute -inset-2 rounded-3xl opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                  style={{ background: `${f.accent}22` }}
                />
                {/* Gradient border */}
                <div
                  className="relative h-full rounded-2xl"
                  style={{ padding: "1.5px", background: `linear-gradient(135deg, ${f.accent}60, ${f.accent}10 55%, ${f.accent}45)` }}
                >
                  <div className="relative flex h-full flex-col rounded-[14px] bg-[#08020f] p-5 transition-transform duration-300 group-hover:-translate-y-1">
                    <HUDBrackets color={`${f.accent}55`} />
                    {/* Top accent edge */}
                    <div
                      className="absolute inset-x-0 top-0 h-px"
                      style={{ background: `linear-gradient(90deg, transparent, ${f.accent}90, transparent)` }}
                    />
                    <div className="mb-4 flex items-center justify-between">
                      <span
                        className="flex h-11 w-11 items-center justify-center rounded-xl"
                        style={{ border: `1px solid ${f.accent}35`, boxShadow: `0 0 20px ${f.accent}20`, background: "rgba(0,0,0,0.5)" }}
                      >
                        <f.icon size={22} style={{ color: f.accent, filter: `drop-shadow(0 0 7px ${f.accent})` }} />
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: f.accent, boxShadow: `0 0 5px ${f.accent}` }} />
                        <span className="text-[10px]" style={{ color: `${f.accent}80` }}>ACTIVE</span>
                      </span>
                    </div>
                    <h3 className="mb-2 text-base font-bold" style={{ textShadow: `0 0 18px ${f.accent}40` }}>
                      {f.name}
                    </h3>
                    <p className="text-[13px] leading-relaxed text-white/55">{f.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-fuchsia-500/10">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-5 py-5 text-xs text-white/35">
          <span className="h-2 w-2 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }} />
          Stencil — content lives in Git.
        </div>
      </footer>
    </div>
  );
}

function NavLink({ to, children, primary, muted }: { to: string; children: React.ReactNode; primary?: boolean; muted?: boolean }) {
  const base = "rounded-lg px-3 py-1.5 text-sm transition-all duration-200";
  if (primary) {
    return (
      <Link
        to={to}
        className={base}
        style={{ color: ACCENT, border: `1px solid ${ACCENT}45`, boxShadow: `0 0 18px ${ACCENT}20` }}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link to={to} className={`${base} ${muted ? "text-white/45 hover:text-white/70" : "text-white/70 hover:text-white"}`}>
      {children}
    </Link>
  );
}

function CtaButton({ to, children, primary, external }: { to: string; children: React.ReactNode; primary?: boolean; external?: boolean }) {
  const cls = "inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-medium transition-all duration-200";
  const style: React.CSSProperties = primary
    ? { color: "#0a0110", background: ACCENT, boxShadow: `0 0 30px ${ACCENT}40` }
    : { color: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.14)" };
  return external ? (
    <a href={to} className={cls} style={style}>
      {children}
    </a>
  ) : (
    <Link to={to} className={cls} style={style}>
      {children}
    </Link>
  );
}
