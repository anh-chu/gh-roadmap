import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ApiIssue, BucketingField, Issue } from "../../../shared/types";
import { fromApi } from "../../../shared/types";
import {
  createIssue as apiCreateIssue,
  fetchIssues,
  patchIssue,
  patchIssueProjectStatus,
  patchRoadmap,
  postComment,
  type IssueCreatePayload,
} from "../lib/api";
import { loadCache, saveCache } from "../lib/swrCache";

interface State {
  issues: Issue[];
  loading: boolean;
  loaded: boolean;
  errorMessage: string | null;
}

type Action =
  | { type: "loading" }
  | { type: "load"; issues: Issue[] }
  | { type: "error"; message: string }
  | { type: "replace"; num: number; patch: Partial<Issue> }
  | { type: "insert"; issue: Issue }
  | { type: "remove"; num: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loading":
      return { ...state, loading: true, errorMessage: null };
    case "load":
      return { issues: action.issues, loading: false, loaded: true, errorMessage: null };
    case "error":
      return { issues: [], loading: false, loaded: true, errorMessage: action.message };
    case "replace":
      return {
        ...state,
        issues: state.issues.map((i) => (i.num === action.num ? { ...i, ...action.patch } : i)),
      };
    case "insert":
      return { ...state, issues: [action.issue, ...state.issues.filter((i) => i.num !== action.issue.num)] };
    case "remove":
      return { ...state, issues: state.issues.filter((i) => i.num !== action.num) };
  }
}

// Bucket reassignment (row-axis) — unchanged shape from prior versions.
export interface BucketChange {
  field: BucketingField;
  // When field='label', this is the value prefix (e.g. "area"). Ignored otherwise.
  prefix?: string;
  // The destination bucket name. For milestone with null target, pass null.
  bucket: string | null;
}

// Placement (column-axis) — discriminated union by `kind`.
// `month` / `week` / `quarter` carry the destination time-bucket key.
// `todo` / `backlog` set the pinned GitHub Projects board's Status (the single
// source of truth for the two meta columns) and clear any planned date.
export type MoveTarget =
  | { kind: "todo" }
  | { kind: "backlog" }
  | { kind: "month"; value: string }
  | { kind: "week"; value: string }
  | { kind: "quarter"; value: string };

// Which board Status options back the TODO/Backlog meta columns (from workspace
// config), plus a hook to surface the add-to-board side effect (real shared
// mutation — must not be silent).
export interface StatusNames {
  todo: string;
  backlog: string;
  onAddedToBoard?: (num: number) => void;
}

export interface MutationApi {
  move(
    num: number,
    target: MoveTarget,
    bucket?: BucketChange,
    status?: StatusNames,
  ): Promise<boolean>;
  setTitle(num: number, title: string): Promise<boolean>;
  setState(num: number, s: "open" | "closed"): Promise<boolean>;
  setAssignee(num: number, assignee: string): Promise<boolean>;
  setMonth(num: number, month: string | null): Promise<boolean>;
  setNotes(num: number, notes: string | null): Promise<boolean>;
  setBody(num: number, body: string): Promise<boolean>;
  setLabels(num: number, labels: string[]): Promise<boolean>;
  setMilestone(num: number, milestone: string | null): Promise<boolean>;
  sendComment(num: number, body: string): Promise<boolean>;
  createIssue(payload: IssueCreatePayload): Promise<ApiIssue | null>;
  refresh(): Promise<void>;
}

export interface UseIssuesResult extends State, MutationApi {}

// Stale-while-revalidate cache: paint the board instantly from the last-known issue
// list on a cold reload, then revalidate in the background. The cache is real prior
// data (never mock), versioned so a shape change invalidates it safely.
const CACHE_KEY = "ghr:issues:v1";

function initState(): State {
  const cached = loadCache<Issue[]>(CACHE_KEY);
  if (Array.isArray(cached)) return { issues: cached, loading: false, loaded: true, errorMessage: null };
  return { issues: [], loading: true, loaded: false, errorMessage: null };
}

export function useIssues(onError: (msg: string) => void): UseIssuesResult {
  const [state, dispatch] = useReducer(reducer, undefined, initState);

  // Capture whether we primed from cache at mount: the first fetch is then a silent
  // background revalidate (no "Loading…" flash) instead of a cold load.
  const primedRef = useRef(state.loaded);

  // silent=true revalidates without blanking the board to the loading skeleton.
  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (!silent) dispatch({ type: "loading" });
    try {
      const data = await fetchIssues();
      const issues = data.map(fromApi);
      saveCache(CACHE_KEY, issues);
      dispatch({ type: "load", issues });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load issues";
      // Keep the cached board on a background revalidate failure; only surface the
      // error screen on a truly cold load with nothing to show.
      if (silent) onError(`Failed: ${msg}`);
      else dispatch({ type: "error", message: msg });
    }
  }, [onError]);

  useEffect(() => {
    void refresh(primedRef.current);
  }, [refresh]);

  // Keep the SWR cache in sync with optimistic mutations too, so a reload right after
  // an edit paints the edited board (background revalidate reconciles with the server).
  useEffect(() => {
    if (state.loaded) saveCache(CACHE_KEY, state.issues);
  }, [state.issues, state.loaded]);

  // Shared instance: another teammate's edits won't push to this client. Refetch when
  // the tab regains focus so a returning user sees current data instead of a stale board.
  // Always silent — a focus refetch must never flash "Loading…" over present data.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const failOrRevert = useCallback(
    async (num: number, forward: Partial<Issue>, backward: Partial<Issue>, op: () => Promise<unknown>): Promise<boolean> => {
      dispatch({ type: "replace", num, patch: forward });
      try {
        await op();
        return true;
      } catch (e) {
        dispatch({ type: "replace", num, patch: backward });
        onError(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return false;
      }
    },
    [onError],
  );

  const move = useCallback(
    async (
      num: number,
      target: MoveTarget,
      bucket?: BucketChange,
      status?: StatusNames,
    ): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;

      // Translate placement target → roadmap PATCH body (the canonical mapping).
      // `quarter` is stored as the first month of the quarter (legacy behavior).
      // TODO/Backlog placement is no longer app-only — it's the board Status
      // (is_todo deprecated; the UI stops sending it).
      function roadmapPatchFor(t: MoveTarget): {
        plannedMonth: string | null;
        plannedWeek: string | null;
      } {
        switch (t.kind) {
          case "todo":
          case "backlog":
            return { plannedMonth: null, plannedWeek: null };
          case "month":
            return { plannedMonth: t.value, plannedWeek: null };
          case "week":
            return { plannedMonth: null, plannedWeek: t.value };
          case "quarter": {
            const m = /^(\d{4})-Q([1-4])$/.exec(t.value);
            const firstMonth = m ? `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}` : null;
            return { plannedMonth: firstMonth, plannedWeek: null };
          }
        }
      }

      // No pinned project (status undefined) → legacy app-only placement:
      // is_todo drives the TODO column via the roadmap PATCH, no GitHub mutation.
      const legacyTodo = status === undefined ? target.kind === "todo" : null;

      // Board Status write (GitHub mutation, optimistic). `undefined` = no write.
      // Dropping into TODO/Backlog sets the matching Status option; dropping a
      // meta-column card onto a time column clears Status so placement (where
      // Todo status overrides planned dates) doesn't snap the card back.
      let statusWrite: string | null | undefined;
      if (status) {
        if (target.kind === "todo") statusWrite = status.todo;
        else if (target.kind === "backlog") statusWrite = status.backlog;
        else if (prev.projectStatus === status.todo || prev.projectStatus === status.backlog) {
          statusWrite = null;
        }
      }
      if (statusWrite !== undefined && statusWrite === prev.projectStatus) statusWrite = undefined;

      const rp = roadmapPatchFor(target);
      const forward: Partial<Issue> = { month: rp.plannedMonth, week: rp.plannedWeek };
      const backward: Partial<Issue> = { month: prev.month, week: prev.week };
      if (legacyTodo !== null) {
        forward.isTodo = legacyTodo;
        backward.isTodo = prev.isTodo;
      }
      if (statusWrite !== undefined) {
        forward.projectStatus = statusWrite;
        backward.projectStatus = prev.projectStatus;
        backward.projectItemId = prev.projectItemId;
      }
      let issuePatch: { labels?: string[]; assignee?: string | null; milestone?: string | null } | null = null;

      if (bucket && bucket.field === "label" && bucket.prefix && bucket.bucket !== null) {
        const prefix = bucket.prefix;
        const b = bucket.bucket;
        const newLabels = prev.labels.filter((l) => !l.startsWith(`${prefix}:`)).concat([`${prefix}:${b}`]);
        forward.labels = newLabels;
        backward.labels = prev.labels;
        if (prefix === "area") {
          forward.area = b;
          backward.area = prev.area;
        }
        if (
          newLabels.length !== prev.labels.length ||
          !newLabels.every((l, i) => l === prev.labels[i])
        ) {
          issuePatch = { labels: newLabels };
        }
      } else if (bucket && bucket.field === "assignee" && bucket.bucket !== null) {
        forward.assignee = bucket.bucket;
        backward.assignee = prev.assignee;
        if (bucket.bucket !== prev.assignee) issuePatch = { assignee: bucket.bucket };
      } else if (bucket && bucket.field === "milestone") {
        const m = bucket.bucket;
        forward.milestone = m;
        backward.milestone = prev.milestone;
        if (m !== prev.milestone) issuePatch = { milestone: m };
      }

      dispatch({ type: "replace", num, patch: forward });
      try {
        // Status first — it's the GitHub mutation (and the likeliest failure,
        // including the 409 github_not_linked case: jsonOrThrow raises the
        // Connect modal AND throws, so the rollback below still runs).
        if (statusWrite !== undefined) {
          const res = await patchIssueProjectStatus(num, statusWrite);
          dispatch({ type: "replace", num, patch: { projectItemId: res.itemId } });
          if (res.addedToBoard) status?.onAddedToBoard?.(num);
        }
        // Only PATCH roadmap if something actually changed.
        if (
          rp.plannedMonth !== prev.month ||
          rp.plannedWeek !== prev.week ||
          (legacyTodo !== null && legacyTodo !== prev.isTodo)
        ) {
          await patchRoadmap(num, {
            plannedMonth: rp.plannedMonth,
            plannedWeek: rp.plannedWeek,
            ...(legacyTodo !== null ? { isTodo: legacyTodo } : {}),
          });
        }
        if (issuePatch) {
          const updated = await patchIssue(num, issuePatch);
          // A milestone reassign changes milestoneDue (server-only field) — sync it
          // so the drift chip recomputes without a reload.
          if (issuePatch.milestone !== undefined) {
            dispatch({ type: "replace", num, patch: { milestoneDue: updated.milestoneDue } });
          }
        }
        return true;
      } catch (e) {
        dispatch({ type: "replace", num, patch: backward });
        onError(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return false;
      }
    },
    [state.issues, onError],
  );

  const setTitle = useCallback(
    async (num: number, title: string): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(num, { title }, { title: prev.title }, () => patchIssue(num, { title }));
    },
    [state.issues, failOrRevert],
  );

  const setStateFn = useCallback(
    async (num: number, s: "open" | "closed"): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(num, { state: s }, { state: prev.state }, () => patchIssue(num, { state: s }));
    },
    [state.issues, failOrRevert],
  );

  const setAssignee = useCallback(
    async (num: number, assignee: string): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(num, { assignee }, { assignee: prev.assignee }, () => patchIssue(num, { assignee }));
    },
    [state.issues, failOrRevert],
  );

  const setMonth = useCallback(
    async (num: number, month: string | null): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(num, { month }, { month: prev.month }, () => patchRoadmap(num, { plannedMonth: month }));
    },
    [state.issues, failOrRevert],
  );

  // App-only planning notes — PATCH /roadmap, never touches GitHub.
  const setNotes = useCallback(
    async (num: number, notes: string | null): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(
        num,
        { roadmapNotes: notes },
        { roadmapNotes: prev.roadmapNotes },
        () => patchRoadmap(num, { roadmapNotes: notes }),
      );
    },
    [state.issues, failOrRevert],
  );

  const setBody = useCallback(
    async (num: number, body: string): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      dispatch({ type: "replace", num, patch: { body } });
      try {
        // Send the version we started from so the server can reject a stale overwrite.
        await patchIssue(num, { body, baseBody: prev.body });
        return true;
      } catch (e) {
        dispatch({ type: "replace", num, patch: { body: prev.body } });
        const msg = e instanceof Error ? e.message : "Failed";
        onError(`Failed: ${msg}`);
        // On a 409 the local copy is stale — pull the latest so the editor shows the winning version.
        if (msg.startsWith("409")) void refresh();
        return false;
      }
    },
    [state.issues, onError, refresh],
  );

  const setLabels = useCallback(
    async (num: number, labels: string[]): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      // `area` is derived from the area:* label — recompute it so the optimistic
      // update keeps the Area meta row in sync until the next refresh.
      const area = labels.find((l) => l.startsWith("area:"))?.slice("area:".length) ?? "unassigned";
      return failOrRevert(
        num,
        { labels, area },
        { labels: prev.labels, area: prev.area },
        () => patchIssue(num, { labels }),
      );
    },
    [state.issues, failOrRevert],
  );

  const setMilestone = useCallback(
    async (num: number, milestone: string | null): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      dispatch({ type: "replace", num, patch: { milestone } });
      try {
        // milestoneDue only exists server-side — apply it from the response so
        // drift recomputes immediately instead of waiting for a full refetch.
        const updated = await patchIssue(num, { milestone });
        dispatch({ type: "replace", num, patch: { milestoneDue: updated.milestoneDue } });
        return true;
      } catch (e) {
        dispatch({ type: "replace", num, patch: { milestone: prev.milestone } });
        onError(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return false;
      }
    },
    [state.issues, onError],
  );

  const sendComment = useCallback(
    async (num: number, body: string): Promise<boolean> => {
      try {
        await postComment(num, body);
        return true;
      } catch (e) {
        onError(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return false;
      }
    },
    [onError],
  );

  const createIssue = useCallback(
    async (payload: IssueCreatePayload): Promise<ApiIssue | null> => {
      const tempNum = -Date.now();
      const optimistic: Issue = {
        num: tempNum,
        title: payload.title,
        body: payload.body ?? null,
        area: (payload.labels ?? []).find((l) => l.startsWith("area:"))?.slice("area:".length) ?? "unassigned",
        month: null,
        week: null,
        state: "open",
        assignee: payload.assignee ?? "unassigned",
        milestone: null,
        milestoneDue: null,
        comments: 0,
        labels: payload.labels ?? [],
        updatedAt: new Date().toISOString(),
        isTodo: false,
        roadmapNotes: null,
        effort: null,
        projectStatus: null,
        projectItemId: null,
      };
      dispatch({ type: "insert", issue: optimistic });
      try {
        const created = await apiCreateIssue(payload);
        dispatch({ type: "remove", num: tempNum });
        dispatch({ type: "insert", issue: fromApi(created) });
        return created;
      } catch (e) {
        dispatch({ type: "remove", num: tempNum });
        onError(e instanceof Error ? `Failed: ${e.message}` : "Failed");
        return null;
      }
    },
    [onError],
  );

  return {
    ...state,
    move,
    setTitle,
    setState: setStateFn,
    setAssignee,
    setMonth,
    setNotes,
    setBody,
    setLabels,
    setMilestone,
    sendComment,
    createIssue,
    refresh,
  };
}
