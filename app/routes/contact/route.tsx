import { redirect } from "react-router";
import { getPublishedContentByPath } from "~/lib/content.server";
import { renderPublicPageResponse, renderNotFoundResponse } from "~/lib/public-page.server";
import { sendContactMessage, validateSubmission } from "~/lib/contact.server";
import type { Route } from "./+types/route";

/** GET /contact — serve the page assigned to the "/contact" path, if any. */
export async function loader({ request }: Route.LoaderArgs) {
  const page = await getPublishedContentByPath("/contact");
  if (page) return renderPublicPageResponse(page, request);
  return renderNotFoundResponse(request);
}

/**
 * POST /contact — email a contact-form submission to the recipient configured
 * in Settings. Works with a plain HTML form (redirects back with ?contact=sent)
 * or a fetch (returns JSON when Accept: application/json).
 */
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  console.log("[contact] POST received; fields:", Array.from(formData.keys()));

  // Honeypot: a hidden field real users leave empty. Bots fill it — accept and drop.
  if (((formData.get("_gotcha") as string) || "").trim()) {
    console.log(
      "[contact] honeypot '_gotcha' was filled — treating as spam and NOT sending. " +
        "If a real submission is being dropped, remove the _gotcha field or check for browser autofill."
    );
    return respond(request, formData, { ok: true });
  }

  const sub = {
    name: (formData.get("name") as string) || "",
    email: (formData.get("email") as string) || "",
    subject: (formData.get("subject") as string) || "",
    message: (formData.get("message") as string) || "",
  };

  const error = validateSubmission(sub);
  if (error) {
    console.log("[contact] validation failed:", error, {
      name: sub.name || "(empty)",
      email: sub.email || "(empty)",
      hasMessage: !!sub.message.trim(),
    });
    return respond(request, formData, { ok: false, error }, 400);
  }

  try {
    await sendContactMessage(sub);
    console.log("[contact] message sent OK");
  } catch (err) {
    console.log("[contact] send failed:", err);
    return respond(
      request,
      formData,
      { ok: false, error: "Sorry, your message couldn't be sent. Please try again later." },
      502
    );
  }

  return respond(request, formData, { ok: true });
}

function respond(
  request: Request,
  formData: FormData,
  result: { ok: boolean; error?: string },
  status = 200
): Response {
  if ((request.headers.get("accept") || "").includes("application/json")) {
    return Response.json(result, { status });
  }
  // Progressive enhancement (no-JS): redirect back with a status flag. A page can
  // show a message from ?contact=sent / ?contact=error (e.g. a conditional block).
  const origin = new URL(request.url).origin;
  const base = (formData.get("_redirect") as string) || request.headers.get("referer") || "/";
  let target: URL;
  try {
    target = new URL(base, origin);
    if (target.origin !== origin) target = new URL("/", origin);
  } catch {
    target = new URL("/", origin);
  }
  target.searchParams.set("contact", result.ok ? "sent" : "error");
  return redirect(target.pathname + target.search);
}
