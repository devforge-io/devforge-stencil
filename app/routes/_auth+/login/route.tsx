import { redirect, useSearchParams } from "react-router";
import { isAuthenticated } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import type { Route } from "./+types/route";

export async function loader({ request }: Route.LoaderArgs) {
  if (await isAuthenticated(request)) throw redirect("/content");
  return null;
}

const ERRORS: Record<string, string> = {
  access: "That GitHub account doesn't have write access to the content repository.",
  oauth: "GitHub sign-in failed. Please try again.",
  state: "Your sign-in session expired. Please try again.",
};

export default function Login() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const message = error ? ERRORS[error] ?? "Sign-in failed. Please try again." : null;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Sign in to Stencil</CardTitle>
        <CardDescription>
          Sign in with GitHub. Your role (Admin, Moderator, or Editor) is based on
          your access to the content repository.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {message && <p className="text-sm text-destructive">{message}</p>}
        <Button
          className="w-full gap-2"
          // Full-page navigation (the route redirects to github.com), not a client Link.
          render={<a href="/auth/github" />}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Continue with GitHub
        </Button>
      </CardContent>
    </Card>
  );
}
