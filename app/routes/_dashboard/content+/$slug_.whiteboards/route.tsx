import { Link } from "react-router";
import { listWhiteboardsForPage } from "~/lib/whiteboard.server";
import { getContent } from "~/lib/content.server";
import type { Route } from "./+types/route";

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }
  const whiteboards = await listWhiteboardsForPage(params.slug);
  return {
    pageSlug: params.slug,
    pageTitle: content.frontmatter.title,
    whiteboards,
  };
}

export default function WhiteboardsList({ loaderData }: Route.ComponentProps) {
  const { pageSlug, pageTitle, whiteboards } = loaderData;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Whiteboards</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            For page:{" "}
            <Link
              to={`/content/${pageSlug}`}
              className="text-brand-600 dark:text-brand-200 hover:underline"
            >
              {pageTitle}
            </Link>
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to={`/content/${pageSlug}/edit`}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            Back to edit
          </Link>
          <Link
            to={`/content/${pageSlug}/whiteboards/new`}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
          >
            New Whiteboard
          </Link>
        </div>
      </div>

      {whiteboards.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            No whiteboards for this page yet.
          </p>
          <Link
            to={`/content/${pageSlug}/whiteboards/new`}
            className="inline-block px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
          >
            Create First Whiteboard
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {whiteboards.map((wb) => (
            <Link
              key={wb.slug}
              to={`/content/${pageSlug}/whiteboards/${wb.slug}`}
              className="block bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden hover:border-brand-500 transition-colors"
            >
              <div className="aspect-video bg-gray-50 dark:bg-gray-950 flex items-center justify-center overflow-hidden">
                <img
                  src={wb.imageUrl}
                  alt={wb.slug}
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </div>
              <div className="p-3 border-t border-gray-200 dark:border-gray-800">
                <h2 className="font-medium text-sm truncate">{wb.slug}</h2>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
