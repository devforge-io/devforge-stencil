import { Link, Outlet, useLocation, useNavigation } from "react-router";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const { username } = await requireAuth(request);
  return { username };
}

export default function ContentLayout({ loaderData }: Route.ComponentProps) {
  const { username } = loaderData;
  const location = useLocation();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-bold tracking-tight">
              Stencil
            </Link>
            <nav className="flex gap-1">
              <Link
                to="/content"
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  location.pathname === "/content"
                    ? "bg-brand-50 dark:bg-brand-700/20 text-brand-700 dark:text-brand-200"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                }`}
              >
                Content
              </Link>
              <Link
                to="/content/new"
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  location.pathname === "/content/new"
                    ? "bg-brand-50 dark:bg-brand-700/20 text-brand-700 dark:text-brand-200"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                }`}
              >
                New
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {username}
            </span>
            <Link
              to="/logout"
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Logout
            </Link>
          </div>
        </div>
      </header>

      {/* Loading bar */}
      {isLoading && (
        <div className="h-0.5 bg-brand-600 animate-pulse" />
      )}

      <main className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 bg-white/60 dark:bg-gray-950/60 z-10 flex items-start justify-center pt-32">
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-8 py-6 shadow-lg max-w-sm text-center">
              <svg className="animate-spin h-6 w-6 text-brand-600 mx-auto mb-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Loading content</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                Stencil stores content in Git, not a traditional database.
                Fetching version history requires walking the commit tree via
                the GitHub API, which can take a moment.
              </p>
            </div>
          </div>
        )}
        <div className="px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
