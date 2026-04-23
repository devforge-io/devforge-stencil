import { Form, redirect, useNavigation } from "react-router";
import { validateToken } from "~/lib/github.server";
import { getSession, commitSession } from "~/lib/auth.server";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import type { Route } from "./+types/route";

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const token = formData.get("token") as string;

  if (!token) {
    return { error: "GitHub token is required" };
  }

  const username = await validateToken(token);
  if (!username) {
    return { error: "Invalid GitHub token" };
  }

  const session = await getSession(request);
  session.set("username", username);
  session.set("token", token);

  return redirect("/content", {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Sign in with GitHub</CardTitle>
        <CardDescription>
          Enter a GitHub Personal Access Token with{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">repo</code>{" "}
          scope to manage your content repository.
        </CardDescription>
      </CardHeader>
      <Form method="post">
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="token">Personal Access Token</Label>
            <Input
              id="token"
              name="token"
              type="password"
              required
              placeholder="ghp_..."
            />
          </div>

          {actionData?.error && (
            <p className="text-sm text-destructive">{actionData.error}</p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Validating..." : "Sign In"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            The token is stored in an encrypted session cookie.
            Repository settings are configured via environment variables.
          </p>
        </CardFooter>
      </Form>
    </Card>
  );
}
