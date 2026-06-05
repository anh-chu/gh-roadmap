import { useCallback, useEffect, useState } from "react";
import type { ApiInsightAccount, ApiInsightListItem } from "../../../shared/types";
import {
  fetchInsightAccounts,
  fetchInsights,
  type InsightFilters,
} from "../lib/api";

// Module-level cache so the Insights tab doesn't refetch on every visit.
interface CacheEntry {
  key: string;
  items: ApiInsightListItem[];
}
let _cache: CacheEntry | null = null;
let _accountsCache: ApiInsightAccount[] | null = null;

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
  const initial = _cache && _cache.key === cacheKey ? _cache.items : [];
  const [items, setItems] = useState<ApiInsightListItem[]>(initial);
  const [accounts, setAccounts] = useState<ApiInsightAccount[]>(_accountsCache ?? []);
  const [loading, setLoading] = useState(initial.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
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
        _accountsCache ? Promise.resolve(_accountsCache) : fetchInsightAccounts(),
      ]);
      _cache = { key: cacheKey, items: list };
      _accountsCache = accs;
      setItems(list);
      setAccounts(accs);
      // Disabled iff backend returns empty AND no accounts AND we never had data.
      // The API returns [] when GitHub isn't configured; this is the proxy signal.
      setDisabled(list.length === 0 && accs.length === 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, [cacheKey, filters.type, filters.confidence, filters.account, filters.dateFrom, filters.dateTo]);

  useEffect(() => {
    void load();
  }, [load]);

  return { items, accounts, loading, error, disabled, refresh: load };
}
