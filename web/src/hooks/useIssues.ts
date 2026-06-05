import { useCallback, useEffect, useReducer } from "react";
import type { ApiIssue, BucketingField, Issue } from "../../../shared/types";
import { fromApi } from "../../../shared/types";
import {
  createIssue as apiCreateIssue,
  fetchIssues,
  patchIssue,
  patchRoadmap,
  postComment,
  type IssueCreatePayload,
} from "../lib/api";

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
// `todo` flips the app-local TODO flag and clears any planned date.
// `backlog` clears everything.
export type MoveTarget =
  | { kind: "todo" }
  | { kind: "backlog" }
  | { kind: "month"; value: string }
  | { kind: "week"; value: string }
  | { kind: "quarter"; value: string };

export interface MutationApi {
  move(
    num: number,
    target: MoveTarget,
    bucket?: BucketChange,
  ): Promise<boolean>;
  setTitle(num: number, title: string): Promise<boolean>;
  setState(num: number, s: "open" | "closed"): Promise<boolean>;
  setAssignee(num: number, assignee: string): Promise<boolean>;
  setMonth(num: number, month: string | null): Promise<boolean>;
  setBody(num: number, body: string): Promise<boolean>;
  setLabels(num: number, labels: string[]): Promise<boolean>;
  setMilestone(num: number, milestone: string | null): Promise<boolean>;
  sendComment(num: number, body: string): Promise<boolean>;
  createIssue(payload: IssueCreatePayload): Promise<ApiIssue | null>;
  refresh(): Promise<void>;
}

export interface UseIssuesResult extends State, MutationApi {}

export function useIssues(onError: (msg: string) => void): UseIssuesResult {
  const [state, dispatch] = useReducer(reducer, {
    issues: [],
    loading: true,
    loaded: false,
    errorMessage: null,
  });

  const refresh = useCallback(async (): Promise<void> => {
    dispatch({ type: "loading" });
    try {
      const data = await fetchIssues();
      dispatch({ type: "load", issues: data.map(fromApi) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load issues";
      dispatch({ type: "error", message: msg });
    }
  }, []);

  useEffect(() => {
    void refresh();
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
    ): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;

      // Translate placement target → roadmap PATCH body (the canonical mapping).
      // `quarter` is stored as the first month of the quarter (legacy behavior).
      function roadmapPatchFor(t: MoveTarget): {
        isTodo: boolean;
        plannedMonth: string | null;
        plannedWeek: string | null;
      } {
        switch (t.kind) {
          case "todo":
            return { isTodo: true, plannedMonth: null, plannedWeek: null };
          case "backlog":
            return { isTodo: false, plannedMonth: null, plannedWeek: null };
          case "month":
            return { isTodo: false, plannedMonth: t.value, plannedWeek: null };
          case "week":
            return { isTodo: false, plannedMonth: null, plannedWeek: t.value };
          case "quarter": {
            const m = /^(\d{4})-Q([1-4])$/.exec(t.value);
            const firstMonth = m ? `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}` : null;
            return { isTodo: false, plannedMonth: firstMonth, plannedWeek: null };
          }
        }
      }

      const rp = roadmapPatchFor(target);
      const forward: Partial<Issue> = { month: rp.plannedMonth, week: rp.plannedWeek, isTodo: rp.isTodo };
      const backward: Partial<Issue> = { month: prev.month, week: prev.week, isTodo: prev.isTodo };
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
        // Only PATCH roadmap if something actually changed.
        if (rp.plannedMonth !== prev.month || rp.plannedWeek !== prev.week || rp.isTodo !== prev.isTodo) {
          await patchRoadmap(num, {
            plannedMonth: rp.plannedMonth,
            plannedWeek: rp.plannedWeek,
            isTodo: rp.isTodo,
          });
        }
        if (issuePatch) await patchIssue(num, issuePatch);
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

  const setBody = useCallback(
    async (num: number, body: string): Promise<boolean> => {
      const prev = state.issues.find((i) => i.num === num);
      if (!prev) return false;
      return failOrRevert(num, { body }, { body: prev.body }, () => patchIssue(num, { body }));
    },
    [state.issues, failOrRevert],
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
      return failOrRevert(num, { milestone }, { milestone: prev.milestone }, () => patchIssue(num, { milestone }));
    },
    [state.issues, failOrRevert],
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
        comments: 0,
        labels: payload.labels ?? [],
        updatedAt: new Date().toISOString(),
        isTodo: false,
        effort: null,
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
    setBody,
    setLabels,
    setMilestone,
    sendComment,
    createIssue,
    refresh,
  };
}
