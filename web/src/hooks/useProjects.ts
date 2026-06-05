import { useCallback, useEffect, useState } from "react";
import type { ProjectFull, ProjectSummary } from "../../../shared/types";
import { fetchProject, fetchProjects, refreshProject } from "../lib/api";

export interface UseProjectsResult {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useProjects(enabled: boolean = true): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
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
  const [project, setProject] = useState<ProjectFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (force = false): Promise<void> => {
      if (num === null) {
        setProject(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const p = force ? await refreshProject(num) : await fetchProject(num);
        setProject(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load project");
      } finally {
        setLoading(false);
      }
    },
    [num],
  );

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { project, loading, error, reload, setProject };
}
