import { Link } from "react-router";
import { useState, useCallback } from "react";
import { getContent, getContentHistory } from "~/lib/content.server";
import { formatDateTime } from "~/lib/format";
import type { Route } from "./+types/route";

interface DiffLine {
  value: string;
  added?: boolean;
  removed?: boolean;
}

interface VersionData {
  raw: string;
  html: string;
  diff?: DiffLine[];
}

export async function loader({ params }: Route.LoaderArgs) {
  const content = await getContent(params.slug);
  if (!content) {
    throw new Response("Not Found", { status: 404 });
  }
  const commits = await getContentHistory(params.slug, content.contentType);
  return { slug: params.slug, commits };
}

export default function ContentHistory({ loaderData }: Route.ComponentProps) {
  const { slug, commits } = loaderData;

  const [mode, setMode] = useState<"list" | "view" | "diff">("list");
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [compareSha, setCompareSha] = useState<string | null>(null);
  const [versionData, setVersionData] = useState<VersionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewTab, setViewTab] = useState<"rendered" | "source">("rendered");

  // For diff mode: track which two revisions are selected
  const [diffOld, setDiffOld] = useState<string | null>(null);
  const [diffNew, setDiffNew] = useState<string | null>(null);

  const fetchVersion = useCallback(
    async (sha: string, compare?: string) => {
      setLoading(true);
      setVersionData(null);
      try {
        const url = compare
          ? `/api/content/${slug}/version/${sha}?compare=${compare}`
          : `/api/content/${slug}/version/${sha}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          setVersionData(data);
        }
      } finally {
        setLoading(false);
      }
    },
    [slug]
  );

  const handleView = useCallback(
    (sha: string) => {
      setMode("view");
      setSelectedSha(sha);
      setViewTab("rendered");
      fetchVersion(sha);
    },
    [fetchVersion]
  );

  const handleCompare = useCallback(() => {
    if (!diffOld || !diffNew || diffOld === diffNew) return;
    setMode("diff");
    setSelectedSha(diffNew);
    setCompareSha(diffOld);
    fetchVersion(diffNew, diffOld);
  }, [diffOld, diffNew, fetchVersion]);

  const handleBack = useCallback(() => {
    setMode("list");
    setSelectedSha(null);
    setCompareSha(null);
    setVersionData(null);
    setDiffOld(null);
    setDiffNew(null);
  }, []);

  const selectedCommit = commits.find((c) => c.sha === selectedSha);
  const compareCommit = commits.find((c) => c.sha === compareSha);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">History: {slug}</h1>
        <div className="flex gap-2">
          {mode !== "list" && (
            <button
              onClick={handleBack}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
            >
              Back to list
            </button>
          )}
          <Link
            to={`/content/${slug}`}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
          >
            Back to content
          </Link>
        </div>
      </div>

      {/* Commit list */}
      {mode === "list" && (
        <>
          {commits.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              No history found.
            </p>
          ) : (
            <>
              {/* Diff selection bar */}
              <div className="mb-4 flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Select two revisions to compare:
                </span>
                <button
                  onClick={handleCompare}
                  disabled={!diffOld || !diffNew || diffOld === diffNew}
                  className="px-3 py-1.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Compare
                </button>
              </div>

              <div className="space-y-1">
                {/* Table header */}
                <div className="grid grid-cols-[40px_40px_1fr_140px_80px_70px] gap-2 px-4 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  <span title="Old (left side of diff)">Old</span>
                  <span title="New (right side of diff)">New</span>
                  <span>Commit</span>
                  <span>Date</span>
                  <span>SHA</span>
                  <span />
                </div>

                {commits.map((commit) => (
                  <div
                    key={commit.sha}
                    className={`grid grid-cols-[40px_40px_1fr_140px_80px_70px] gap-2 items-center border rounded-lg px-4 py-3 ${
                      commit.isPublished
                        ? "bg-green-50 dark:bg-green-950/20 border-green-300 dark:border-green-800"
                        : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    {/* Old radio */}
                    <input
                      type="radio"
                      name="diff-old"
                      checked={diffOld === commit.sha}
                      onChange={() => setDiffOld(commit.sha)}
                      className="w-4 h-4 accent-brand-600"
                      title="Select as older version"
                    />
                    {/* New radio */}
                    <input
                      type="radio"
                      name="diff-new"
                      checked={diffNew === commit.sha}
                      onChange={() => setDiffNew(commit.sha)}
                      className="w-4 h-4 accent-brand-600"
                      title="Select as newer version"
                    />
                    {/* Message + author */}
                    <div className="min-w-0">
                      <p className={`font-medium text-sm truncate flex items-center gap-2 ${
                        commit.isPublished
                          ? "text-green-700 dark:text-green-300"
                          : ""
                      }`}>
                        {commit.isPublished && (
                          <svg className="w-4 h-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                          </svg>
                        )}
                        {commit.message}
                        {commit.isPublished && (
                          <span className="text-xs font-normal px-2 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 rounded-full whitespace-nowrap">
                            Published
                          </span>
                        )}
                      </p>
                      <p className={`text-xs mt-0.5 ${
                        commit.isPublished
                          ? "text-green-600/70 dark:text-green-400/70"
                          : "text-gray-500 dark:text-gray-400"
                      }`}>
                        {commit.author}
                      </p>
                    </div>
                    {/* Date */}
                    <time className={`text-xs ${
                      commit.isPublished
                        ? "text-green-600/70 dark:text-green-400/70"
                        : "text-gray-500 dark:text-gray-400"
                    }`}>
                      {formatDateTime(commit.date)}
                    </time>
                    {/* SHA */}
                    <code className={`text-xs font-mono ${
                      commit.isPublished
                        ? "text-green-600/70 dark:text-green-400/70"
                        : "text-gray-400"
                    }`}>
                      {commit.sha.slice(0, 7)}
                    </code>
                    {/* View button */}
                    <button
                      onClick={() => handleView(commit.sha)}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        commit.isPublished
                          ? "text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/30"
                          : "text-brand-600 dark:text-brand-200 hover:bg-brand-50 dark:hover:bg-brand-700/20"
                      }`}
                    >
                      View
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* View single version */}
      {mode === "view" && (
        <div>
          {selectedCommit && (
            <div className="mb-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium">{selectedCommit.message}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {selectedCommit.author} &middot;{" "}
                    {formatDateTime(selectedCommit.date)} &middot;{" "}
                    <code className="text-xs font-mono">
                      {selectedCommit.sha.slice(0, 7)}
                    </code>
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setViewTab("rendered")}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      viewTab === "rendered"
                        ? "bg-brand-600 text-white"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    Rendered
                  </button>
                  <button
                    onClick={() => setViewTab("source")}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      viewTab === "source"
                        ? "bg-brand-600 text-white"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    Source
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="p-8 text-center text-gray-400">Loading...</div>
          )}

          {versionData && viewTab === "rendered" && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8">
              <article
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: versionData.html }}
              />
            </div>
          )}

          {versionData && viewTab === "source" && (
            <pre className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 overflow-x-auto text-sm font-mono whitespace-pre-wrap">
              {versionData.raw}
            </pre>
          )}
        </div>
      )}

      {/* Diff view */}
      {mode === "diff" && (
        <div>
          <div className="mb-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500 dark:text-gray-400">
                Comparing
              </span>
              {compareCommit && (
                <span className="font-mono text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-2 py-0.5 rounded">
                  {compareCommit.sha.slice(0, 7)}
                </span>
              )}
              <span className="text-gray-400">&rarr;</span>
              {selectedCommit && (
                <span className="font-mono text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded">
                  {selectedCommit.sha.slice(0, 7)}
                </span>
              )}
            </div>
            {compareCommit && selectedCommit && (
              <div className="mt-2 grid grid-cols-2 gap-4 text-xs text-gray-500 dark:text-gray-400">
                <div>
                  <span className="text-red-600 dark:text-red-400 font-medium">
                    Old:
                  </span>{" "}
                  {compareCommit.message} &middot;{" "}
                  {formatDateTime(compareCommit.date)}
                </div>
                <div>
                  <span className="text-green-600 dark:text-green-400 font-medium">
                    New:
                  </span>{" "}
                  {selectedCommit.message} &middot;{" "}
                  {formatDateTime(selectedCommit.date)}
                </div>
              </div>
            )}
          </div>

          {loading && (
            <div className="p-8 text-center text-gray-400">
              Computing diff...
            </div>
          )}

          {versionData?.diff && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm font-mono">
                  <tbody>
                    {versionData.diff.map((part, i) => {
                      const lines = part.value.split("\n");
                      // Remove trailing empty string from split
                      if (lines[lines.length - 1] === "") lines.pop();

                      return lines.map((line, j) => (
                        <tr
                          key={`${i}-${j}`}
                          className={
                            part.added
                              ? "bg-green-50 dark:bg-green-950/40"
                              : part.removed
                                ? "bg-red-50 dark:bg-red-950/40"
                                : ""
                          }
                        >
                          <td className="w-8 px-2 py-0.5 text-right text-xs text-gray-400 select-none border-r border-gray-200 dark:border-gray-800">
                            {part.added ? "+" : part.removed ? "-" : " "}
                          </td>
                          <td
                            className={`px-3 py-0.5 whitespace-pre-wrap ${
                              part.added
                                ? "text-green-800 dark:text-green-300"
                                : part.removed
                                  ? "text-red-800 dark:text-red-300"
                                  : "text-gray-700 dark:text-gray-300"
                            }`}
                          >
                            {line || "\u00A0"}
                          </td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {versionData && !versionData.diff && (
            <div className="p-8 text-center text-gray-400">
              No differences found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
