# Shell, overview and human gates

Implemented the assigned slice in the template control UI; no live data, approvals, real agent runs, commits or pushes were performed.

- F01/F02: Overview separates initiative decisions and Ready Human tasks. Needs you, Agent working, Next eligible and Waiting include origin actions and explicit reasons. Only a matching active runtime run with status running is presented as working; stale initiative status and interrupted recovery remain explicit. The first unfinished exact task in an ordered approved plan is eligible only when its current approved scope matches, prior tasks/prerequisites are Done, and the task is Ready with no blocker. Prose/duplicate/missing task IDs and stale authority are unresolved; blocked prerequisites name title/ID/status. Independent plans have no invented global priority. Ready Human tasks are never described as authorized.
- F03/F24/F30/F31: grouped desktop sidebar, collapsible navigation, narrow drawer with Escape/backdrop/close and keyboard focus handling; persistent visible connection state; compact overview, readable prose/metadata, state-specific task load failure and uncertain action feedback. Existing write/admission guards remain separate from presentation.
- F14/F15: events and runs have 10-record pages, type/status filters, ranges and collapsed individual run details. All retained records are accessible. The UI explicitly discloses the existing runtime retention caps (200 events, 100 runs); this does not restore previously discarded records.
- F20: shell passes task close callbacks; closing clears task detail from the route. Linked tasks preserve source route/view/scroll and initiative context, with history state for Back/Forward. Task worker owns editor close suppression and persisted task worksets.
- F21: sticky current-decision region with approval consequence copy; header jumps to Scope/Plan/Evidence/Checks. Existing human approvals and stopped-process confirmation remain intact.
- F22: one navigable UAT scenario at a time with checked/remaining/rework counts and next-unchecked resume. Notes/results use existing session draft persistence and generation guards. Rework submits every check result; lifecycle validates IDs/statuses/lengths before mutation, saves immutable check titles/results/notes, candidate evidence and plan hash in the rework message, and only then clears the current checks for delivery. The user can reopen Previous rework observations; the correction workflow already receives messages in its state snapshot. No acceptance is inferred.

## Evidence and review

- `node --test scripts/shell-gates.test.mjs`: 8/8 passed. Synthetic overview classification, 26-event/50-run completeness, check-linked rework serialization/reopen, invalid/stale IDs and oversized notes rejecting without partial changes, legacy payload retention, approved task order/authority/dependency/ambiguity matrix.
- `node --test scripts/control.test.mjs`: 11/11 passed. Existing lifecycle authority, stale approvals, rework, restart, automatic continuation, cancellation, recovery and local HTTP protections.
- `node --check` for app.js and lifecycle.mjs passed; `git diff --check` passed (unrelated CRLF advisory warnings only).
- Lightweight source review found and fixed project-switch close ordering, intermediate task-route history entries, stale running presentation, and uncertain action feedback. These are local/source/synthetic results; parent owns integrated rendered validation and Human acceptance remains unobserved.

## Integration

Register `overview-model.js` in server staticFiles (parent owns whitelist). No new workspace view names: `board` is Overview. Shared search styles added for supporting worker's scopes, help, snippets and selected row. Insights receives `onOpenTask`; task panels receive `onClose` and support suppressed closes during route traversal.

Check desktop/narrow drawer layout and focus, long initiative sticky decisions, all 20 UAT scenarios, rework notes after reopen, task Close then refresh, initiative/milestone task links with Back/Forward, and 26-event/50-run fixtures in parent's disposable browser harness. Parent can make final integration fixes in these files after this handoff.


Parent rendered-review follow-up: Overview now retains In Progress tasks in a bounded Recorded task state group with explicit execution-unverified wording, while Agent working continues to require runtime evidence. Needs you states initiative decision and Ready Human counts separately. Next eligible includes milestone-order ambiguity counts and a Milestones route. Milestones use a read-only native fetch cached for 30 seconds, invalidated after UI mutations, with project-epoch and request-entry checks preventing stale response application. The additional synthetic fixture covers 40 unsequenced milestones, tied order and recorded versus active execution.


Second rendered-review follow-up: Previous rework observations now uses 10-review pages and collapsed review summaries (date, feedback, checked/failed counts). Expanded reviews show concise observed check titles/results/notes inside a bounded region; untouched pending checks are a count with an explicit title-list disclosure. Candidate evidence is optional and collapsed. There is no generic repeated ID/By/At/empty field dump. Lifecycle now stamps Human/at only for a completed result or nonblank note, stripping those fields from untouched pending checks. The 20-check regression preserves failed notes and an interrupted pending note, omits authorship from 18 untouched checks, and confirms approvedUat remains null. Focused plus lifecycle suites: 19/19 passed after this change.
