# Backlog.md comparator: human browser workflows

**Research appendix:** prescriptions below are provisional ideas, superseded by the [consolidated report](REPORT.md). In particular, there need not be one uniquely next task, all metadata need not stay visible, and server-side cursors are an implementation option rather than a universal requirement. Readiness never grants execution authority.

**Research date:** 22 September 2026\
**Comparator:** [Backlog.md](https://github.com/MrLesk/Backlog.md), the Markdown-native tool bundled beneath Switchflow. This is **Backlog.md**, not the unrelated Nulab cloud product named Backlog.

**Public-code follow-up:** [Interaction review at a fixed v1.51.0 commit](research-backlog-code.md) adds drag timing/placement, conditional rendering, selection, navigation and failure-recovery evidence. Use those immutable references for the follow-up findings rather than assuming the `main` links below remain unchanged.

## Decision-relevant finding

Backlog.md is useful as a close, local-first comparator for task detail, navigation, filtering and dependency/readiness language. It should not be restored wholesale: it lacks Switchflow's owner-facing Intake, Planning, delivery and UAT workflow. The strongest borrowed patterns are a persistent, collapsible sidebar; an explicit derived **Ready** signal; a two-column task-detail modal with large Markdown editors; and bounded scroll areas for dense sub-elements. Current Backlog.md still renders the full comment history in its modal, so it is not a model for the requested history-pagination repair.

## Evidence and provenance boundary

| Evidence | What it establishes | Limit |
| --- | --- | --- |
| Current upstream v1.51.0 release and main-branch React source, checked 22 Sep | Documented/reviewable current Backlog.md browser behaviours | Source and release evidence, not a locally operated or human-tested instance. |
| Switchflow's pinned fork | Switchflow pins upstream tag `v1.50.1`, commit [`94c10a690b75f26ebfe8e337e74ffe02f2d459d7`](https://github.com/MrLesk/Backlog.md/tree/94c10a690b75f26ebfe8e337e74ffe02f2d459d7), then applies a local patch. | Historical native comparator only. It is two releases behind current v1.51.0 and has product-specific changes. |
| Current Switchflow documentation and browser assets | The normal product is the custom Switchflow workspace; it retains top navigation, custom views and the Backlog data handlers. `board:native` is explicitly diagnostic. | This review did not launch a fresh live board or collect participant usability observations. |

### Local provenance

* [`template/.switchflow/package-lock.json:10-18`](../../template/.switchflow/package-lock.json) pins the npm package to `1.50.1` and records its registry integrity.
* [`template/.switchflow/scripts/backlog-fork/manifest.json:1-11`](../../template/.switchflow/scripts/backlog-fork/manifest.json) pins the upstream tag, commit and source-archive SHA-256. [`README.md:1-15`](../../template/.switchflow/scripts/backlog-fork/README.md) explains that the source/cache is external and the fork is local.
* [`docs/backlog-ui-review.md:1-4`](../../docs/backlog-ui-review.md) says the native Backlog layout was rolled back and Switchflow's own top navigation is the selected interface. [`docs/browser-control.md:3-11`](../../docs/browser-control.md) defines the browser as the owner workspace and [`docs/browser-control.md:7`](../../docs/browser-control.md) identifies `board:native` as the retained diagnostic route.
* [`docs/verification-0.5.0.md:5-15`](../../docs/verification-0.5.0.md) records a custom-interface verification run and explicitly distinguishes the earlier native-interface trial as historical evidence at lines 32-45. This is useful package/rendering evidence, not human acceptance.

## The real Backlog.md workflows a person performs

### 1. Orient, find work, then act

In current Backlog.md, a person opens the local browser board, uses the persistent sidebar quick search to find a task/document/decision, then opens the item in place. The board supports drag-and-drop; current v1.51.0 also lets a person select several cards and move them together. The sidebar/search and in-place update behaviour are explicit v1.51.0 release claims, alongside retention of filters, scroll position and open modals after a data refresh.

* Primary evidence: [v1.51.0 release](https://github.com/MrLesk/Backlog.md/releases/tag/v1.51.0); it calls out sidebar quick search and preservation of filters, scroll and modals. [README Web Interface](https://github.com/MrLesk/Backlog.md/blob/main/README.md#web-interface) documents the board, multi-select, task forms and responsive browser surface.
* Source evidence: [`src/web/components/Board.tsx`](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/Board.tsx) filters task cards by milestone, assignee, labels, priority, type and project (lines 251-288); the move-selection flow begins at lines 301-365.

**Contrast with Switchflow:** the current custom shell has a top header and a horizontal workspace navigation ([`index.html:18-26`](../../template/.switchflow/scripts/control/public/index.html)); its views are mounted from the `board`, `tasks`, `milestones`, `documents`, `decisions`, `drafts`, `statistics`, `skills`, and `settings` set ([`app.js:55`](../../template/.switchflow/scripts/control/public/app.js)). This spends vertical space on global controls and makes destination scanning depend on horizontal labels. Backlog.md's sidebar is a more stable place for cross-cutting navigation and its collapsed mode keeps an icon rail available.

**Improvement implication:** move the project-wide destinations from the top bar into a persistent, collapsible left rail. Keep the top bar for project/context, connection state, global search, theme and the one primary creation action. This makes the active location continuously visible and releases vertical space for initiative/task content.

### 2. Decide what is next

Backlog.md's current task contract exposes a derived `isReady` verdict based on all declared dependencies: it is true only when an unfinished task has no unresolved dependencies. v1.51.0 says the web badge, CLI and TUI share that same computation. Its milestone swimlanes make the task's initiative-sized grouping visible on the board, while a task-detail dependency graph shows what blocks it and what it unblocks.

* Primary evidence: [v1.51.0 release](https://github.com/MrLesk/Backlog.md/releases/tag/v1.51.0) lists the shared readiness badge, milestone swimlanes and dependency graph.
* Contract evidence: [CLI instructions, lines 307-312](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md#stable-json-output) define `isReady`, the fail-closed readiness criteria and `dependencyGraph`/blocking fields. The [README](https://github.com/MrLesk/Backlog.md/blob/main/README.md#features) describes milestones and dependencies as making execution order reviewable.

**Contrast with Switchflow:** Switchflow already has the domain data for a stronger answer. It records the next human decision per initiative (`intake` -> review scope, `planning` -> review plan, `delivery` -> follow delivery, `uat` -> run the walkthrough) in [`app.js:142-144`](../../template/.switchflow/scripts/control/public/app.js). It also says exact Backlog task IDs are returned in approved plans and shown in the initiative's delivery-task section ([`docs/browser-control.md:56-58`](../../docs/browser-control.md)). But the board summary is distributed across cards: it reports the number needing attention and says the next decision is shown on each card ([`app.js:221-225`](../../template/.switchflow/scripts/control/public/app.js)). It does not establish one ranked **Next for you** item or one derived **Next agent task** item.

**Improvement implication:** create a compact, persistent "Next" panel above the board or in the new rail. It should show one highest-priority owner action (with its initiative, gate and reason), then a separate agent-work line only when delivery is authorized. The visible derivation must be deterministic: attention/recovery first, then Intake/Planning/UAT due for owner action, then the earliest `Ready` task in accepted phase order. Never infer authorisation from readiness; label it "Ready after approval" until the initiative grant exists.

### 3. Read and edit a task without losing context

Current Backlog.md's `TaskDetailsModal` uses a wide `max-w-5xl` modal, a 2:1 desktop main-content/metadata grid, and Markdown editors that are 320 px for Description and 280 px for Plan and Notes. It keeps parent/subtask navigation above the detail. The user can preview, press `E` to edit, use Ctrl/Cmd+S to save, and is asked before discarding dirty edits.

* Source evidence: [`TaskDetailsModal.tsx:1062-1235`](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/TaskDetailsModal.tsx) sets `max-w-5xl`, hierarchy navigation and the responsive grid, and gives Description a 320 px editor. [Lines 1537-1571](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/TaskDetailsModal.tsx) give Plan and Notes 280 px editors; [lines 467-496](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/TaskDetailsModal.tsx) define keyboard and dirty-close behaviour.

**Contrast with Switchflow:** the current custom task editor gives each textarea `rows="4"` ([`tasks-editor.js:10-13`](../../template/.switchflow/scripts/control/public/tasks-editor.js)) and only sets `min-height:100px` in CSS ([`tasks.css:1`](../../template/.switchflow/scripts/control/public/tasks.css)). The dialog has a nominal 820 px width and a sticky footer, but Description, block reason, plan, notes, final summary and the new comment field all share this small text treatment. The content sections are collapsible, which reduces initial density but forces repeated opening/closing when reviewing a full task.

**Improvement implication:** replace the all-fields form with read-first task detail and an explicit Edit mode. On desktop, reserve roughly two-thirds for the narrative and one-third for status/owner/milestone/dependencies. Make Description 320 px minimum, Plan/Notes 240-280 px, and allow resizing or a full-screen detail route. Keep metadata always visible; progressively disclose only seldom-used technical fields. Maintain the existing sticky save/footer and retained local draft behaviour.

### 4. Inspect discussion and long history

Backlog.md shows comments chronologically in the task modal and provides an inline comment composer. This is coherent for a small local backlog, but it maps every comment into the modal: current source has no comment page/window mechanism. It only bounds certain dense sub-elements: modified files use `max-h-64 overflow-y-auto`.

* Source evidence: [`TaskDetailsModal.tsx:1574-1620`](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/TaskDetailsModal.tsx) renders each comment and then the composer. [Lines 1367-1369](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/TaskDetailsModal.tsx) are a precise example of bounded nested scrolling for modified files.
* List-pagination evidence: [CLI instructions, lines 273-282](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md#paging-long-lists) provide `--max-count`/`--skip` windows and a `Next` command for long CLI lists. That is not evidence that browser comments are paginated.

**Contrast with Switchflow:** comments are mapped in full into the task editor ([`tasks-editor.js:13`](../../template/.switchflow/scripts/control/public/tasks-editor.js)); its insights screen likewise loops over every completed task to build its history table ([`insights.js:190-210`](../../template/.switchflow/scripts/control/public/insights.js)). The task board fetches the full task list and filters it client-side ([`tasks.js:37-42`](../../template/.switchflow/scripts/control/public/tasks.js)); it has no paging control. The initiative dialog deliberately preserves its outer scroll position on rerender ([`app.js:358-426`](../../template/.switchflow/scripts/control/public/app.js)), but that is preservation, not information hierarchy.

**Improvement implication:** do not copy Backlog.md's full-history modal. Use a preview plus explicit expansion:

1. Show the latest 3-5 comments/events, newest first, with author, time and a one-line semantic summary.
2. Give the event/feed region its own `max-height` and scroll only after the preview threshold.
3. Add "Show 20 older" / "Show all" cursor pagination, preserving the current task and focus. Use server-side cursors for comments, activity and completed-history tables rather than downloading full histories.
4. Keep workflow-critical state (current gate, blocker, next decision) above the scroll boundary, so it is never buried below chronology.

### 5. Search, filter and switch views

Backlog.md uses a global/sidebar search path plus board-level filters. Its release explicitly says it retains open modal, filter and scroll state after data updates; its board source applies the filters together before rendering. The milestone page has an inline search with clear action and a visible no-match recovery message.

* Source evidence: [`Board.tsx:251-288`](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/Board.tsx) and [`MilestonesPage.tsx:722-795`](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/src/web/components/MilestonesPage.tsx).
* Search scope: [README, lines 299-315](https://github.com/MrLesk/Backlog.md/blob/main/README.md#working-without-ai-agents) documents fuzzy search across tasks, docs and decisions and the ability to work manually or through agents over the same records.

**Contrast with Switchflow:** task search is only ID/title/description text plus visible Status, Owner, Label, Priority, Type and Milestone selects ([`tasks.js:8-29`](../../template/.switchflow/scripts/control/public/tasks.js)). The workspace Ctrl+K search does include initiatives and sends a query to the native search endpoint ([`workspace-search.js:1-32`](../../template/.switchflow/scripts/control/public/workspace-search.js)), but the primary navigation makes it less discoverable than a persistent sidebar input.

**Improvement implication:** make one clear global search control in the rail and retain context-scoped filters in each view. Reflect active filters as removable chips and show a result count. Persist filters, selected project and scroll position per browser tab; reset only when the user deliberately clears them. Search results should distinguish "initiative awaiting you", "ready delivery task", "blocked task", document and decision, instead of leaving the user to infer urgency from type alone.

## Recommended improvement sequence

| Priority | Change | Why it comes first | Human-verifiable success condition |
| --- | --- | --- | --- |
| P0 | Persistent collapsible sidebar; simplify top bar | It fixes orientation and creates a stable place for next action/search without changing workflow policy. | A user can identify current view, project, next action and open global search without scrolling. |
| P0 | Deterministic Next panel with owner/agent separation | It directly resolves "what should I do now?" and protects the Intake/Planning/UAT authority model. | Given mixed blocked, pending-UAT and ready tasks, the displayed next owner action is explainable from visible rules and never dispatches unauthorized work. |
| P1 | Read-first task detail, wide adaptive editor, metadata column | It addresses the current small four-row fields and reduces edit fatigue. | A 1,500-word description and plan are readable/editable without repeated scrolling or collapsing sections; narrow screens stack cleanly. |
| P1 | Bounded activity/comments/history with cursor pagination | It prevents a long historical record from hiding current work. | A task with 200 comments initially shows a compact recent slice; loading older entries retains focus, selected task and unsaved edits. |
| P2 | Unified global search plus retained scoped filters | It turns navigation and discovery into repeatable workflows rather than page-hunting. | Search filters persist across a refresh and the user can clear one filter or all filters deliberately. |

## What this comparator should *not* decide

Backlog.md's current source can validate patterns and its documented workflow, but it cannot demonstrate that those patterns solve Switchflow's human gates. Its browser has no equivalent of Switchflow's approval/recovery/run-admission model. The recommendation therefore keeps Switchflow's explicit owner controls and changes the presentation around them. Before implementation, the proposed sidebar, Next-panel ranking and long-history behaviour need a rendered Switchflow prototype and an owner walkthrough with real initiatives, task descriptions and histories.
