// Versioned localStorage read/write for stale-while-revalidate hooks: hydrate
// initial state from the last-known value so a cold reload paints instantly,
// then revalidate in the background. Bump the key's version suffix on a shape change.
export function loadCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
