import { useCallback, useEffect, useState } from "react";
import type { MetaResponse } from "../../../shared/types";
import { fetchMeta } from "../lib/api";

export interface UseMeta {
  meta: MetaResponse | null;
  refresh: () => Promise<void>;
}

export function useMeta(intervalMs = 30_000): UseMeta {
  const [meta, setMeta] = useState<MetaResponse | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const m = await fetchMeta();
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
        if (!cancelled) setMeta(m);
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
