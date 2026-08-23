/**
 * /tools/feature-requests: landing page for the feature-requests tool.
 *
 * Signed-in people go straight to their projects; everyone else gets the
 * pitch and the two ways in. Hand-written React route (see website-audit for
 * the reasoning), self-contained like the rest of the tool.
 */

import { redirect, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { Code2, ListChecks, MessageSquarePlus, ThumbsUp } from "lucide-react";
import { getSiteChrome } from "~/lib/site-chrome.server";
import { getFrUser, PROJECTS_PATH } from "~/lib/feature-requests/session.server";
import { anvilConfigured } from "~/lib/feature-requests/anvil.server";
import { Card, Shell, TOOL_PATH, ghostBtn, molten, primaryBtn, primaryBtnStyle } from "~/components/tools/feature-requests/shell";

export function meta() {
  return [
    { title: "Feature requests · collect and prioritise ideas from your users · Devforge" },
    {
      name: "description",
      content:
        "Create a project, drop one script tag on your site, and collect feature requests with a public board and upvotes. Free, powered by Anvil DB.",
    },
    { name: "robots", content: "index, follow" },
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getFrUser(request);
  if (user) throw redirect(PROJECTS_PATH);
  const chrome = await getSiteChrome();
  return { chrome, ready: anvilConfigured() };
}

const SNIPPET = `<script src="https://devforge.io/tools/feature-requests/embed.js"
        data-project="YOUR_PROJECT_ID" async></script>`;

export default function FeatureRequestsLanding() {
  const { chrome, ready } = useLoaderData<typeof loader>();
  return (
    <Shell chrome={chrome} wide>
      <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
        Let your users tell you {molten("what to build next")}.
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/60">
        Create a project, paste one script tag into your site, and you have a feature request box with a public
        board and upvotes. Triage everything from a simple dashboard. No backend to run on your side.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <a href={`${TOOL_PATH}/sign-up`} className={primaryBtn} style={primaryBtnStyle}>
          Create a free account
        </a>
        <a href={`${TOOL_PATH}/sign-in`} className={ghostBtn}>
          Sign in
        </a>
      </div>
      {!ready ? (
        <p className="mt-4 text-sm text-[#ffd98a]">
          The tool is not connected to its database yet. Sign-in and project pages will not work until it is.
        </p>
      ) : null}

      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: MessageSquarePlus,
            title: "One script tag",
            body: "A floating button and form, or an inline board, styled to your accent colour and isolated in a shadow root so it never fights your CSS.",
          },
          {
            icon: ThumbsUp,
            title: "Public board with upvotes",
            body: "Visitors see what others asked for, vote, and you get a ranked list instead of a pile of emails. Turn the board off per project if you prefer a private inbox.",
          },
          {
            icon: ListChecks,
            title: "Triage in a minute",
            body: "Mark requests planned, in progress, done or declined; declined ones leave the board. Restrict submissions to your own domains.",
          },
        ].map((f) => (
          <Card key={f.title}>
            <f.icon size={18} className="text-[#f5a524]" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-white">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{f.body}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-10">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/45">
          <Code2 size={13} aria-hidden="true" />
          The whole integration
        </div>
        <pre className="mt-3 whitespace-pre-wrap break-all rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-[12.5px] leading-relaxed text-white/80">
          {SNIPPET}
        </pre>
        <p className="mt-3 text-sm text-white/50">
          Accounts and data live in{" "}
          <a href="/products/anvil-db" className="text-[#ffd98a] underline-offset-2 hover:underline">
            Anvil DB
          </a>
          , Devforge's graph database. Nothing is sold, scraped or shared.
        </p>
      </Card>
    </Shell>
  );
}
