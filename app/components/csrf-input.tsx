import { createContext, useContext } from "react";

/**
 * Carries the CSRF token minted by the route loader down to any <Form> below it.
 *
 * The upstream version of this component read the token off the *root* loader.
 * Here it comes from context instead, so the tool routes stay self-contained and
 * this fork's root.tsx (shared with the whole CMS) needs no change.
 */
const CsrfContext = createContext<string>("");

export function CsrfProvider({
  token,
  children,
}: {
  token: string;
  children: React.ReactNode;
}) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

export function useCsrfToken(): string {
  return useContext(CsrfContext);
}

/**
 * Drop this inside any <Form> that performs a mutation, then validate in the
 * action with `validateCsrf(request, formData)` from ~/lib/csrf.server.
 */
export function CsrfInput() {
  const token = useCsrfToken();
  return <input type="hidden" name="_csrf" value={token} />;
}
