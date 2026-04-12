import { Link, Outlet, useLocation } from "react-router";
import { requireAuth } from "~/lib/auth.server";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const { username } = await requireAuth(request);
  return { username };
}

export default function ContentLayout({ loaderData }: Route.ComponentProps) {
  const { username } = loaderData;
  const location = useLocation();

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

      <main className="flex-1">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
