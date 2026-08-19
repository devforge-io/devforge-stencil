/**
 * Synchroniser-token CSRF for the public tool routes.
 *
 * Self-contained on purpose: the token is minted by the route loader that renders
 * the form (not by the root loader), so adding the tools to this fork needs no
 * change to root.tsx and no new root loader data for every other page to carry.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createCookie } from "react-router";

/** HttpOnly CSRF cookie, server-only and never readable by JS. */
export const csrfCookie = createCookie("_csrf", {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24, // 24 hours
});

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Returns the request's existing CSRF token, or mints one.
 *
 * `setCookie` is non-null only when a fresh token was minted; the caller must
 * then send it as a Set-Cookie header, or validation will fail on submit.
 */
export async function ensureCsrfToken(
  request: Request,
): Promise<{ token: string; setCookie: string | null }> {
  const existing = String(
    (await csrfCookie.parse(request.headers.get("Cookie") ?? "")) ?? "",
  );
  if (existing) return { token: existing, setCookie: null };

  const token = generateCsrfToken();
  return { token, setCookie: await csrfCookie.serialize(token) };
}

/**
 * Validates the `_csrf` form field against the httpOnly cookie using a
 * timing-safe comparison. Throws a 403 Response when absent or mismatched.
 */
export async function validateCsrf(
  request: Request,
  formData: FormData,
): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const tokenFromForm = String(formData.get("_csrf") ?? "");
  const tokenFromCookie = String(
    (await csrfCookie.parse(request.headers.get("Cookie") ?? "")) ?? "",
  );

  const invalid =
    !tokenFromForm ||
    !tokenFromCookie ||
    tokenFromForm.length !== tokenFromCookie.length ||
    !timingSafeEqual(Buffer.from(tokenFromForm), Buffer.from(tokenFromCookie));

  if (invalid) {
    throw new Response("Invalid or missing CSRF token.", {
      status: 403,
      statusText: "Forbidden",
    });
  }
}
