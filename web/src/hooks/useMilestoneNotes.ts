import { useCallback, useEffect, useState } from "react";
import type { MilestoneNotes } from "../../../shared/types";
import { fetchMilestoneNotes, refreshMilestoneNotes } from "../lib/api";

// Module-level cache keyed by milestone title so reopening a card is instant.
const cache = new Map<string, MilestoneNotes>();
// Once the server says AI is off, stop asking.
let aiDisabled = false;

export interface UseMilestoneNotes {
  notes: MilestoneNotes | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  refresh: () => Promise<void>;
}

// `enabled` gates generation — notes are an AI call, so we only fetch once the
// user opens the release-notes panel for a given milestone.
export function useMilestoneNotes(title: string | null, enabled: boolean): UseMilestoneNotes {
  const [notes, setNotes] = useState<MilestoneNotes | null>(
    title !== null ? cache.get(title) ?? null : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(aiDisabled);

  useEffect(() => {
    if (title === null || !enabled) return;
    const cached = cache.get(title);
    if (cached) {
      setNotes(cached);
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
    fetchMilestoneNotes(title)
      .then((n) => {
        if (cancelled) return;
        if (n === null) {
          aiDisabled = true;
          setDisabled(true);
        } else {
          cache.set(title, n);
          setNotes(n);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "release notes failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [title, enabled]);

  const refresh = useCallback(async (): Promise<void> => {
    if (title === null || aiDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const n = await refreshMilestoneNotes(title);
      if (n === null) {
        aiDisabled = true;
        setDisabled(true);
      } else {
        cache.set(title, n);
        setNotes(n);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "release notes failed");
    } finally {
      setLoading(false);
    }
  }, [title]);

  return { notes, loading, error, disabled, refresh };
}
