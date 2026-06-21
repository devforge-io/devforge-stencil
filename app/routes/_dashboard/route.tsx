import { Link, Outlet, useLocation, useNavigation } from "react-router";
import { requireAuth } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const { username } = await requireAuth(request);
  return { username };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { username } = loaderData;
  const location = useLocation();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const navItems = [
    { to: "/content", label: "Content", exact: true },
    { to: "/content/new", label: "New", exact: true },
    { to: "/components", label: "Components", exact: false },
    { to: "/content/settings", label: "Settings", exact: true },
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
        <Outlet />
      </main>
    </div>
  );
}
