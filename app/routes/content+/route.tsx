import { Link, Outlet, useLocation, useNavigation } from "react-router";
import { requireAuth } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";
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

  const navItems = [
    { to: "/content", label: "Content", exact: true },
    { to: "/content/new", label: "New", exact: true },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-bold tracking-tight">
              Stencil
            </Link>
            <Separator orientation="vertical" className="h-6" />
            <nav className="flex gap-1">
              {navItems.map((item) => {
                const active = item.exact
                  ? location.pathname === item.to
                  : location.pathname.startsWith(item.to);
                return (
                  <Button
                    key={item.to}
                    variant={active ? "secondary" : "ghost"}
                    size="sm"
                    render={<Link to={item.to} />}
                  >
                    {item.label}
                  </Button>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{username}</span>
            <Button variant="ghost" size="sm" render={<Link to="/logout" />}>
              Logout
            </Button>
          </div>
        </div>
      </header>

      {isLoading && (
        <div className="h-0.5 bg-primary animate-pulse" />
      )}

      <main className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 bg-background/60 z-10 flex items-start justify-center pt-32">
            <Card className="max-w-sm text-center">
              <CardContent className="pt-6">
                <svg
                  className="animate-spin h-6 w-6 text-primary mx-auto mb-3"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <p className="text-sm font-medium mb-1">Loading content</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Stencil stores content in Git, not a traditional database.
                  Fetching version history requires walking the commit tree via
                  the GitHub API, which can take a moment.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
        <div className="px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
