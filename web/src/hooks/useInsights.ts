import { useCallback, useEffect, useState } from "react";
import type { ApiInsightAccount, ApiInsightListItem } from "../../../shared/types";
import {
  fetchInsightAccounts,
  fetchInsights,
  type InsightFilters,
} from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

// SWR cache so the Insights tab paints instantly on a cold reload, then revalidates.
// items are stored with the filter key they were fetched under (hydrate only on match);
// accounts are filter-independent so they get their own key.
const ITEMS_KEY = "ghr:insights:v1";
const ACCOUNTS_KEY = "ghr:insight-accounts:v1";

interface CacheEntry {
  key: string;
  items: ApiInsightListItem[];
}

function keyOf(f: InsightFilters): string {
  return JSON.stringify({
    type: f.type ?? [],
    confidence: f.confidence ?? [],
    account: f.account ?? "",
    dateFrom: f.dateFrom ?? "",
    dateTo: f.dateTo ?? "",
    search: "", // search is client-side; don't include in cache key
  });
}

export interface UseInsightsResult {
  items: ApiInsightListItem[];
  accounts: ApiInsightAccount[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  refresh: () => Promise<void>;
}

export function useInsights(filters: InsightFilters): UseInsightsResult {
  const cacheKey = keyOf(filters);
  const cached = loadCache<CacheEntry>(ITEMS_KEY);
  const initial = cached && cached.key === cacheKey ? cached.items : [];
  const [items, setItems] = useState<ApiInsightListItem[]>(initial);
  const [accounts, setAccounts] = useState<ApiInsightAccount[]>(
    () => loadCache<ApiInsightAccount[]>(ACCOUNTS_KEY) ?? [],
  );
  const [loading, setLoading] = useState(initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [list, accs] = await Promise.all([
        fetchInsights({
          type: filters.type,
          confidence: filters.confidence,
          account: filters.account,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        }),
        fetchInsightAccounts(),
      ]);
      saveCache(ITEMS_KEY, { key: cacheKey, items: list });
      saveCache(ACCOUNTS_KEY, accs);
      setItems(list);
      setAccounts(accs);
      // Disabled iff backend returns empty AND no accounts. The API returns [] when
      // GitHub isn't configured; this is the proxy signal.
      setDisabled(list.length === 0 && accs.length === 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, [cacheKey, filters.type, filters.confidence, filters.account, filters.dateFrom, filters.dateTo]);

  // Revalidate on mount/filter change; silent (keep visible rows) when primed for this key.
  useEffect(() => {
    void load(initial.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { items, accounts, loading, error, disabled, refresh: load };
}
