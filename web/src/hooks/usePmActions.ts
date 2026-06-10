import { useCallback, useEffect, useState } from "react";
import type { PmActionsResponse } from "../../../shared/types";
import { fetchPmActions, refreshPmActions } from "../lib/api";

// Single-slot cache so re-mounting the Progress tab is instant.
let cached: PmActionsResponse | null = null;

export interface UsePmActions {
  data: PmActionsResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePmActions(): UsePmActions {
  const [data, setData] = useState<PmActionsResponse | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cached) {
      setData(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPmActions()
      .then((d) => {
        if (cancelled) return;
        cached = d;
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "pm-actions failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const d = await refreshPmActions();
      if (d !== null) {
        cached = d;
        setData(d);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "pm-actions failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, refresh };
}
