import { useCallback, useEffect, useState } from "react";
import type { MetaResponse } from "../../../shared/types";
import { fetchMeta } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

export interface UseMeta {
  meta: MetaResponse | null;
  refresh: () => Promise<void>;
}

// SWR cache for dashboard meta so the Roadmap grid (gated on meta.buckets) renders
// instantly on a cold reload instead of flashing the empty "Loading…" board.
const CACHE_KEY = "ghr:meta:v1";

export function useMeta(intervalMs = 30_000): UseMeta {
  const [meta, setMeta] = useState<MetaResponse | null>(() => loadCache<MetaResponse>(CACHE_KEY));

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const m = await fetchMeta();
      saveCache(CACHE_KEY, m);
      setMeta(m);
    } catch {
      /* leave previous state */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const m = await fetchMeta();
        if (!cancelled) {
          saveCache(CACHE_KEY, m);
          setMeta(m);
        }
      } catch {
        /* leave previous state */
      }
    };
    void tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return { meta, refresh };
}
