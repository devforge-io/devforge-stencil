import { Link, Outlet, useLocation, useNavigation } from "react-router";
import { requireAuth } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const { username, role, avatarUrl } = await requireAuth(request);
  return { username, role, avatarUrl };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { username, role, avatarUrl } = loaderData;
  const location = useLocation();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const navItems = [
    { to: "/content", label: "Content", exact: true },
    { to: "/components", label: "Components", exact: false },
    { to: "/files", label: "Files", exact: false },
    { to: "/content/new", label: "New", exact: true },
    // Settings is admin-only (matches the server-side guard).
    ...(role === "admin"
      ? [{ to: "/content/settings", label: "Settings", exact: true }]
      : []),
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-6">
            {/* Full-page nav (not client-side): "/" may be a server-rendered
                page assigned to the root path, served by the index route's
                middleware — a client navigation would show the fallback. */}
            <a href="/" className="text-lg font-bold tracking-tight">
              Stencil
            </a>
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
            {avatarUrl && (
              <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full" />
            )}
            <span className="text-sm text-muted-foreground">{username}</span>
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
              {role}
            </span>
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
        <Outlet />
      </main>
    </div>
  );
}
