import { Link } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const loggedIn = await isAuthenticated(request);
  return { loggedIn };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { loggedIn } = loaderData;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Stencil</h1>
          <nav className="flex gap-4">
            {loggedIn ? (
              <>
                <Link
                  to="/content"
                  className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
                >
                  Dashboard
                </Link>
                <Link
                  to="/logout"
                  className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 text-sm"
                >
                  Logout
                </Link>
              </>
            ) : (
              <Link
                to="/login"
                className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
              >
                Login
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl text-center">
          <h2 className="text-5xl font-bold tracking-tight mb-6">
            Git-backed CMS
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8 leading-relaxed">
            Stencil is a headless CMS that stores content as Markdown in your
            GitHub repository. Edit, preview, and publish with full version
            history.
          </p>
          <div className="flex gap-4 justify-center">
            <Link
              to={loggedIn ? "/content" : "/login"}
              className="px-6 py-3 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors font-medium"
            >
              Get Started
            </Link>
            <a
              href="/api/health"
              className="px-6 py-3 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors font-medium"
            >
              API Status
            </a>
          </div>
        </div>
      </main>

      <footer className="border-t border-gray-200 dark:border-gray-800 py-6 text-center text-sm text-gray-500">
        Stencil CMS &mdash; Content lives in Git
      </footer>
    </div>
  );
}
