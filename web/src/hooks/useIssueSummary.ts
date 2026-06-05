import { useCallback, useEffect, useState } from "react";
import type { AiSummary } from "../../../shared/types";
import { fetchIssueSummary, refreshIssueSummary } from "../lib/api";

// Module-level cache so reopening a Drawer or re-hovering a Card is instant.
const cache = new Map<number, AiSummary>();
// `null` means we asked the server and AI is disabled — don't try again.
let aiDisabled = false;

export interface UseIssueSummary {
  summary: AiSummary | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  refresh: () => Promise<void>;
}

export function useIssueSummary(num: number | null): UseIssueSummary {
  const [summary, setSummary] = useState<AiSummary | null>(
    num !== null ? cache.get(num) ?? null : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(aiDisabled);

  useEffect(() => {
    if (num === null) {
      setSummary(null);
      setError(null);
      return;
    }
    const cached = cache.get(num);
    if (cached) {
      setSummary(cached);
      setError(null);
      return;
    }
    if (aiDisabled) {
      setDisabled(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchIssueSummary(num)
      .then((s) => {
        if (cancelled) return;
        if (s === null) {
          aiDisabled = true;
          setDisabled(true);
        } else {
          cache.set(num, s);
          setSummary(s);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "summary failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [num]);

  const refresh = useCallback(async (): Promise<void> => {
    if (num === null || aiDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const s = await refreshIssueSummary(num);
      if (s === null) {
        aiDisabled = true;
        setDisabled(true);
      } else {
        cache.set(num, s);
        setSummary(s);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "summary failed");
    } finally {
      setLoading(false);
    }
  }, [num]);

  return { summary, loading, error, disabled, refresh };
}
