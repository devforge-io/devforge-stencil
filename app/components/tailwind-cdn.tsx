/**
 * Tailwind's CDN runtime, for hand-written routes that embed CMS chrome.
 *
 * The public CMS pages are rendered with this script (see TAILWIND_HEAD in
 * public-page.server.ts), and the site header/footer components are styled
 * with utility classes that only exist once it runs. This app's own Tailwind
 * build only scans app source, so without the runtime those classes would be
 * missing on routes like the tools. Mirrors the public pages' config.
 */

export const TAILWIND_CDN_SRC = "https://cdn.tailwindcss.com";

export function TailwindCdn() {
  return (
    <>
      <script src={TAILWIND_CDN_SRC} />
      <script dangerouslySetInnerHTML={{ __html: "tailwind.config={darkMode:'media'}" }} />
    </>
  );
}
