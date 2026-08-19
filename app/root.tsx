import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { runWithRequestToken } from "./lib/request-token.server";
import { resolveRequestToken } from "./lib/session-token.server";
import "./app.css";

/**
 * Baseline security headers for every response.
 *
 * Applied here rather than in each route because the public pages are served by
 * resource-route loaders returning raw Responses, which never pass through an
 * entry.server handler. `set` is used only when a route has not already spoken
 * for the header, so a route can still opt out.
 *
 * Framing is the exception: /embed/* is deliberately iframe-embeddable, so it
 * must not be sent frame-ancestors 'none' or the embeds break.
 */
function applySecurityHeaders(request: Request, response: Response): void {
  const h = response.headers;
  const setIfAbsent = (key: string, value: string) => {
    if (!h.has(key)) h.set(key, value);
  };

  setIfAbsent("X-Content-Type-Options", "nosniff");
  setIfAbsent("Referrer-Policy", "strict-origin-when-cross-origin");
  setIfAbsent("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  setIfAbsent("Cross-Origin-Opener-Policy", "same-origin");
  setIfAbsent(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );

  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    /* keep the default and stay conservative */
  }
  const embeddable = pathname.startsWith("/embed");
  if (!embeddable) {
    setIfAbsent("X-Frame-Options", "DENY");
    // The pages inline their own <style>/<script> and load the Tailwind CDN, so a
    // strict script-src would break them. frame-ancestors is the part that has to
    // be a header (a <meta> CSP cannot express it) and is the clickjacking control.
    setIfAbsent("Content-Security-Policy", "frame-ancestors 'none'");
  }
}

/**
 * Resolve the GitHub token for every request (service token, else the signed-in
 * user's) and expose it via AsyncLocalStorage for git operations. Server-only —
 * stripped from the client bundle like loaders/actions.
 */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => {
    const { token, setCookie } = await resolveRequestToken(request);
    return runWithRequestToken(token, async () => {
      const response = await next();
      if (setCookie) response.headers.append("Set-Cookie", setCookie);
      applySecurityHeaders(request, response);
      return response;
    });
  },
];

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export async function loader() {
  const { getSettings } = await import("./lib/settings.server");
  try {
    const { settings } = await getSettings();
    return { favicon: typeof settings.favicon === "string" ? settings.favicon : null };
  } catch {
    return { favicon: null };
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const favicon = data?.favicon;
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Stencil CMS</title>
        {favicon && <link rel="icon" href={favicon} />}
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-gray-300 dark:text-gray-700">
          {message}
        </h1>
        <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
          {details}
        </p>
        {stack && (
          <pre className="mt-8 max-w-2xl mx-auto p-4 bg-gray-100 dark:bg-gray-900 rounded-lg overflow-x-auto text-left text-sm">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
