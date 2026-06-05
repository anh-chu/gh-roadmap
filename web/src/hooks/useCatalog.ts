import { useEffect, useState } from "react";
import type { CatalogResponse } from "../../../shared/types";
import { fetchCatalog } from "../lib/api";

// Full repo label/milestone catalog. Fetched once and shared across consumers —
// it changes rarely and the server caches it too.
let cache: CatalogResponse | null = null;
let inflight: Promise<CatalogResponse> | null = null;

const EMPTY: CatalogResponse = { labels: [], milestones: [] };

export function useCatalog(): CatalogResponse {
  const [catalog, setCatalog] = useState<CatalogResponse>(cache ?? EMPTY);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    inflight ??= fetchCatalog().then((c) => {
      cache = c;
      return c;
    });
    inflight
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        /* keep empty; App unions with in-use values */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return catalog;
}
