import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { runWithRequestToken } from "./lib/request-token.server";
import { resolveRequestToken } from "./lib/session-token.server";
import "./app.css";

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

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Stencil CMS</title>
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
