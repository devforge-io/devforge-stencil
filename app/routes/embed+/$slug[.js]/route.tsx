import type { Route } from "./+types/route";

export function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const origin = url.origin;
  const slug = params.slug;

  const js = `(function() {
  var container = document.currentScript.parentElement;
  var iframe = document.createElement('iframe');
  iframe.src = '${origin}/embed/${slug}';
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('title', 'Stencil: ${slug}');
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'stencil-resize' && e.data.slug === '${slug}') {
      iframe.style.height = e.data.height + 'px';
    }
  });
  container.appendChild(iframe);
})();`;

  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
