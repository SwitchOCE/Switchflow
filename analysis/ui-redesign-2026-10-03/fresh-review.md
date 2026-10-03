# Switchflow UI: independent review (fixture build, 2026-10-03)

**Verdict: ACCEPT WITH FIXES.** The structural redesign works: the sidebar, the read-first task drawer, bounded histories and the master/detail Milestones view are all in place. Two of the owner's explicit complaints are still visible, though: "what's next" and the half-width prose on Milestones. There are also several seams between editors and drawers that were plainly built by different hands.

Method: I used the fixture server on :65445 and tested at 1600×900, 1920×1080, 1100×800 and 375×812, in both themes. I ran the scale, ordered and empty scenarios, plus offline, conflict and active-run. I measured contrast in every view with a script. I steered an agent, edited and discarded tasks, documents and milestones, walked UAT and plan approval, used Ctrl K, and tabbed with the keyboard.

## Owner requirements

| Requirement | Status | Evidence |
|---|---|---|
| Topbar → sidebar | **Met** | Grouped sidebar (Work / Knowledge / Project tools), `aria-current`, a collapsible 60px rail and a mobile drawer. |
| Clear next milestone/task | **Partly** | The Overview "Up next" card says **0**, while the milestone detail shows "Next up: DEMO-1" and "Needs you" lists 5 ready tasks. Ordering needs one numeric edit per milestone, and 37 of 40 are still unordered. |
| Task text boxes fit content | **Met** | The task opens as a reading view. In edit mode the description is 628px tall, and Expand widens the drawer to 1860px. |
| Pagination / sub-scrolling instead of full histories | **Mostly met** | Discussion shows 10 comments, then "Show older (90 more)". List view pages 30 at a time, Insights pages 20, and initiative history scrolls inside a 420px box. Exceptions: the board's Done column renders all 150 cards, and Milestones scrolls twice (see P2-9). |
| Milestone page quality | **Partly** | The master/detail layout, progress, Next up and grouped linked tasks are good. Prose is half-width, there is a double scroll, and ordering is laborious. |
| Contrast / separation / spacing | **Partly** | Body text passes AA in every view in both themes. Panel borders are only 1.15:1 against the page (light) and 1.41:1 (dark). The attention badge is 2.12:1. |
| Markdown not half-width at 16:9 | **Partly** | The document reader is fine (660px prose plus a sticky table of contents). Milestone scope prose is capped at 543px inside a 1134px panel at 1920 (48%). |
| Dark mode blue/gray | **Met** | Body is `rgb(13,18,25)` with blue-gray surfaces and no green cast. |

## P1: blocks an owner requirement

**P1-1 · Overview / Milestones: two conflicting meanings of "next".**
- **Reproduce:** load the Overview in the default or "ordered" scenario.
- **Observed:** "Up next 0 – No approved plan has a task ready to start." At the same time, Milestones › Accept and launch shows "NEXT UP: DEMO-1 · Human", and "Needs you" lists DEMO-1…5 as "ready to start" with no rank.
- **Expected:** one canonical "next" per scope, shown the same way everywhere.
- **Fix:** rename the Overview card to "Next for agents", or fold human-owned Ready tasks into it under an owner label. Show the milestone's Next-up task on the Overview. Rank "Needs you" by milestone order, then priority.

**P1-2 · Milestones: sequencing is too costly to fix the root cause.**
- **Reproduce:** Milestones › Set order.
- **Observed:** a single number field per milestone. There is no drag handle (`draggable` count is 0) and no keyboard move. Putting 40 milestones in order takes 40 separate edits, so "Not yet ordered 28" stays.
- **Expected:** drag-to-reorder or move up/down in the list, as in Linear, Jira and Plane.
- **Fix:** add a reorder handle to `.ms-row` with Alt+↑/↓, plus a "Move to top of Upcoming" action. Write the order numbers in a single batch.

**P1-3 · Milestones: scope prose uses half the panel at 16:9.**
- **Reproduce:** 1920×1080, open any milestone.
- **Observed:** `.ms-prose` has a max-width of 543px inside a 1134px `.ms-detail`, and the right half is empty. This is the owner's explicit complaint.
- **Expected:** a readable measure that fills the panel, or a second column.
- **Fix:** put scope and linked tasks side by side at ≥1400px. Alternatively, raise the cap to about 72ch at 15–16px and reuse the Documents prose token, so tasks, milestones, initiatives and documents all share one measure.

## P2: material friction or visible inconsistency

1. **Documents and Milestones show "unsaved edits" when nothing changed.**
   - Reproduce: open Edit, then Close without typing.
   - Observed: Documents shows "Unsaved edits · kept in this tab" plus a Resume/Discard banner, and Milestones shows "You have unsaved edits to this milestone." The task editor handles the same case correctly ("No changes yet.").
   - Fix: compare the draft with the original before storing it or showing the label (as `tasks-editor.js:385` does).
2. **Three different editor action bars.**
   - Observed:
     - Task: a sticky right-aligned footer (Discard / Save changes).
     - Document: Close / Discard / Compare / Save document.
     - Milestone: inline and left-aligned (Save milestone / "Load latest; keep my draft" / Close editor). The milestone bar shows the conflict action even when there is no conflict, and its header reads "Edit m-1" instead of the title.
   - Fix: one shared sticky footer component, with a status on the left and Discard + primary Save on the right. Show the conflict actions only when there is a conflict.
3. **UAT: "Request rework" is buried.**
   - Reproduce: initiative › Checks, mark one check Needs rework.
   - Observed: the sticky bar still offers only a disabled "Accept delivered outcome". "Request rework" sits at y≈3650px, below all 20 checks. Underneath, a second footer still reads "Review checks / submit verdict" while you are already on Checks.
   - Fix: when any check is marked rework, make the sticky bar's primary action "Request rework (n)" and scroll to the feedback field. Hide the duplicate footer on the Checks tab.
4. **Plan approval has no adjacent alternative.**
   - Observed: the only footer action is "Approve plan & start delivery →". Changes are possible only through the collapsed "Add a project update" or "Propose a scope change".
   - Fix: add a secondary "Request changes" button next to Approve that opens the scope-change form.
5. **Initiative drawer is not addressable.**
   - Observed: opening an initiative leaves the URL as `view=initiatives`, whereas tasks get `&task=DEMO-1` and milestones `&record=m-2`. Back and Refresh lose the drawer.
   - Fix: add `&initiative=<id>`.
6. **Cold-load error state is wrong.**
   - Reproduce: `offline=true`, then load `view=tasks`.
   - Observed: "Overview" is the heading and the active nav item, the body is blank, "Cannot load the shared project registry." has no Retry, and the status stays "Connecting…". Every deep link also flashes Overview before the real view appears.
   - Fix: render the requested view's shell and active item from the URL. Show an error panel with Retry and the command for starting the server.
7. **"Decisions" means two things.**
   - Observed: the Overview reports "2 decisions" for UAT and plan reviews, but the Decisions view lists ADRs (1 Accepted).
   - Fix: call them "2 reviews" or "approvals".
8. **Attention signal is weak.**
   - Observed: the sidebar "Needs you" badge is 2.12:1 in dark mode (white on light blue), and badges are hidden entirely when the sidebar is collapsed.
   - Fix: use dark text or a darker fill to reach ≥4.5:1, and show a dot or count on the rail icons.
9. **Milestones double scroll.**
   - Observed: the 868px `.ms-list-pane` scrolls inside a page that also scrolls (document height 1518 at 900px). The bottom of the list is unreachable until the page has been scrolled.
   - Fix: make the list pane sticky with `height: calc(100vh - header)`, or let only the page scroll.
10. **Task reading view has no workflow actions.**
    - Observed: changing a Ready human task to In progress or Done requires Edit → select → Save. The drawer also closes after saving instead of returning to the reading view.
    - Fix: make Status, Owner and Priority editable in place in the properties panel, add a primary "Start" / "Mark done" button, and stay open after Save.
11. **Agents view seams.**
    - Routing fields stay editable while "Save routing" is disabled ("Editing paused…"). The fields should be disabled too.
    - A Failed or ended session still shows the composer. It should be replaced with "Add update on initiative →".
    - On mobile, the list and the detail are stacked on one screen, leaving a tiny transcript area. Use list → detail navigation instead.
12. **Board at 1600×900: the Done column is clipped by about 60px.**
    - Observed: Done renders all 150 cards, oldest first.
    - Fix: narrow the columns to fit five at 1600, and show Done as "Recent 20 + Show older", newest first, matching List and Insights.

## P3: polish

- **Inconsistent casing:** Priority and Type options are lowercase ("low/high", "feature/bug") while Status is capitalized. The reading view shows "High".
- **Refresh controls:** Initiatives, Documents and Decisions use a "Refresh" text button, Settings says "Reload", and Tasks and Drafts use an icon. Pick one, or remove them where the data is live.
- **Plural bug:** "1 skills".
- **Labels:** the sidebar says "Drafts" but the page says "Draft tasks". The Milestones filter says "Active" while the group heading says "In progress".
- **Stop confirmation:** Stop uses a native `confirm()`, unlike the app's own dialogs.
- **Composer toggle:** the selected state of Steer now / Queue is barely distinguishable (rgb(22,29,40) on a near-identical background).
- **Light theme:** the Codex avatar letter is 1.18:1. "Updated 04:30 PM", "200 tasks" and "1 document" are 4.39:1.
- **Type sizes:** 11px is used for 28 text nodes on the Overview. Body prose is 14px in tasks and milestones but 16px in documents.
- **Ctrl K:**
  - Milestones are not searchable.
  - "No matching records" appears above a matching "Go to Milestones" command.
  - Results show the raw "m-1" instead of the milestone name.
  - There is an empty band above the input.
- **Conflict banners:** the conflict state shows two stacked banners that say the same thing.
- **Duplicated lists:** Documents and Decisions list the same records twice (in the left rail and in the "All …" panel) when nothing is selected.
- **Framework health:** it is a sidebar item that opens a drawer, and the active item stays on the previous view.
- **Tab title:** it never names the view or the record.
- **Short screens:** the sidebar needs to scroll at 1100×800.
- **Empty states:**
  - The empty Overview leaves a large grid gap above "Waiting".
  - The empty Overview and Initiatives have no "New initiative" call to action.
- **Comment form:** the comment box asks for "Your name" in a single-owner local tool.
- **Mobile:**
  - Task properties (status, owner) appear only after the whole description.
  - The Agents composer still shows the "Ctrl+Enter" hint.

## What is good and should be kept

- **Task drawer:** keeps its place. Focus returns to the card on Esc. Drafts survive closing ("Restored unsaved edits"), and discarding can be undone.
- **Conflict handling on tasks:** keeps your edits and offers "Compare with latest".
- **Bounded histories:** Discussion, List, Insights and initiative history are all paged or scroll inside their own box.
- **Offline recovery:** live offline shows a clear banner and recovers automatically.
- **Guided UAT:** "0 of 20 checked", "Next unchecked", and Pass / Needs rework on each check.
- **Steering:** the composer gives clear "Sent. The agent reads it at its next step." feedback, and the message appears in the transcript.
- **Documents:** a reader with a sticky table of contents and a split editor with preview.
- **Accessibility basics:** a visible 1.6px focus ring, `role=option` milestone rows with complete aria-labels, and a skip link.
