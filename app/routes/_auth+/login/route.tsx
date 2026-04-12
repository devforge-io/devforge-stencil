import { Form, redirect, useNavigation } from "react-router";
import { validateToken } from "~/lib/github.server";
import { getSession, commitSession } from "~/lib/auth.server";
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
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
      <h2 className="text-lg font-semibold mb-4">Sign in with GitHub</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Enter a GitHub Personal Access Token with{" "}
        <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">
          repo
        </code>{" "}
        scope to manage your content repository.
      </p>

      <Form method="post" className="space-y-4">
        <div>
          <label
            htmlFor="token"
            className="block text-sm font-medium mb-1.5"
          >
            Personal Access Token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            required
            placeholder="ghp_..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
        </div>

        {actionData?.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {actionData.error}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full px-4 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-50"
        >
          {isSubmitting ? "Validating..." : "Sign In"}
        </button>
      </Form>

      <p className="mt-4 text-xs text-gray-500 dark:text-gray-500">
        The token is stored in an encrypted session cookie.
        Repository settings are configured via environment variables.
      </p>
    </div>
  );
}
