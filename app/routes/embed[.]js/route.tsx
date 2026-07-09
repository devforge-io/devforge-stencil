import type { Route } from "./+types/route";

// Parent-side resizer: matches each embed iframe by its message source window
// and sets its height from the posted document height.
const EMBED_JS =
  `(function(){window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='stencil-embed-resize'||typeof d.height!=='number')return;var f=document.getElementsByTagName('iframe');for(var i=0;i<f.length;i++){if(f[i].contentWindow===e.source){f[i].style.height=d.height+'px';break;}}});})();`;

/** GET /embed.js — tiny script an embedding page includes to auto-size iframes. */
export async function loader() {
  return new Response(EMBED_JS, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
