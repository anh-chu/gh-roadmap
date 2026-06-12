import { useEffect, useState } from "react";
import type { Workspace } from "../../../shared/types";
import { fetchWorkspaces } from "../lib/api";

interface WorkspacesData {
  workspaces: Workspace[];
  activeId: number;
}

// Module-level cache: the pod list changes only via the admin manage popover, which
// calls refetchWorkspaces() after each mutation; subscribers keep mounts in sync.
// Switching pods does a full reload anyway.
let cache: WorkspacesData | null = null;
let inflight: Promise<WorkspacesData> | null = null;
const subscribers = new Set<(d: WorkspacesData) => void>();

async function load(): Promise<WorkspacesData> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetchWorkspaces().then((d) => {
      cache = d;
      inflight = null;
      return d;
    });
  }
  return inflight;
}

// Invalidate + reload after a pod mutation (create / rename / archive).
export async function refetchWorkspaces(): Promise<WorkspacesData> {
  cache = null;
  inflight = null;
  const d = await load();
  subscribers.forEach((fn) => fn(d));
  return d;
}

export interface UseWorkspacesResult {
  workspaces: Workspace[];
  activeId: number | null;
}

export function useWorkspaces(): UseWorkspacesResult {
  const [data, setData] = useState<WorkspacesData | null>(cache);

  useEffect(() => {
    let cancelled = false;
    const onUpdate = (d: WorkspacesData): void => {
      if (!cancelled) setData(d);
    };
    subscribers.add(onUpdate);
    if (!cache) {
      void load()
        .then(onUpdate)
        .catch(() => {
          // Pre-multi-pod server or transient failure: render no switcher (single-pod look).
        });
    }
    return () => {
      cancelled = true;
      subscribers.delete(onUpdate);
    };
  }, []);

  return { workspaces: data?.workspaces ?? [], activeId: data?.activeId ?? null };
}
