import type { ReactNode } from "react";
import { useState } from "react";
import { Globe, ImageOff } from "lucide-react";
import { twMerge } from "tailwind-merge";
import type { PagePreview } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Remote images                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The app CSP is `img-src 'self' data: blob: ...`, so a remote og:image would be
 * blocked outright. Everything foreign goes through the first-party proxy.
 */
function proxied(url: string): string {
  return `/tools/og-proxy?url=${encodeURIComponent(url)}`;
}

/** Renders a proxied remote image, swapping in `fallback` when it fails to load. */
function RemoteImage({
  src,
  alt,
  className,
  fallback,
}: {
  src: string | null;
  alt: string;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return <>{fallback}</>;

  return (
    <img
      src={proxied(src)}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      onLoad={(event) => {
        // The proxy answers an unusable upstream with a transparent 1x1 GIF,
        // which decodes cleanly and so never fires `onError`. Treat it as a miss
        // so the dashed placeholder - the actual insight - is what people see.
        const img = event.currentTarget;
        if (img.naturalWidth <= 1 && img.naturalHeight <= 1) setFailed(true);
      }}
      className={className}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Clip to `max` characters with a real ellipsis, the way the platform would. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url;
  return parsed.host.replace(/^www\./, "");
}

/** "example.com › blog › a-post" - Google's breadcrumb rendering of the URL. */
function breadcrumbOf(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url;
  const host = parsed.host.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return host;
  const shown = segments.slice(0, 3).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return `${host} › ${shown.join(" › ")}`;
}

/* -------------------------------------------------------------------------- */
/* Shared chrome                                                               */
/* -------------------------------------------------------------------------- */

/** The dashed "this tag is missing" block. The absence is the insight. */
function Missing({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={twMerge(
        "flex items-center justify-center gap-2 rounded-md border border-dashed border-rose-400/70 bg-rose-50 px-3 py-3 text-center font-mono text-[11px] leading-relaxed text-rose-700",
        className,
      )}
    >
      {children}
    </div>
  );
}

function MissingImage({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={twMerge(
        "flex flex-col items-center justify-center gap-2 border border-dashed border-rose-400/70 bg-rose-50 p-4 text-center",
        className,
      )}
    >
      <ImageOff size={18} className="text-rose-400" aria-hidden="true" />
      <span className="font-mono text-[11px] leading-relaxed text-rose-700">{label}</span>
    </div>
  );
}

function Favicon({
  src,
  host,
  size = 18,
  rounded = true,
}: {
  src: string | null;
  host: string;
  size?: number;
  rounded?: boolean;
}) {
  const letter = host.charAt(0).toUpperCase() || "?";

  return (
    <RemoteImage
      src={src}
      alt=""
      className={twMerge(
        "shrink-0 bg-white object-contain",
        rounded ? "rounded-full" : "rounded-[3px]",
      )}
      fallback={
        <span
          className={twMerge(
            "flex shrink-0 items-center justify-center bg-[#dadce0] font-sans text-[10px] font-semibold text-[#5f6368]",
            rounded ? "rounded-full" : "rounded-[3px]",
          )}
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          {letter}
        </span>
      }
    />
  );
}

/** Dark card wrapper that carries the site's visual language around each mock. */
function MockShell({
  eyebrow,
  note,
  children,
}: {
  eyebrow: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-xl print:break-inside-avoid print:border-black/15 print:bg-white print:backdrop-blur-none">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px print:hidden"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(244,63,94,0.5), rgba(129,140,248,0.35), rgba(6,182,212,0.3), transparent)",
        }}
      />
      <h3 className="font-mono text-[11px] tracking-[0.28em] text-[#f5a524]/70 print:text-black/60">
        {eyebrow}
      </h3>
      {note ? (
        <p className="mt-1 text-[11px] leading-relaxed text-white/40 print:text-black/55">{note}</p>
      ) : null}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* PreviewCards                                                                */
/* -------------------------------------------------------------------------- */

export function PreviewCards({ preview, finalUrl }: { preview: PagePreview; finalUrl: string }) {
  const host = hostOf(finalUrl || preview.displayUrl);
  const siteName = preview.siteName ?? host;
  const breadcrumb = breadcrumbOf(finalUrl || preview.displayUrl);

  const socialTitle = preview.ogTitle ?? preview.title;
  const socialDescription = preview.ogDescription ?? preview.description;
  const twitterImage = preview.twitterImage ?? preview.ogImage;
  const card = (preview.twitterCard ?? "").toLowerCase();
  const isLargeCard = card !== "summary";

  return (
    <section aria-labelledby="audit-previews" className="mt-12">
      <div className="font-mono text-[11px] tracking-[0.28em] text-[#f5a524]/70 print:text-black/60">
        SHARE PREVIEW
      </div>
      <h2
        id="audit-previews"
        className="mt-2 font-mono text-xl font-semibold tracking-tight text-white sm:text-2xl print:text-black"
      >
        How this page looks when it&apos;s shared
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55 print:text-black/70">
        Reconstructed from the tags actually served on the page. Anything drawn with a dashed
        outline is a tag the page does not have - that is what the platform will fall back to.
      </p>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <GoogleCard
          preview={preview}
          host={host}
          siteName={siteName}
          breadcrumb={breadcrumb}
          finalUrl={finalUrl}
        />
        <OpenGraphCard
          host={host}
          title={socialTitle}
          description={socialDescription}
          image={preview.ogImage}
        />
        <TwitterCard
          host={host}
          isLargeCard={isLargeCard}
          rawCard={preview.twitterCard}
          title={socialTitle}
          description={socialDescription}
          image={twitterImage}
        />
        <SlackCard
          preview={preview}
          host={host}
          siteName={siteName}
          title={socialTitle}
          description={socialDescription}
          image={preview.ogImage}
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Google SERP                                                              */
/* -------------------------------------------------------------------------- */

function GoogleCard({
  preview,
  host,
  siteName,
  breadcrumb,
  finalUrl,
}: {
  preview: PagePreview;
  host: string;
  siteName: string;
  breadcrumb: string;
  finalUrl: string;
}) {
  const title = preview.title ?? preview.ogTitle;
  const description = preview.description ?? preview.ogDescription;

  return (
    <MockShell
      eyebrow="GOOGLE SEARCH RESULT"
      note={`Titles clip near 60 characters, snippets near 160. Rendered from ${finalUrl ? "the final URL" : "the requested URL"}.`}
    >
      <div className="rounded-xl bg-white p-4 font-sans shadow-[0_10px_30px_rgba(0,0,0,0.35)] print:shadow-none print:ring-1 print:ring-black/10">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[#dadce0] bg-white">
            <Favicon src={preview.favicon} host={host} size={18} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[14px] leading-tight text-[#202124]">{siteName}</div>
            <div className="truncate text-[12px] leading-tight text-[#4d5156]">{breadcrumb}</div>
          </div>
        </div>

        {title ? (
          <div className="mt-2 text-[20px] leading-[1.3] text-[#1a0dab] hover:underline">
            {clip(title, 60)}
          </div>
        ) : (
          <Missing className="mt-2">
            No &lt;title&gt; - Google will invent a headline from the page content
          </Missing>
        )}

        {description ? (
          <p className="mt-1.5 text-[14px] leading-[1.58] text-[#4d5156]">{clip(description, 160)}</p>
        ) : (
          <Missing className="mt-2">
            No meta description - Google will scrape an arbitrary snippet from the body
          </Missing>
        )}
      </div>

      {preview.favicon ? null : (
        <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-amber-300/80 print:text-black/60">
          No favicon found - the result shows a generic globe instead of your mark.
        </p>
      )}
    </MockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Open Graph / Facebook                                                    */
/* -------------------------------------------------------------------------- */

function OpenGraphCard({
  host,
  title,
  description,
  image,
}: {
  host: string;
  title: string | null;
  description: string | null;
  image: string | null;
}) {
  return (
    <MockShell
      eyebrow="OPEN GRAPH · FACEBOOK / LINKEDIN"
      note="The 1.91:1 card most link unfurlers fall back to."
    >
      <div className="overflow-hidden rounded-lg border border-[#dddfe2] bg-white font-sans shadow-[0_10px_30px_rgba(0,0,0,0.35)] print:shadow-none">
        <RemoteImage
          src={image}
          alt=""
          className="aspect-[1.91/1] w-full bg-[#f2f3f5] object-cover"
          fallback={
            <MissingImage
              className="aspect-[1.91/1] w-full border-x-0 border-t-0"
              label="No og:image - platforms will show a bare link"
            />
          }
        />

        <div className="border-t border-[#dddfe2] bg-[#f2f3f5] px-3 py-2.5">
          <div className="truncate font-sans text-[12px] uppercase tracking-wide text-[#606770]">
            {host}
          </div>

          {title ? (
            <div className="mt-0.5 line-clamp-2 text-[16px] font-semibold leading-[1.35] text-[#1d2129]">
              {clip(title, 88)}
            </div>
          ) : (
            <Missing className="mt-1.5">
              No og:title and no &lt;title&gt; - the card will show the raw URL
            </Missing>
          )}

          {description ? (
            <p className="mt-1 line-clamp-2 text-[13px] leading-[1.4] text-[#606770]">
              {clip(description, 140)}
            </p>
          ) : (
            <Missing className="mt-1.5">
              No og:description - the card body will be empty
            </Missing>
          )}
        </div>
      </div>
    </MockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. X / Twitter                                                              */
/* -------------------------------------------------------------------------- */

function TwitterCard({
  host,
  isLargeCard,
  rawCard,
  title,
  description,
  image,
}: {
  host: string;
  isLargeCard: boolean;
  rawCard: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
}) {
  const note = rawCard
    ? `twitter:card = "${rawCard}"`
    : "No twitter:card tag - X falls back to the Open Graph tags and a summary layout.";

  const body = (
    <>
      {title ? (
        <div className="line-clamp-2 text-[15px] font-semibold leading-[1.3] text-[#0f1419]">
          {clip(title, 70)}
        </div>
      ) : (
        <Missing>No title - X will render the bare link</Missing>
      )}
      {description ? (
        <p className="mt-0.5 line-clamp-2 text-[14px] leading-[1.35] text-[#536471]">
          {clip(description, 125)}
        </p>
      ) : (
        <p className="mt-0.5 font-mono text-[11px] text-[#536471]">No description supplied</p>
      )}
      <div className="mt-1 truncate text-[14px] text-[#536471]">{host}</div>
    </>
  );

  return (
    <MockShell eyebrow="X · TWITTER CARD" note={note}>
      <div className="overflow-hidden rounded-2xl border border-[#cfd9de] bg-white font-sans shadow-[0_10px_30px_rgba(0,0,0,0.35)] print:shadow-none">
        {isLargeCard ? (
          <>
            <RemoteImage
              src={image}
              alt=""
              className="aspect-[2/1] w-full bg-[#f7f9f9] object-cover"
              fallback={
                <MissingImage
                  className="aspect-[2/1] w-full border-x-0 border-t-0"
                  label="No twitter:image or og:image - X collapses this to a plain text link"
                />
              }
            />
            <div className="px-3 py-2.5">{body}</div>
          </>
        ) : (
          <div className="flex items-stretch">
            <RemoteImage
              src={image}
              alt=""
              className="aspect-square w-[120px] shrink-0 bg-[#f7f9f9] object-cover sm:w-[140px]"
              fallback={
                <MissingImage
                  className="aspect-square w-[120px] shrink-0 border-y-0 border-l-0 sm:w-[140px]"
                  label="No image for the summary thumbnail"
                />
              }
            />
            <div className="min-w-0 flex-1 border-l border-[#cfd9de] px-3 py-2.5">{body}</div>
          </div>
        )}
      </div>
    </MockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Slack / Discord unfurl                                                   */
/* -------------------------------------------------------------------------- */

function SlackCard({
  preview,
  host,
  siteName,
  title,
  description,
  image,
}: {
  preview: PagePreview;
  host: string;
  siteName: string;
  title: string | null;
  description: string | null;
  image: string | null;
}) {
  return (
    <MockShell
      eyebrow="SLACK · DISCORD UNFURL"
      note="Chat clients quote the same Open Graph tags with a coloured rail."
    >
      <div className="rounded-lg bg-white p-3.5 font-sans shadow-[0_10px_30px_rgba(0,0,0,0.35)] print:shadow-none print:ring-1 print:ring-black/10">
        <div className="border-l-4 border-[#1264a3] pl-3">
          <div className="flex items-center gap-1.5">
            <Favicon src={preview.favicon} host={host} size={16} rounded={false} />
            <span className="truncate text-[13px] font-bold text-[#1d1c1d]">{siteName}</span>
          </div>

          {title ? (
            <div className="mt-1 text-[15px] font-bold leading-snug text-[#1264a3] hover:underline">
              {clip(title, 90)}
            </div>
          ) : (
            <Missing className="mt-1.5">
              No title - Slack posts the naked URL with no context
            </Missing>
          )}

          {description ? (
            <p className="mt-1 text-[13px] leading-[1.45] text-[#1d1c1d]">{clip(description, 180)}</p>
          ) : (
            <Missing className="mt-1.5">
              No description - teammates get a link with nothing to judge it by
            </Missing>
          )}

          <div className="mt-2">
            <RemoteImage
              src={image}
              alt=""
              className="max-h-40 w-full max-w-[360px] rounded-md object-cover"
              fallback={
                <Missing className="max-w-[360px] justify-start text-left">
                  <ImageOff size={14} className="shrink-0 text-rose-400" aria-hidden="true" />
                  No og:image - the unfurl stays text-only
                </Missing>
              }
            />
          </div>
        </div>
      </div>

      <p className="mt-2.5 flex items-center gap-1.5 font-mono text-[11px] text-white/35 print:text-black/55">
        <Globe size={12} aria-hidden="true" />
        {preview.displayUrl}
      </p>
    </MockShell>
  );
}
