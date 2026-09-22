# Trello and Plane: human-workflow comparison research

**Research appendix:** recommendations below are provisional alternatives. The [consolidated report](REPORT.md) governs scope, ranking, layout modes and scrolling choices; competitor features are not automatic Switchflow requirements.

**Research date:** 2026-09-22\
**Scope:** Current public first-party documentation and the official product screenshots embedded in it. This is interaction research for the Switchflow UI review, not a claim that either product's internal implementation should be copied.

**Plane public-code follow-up:** [Source interaction review](research-plane-code.md) adds immutable implementation evidence for drag/drop, conditional UI and grouped board loading. It supplements this documentation review; board paging must not be inferred to establish activity-history paging.

## Evidence boundary

Every claim below is marked **Documented** when the vendor's current help/docs explicitly describes it. **Official screenshot** means the documentation provides an annotated or illustrative image, but this reviewer did not operate a logged-in production account. There are **no direct live-product observations** in this note. Where a source does not describe pagination, panel scrolling, or a responsive breakpoint, this report says so rather than inferring it from a screenshot.

The comparison is useful because Trello optimises a personal, board-centred “what should I do now?” workflow, while Plane combines a project sidebar with dedicated personal-work, cycle, and saved-view surfaces. Neither model removes Switchflow's three human gates: Intake, Planning and UAT. Delivery and Complete are lifecycle stages, not additional human gates.

## Trello: observed product model from primary sources

### 1. Move between contexts without replacing the work surface

**Workflow — resume or switch projects** (**Documented; official screenshots**)

1. On any board, use the navigation bar to open the board switcher.
2. Search by board name, or choose a starred, recent, or Workspace board.
3. Press `Enter` to open it; `Esc` closes the switcher.
4. A person who works mostly from a fixed set can pin the switcher to the left edge as a sidebar, and can show it in compact list or grid form. Sections can be collapsed and that state is remembered.
5. Inbox, Planner, and Board can be viewed side-by-side and the divider is drag-resizable; double-click resets the panel sizes.

Why it matters for Switchflow: the request to turn the top bar into a sidebar is a mainstream, documented pattern. It provides a stable place for project/context switching while leaving the main surface for the user's current work. The key transferable detail is user control: pinning, compact/list choice, remembered collapse state, and resizable adjacent panels—not merely moving links left.

Evidence: [Navigate Trello — navigation, pinned switcher, resizing](https://support.atlassian.com/trello/docs/navigation-in-trello/) (documented; annotated screenshots). The same page identifies search, create, notifications and profile as global-header actions, while the board header contains view selection, filtering, sharing, and board settings. This separates global navigation from context-specific actions.

### 2. Answer “what is next?” at a personal, actionable level

**Workflow — start the day from Home** (**Documented; official screenshots**)

1. Open Home from the top-left Trello icon.
2. Inspect **Up Next**, which begins with overdue work assigned to the person, then mixes due-soon assigned work and mentions needing action; it finally shows overdue/upcoming unassigned board work as a safety net.
3. On a due card, use the immediate **Complete** action or open the card; on a conversation, use **Reply** inline; dismiss items that should not be personal next actions.
4. Go to the board only when the card requires project context.

This is a concrete prioritisation rule, not an undifferentiated activity feed. It is also bounded: Trello documents that only the next 20 due-date cards are displayed, a deliberate triage limit rather than an endless list.

Evidence: [Your Trello home page](https://support.atlassian.com/trello/docs/the-home-page/) (documented; official screenshots).

**Workflow — make time for selected work without losing board location** (**Documented; official screenshots**)

1. Expand Planner beside the board (`g`, then `p`).
2. Planner automatically shows due-date cards that are personal-board cards or shared-board cards assigned to the person.
3. Filter which board/card sources appear.
4. Drag a card from the board or Inbox into an open time slot, or open the card to edit it. The work stays in its original board/list; linking it to focus time does not change its due date.

Evidence: [Trello Planner](https://support.atlassian.com/trello/docs/trello-planner/) (documented; official screenshots). This is a useful contrast for Switchflow: a next-action surface can link to canonical workflow state without silently changing that state.

### 3. Find, filter, and create in the current context

**Workflow — recover a task and return to it** (**Documented; official screenshots**)

* Use global search to find cards/boards across Workspaces; advanced search supports operators, board and recency filters, description inclusion, and saved searches on Premium.
* On a board, use the visible Filter action for keyword, member, due date, and label. Keyboard users can open it with `f` and clear it with `x`.
* Search results expose extra card context on hover rather than forcing an immediate context switch.

Evidence: [Search for cards and boards](https://support.atlassian.com/trello/docs/searching-for-cards-all-boards/); [Navigate Trello](https://support.atlassian.com/trello/docs/navigation-in-trello/) (documented; search-result/board-header screenshots).

**Workflow — create with proportionate commitment** (**Documented; official screenshots**)

* Use `n` while a card is hovered to compose a new card directly below it in the list, retaining ordering context.
* Use the Inbox for unstructured capture and move an item to a board when ready; Trello suggests Today/This week/Later as an optional personal triage model.
* In table view, add items between rows and edit basic details in situ; use Calendar/Timeline only when date relationships are what the person needs to see.

Evidence: [Keyboard shortcuts](https://support.atlassian.com/trello/docs/keyboard-shortcuts-in-trello/); [Trello Inbox](https://support.atlassian.com/trello/docs/trello-inbox/); [Trello views](https://trello.com/guide/activate-views) (documented; official screenshots). Tradeoff: views and Planner add surface area and some are paid-plan features, so Switchflow should solve the common next-action case before adding a full calendar or many view types.

### 4. Read and edit substantive task content

**Workflow — improve a card description** (**Documented; official screenshot of editor toolbar**)

1. Open a card and edit its description with the rich-text toolbar.
2. Use headings, lists, link/image insertion, and the `/` quick-insert menu; keyboard shortcuts apply formatting without leaving the editor.
3. Use the title edit shortcut (`t`) when only the heading needs a change.

Evidence: [Format text in Trello](https://support.atlassian.com/trello/docs/how-to-format-your-text-in-trello/); [Keyboard shortcuts](https://support.atlassian.com/trello/docs/keyboard-shortcuts-in-trello/). The sources establish editing affordances, but do **not** document card-back width, textarea min-height, a full-screen mode, or history pagination. Do not claim those specifics as Trello evidence.

### 5. Keyboard and accessibility affordances

Trello documents an in-product shortcut reference (`Shift` + `?`), board switching, filtering, card-title editing, arrow/`j`/`k` card navigation, inline creation, archive, undo/redo, and a setting to disable keyboard shortcuts for accessibility or to prevent accidental actions. This is concrete evidence that speed features need an escape hatch and discoverability, rather than relying on invisible shortcuts.

Evidence: [Keyboard shortcuts in Trello](https://support.atlassian.com/trello/docs/keyboard-shortcuts-in-trello/) (**Documented**).

## Plane: observed product model from primary sources

### 1. Sidebar is a personal, configurable context map

**Workflow — configure the navigation for current work** (**Documented; official screenshots**)

1. Open the Filters icon in the sidebar.
2. Choose which personal/workspace sections stay visible, move lower-use sections to **More**, and drag items into a personal order.
3. Choose either accordion project navigation (nested sidebar items; other projects collapse when one opens) or horizontal tabs inside the project view.
4. If many projects exist, set a limit; Plane shows recently accessed projects in the sidebar and leaves the remainder in **More**.

Evidence: [Customize navigation](https://docs.plane.so/workspaces-and-users/customize-navigation) (**Documented; official screenshots**). This is highly relevant to Switchflow's topbar request: a sidebar should be both a recognisable global navigation rail and a way to keep active project context visible. It should not force every project and every feature into the first viewport.

### 2. Find your next task by a dedicated, personal view

**Workflow — check personal workload** (**Documented; official screenshot**)

1. Go to **Your Work** from the workspace.
2. Use tabs for assigned, created, and subscribed items.
3. Read workload grouped by Backlog, Not started, Working on, Completed, and Cancelled; inspect priority and state breakdowns, then choose the relevant work item.
4. Recent activity is available as a separate chronological section, not the only navigation method.

Evidence: [Plane Your Work](https://docs.plane.so/your-work) (**Documented; official screenshot**). Plane's model is informative for Switchflow: users need a compact personal queue that makes readiness/state visible before browsing the full historic record. It is not evidence that its exact status names suit Switchflow.

**Workflow — establish the current commitment and blockers** (**Documented; official screenshots**)

1. Open the project Cycle from the sidebar (or create one with `Q` / Add Cycle).
2. Use the active/upcoming/completed state to distinguish current planned work from later work; completed cycles can transfer incomplete items to an active/upcoming cycle.
3. In a work item, set a dependency such as **Blocked by** or **Blocking**; dated items display connector lines in Timeline, with date conflicts shown in red.
4. Group feature-scale work in Modules, where state and computed completion progress are visible; choose list, gallery, or timeline according to the question being asked.

Evidence: [Cycles](https://docs.plane.so/core-concepts/cycles); [Dependencies in Timeline](https://docs.plane.so/core-concepts/issues/timeline-dependency); [Modules](https://docs.plane.so/core-concepts/modules) (**Documented; official screenshots**). Tradeoff: cycles, modules and dependency timelines make commitment legible, but they create data-maintenance obligations. In Switchflow, show a clear next milestone/task even where dependencies are absent; offer dependencies only when the workflow genuinely needs them.

### 3. Open a task without immediately losing list context

**Workflow — choose the reading/editing canvas** (**Documented; official screenshots**)

1. Click a work item in a list or board.
2. By default it opens in a **side peek** alongside the source list. This deliberately preserves the list context.
3. Switch to **Modal** when focused overlay work is useful, or **Full screen** when description and detail require the whole viewport.
4. Use breadcrumb path, type badge, parent/sibling access, and the collapsible properties panel to retain hierarchy without burying the description under metadata.
5. Edit description; use the toolbar for sub-work items, dependencies, links, attachments, and pages.

Evidence: [Manage work items](https://docs.plane.so/core-concepts/issues/overview) (**Documented; official screenshots**). This directly supports the Switchflow modal concern: one fixed dialog is a poor fit for both one-line updates and lengthy decision/plan text. A side peek preserves navigation; an explicit full-screen route protects reading and editing depth.

### 4. Control history rather than creating a single unbounded feed

**Workflow — inspect only the history needed** (**Documented; no source statement about pagination**)

1. In the lower task detail area choose **All**, **Activity**, **Comments**, **Worklogs**, **Transition**, or **History**.
2. Use **Comments** for human discussion; use **Activity** for system events; use **Transition** to see who changed state and time in the prior state; use **History** for structured before/after property changes.
3. Filter the activity area by event type and switch chronology between newest-first (default) and oldest-first.
4. For description-specific audit, select the last-edited timestamp to inspect editor history.

Evidence: [Manage work items — Activity and collaboration](https://docs.plane.so/core-concepts/issues/overview) (**Documented**). The source documents tabs, filters, and a sort toggle. It does **not** document pagination, virtualisation, or a nested scrolling region; this report must not attribute any of those mechanisms to Plane.

### 5. Search, saved filters, creation, and return context

**Workflow — recover a work item or build a recurring queue** (**Documented; official screenshots**)

1. Press `Cmd/Ctrl+K` or use the top search icon. Results update as the person types and are separated into content-type tabs including work items, cycles, modules, views, pages, comments and projects.
2. In a project, open Filters; the dedicated filter row stays available below the main toolbar. Add state/priority/assignee/date conditions and see matching items update instantly.
3. Clear one condition with its X or Clear all; save an effective filter/layout/sort/display combination as a named View.
4. Use Plane's built-in workspace views—All Issues, Assigned to Me, Created by Me, Subscribed—or a project view with a stable URL.

Evidence: [Search workspace](https://docs.plane.so/workspaces-and-users/search-workspace); [Work Item Filters](https://docs.plane.so/core-concepts/issues/visualise_filter); [Views](https://docs.plane.so/core-concepts/views) (**Documented; official screenshots**).

**Workflow — capture without unnecessary form friction** (**Documented; official screenshot**)

* Use `N`, then `I` for the full work-item modal when title, description, assignee, state, priority, label, and dates need deliberate entry; half-written items are retained as Drafts.
* In a List or Board, use the inline quick-add row when title plus default properties is sufficient, then refine in the detail view.

Evidence: [Manage work items](https://docs.plane.so/core-concepts/issues/overview) (**Documented; official screenshots**). This suggests Switchflow should have a clear distinction between quick capture and a full, readable task editor, while preserving a user's partial prose.

### 6. Keyboard discovery and command hierarchy

Plane documents a `Cmd/Ctrl + /` shortcut reference, a sequence-oriented create model (`N` then `I` for a work item, `N` then `P` for a project), location shortcuts (`G` then `Y` for Your Work), and task-level changes such as `S` state, `P` priority and `A` assign. Workspace search is `Cmd/Ctrl+K`.

Evidence: [Plane keyboard shortcuts](https://docs.plane.so/support/keyboard-shortcuts) (**Documented**). For Switchflow, this supports providing a discoverable command/shortcut layer after primary visible controls are clear. Avoid introducing keys that conflict with rich-text editing or that cannot be disabled/ignored in an editable field.

## Transferable recommendations for Switchflow

These are recommendations, not findings that Switchflow already meets them. They should be validated against the actual current UI before planning implementation.

| # | Recommendation | Why it improves the human workflow | Tradeoff / guardrail | Comparison evidence |
|---|---|---|---|---|
| 1 | Replace the topbar's primary navigation with a persistent, collapsible left sidebar: project switcher, core sections, current project, and a **More** overflow. Remember each person's collapse/order choices. | Makes context and places to go visible while retaining the main width for task content. Trello offers a pinnable switcher; Plane makes sidebar contents/order personal. | Keep the rail narrow and do not put every feature/project in it. Keyboard/focus and small-screen fallback need design and testing. | Trello navigation; Plane customize navigation. |
| 2 | Add a first-class **Next for you** surface above general activity. Rank explicit actionable states: required owner decision, blocked task awaiting action, assigned ready task, imminent UAT/milestone due item. State why each item is next and link into its canonical project context. | Users cannot reliably infer the next action from a full history. Trello's Up Next has an explicit ordering and bounded result set; Plane isolates Your Work from activity. | The rule must be transparent and based on Switchflow's real gates, not a hidden score. Let users dismiss/return items without falsely completing them. | Trello Home; Plane Your Work. |
| 3 | On every project/milestone, surface current phase, its owner/gate, and one next task; show a separate “blocked by” cue when dependency or approval prevents progress. | Makes sequencing legible before asking a person to open records one by one. Plane makes active cycles/module state and dependency conflicts visible. | Do not fabricate a “next” task when readiness data is incomplete; say “needs planning/owner decision” and link to that decision. | Plane cycles, modules, dependencies. |
| 4 | Replace the single fixed task modal with three explicit presentation modes: context-preserving side panel, a generous modal for normal edits, and full-screen detail/editor for long plans, evidence and discussions. | A short status update and a multi-page plan have incompatible reading/editing needs. Plane formally offers peek/modal/full-screen modes. | Preserve unsaved drafts across mode changes; keep a clear close/back route to the originating list and preserve scroll/filter state. | Plane work-item detail modes. |
| 5 | In the full detail editor, make prose the main column and put metadata in a secondary, collapsible section. Give description and comment editors a practical minimum height, resize affordance, rich text/Markdown support, and a readable line length. | Dense metadata should not crowd out the material people are opening the task to read. Plane separates a collapsible properties panel and task body; Trello documents direct rich-text editing. | Exact width/height must be decided by rendered responsive testing, not copied from either vendor's screenshots. | Plane work-item detail; Trello text formatting. |
| 6 | Split task history into tabs or filter chips: **Discussion**, **Activity**, **State/transition**, and **Full audit**. Default to the human-relevant discussion/latest update, with a count and an explicit route to audit detail. Add event-type filters and newest/oldest ordering. | A single combined history forces users to scan system noise to find a decision or reply. Plane separates these mental questions and supplies filter/sort controls. | Preserve a complete audit trail and make the all-events view available; do not hide automation or approvals. | Plane activity and collaboration. |
| 7 | For long histories, define and test a bounded rendering strategy: pagination or explicit “load older” with a visible result count; independently scroll the history only where it does not trap keyboard focus. | This directly addresses the reported unbounded vertical pages and reduces loss of task context. The comparison sources support history filtering/sorting, not a claim that Trello/Plane paginate. | Record the chosen accessibility contract: focus order, screen-reader announcement for added results, return scroll position, and URL/share behavior. | Plane activity filters/sort; evidence boundary above. |
| 8 | Make filters a persistent, reversible work-control row and allow a saved “My ready work” / “Awaiting my decision” view. Add global search that returns type-labelled results and preserves/reopens the original list context. | People need to narrow a large workset without navigating away or re-creating queries. Plane uses a dedicated filter row and reusable views; both vendors support cross-context search. | Start with a small high-value filter set (state, owner, phase, milestone, due/blocked) before a complex query language. Clearly show and clear active filters. | Plane filters/views/search; Trello filter/search. |
| 9 | Offer quick capture separately from full authoring: a small “capture task/idea” path and a fuller task form with draft recovery. Put Create in the global navigation, while contextual add appears in task/milestone lists. | Lets people record a thought without abandoning their current workflow, but does not make substantial planning prose live in a cramped composer. | Captured items must land in a visible inbox/untriaged state with an owner/triage route, never silently disappear into general history. | Trello Inbox/inline create; Plane inline add/drafts. |
| 10 | Add a discoverable keyboard reference and a modest set of high-confidence shortcuts only after visual actions work: open search, create, navigate to My Work, filter, open/close detail. Respect editable fields and provide a user setting to disable shortcuts. | Helps experienced users move between work without hiding the product from mouse/touch users. Trello explicitly provides discovery and disabling; Plane publishes comprehensive navigation/create actions. | Accessibility audit must cover focus indicator, Escape behavior, modal focus restoration, and no single shortcut may be required for a core workflow. | Trello keyboard shortcuts; Plane keyboard shortcuts. |

## Suggested validation scenarios for the main review

Use these as human walkthroughs against Switchflow before committing to visual solutions:

1. **Morning triage:** open Switchflow and identify one meaningful next action in under 10 seconds. Verify the explanation states project, milestone/phase, gate, owner and blocking condition if any.
2. **Resume deep work:** filter to a project, open a long task, read/edit a multi-paragraph description, check related decision and recent discussion, then return to the same filtered list and scroll position.
3. **History investigation:** find who changed a task from Planning to Delivery, when, and why, without scanning comments or the entire page; then load older audit entries without the page jumping.
4. **Context change:** switch projects through the sidebar, navigate to a task from global search, and return to the prior project/view. Test both collapsed and wide navigation.
5. **Keyboard and narrow view:** perform search, task open/close and next-item selection with keyboard; check focus restoration, editor shortcut safety and the narrow-layout navigation path.

## Source list and evidence limitations

All sources are current vendor-controlled documentation accessed 2026-09-22. Trello sources are Atlassian Support or Trello's official guide; Plane sources are Plane's official documentation. They document features and embed official images, but are not usability studies and do not prove effectiveness for Switchflow users. Product tiers can limit some competitor features; do not create a Switchflow requirement merely because a paid tier exposes it.

* [Trello: Navigate Trello](https://support.atlassian.com/trello/docs/navigation-in-trello/)
* [Trello: Home page](https://support.atlassian.com/trello/docs/the-home-page/)
* [Trello: Planner](https://support.atlassian.com/trello/docs/trello-planner/)
* [Trello: Inbox](https://support.atlassian.com/trello/docs/trello-inbox/)
* [Trello: Search for cards and boards](https://support.atlassian.com/trello/docs/searching-for-cards-all-boards/)
* [Trello: Keyboard shortcuts](https://support.atlassian.com/trello/docs/keyboard-shortcuts-in-trello/)
* [Trello: Format text](https://support.atlassian.com/trello/docs/how-to-format-your-text-in-trello/)
* [Trello: Views guide](https://trello.com/guide/activate-views)
* [Plane: Customize navigation](https://docs.plane.so/workspaces-and-users/customize-navigation)
* [Plane: Your Work](https://docs.plane.so/your-work)
* [Plane: Manage work items](https://docs.plane.so/core-concepts/issues/overview)
* [Plane: Cycles](https://docs.plane.so/core-concepts/cycles)
* [Plane: Modules](https://docs.plane.so/core-concepts/modules)
* [Plane: Dependencies in Timeline](https://docs.plane.so/core-concepts/issues/timeline-dependency)
* [Plane: Work Item Filters](https://docs.plane.so/core-concepts/issues/visualise_filter)
* [Plane: Views](https://docs.plane.so/core-concepts/views)
* [Plane: Search workspace](https://docs.plane.so/workspaces-and-users/search-workspace)
* [Plane: Keyboard shortcuts](https://docs.plane.so/support/keyboard-shortcuts)
