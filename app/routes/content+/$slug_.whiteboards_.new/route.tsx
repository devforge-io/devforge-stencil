import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const wbSlug = (formData.get("wbSlug") as string)?.trim();

  if (!wbSlug) {
    return { error: "Name is required" };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wbSlug)) {
    return { error: "Name must be lowercase alphanumeric with hyphens" };
  }

  return redirect(`/content/${params.slug}/whiteboards/${wbSlug}`);
}

export default function NewWhiteboard({
  params,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-6">New Whiteboard</h1>

      <Form method="post" className="space-y-4">
        <div>
          <label htmlFor="wbSlug" className="block text-sm font-medium mb-1.5">
            Name
          </label>
          <input
            id="wbSlug"
            name="wbSlug"
            required
            autoFocus
            placeholder="architecture-diagram"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Saved as{" "}
            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">
              content/whiteboards/{params.slug}/[name].excalidraw
            </code>
          </p>
        </div>

        {actionData?.error && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {actionData.error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {isSubmitting ? "Creating..." : "Create"}
          </button>
        </div>
      </Form>
    </div>
  );
}
