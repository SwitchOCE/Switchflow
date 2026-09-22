# Switchflow human interaction audit: source evidence

Reviewed 22 September 2026. This is the source interaction audit supporting the consolidated review. It covers the current served workspace in `template/.switchflow/scripts/control/public`; it does not treat historical browser checks as current visual proof. All findings below are verified source behavior or explicit design implications of that behavior. Pixel layout, timing, actual keyboard/screen-reader behavior and user comprehension require the parent's rendered walkthrough. No application files were changed.

## Outcome

The dominant problem is that the interface exposes editable records more effectively than it supports a person deciding what matters, reading that information, and returning to their previous context. The sidebar is a useful bounded improvement, but task reading, next-action explanation and scroll ownership need to be designed together. Making every region scroll independently would introduce another problem; use one primary reading surface, bounded auxiliary histories, and explicit loading of older records.

The current UI already has useful safeguards worth preserving: separate human Intake/Planning/UAT gates, action-specific explanatory copy, native dialogs, visible focus outlines, skip navigation, project-scoped draft recovery, read-only state explanations, explicit save controls, failed-save retention, milestone conflict handling and mobile breakpoints. These are not evidence of completed accessibility or usability acceptance.

## Scope and human action inventory

Paths below are relative to `template/.switchflow/scripts/control/public/`.

| Surface | Human actions inspected | Evidence |
| --- | --- | --- |
| Workspace shell | Home, project selector, add project, connection status, project search, theme switch, new initiative, nine navigation destinations, skip link | [index.html:18–24](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:18>); [app.js:549–660](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:549>); [styles.css:12–30](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:12>) |
| Initiative board | Search, refresh, five lifecycle stages, card selection, attention count, task preview, framework health | [app.js:196–226,497–547](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:196>); [index.html:28–38](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:28>) |
| Initiative creation | Title, desired outcome, optional dictation, detailed review option, start intake, cancel | [index.html:51–52](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:51>); [app.js:471–491,661–675](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:471>) |
| Intake and Planning | Read request/context/scope/plan, answer questions, approve scope/plan, retry, cancel active run, recovery hold | [app.js:228–253,356–398](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:228>) |
| UAT and completion | Open artifact references, record each result and notes, accept, request rework, read accepted walkthrough/evidence | [app.js:269–326,399–410](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:269>) |
| Initiative ancillary detail | Recent activity, active run, all run records, linked tasks, project update, scope change | [app.js:334–354,411–417](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:334>) |
| Tasks and Drafts | Search, seven filters, clear filters, Board/List, create/open/edit, status movement, drag ordering, promote, archive/completed archive, cleanup, ID repair | [tasks.js:4–132](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:4>) |
| Task detail | Title, status, priority, type, milestone, owners, labels, description/block reason, AC/DoD, dependencies/references/files, implementation/final summary, comments, save/close, restore draft, conflict compare | [tasks-editor.js:3–75](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:3>) |
| Milestones | Search, active/archive toggle, create/edit metadata, execution order, progress, task search/assignment/reassignment, archive/remove, concurrent-edit compare | [milestones.js:12–220](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:12>) |
| Documents and Decisions | Search, folder tree, read, heading navigation, record/external links, local images, copy code, create/edit, formatting, preview, save/cancel/retain/discard/compare | [knowledge.js:6–146](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/knowledge.js:6>); `documents.js`; `documents.css` |
| Insights | Refresh, task/draft/progress summaries, status/priority/milestone distribution, Done-task history | [insights.js:148–213](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:148>) |
| Settings | Refresh, project/display/task defaults, workflow toggles, DoD item add/remove, native-browser and advanced controls, save/discard/validation | [insights.js:232–341](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:232>) |
| Skills | Search, read skill/reference, headings, source Markdown, copy code, refresh, read-only state | [skills.js:8–89](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/skills.js:8>) |
| Cross-cutting | Loading, empty/no-match, offline/read-only, failure/retry, draft persistence, conflict/recovery, deep links, browser Back, resize, focus and keyboard reachability | Files above; `workspace-client.js`, `workspace-search.js` |

## Findings

Severity here describes human impact: **High** repeatedly prevents confident decisions or reliable review; **Medium** adds material navigation, reading or recovery work; **Low** is bounded polish or a smaller interaction defect. Each recommendation is a proposed improvement, not a claim that all comparison products use it.

### L01 — High: no project-level answer to “what should happen next?”

**Verified:** Initiative cards each have next-action text ([app.js:139–145,211–214](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:139>)), and the board shows an aggregate attention count ([app.js:221](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:221>)). Tasks are grouped by status and sorted by `ordinal` within the board ([tasks.js:31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:31>)), while the home preview simply takes the first eight task records ([app.js:504](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:504>)). Milestones sort by optional execution order, then title and ID ([milestones.js:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:2>)), displaying order and done counts ([milestones.js:42–47](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:42>)). There is no combined priority/eligibility explanation or distinct “next human decision / current agent work / upcoming eligible work” view in these renderers.

**Human consequence:** A Ready task, early milestone, top card and attention badge can each seem like a competing instruction. A person has to open records and interpret hidden relationships to decide what matters. “Order 2” is particularly liable to be mistaken for delivery authorization.

**Improve:** Add a compact “Needs you / In progress / Next eligible” section using the actual workflow's authoritative selection rules. Show why an item is next, what blocks alternatives, and whether ordering is merely suggested. Link directly to the pending decision. Never infer authority from milestone ID, display order, priority or a percentage.

**Acceptance:** In a fixture with a blocked early milestone, a Ready later task, one pending human decision and one active run, the user can identify each category and its reason without opening multiple records. No ineligible item receives an unqualified “Next” label. The first-eight home preview states its selection rule and has a displayed/total count.

### L02 — High: task details open as a long edit form with uniformly small prose boxes

**Verified:** [tasks-editor.js:10](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:10>) assigns `rows="4"` to every multiline field. Description and Block reason are always expanded; implementation plan, notes and final summary use the same helper (`:13`). `.sf-task-editor` is 820px wide with a 100px minimum textarea height ([tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>)); resizing is manual ([styles.css:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:2>)). There is no reading mode, task Markdown preview, expand-to-read control or autosize logic in the editor.

**Human consequence:** A long description/plan is presented as a small text-editing viewport, so the reader cannot scan its structure or compare sections. A one-line or empty block reason gets the same treatment as a substantial specification. Metadata takes the first part of the dialog before the person reaches the work description.

**Improve:** Open existing tasks in a readable detail view with task title as the primary heading, rendered prose, compact metadata, and explicit edit controls. For editing, grow prose fields to a sensible content limit and offer expanded editing. Collapse empty optional sections. Preserve plain-text/Markdown source and explicit save semantics.

**Acceptance:** A task with a 2,000-word description, lists, links, 15 AC items and long implementation notes can be scanned with one primary content scrollbar. Key metadata and close/save controls remain reachable at 1366×768, 390px width and 200% zoom. A short block reason does not consume an empty 100px box.

### L03 — High: task discussions and run records expand into the main detail scroll

**Verified:** All comments are rendered before the comment composer via `.map()` ([tasks-editor.js:13](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:13>)). `.sf-comments` has no bounded height ([tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>)). Every initiative run is rendered beneath activity through the generic recursive renderer ([app.js:103–119,411–414](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:103>)). The global dialog supplies the scrollbar ([styles.css:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:2>)).

**Human consequence:** Opening Comments on a mature task pushes the place to contribute below its full history. Reviewing one older run increases the distance to the current decision. Readers lose the identity and action context while scrolling through repetitive metadata.

**Improve:** Give Discussion and Activity distinct sections with a visible recent-count/total, newest meaningful content first, “Load older” or pagination, and an accessible bounded history region where appropriate. Keep the composer and current task/initiative identity readily accessible. Collapse each run to a human summary and expand its diagnostics deliberately.

**Acceptance:** With 100 comments and 50 runs, initial detail height/interaction effort is bounded; the newest content and composer are easy to reach, every older item remains accessible, and keyboard scrolling does not trap focus or unexpectedly scroll the underlying page.

### L04 — Medium: activity truncates at 25 without telling the user or offering older events

**Verified:** `renderActivity()` uses `.slice(-25).reverse()` ([app.js:344–346](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:344>)) and renders only those events with no limit notice or older-events control (`:347–354`).

**Human consequence:** The visible timeline appears complete even when earlier explanations are missing. This is a different problem from unbounded scrolling and needs explicit completeness cues.

**Improve:** Label “Latest 25 of N events” and provide access to earlier events; offer useful human filters such as decisions, questions, delivery and failures.

**Acceptance:** A 26-event fixture makes the limit visible and the oldest event retrievable without leaving the UI.

### L05 — Medium: navigation consumes two horizontal bands and loses destinations off-screen

**Verified:** Shell controls sit in `.topbar`, then nine destinations in `.workspace-tabs` ([index.html:19–24](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:19>)). Tabs are nonshrinking with horizontal overflow ([styles.css:20](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:20>)), while the header wraps at smaller widths ([styles.css:26,30](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:26>)). Neither navigation nor topbar is sticky. The introductory lifecycle panel is shown above the board on every visit ([index.html:28–31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:28>)).

**Human consequence:** Returning users spend vertical space on repeated explanation and must horizontally find less-used destinations. The project identity, controls and content compete for width.

**Improve:** Adopt the requested persistent desktop sidebar with project identity/picker, grouped navigation, clear current view and attention counts. Put local page actions beside the page title; use a drawer at narrow widths. Collapse or shorten the repeat introduction after onboarding. Preserve full labels in expanded mode.

**Acceptance:** All nine destinations are discoverable without horizontal tab scrolling on desktop; the mobile drawer opens/closes by keyboard and returns focus; project, current destination and pending attention remain identifiable during long reads.

### L06 — Medium: milestone editing moves the reader below the entire grid

**Verified:** The milestone grid is appended before the single editor ([milestones.js:32–34](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:32>)). Opening a milestone creates that editor and focuses its heading (`:61–65,124`). Close editor focuses the first button in the list, not the originating milestone (`:92`).

**Human consequence:** Opening a milestone far up a large grid jumps to a remote page position. Closing returns to an unrelated item. The user must reconstruct where they were.

**Improve:** Open a contextual side panel/detail route with milestone title, summary, linked work and next-state explanation. Restore the originating card, filters and scroll on close. Separate “view milestone” from destructive metadata operations.

**Acceptance:** Open the twentieth of 40 milestones, inspect a task, and return: the selected milestone and list position are preserved. Editing no longer requires traversing the rest of the grid.

### L07 — Medium: opening linked work discards initiative context

**Verified:** Initiative task buttons call `openTask()` ([app.js:339](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:339>)); that closes the initiative dialog, changes the main view to Tasks, and opens the task ([app.js:515–518](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:515>)). There is no initiative ID in the route writer, which supports task/record only ([app.js:562–568](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:562>)). Milestone task buttons also use this navigation ([app.js:602](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:602>); [milestones.js:139](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:139>)).

**Human consequence:** Checking a dependency or delivery detail while approving a plan becomes a navigation detour, with no “Back to [initiative/milestone]” context.

**Improve:** Preserve an origin breadcrumb/back action or open task detail as a child detail pane with deterministic return. Deep-link initiative selection as well as task selection.

**Acceptance:** From a scrolled initiative plan or filtered milestone, open a task and close/Back once to the same origin selection and reading position.

### L08 — Medium: closing a task leaves the task deep link active

**Verified:** Opening a task writes `?view=tasks&task=ID` ([tasks.js:53](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:53>)). The editor's close handler removes the dialog but invokes no navigation callback ([tasks-editor.js:70–75](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:70>)); the `navigate` argument is unused. Browser location handling reopens tasks in that route ([app.js:627–635](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:627>)).

**Human consequence:** Closing a task then reloading reopens the task the user just dismissed. The URL ceases to describe the visible workspace.

**Improve:** Make open/close part of the route state, preserving correct Back/Forward semantics and the board's filters/scroll.

**Acceptance:** Open→close→reload remains on the board; direct task links still open the intended task; Back/Forward each corresponds to the visible detail state. This is source-confirmed; the actual browser sequence remains a rendered verification target.

### L09 — Medium: changing filters leaves the total count looking like the result count

**Verified:** Filters include search, status, owner, label, priority, type and milestone ([tasks.js:8,16–19](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:8>)); render computes `shown` (`:27`) but the notice is set to total task count on refresh (`:41`). Board/List/filter selections are not stored in route or browser storage; new mounting initializes default state (`:5,8`; [app.js:612](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:612>)).

**Human consequence:** Users cannot tell how much work is hidden or easily reproduce a useful working view after reload/project switching. Seven selectors also impose scanning cost for a simple “my blocked work” question.

**Improve:** Show “12 of 148 tasks,” active filter chips and a visible reset; preserve per-project view state and make common attention/ready/blocked views easy to select.

**Acceptance:** Every filter change updates shown/total count; no-match state offers clear/reset; reload and project return restore the same meaningful view without leaking another project's filters.

### L10 — Medium: List view reuses full cards instead of supporting rapid comparison

**Verified:** Board and List both use `card()` ([tasks.js:22–31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:22>)). List CSS changes cards into rows but retains card metadata, badge and duplicated open/action controls ([tasks.css:3](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:3>)). No sort choice or column controls are rendered.

**Human consequence:** Users choose List expecting efficient comparison by owner, milestone, status and priority but still read stacked card-shaped content. Dense projects require substantial scrolling.

**Improve:** Provide aligned, compact rows with task title, status, owner, milestone and priority; allow sorting where meaningful and an explicit density option. Keep a card board for status movement.

**Acceptance:** A 30-task list supports comparing the same property down a column without opening records; long titles wrap sensibly; keyboard row navigation and a narrow-screen fallback remain usable.

### L11 — Medium: dependencies are editable IDs rather than readable relationships

**Verified:** Task dependency editing is a comma-separated ID field inside a disclosure ([tasks-editor.js:13](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:13>)). Full task cards print raw `blockReason` ([tasks.js:23](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:23>)), whereas the homepage specifically translates `dependent` into “Waiting for dependencies” ([app.js:509](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:509>)).

**Human consequence:** “dependent” does not say what the user is waiting for. To understand one blocker, the reader must remember IDs and search for each dependency.

**Improve:** Show linked dependency titles and states, distinguish “blocked by” from “blocks,” translate reserved reason codes consistently, and use a searchable relationship picker for edits.

**Acceptance:** A task blocked by two predecessors identifies both titles/states and opens them directly; users can add/remove the intended dependency without memorizing an ID or accidentally losing existing relationships.

### L12 — Medium: acceptance checks mix raw checklist syntax with two-checkbox rows

**Verified:** AC is edited as lines with `[x]`; existing DoD uses separate “Keep” and completion checkboxes, and a separate multiline add field ([tasks-editor.js:13](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:13>); parsing in [tasks-model.js:8–10,28–31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-model.js:8>)).

**Human consequence:** A person must learn two ways to perform the same checklist interaction. “Keep” is a deletion command expressed as a positive checkbox next to a completion checkbox, increasing the chance of clearing the wrong state.

**Improve:** Use consistent checklist rows with completion checkbox, readable criterion, edit and explicitly labelled remove controls; offer bulk text editing as an advanced alternative.

**Acceptance:** Checking an item cannot remove it; removal clearly targets its text and is recoverable before save; AC and DoD support the same keyboard model while preserving their different meaning.

### L13 — Medium: current gate actions sit below all context and prior plan content

**Verified:** Initiative detail appends request, summary, inventory/context, questions, blockers, scope and plan before gate buttons ([app.js:371–398](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:371>)); UAT and rework come later (`:399–406`). Only the task editor/settings have sticky action controls; initiative detail does not ([styles.css:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:2>); [tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>); [insights.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.css:1>)).

**Human consequence:** The next-action summary is visible early, but performing it requires traversing all context. This is especially costly on returning to a plan after reading supporting evidence.

**Improve:** Retain the current decision and action in a stable header/footer, with clearly linked sections for scope, plan and evidence. Keep approval consequence copy adjacent to the action, and avoid auto-enabling acceptance before checks are complete.

**Acceptance:** In a long-plan fixture, the reader can jump between decision, plan and evidence and return to the primary action without losing context. The approval consequence and any missing requirements stay visible.

### L14 — Medium: UAT lacks progress/resume navigation across a long walkthrough

**Verified:** Every check renders sequentially with a select and notes textarea ([app.js:301–325](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:301>)); accept is appended after all checks. There is no done/remaining summary, jump list or failed-check filter. Failed acceptance shows a general error rather than taking the user to the first pending/failed item (`:322`).

**Human consequence:** On a 20-check acceptance run, users must scan back through completed checks to discover what remains and where to resume. The distinction between “record failed result” and separate “request rework” is not made into a single coherent completion workflow.

**Improve:** Add checked/passed/needs-rework counts, jump to next unchecked, an accessible compact result overview, and a clear finish-review path that routes to acceptance or rework with the recorded failed observations.

**Acceptance:** Leave a mixed-result walkthrough halfway through and resume at the first unchecked item. Requesting rework clearly retains or deliberately includes relevant failed-check observations. Do not conflate agent test evidence with human acceptance.

### L15 — Medium: conflict resolution presents raw record data instead of a field comparison

**Verified:** Task latest-version comparison appends `JSON.stringify(latest,null,2)` ([tasks-editor.js:48](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:48>)) and offers “Keep my edits against this version” (`:49–52`). Milestone compare similarly displays JSON ([milestones.js:118–120](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.js:118>)). Document compare exposes JSON metadata and raw Markdown ([knowledge.js:90–99](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/knowledge.js:90>)).

**Human consequence:** The user must mentally compare machine-shaped records with their form, including unrelated fields. The global “keep my edits” wording does not tell them which saved changes would be overwritten.

**Improve:** Present only changed human fields with “Saved version / Your draft,” clear diffs and explicit per-field choices, retaining the existing revision safeguards and safe refusal when indexed DoD changes cannot merge.

**Acceptance:** A conflict in description plus labels identifies both differences without reading JSON; choosing one side for one field does not silently select the same side for unrelated fields.

### L16 — Medium: ordinary task close has no “discard my edits” path

**Verified:** Input is stashed to sessionStorage ([tasks-editor.js:18,57](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:18>)). Normal Close keeps the draft; reopening restores it (`:19–26,70`). The only “Discard my edits and close” control exists in the conflict panel (`:39–40`). Policy copy appears after the entire fieldset (`:13,33`).

**Human consequence:** A reader who experiments with a status/description then closes the form cannot clearly return to the saved version. Task behavior also differs from Documents' visible Keep/Discard choices and Settings' discard button.

**Improve:** Expose an accurate unsaved-changes state and explicit “Discard edits”/“Keep draft” semantics in a consistent location. Keep Close lightweight if draft preservation is intentional, but make that result visible.

**Acceptance:** Modify an existing task, close, reopen, discard and reopen again: the saved version is restored, without requiring a conflict or a browser storage reset.

### L17 — Medium: task review dialogs lack an accessible name

**Verified:** `showReview()` creates a dialog with an h2 but no `aria-label` or `aria-labelledby`, and that heading has no ID ([tasks.js:57–61](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:57>)). This path handles archive/promote/cleanup/duplicate-repair reviews. Other dialogs explicitly supply names ([tasks-editor.js:5](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:5>); [index.html:50–56](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:50>)).

**Human consequence:** Assistive technology cannot reliably announce which decision dialog opened; destructive confirmations especially need a clear named context.

**Improve:** Give each dialog a programmatically associated title and concise description; verify focus entry, focus containment and return to its exact trigger, especially when an Actions dialog is replaced by a confirmation.

**Acceptance:** Accessibility tree exposes the visible title as every review dialog's name; keyboard and screen-reader tests cover nested Actions→Archive→Cancel and return to the originating task.

### L18 — Medium: task ordering has no equivalent non-drag control

**Verified:** The sole UI for ordinal placement is drag/drop ([tasks.js:116–128](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:116>)). “Open / move” changes status/milestone through the editor but has no position field ([tasks-editor.js:13](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:13>)).

**Human consequence:** A keyboard or touch user can change status but cannot perform the same within-column ordering action as a mouse user. Visual ordering is already ambiguous enough to affect perceived “next task.”

**Improve:** Provide an accessible Move menu with status and position choices (top/bottom/before/after), and announce the resulting move. Explain whether display order affects delivery order.

**Acceptance:** The complete within-column and cross-column placement operation works without dragging and announces task, destination and position. Touch users receive an equally usable path.

### L19 — Medium: search gives an apparently complete, undifferentiated result list

**Verified:** Global search requests `limit=40`, reports `${matches.length} results`, and appends initiative matches before the returned task/document/decision results ([workspace-search.js:10–23](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/workspace-search.js:10>)). Results show only title, type and ID, with no matched excerpt or type filter. Milestones and drafts are absent from the advertised search scope ([index.html:55](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:55>)).

**Human consequence:** Common terms can produce 40 results with no indication that others were omitted. Repeated titles force users to open candidates rather than recognize the match. The user must know which separate area contains a record.

**Improve:** Group/filter by record type, show a concise matched excerpt and project context, make caps explicit and offer more results. State search scope clearly; add milestone/draft discovery if supported by the intended product scope.

**Acceptance:** A query matching over 40 records shows its limit and route to the rest; equally titled records are distinguishable before opening; keyboard navigation and result return are verified.

### L20 — Medium: mature boards and Insights still grow without a reading boundary

**Verified:** Board/list renders every shown task ([tasks.js:30–31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:30>)); initiative columns render every stage member ([app.js:206–216](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:206>)). Task stacks and initiative card lists have no maximum height ([tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>); [styles.css:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:2>)). Insights renders every completionHistory row ([insights.js:202–209](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:202>)); `.insights-table-scroll` has `overflow:auto` but no bounded height ([insights.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.css:1>)).

**Human consequence:** One long column/history sets the page's vertical burden; status headings and page controls disappear, and comparison across columns becomes harder.

**Improve:** Choose an explicit scroll policy per surface: viewport-bounded board columns with persistent headings, compact list pagination/load-more with range counts, and paged or bounded Done history. Keep long documents primarily page-scrolled rather than putting a scrollbar around every paragraph.

**Acceptance:** With 200 tasks, one 100-card status and 150 Done rows, navigation and controls remain stable; counts reflect visible and total records; loading older items preserves position and supports keyboard access.

### L21 — Medium: small text and repeated controls consume the card space needed for decisions

**Verified:** Task ID is 10px, metadata/status 11px, badges 10px, card action text 11px; card body padding is 17px with a separate action row ([styles.css:2](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:2>); [tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>)). The whole title/card button and “Open / move” both open the same editor ([tasks.js:23,100](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.js:23>)). Home repeats an explanatory hero above the board ([index.html:28–31](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/index.html:28>)).

**Human consequence:** Essential state and ownership receive small text while duplicate opening controls and large structural gaps consume space. This is a hierarchy/reading issue, not a claim of WCAG failure based only on font size.

**Improve:** Establish a small type/spacing scale: readable core metadata, explicit primary/secondary roles, one open affordance plus contextual menu, and compact/detailed density where appropriate. Make spacing follow content hierarchy rather than adding uniform empty area.

**Acceptance:** Rendered review at 100%/200% zoom shows readable task state/owner/milestone and a clear primary click target; density changes do not hide critical blockers or require color alone.

### L22 — Medium: document navigation and actions separate from the reader at narrow widths

**Verified:** At <=650px Documents stacks toolbar, up to 16rem of folder navigation, up to 10rem of TOC and then content ([documents.css:10](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/documents.css:10>)). Editor actions are at the bottom of the entire form and are not sticky ([knowledge.js:82](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/knowledge.js:82>); [knowledge.css:6](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/knowledge.css:6>)), unlike Settings. On desktop, document navigation is bounded but not sticky ([documents.css:5](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/documents.css:5>)); TOC is sticky (`:6`).

**Human consequence:** Opening a document on a narrow device leaves substantial navigation before its content; on a long read, the record picker can disappear. Saving a long edit requires reaching its bottom.

**Improve:** Use collapsible “Browse documents” and “On this page” controls on narrow screens, a persistent compact document identity/action bar, and a predictable desktop navigation rail. Keep prose width and existing local-link/image boundaries.

**Acceptance:** At 390px, opening a document reveals its title/body without scrolling through both navigation blocks; long edits keep save state/actions reachable; changing records retains the explicit draft safety behavior.

### L23 — Medium: Done-history rows cannot open the work they summarize

**Verified:** Insights builds task title and ID as noninteractive strong/span elements ([insights.js:203–207](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:203>)); no task navigation callback is used by the history renderer.

**Human consequence:** After finding an interesting completed outcome, the reader must navigate to Tasks and search its ID manually.

**Improve:** Make the task identity a real link to its read view, preserving return to the same Insights history page/filter. Maintain explicit “Last updated” labeling; do not rename that field “completed on” without evidence.

**Acceptance:** A history row opens the correct task by keyboard or pointer and returns to the previous history position.

### L24 — Low: adding a DoD default focuses the first row, not the new row

**Verified:** After appending and rerendering all rows, Add checklist item calls `list.querySelector('input:last-of-type')?.focus()` ([insights.js:314](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:314>)). Each row contains one input, so each input is its row's last input; querySelector returns the first matching input.

**Human consequence:** Keyboard users begin typing into an existing criterion instead of the newly added blank field.

**Improve:** Focus the newly appended row's input using its index/ID or an explicit retained node; apply matching focus recovery after removal.

**Acceptance:** With three existing criteria, Add focuses the fourth empty input; deleting it moves focus to a sensible adjacent row or Add button.

### L25 — Low: date-format settings promise behavior the workspace does not consistently provide

**Verified:** Settings offers YYYY-MM-DD, DD/MM/YYYY and MM/DD/YYYY choices and says “Changes display only” ([insights.js:287](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:287>)); Insights uses locale-based `Intl.DateTimeFormat` without reading that choice (`:141–146`), initiative activity uses `toLocaleString` ([app.js:350](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:350>)), and task comments print stored dates verbatim ([tasks-editor.js:13](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks-editor.js:13>)).

**Human consequence:** Users who choose a date style see several conflicting presentations and cannot infer which timestamps follow their preference.

**Improve:** Either scope the setting explicitly to its actual native surface, or apply a shared workspace formatter consistently; provide full absolute time on demand where compact relative dates are used.

**Acceptance:** Setting each supported format produces the documented presentation across task comments, initiative activity and Insights, or the UI clearly identifies the narrower setting scope.

### L26 — Medium: discarding a substantial document draft is immediate and irreversible in the UI

**Verified:** Discard draft and Discard saved draft are rendered beside ordinary edit actions ([knowledge.js:20,82](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/knowledge.js:20>)). Their handlers erase stored recovery content immediately with no undo or confirmation (`:135–136`). Settings discards all unsaved changes similarly ([insights.js:410–414](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.js:410>), function `discardSettings`).

**Human consequence:** A mistaken click can remove substantial unsaved writing. Draft preservation elsewhere raises the expectation of recoverability.

**Improve:** Offer immediate undo with retained recovery data, or confirm only when meaningful unsaved edits would be lost. Distinguish Discard from Cancel/Keep visually and verbally.

**Acceptance:** An accidental discard of a long draft has an obvious recovery path; an unchanged form can close without unnecessary confirmation.

### L27 — High: failed UAT observations are not submitted with rework and are then cleared

**Verified:** Per-check results and notes are collected only in the Accept handler, which refuses submission when any check is not passed ([app.js:319–324](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:319>)). The separate Request rework action sends only its overall feedback textarea ([app.js:327–332,404](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:327>)). On successful request-rework, `act()` clears all per-check result/note drafts via `clearUatDraft()` ([app.js:180–181,255–258](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/app.js:180>)). This conclusion is source-confirmed; no populated live UAT run was executed.

**Human consequence:** A person marks a check “Needs rework,” writes detailed observations into its Notes field, then enters “Please fix the failed check” in the overall feedback. The detailed observations are never included in the rework request and their local drafts are cleared after it succeeds. The UI invites useful human work that is not delivered to the agent.

**Improve:** Make the finish-review action submit the current per-check outcomes and observations with overall feedback, or explicitly carry the failed-check observations into a reviewable rework summary before submission. Preserve unsent observations until successful durable recording and make that recording visible.

**Acceptance:** Mark one check failed with unique notes, another passed, and one pending. Request rework with brief overall feedback. Verify all relevant per-check observations are durably recorded and visible in the rework history, and retained locally on request failure. Do not require the human to copy notes manually between fields.

## Important qualifications and preserved patterns

- The user's “always full histories” observation should be reported as a cross-surface inconsistency, not a literal universal rule. The milestone task list already has `max-height:30rem; overflow-y:auto` ([milestones.css:19](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/milestones.css:19>)); milestone descriptions have a 12rem cap (`:5`); task conflict/review preformatted blocks have a 300px cap ([tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>)); artifact previews have 60vh ([styles.css:9](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/styles.css:9>)); documents nav/TOC have 75vh/70vh limits ([documents.css:5–6](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/documents.css:5>)). These patterns can inform a coherent scroll policy.
- Task save controls already use a sticky footer ([tasks.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/tasks.css:1>)), and Settings has sticky save/discard controls ([insights.css:1](<C:/Users/keech/Documents/Switchflow/template/.switchflow/scripts/control/public/insights.css:1>)). Verify rendering/occlusion before claiming either is unusable.
- Task, document and initiative drafts are preserved by project and browser tab. The problem is inconsistent explanation and discard/recovery interaction, not absence of draft retention.
- Initiative cards already explain the next action; the missing piece is cross-project/initiative/task prioritization and authoritative eligibility explanation, not a total absence of next-action text.
- Native dialogs, labels, focus-visible styling, reduced-motion styles and several deliberate focus-restoration paths already exist. A complete screen-reader, touch and zoom audit was not performed by this source-review agent.
- No specific color-contrast failure is asserted without rendered/computed-color measurement. Small text, custom dark-theme overrides and white-on-teal surfaces should be measured in the rendered review.
- Documents and Skills have separate reading surfaces and a useful TOC; use this existing product pattern as a starting point for task reading rather than forcing users into editors.
- This audit did not execute agent runs, accept UAT, mutate live projects, or claim backend ordering correctness. Recommendations about “next work” must preserve the authority of approved scope, dependency readiness and current workflow gates.

## Suggested improvement sequence

1. **Define the interaction contract first.** Specify what “Needs you,” “Current,” “Next eligible,” “Blocked,” “Done” and “Archived” mean on each surface. Specify primary scroll owner, reading/editing transition, save/draft semantics and context-return behavior. This prevents a sidebar facelift from preserving the same decision ambiguity.
2. **Ship shell and core reading together.** Desktop sidebar/mobile drawer, compact returning-user overview, readable task detail, contextual navigation and stable action placement. Verify long records immediately, rather than only short demo data.
3. **Bound growing content.** Shared discussion/activity/history components with counts, older-record access, filters and clear time formatting; deliberate board/list/Insights scroll policy; UAT progress/resume controls.
4. **Improve relationship manipulation.** Dependencies, owners/labels, AC/DoD checklists, milestone detail and accessible ordering. Preserve revision/draft safety while replacing raw identifiers and machine-shaped comparisons.
5. **Unify recovery and accessibility.** Named dialogs, focus return, keyboard parity, undo/discard handling, low-vision/zoom/dark-theme verification, empty/no-match/offline/retry consistency.
6. **Validate the complete human journeys.** Start initiative → answer → approve scope → approve plan → inspect current/next work → inspect a linked task → return → review delivered evidence → run/resume UAT → request rework or accept → revisit accepted outcome. Separately test a long-lived project with crowded boards, many milestones, 100 comments, 50 runs, conflicting edits and disconnection.

## Evidence boundaries for consolidation

The parent reviewer should join these source findings to current rendered screenshots and official comparison workflow evidence. The source establishes why a behavior exists, while the browser establishes what the person actually sees and can do. Exact modal clipping, horizontal overflow, low-contrast states, tab counts and screenshots should be labelled rendered only when observed. Feature-by-feature parity with Asana/Jira/Trello/Plane/Backlog is not the objective; choose the comparison pattern that reduces a documented human cost while preserving Switchflow's three human gates.

Memory consulted only to locate the existing workspace and retained trial documentation: `MEMORY.md:108–133`, rollout ID `01a0b8c9-5c45-78f2-94a5-5d8f418a1cf0`. Current source and `docs/workspace-0.5.0.md` / `docs/verification-0.5.0.md` were read directly. Historic Atlas/Beacon trial coverage was not reused as current acceptance evidence.
