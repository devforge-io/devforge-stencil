import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The GitHub token to use for the current request's git operations. When
 * GITHUB_TOKEN is set it's used for every request; otherwise the root middleware
 * puts the signed-in user's OAuth access token here so operations act as them
 * (empty string ⇒ unauthenticated, for public-repo reads by anonymous visitors).
 */
const store = new AsyncLocalStorage<{ token: string }>();

export function runWithRequestToken<T>(token: string, fn: () => T): T {
  return store.run({ token }, fn);
}

export function getRequestToken(): string {
  return store.getStore()?.token ?? "";
}
