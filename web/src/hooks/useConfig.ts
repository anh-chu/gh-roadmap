import { useCallback, useEffect, useState } from "react";
import type { BucketingField, RangeGranularity, WorkspaceConfig } from "../../../shared/types";
import { getConfig, patchConfig } from "../lib/api";

const DEFAULT_CONFIG: WorkspaceConfig = {
  bucketingField: "label",
  bucketingValue: "area",
  masterFilterInclude: [],
  masterFilterExclude: [],
  rangeGranularity: "month",
  rangeCount: 3,
  rangeOffset: 0,
  todoStaleDays: 14,
  flowShippingHours: 24,
  flowReviewDays: 3,
  flowCodeDays: 3,
  flowDiscussionDays: 5,
  flowStallDays: 14,
  flowColdDays: 60,
  flowFreshDays: 7,
  pinMetaCols: true,
  predictPrStaleDays: 3,
  predictPrMinAge: 7,
  predictReviewWaitDays: 2,
  predictPromiseConfidenceMin: 60,
  predictReplyOverdueHours: 24,
  aiModelSummary: null,
  aiModelProgress: null,
  aiModelExtract: null,
  updatedAt: "",
};

export interface ConfigPatch {
  bucketingField?: BucketingField;
  bucketingValue?: string;
  masterFilterInclude?: string[];
  masterFilterExclude?: string[];
  rangeGranularity?: RangeGranularity;
  rangeCount?: number;
  rangeOffset?: number;
  todoStaleDays?: number;
  flowShippingHours?: number;
  flowReviewDays?: number;
  flowCodeDays?: number;
  flowDiscussionDays?: number;
  flowStallDays?: number;
  flowColdDays?: number;
  flowFreshDays?: number;
  pinMetaCols?: boolean;
  aiModelSummary?: string | null;
  aiModelProgress?: string | null;
  aiModelExtract?: string | null;
}

export interface UseConfigResult {
  config: WorkspaceConfig;
  loaded: boolean;
  updateConfig: (patch: ConfigPatch) => Promise<boolean>;
}

export function useConfig(onError?: (msg: string) => void): UseConfigResult {
  const [config, setConfig] = useState<WorkspaceConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const c = await getConfig();
        if (!cancelled) {
          setConfig(c);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfig = useCallback(
    async (patch: ConfigPatch): Promise<boolean> => {
      const prev = config;
      const optimistic: WorkspaceConfig = {
        bucketingField: patch.bucketingField ?? prev.bucketingField,
        bucketingValue: patch.bucketingValue ?? prev.bucketingValue,
        masterFilterInclude: patch.masterFilterInclude ?? prev.masterFilterInclude,
        masterFilterExclude: patch.masterFilterExclude ?? prev.masterFilterExclude,
        rangeGranularity: patch.rangeGranularity ?? prev.rangeGranularity,
        rangeCount: patch.rangeCount ?? prev.rangeCount,
        rangeOffset: patch.rangeOffset ?? prev.rangeOffset,
        todoStaleDays: patch.todoStaleDays ?? prev.todoStaleDays,
        flowShippingHours: patch.flowShippingHours ?? prev.flowShippingHours,
        flowReviewDays: patch.flowReviewDays ?? prev.flowReviewDays,
        flowCodeDays: patch.flowCodeDays ?? prev.flowCodeDays,
        flowDiscussionDays: patch.flowDiscussionDays ?? prev.flowDiscussionDays,
        flowStallDays: patch.flowStallDays ?? prev.flowStallDays,
        flowColdDays: patch.flowColdDays ?? prev.flowColdDays,
        flowFreshDays: patch.flowFreshDays ?? prev.flowFreshDays,
        pinMetaCols: patch.pinMetaCols ?? prev.pinMetaCols,
        predictPrStaleDays: prev.predictPrStaleDays,
        predictPrMinAge: prev.predictPrMinAge,
        predictReviewWaitDays: prev.predictReviewWaitDays,
        predictPromiseConfidenceMin: prev.predictPromiseConfidenceMin,
        predictReplyOverdueHours: prev.predictReplyOverdueHours,
        aiModelSummary: patch.aiModelSummary !== undefined ? patch.aiModelSummary : prev.aiModelSummary,
        aiModelProgress: patch.aiModelProgress !== undefined ? patch.aiModelProgress : prev.aiModelProgress,
        aiModelExtract: patch.aiModelExtract !== undefined ? patch.aiModelExtract : prev.aiModelExtract,
        updatedAt: new Date().toISOString(),
      };
      setConfig(optimistic);
      try {
        const saved = await patchConfig(patch);
        setConfig(saved);
        return true;
      } catch (e) {
        setConfig(prev);
        onError?.(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return false;
      }
    },
    [config, onError],
  );

  return { config, loaded, updateConfig };
}
