import { useCallback, useEffect, useState } from "react";
import type { AiProgress } from "../../../shared/types";
import { fetchAiProgress, refreshAiProgress } from "../lib/api";

// Single-slot cache so re-mounting the Progress tab is instant.
let cached: AiProgress | null = null;
let aiDisabled = false;

export interface UseAiProgress {
  summary: AiProgress | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  refresh: () => Promise<void>;
}

export function useAiProgress(): UseAiProgress {
  const [summary, setSummary] = useState<AiProgress | null>(cached);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(aiDisabled);

  useEffect(() => {
    if (cached || aiDisabled) {
      setSummary(cached);
      setDisabled(aiDisabled);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAiProgress()
      .then((s) => {
        if (cancelled) return;
        if (s === null) {
          aiDisabled = true;
          setDisabled(true);
        } else {
          cached = s;
          setSummary(s);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "progress failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (aiDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const s = await refreshAiProgress();
      if (s === null) {
        aiDisabled = true;
        setDisabled(true);
      } else {
        cached = s;
        setSummary(s);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "progress failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return { summary, loading, error, disabled, refresh };
}
