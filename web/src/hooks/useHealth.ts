import { useCallback, useEffect, useRef, useState } from "react";
import type { HealthHistorical, HealthLive, HealthSnapshotSummary } from "../../../shared/types";
import { fetchHealth, fetchHealthHistory, fetchHealthSnapshot } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

// SWR: keep the Progress headline painted from the last-known live snapshot on a cold reload.
const LIVE_KEY = "ghr:health-live:v1";

interface UseHealth {
  live: HealthLive | null;
  history: HealthSnapshotSummary[];
  snapshot: HealthHistorical | null;
  scrubbedDate: string | null;
  scrubTo: (date: string | null) => void;
  loading: boolean;
}

const LIVE_POLL_MS = 60_000;

export function useHealth(): UseHealth {
  const [live, setLive] = useState<HealthLive | null>(() => loadCache<HealthLive>(LIVE_KEY));
  const [history, setHistory] = useState<HealthSnapshotSummary[]>([]);
  const [snapshot, setSnapshot] = useState<HealthHistorical | null>(null);
  const [scrubbedDate, setScrubbedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => loadCache<HealthLive>(LIVE_KEY) === null);
  const snapshotCache = useRef<Map<string, HealthHistorical>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const runLive = async (): Promise<void> => {
      try {
        const r = await fetchHealth();
        if (!cancelled) {
          saveCache(LIVE_KEY, r);
          setLive(r);
        }
      } catch {
        /* keep last good state */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void runLive();
    const id = window.setInterval(runLive, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const h = await fetchHealthHistory(30);
        if (!cancelled) setHistory(h);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scrubTo = useCallback((date: string | null): void => {
    setScrubbedDate(date);
    if (date === null) {
      setSnapshot(null);
      return;
    }
    const cached = snapshotCache.current.get(date);
    if (cached) {
      setSnapshot(cached);
      return;
    }
    void (async () => {
      try {
        const s = await fetchHealthSnapshot(date);
        snapshotCache.current.set(date, s);
        setSnapshot(s);
      } catch {
        setSnapshot(null);
      }
    })();
  }, []);

  return { live, history, snapshot, scrubbedDate, scrubTo, loading };
}
