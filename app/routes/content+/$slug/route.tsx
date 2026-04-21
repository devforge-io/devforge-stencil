import { Link, Form, useNavigation } from "react-router";
import { formatDate } from "~/lib/format";
import {
  getContent,
  getContentPublishStatus,
  getPageCompiledCss,
  publishContent,
  unpublishContent,
} from "~/lib/content.server";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }
  const publishStatus = await getContentPublishStatus(params.slug, content.contentType);

  // Load compiled CSS for page content (from draft branch for preview)
  let compiledCss: string | null = null;
  if (content.contentType === "page") {
    const { getGitHubConfig } = await import("~/lib/github.server");
    compiledCss = await getPageCompiledCss(params.slug, getGitHubConfig().branch);
  }

  return { content, publishStatus, compiledCss };
}

export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const contentType = (formData.get("contentType") as "markdown" | "page") ?? "markdown";

  if (intent === "publish") {
    await publishContent(params.slug, contentType);
  } else if (intent === "unpublish") {
    await unpublishContent(params.slug, contentType);
  }

  return { ok: true };
}

export default function ContentView({ loaderData }: Route.ComponentProps) {
  const { content, publishStatus, compiledCss } = loaderData;
  const navigation = useNavigation();
  const isPublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "publish";
  const isUnpublishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "unpublish";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            {content.frontmatter.title}
            {publishStatus.published ? (
              publishStatus.upToDate ? (
                <span className="text-sm font-normal px-2.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">
                  Published
                </span>
              ) : (
                <span className="text-sm font-normal px-2.5 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-full">
                  Unpublished changes
                </span>
              )
            ) : (
              <span className="text-sm font-normal px-2.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full">
                Draft
              </span>
            )}
          </h1>
          {content.frontmatter.description && (
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {content.frontmatter.description}
            </p>
          )}
          <code className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-1">
            {content.sha.slice(0, 7)}
          </code>
        </div>
        <div className="flex gap-2">
          <Form method="post">
            <input type="hidden" name="contentType" value={content.contentType} />
            {publishStatus.published && publishStatus.upToDate ? (
              <button
                type="submit"
                name="intent"
                value="unpublish"
                disabled={isUnpublishing}
                className="px-3 py-1.5 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-sm disabled:opacity-50"
              >
                {isUnpublishing ? "Unpublishing..." : "Unpublish"}
              </button>
            ) : (
              <button
                type="submit"
                name="intent"
                value="publish"
                disabled={isPublishing}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium disabled:opacity-50"
              >
                {isPublishing
                  ? "Publishing..."
                  : publishStatus.published
                    ? "Publish Changes"
                    : "Publish"}
              </button>
            )}
          </Form>
          <Link
            to={`/content/${content.slug}/history`}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            History
          </Link>
          <Link
            to={`/content/${content.slug}/edit`}
            className="px-3 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
          >
            Edit
          </Link>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {content.frontmatter.tags?.map((tag) => (
          <span
            key={tag}
            className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full"
          >
            {tag}
          </span>
        ))}
        {content.frontmatter.publishedAt && (
          <time className="text-xs text-gray-400">
            Created{" "}
            {formatDate(content.frontmatter.publishedAt)}
          </time>
        )}
      </div>

      {content.contentType === "page" && "css" in content ? (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <iframe
            srcDoc={`<!DOCTYPE html><html><head><style>${compiledCss || (content as { css: string }).css}</style></head><body>${content.html}</body></html>`}
            className="w-full min-h-[500px] border-0"
            title={content.frontmatter.title}
          />
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8">
          <article
            className="prose max-w-none"
            dangerouslySetInnerHTML={{ __html: content.html }}
          />
        </div>
      )}

      {publishStatus.published && (
        <div className="mt-4 text-xs text-gray-400">
          Embed:{" "}
          <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
            /api/content/{content.slug}
          </code>
          {" | "}
          <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
            /embed/{content.slug}
          </code>
        </div>
      )}
    </div>
  );
}
