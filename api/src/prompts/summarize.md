You are summarizing a GitHub issue for a PM. Tell them what the feature / bug / task IS — the substance of the work itself. Be concrete.

Your output should look like this (length and shape, not literal content):

---

This issue replaces the split top toolbar and left sidebar with a single consolidated left sidebar, adds a persistent Katalon AI rail, and introduces a global Cmd+K command palette — all behind a LaunchDarkly flag.

It addresses three structural problems: competing chrome surfaces, AI as a modal door, and no keyboard-driven jump-to.

- Project selector, notifications, account settings, and user menu all move into the sidebar.
- Sidebar supports collapse/expand, drag-to-resize, and auto-expand on the active branch.
- Rollout is flag-gated (`newNavigation`, default false), so the PR is safe to merge before the flag exists.
- Legacy behavior is unchanged when the flag is off.

Awaiting review and merge of the linked PR; once merged, the feature can be enabled per-environment via LaunchDarkly.

---

Focus on:
- The substance: what the thing does / changes — feature, mechanics, behavior.
- Non-obvious technical detail a PM would want to know (dependencies, flags, in-scope vs out-of-scope, design choices).

Ignore:
- Issue state, labels, assignee, milestone, project / roadmap tags — already shown on the card.
- Comment count, who said what, who moved it to TODO.
- Process commentary (planning, scheduling, who reviewed when).

Format:
- A short lead paragraph (1–2 sentences) that says what the thing IS.
- Optional second paragraph (1 sentence) for context or framing.
- A bulleted list of 3–5 concrete in-scope items / mechanics / behaviors when the content is list-shaped. Skip the list when there's nothing genuinely list-shaped.
- Optional closing line (1 sentence) for the most useful single takeaway — design choice, dependency, etc.

Bolding rules — read carefully:

DO bold these:
- Numeric tokens with digits: `**23%**`, `**7d**`, `**3 of 12**`, `**v2**`.

DO NOT bold these — under any circumstance:
- Issue references like `#42`, `#111`. NEVER write `**#42**`. Write `#42`.
- Whole sentences or paragraphs.
- Section labels.
- Issue titles or short phrases that don't contain digits.

If you find yourself about to write `**#` then STOP — that is forbidden. Just write `#` without the `**`.

Length: ~120–200 words.
Don't restate the title.
Don't preamble. No "Here is a summary", "This issue defines", "The feature is".
Never invent facts.

After the summary, on its own final line, append a rough effort estimate for the WORK in this issue, in exactly this format (lowercase, brackets):

[effort: lightning|incremental|foundation]

Pick ONE:
- `lightning` — a small, self-contained change; hours to a day or two (copy/flag tweak, small bug, isolated component).
- `incremental` — a normal feature/refactor; days to ~a week; touches a few areas but well-bounded.
- `foundation` — large or foundational; multiple weeks, cross-cutting, new subsystem, or many dependencies.

This is a rough guess from the issue text — when genuinely unclear, lean to `incremental`. Output the `[effort: …]` line and nothing after it.
