import { Link } from "react-router";
import { listContent } from "~/lib/content.server";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/route";

export async function loader() {
  const items = await listContent();
  return { items };
}

export default function ContentIndex({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Content</h1>
        <Link
          to="/content/new"
          className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
        >
          New Post
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            No content yet. Create your first post to get started.
          </p>
          <Link
            to="/content/new"
            className="inline-block px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium"
          >
            Create First Post
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Link
              key={item.slug}
              to={`/content/${item.slug}`}
              className="block bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:border-brand-500 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-semibold flex items-center gap-2">
                    {item.meta.title}
                    {item.published ? (
                      item.upToDate ? (
                        <span className="text-xs font-normal px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">
                          Published
                        </span>
                      ) : (
                        <span className="text-xs font-normal px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-full">
                          Unpublished changes
                        </span>
                      )
                    ) : (
                      <span className="text-xs font-normal px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full">
                        Draft
                      </span>
                    )}
                  </h2>
                  {item.meta.description && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                      {item.meta.description}
                    </p>
                  )}
                  {item.meta.tags && item.meta.tags.length > 0 && (
                    <div className="flex gap-1.5 mt-2">
                      {item.meta.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {item.meta.publishedAt && (
                  <time className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap ml-4">
                    {formatDate(item.meta.publishedAt)}
                  </time>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
