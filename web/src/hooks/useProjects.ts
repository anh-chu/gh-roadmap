import { useCallback, useEffect, useState } from "react";
import type { ProjectFull, ProjectSummary } from "../../../shared/types";
import { fetchProject, fetchProjects, refreshProject } from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

// SWR: the Kanban tab paints from the last-known board on a cold reload, then revalidates.
const LIST_KEY = "ghr:projects:v1";
const boardKey = (num: number): string => `ghr:project:${num}:v1`;

export interface UseProjectsResult {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useProjects(enabled: boolean = true): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectSummary[]>(
    () => loadCache<ProjectSummary[]>(LIST_KEY) ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(projects.length === 0);
    setError(null);
    try {
      const list = await fetchProjects();
      saveCache(LIST_KEY, list);
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { projects, loading, error, reload };
}

export interface UseProjectResult {
  project: ProjectFull | null;
  loading: boolean;
  error: string | null;
  reload: (force?: boolean) => Promise<void>;
  setProject: (p: ProjectFull) => void;
}

export function useProject(num: number | null, enabled: boolean = true): UseProjectResult {
  const [project, setProject] = useState<ProjectFull | null>(
    () => (num === null ? null : loadCache<ProjectFull>(boardKey(num))),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (force = false): Promise<void> => {
      if (num === null) {
        setProject(null);
        return;
      }
      // Don't blank the board to a spinner when we already have a cached copy showing.
      const cached = loadCache<ProjectFull>(boardKey(num));
      setLoading(cached === null);
      setError(null);
      try {
        const p = force ? await refreshProject(num) : await fetchProject(num);
        saveCache(boardKey(num), p);
        setProject(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load project");
      } finally {
        setLoading(false);
      }
    },
    [num],
  );

  // Re-hydrate from cache when the selected board changes, then revalidate.
  useEffect(() => {
    if (!enabled) return;
    if (num !== null) setProject(loadCache<ProjectFull>(boardKey(num)));
    void reload();
  }, [enabled, reload, num]);

  return { project, loading, error, reload, setProject };
}
