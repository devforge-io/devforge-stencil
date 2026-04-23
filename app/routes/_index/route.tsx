import { Link } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  const loggedIn = await isAuthenticated(request);
  return { loggedIn };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { loggedIn } = loaderData;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Stencil</h1>
          <nav className="flex gap-2">
            {loggedIn ? (
              <>
                <Button render={<Link to="/content" />}>Dashboard</Button>
                <Button variant="ghost" render={<Link to="/logout" />}>Logout</Button>
              </>
            ) : (
              <Button render={<Link to="/login" />}>Login</Button>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl text-center">
          <h2 className="text-5xl font-bold tracking-tight mb-6">
            Git-backed CMS
          </h2>
          <p className="text-xl text-muted-foreground mb-8 leading-relaxed">
            Stencil is a headless CMS that stores content as Markdown in your
            GitHub repository. Edit, preview, and publish with full version
            history.
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" render={<Link to={loggedIn ? "/content" : "/login"} />}>
              Get Started
            </Button>
            <Button size="lg" variant="outline" render={<a href="/api/health" />}>
              API Status
            </Button>
          </div>
        </div>
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted-foreground">
        Stencil CMS &mdash; Content lives in Git
      </footer>
    </div>
  );
}
