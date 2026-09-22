# Rendered Switchflow observations

Date: 22 September 2026. Read-only review of the existing local Switchflow service at `http://127.0.0.1:65315`, with Anagrind selected. No task, milestone, approval, settings or project record was saved or changed. Search, view selection, disclosure controls and viewport were used. Temporary viewport overrides were reset.

Current Switchflow checkout: `763297bf791771a9a3d2633630960b625f290d73`. All 21 served public UI files match this checkout after CRLF/LF normalization; [comparison manifest](live-source-comparison.json) records local SHA-256 hashes and individual match results. This ties the rendered observations to the source review; it does not verify every service/backend module.

## Direct observations

| ID | Walkthrough / evidence | Observed result |
| --- | --- | --- |
| R01 | Open Initiatives; [narrow capture](screenshots/01-overview-narrow.png), [1440 × 1000 capture](screenshots/02-overview-desktop.png) | Zero initiatives; header says 0 need attention. Same project has 97 tasks, including Ready Human-owned work. Intro, empty board and onboarding occupy most of the first screen; task preview starts below them. |
| R02 | Open Tasks; [desktop board](screenshots/03-task-board-desktop.png) | 97 tasks: 4 Backlog, 6 Ready, 1 In Progress, 3 Review, 20 Blocked, 63 Done. Five of the six Ready tasks are Human-owned. No project-wide next-action recommendation. Six horizontal columns exceed available working width. |
| R03 | Open AN-35; [description](screenshots/04-task-description.png) | Description is 576 characters; textarea client width 730 CSS px, client height 100 px, scroll height 139 px at desktop review viewport. Long content opens directly in editing controls. Empty Block reason receives the same 100px treatment. |
| R04 | Expand Implementation & final summary; [long notes](screenshots/05-task-long-notes.png) | Implementation notes are 3,404 characters; textarea is 730 × 100 CSS px, scroll height 705 px, rows attribute 4. The visible field height is about 14% of its total scroll height. This is a geometric measure, not a measured comprehension score. |
| R05 | Close AN-35, inspect URL, refresh, wait for load | Dialog disappears but URL retains `&task=AN-35`. Once refresh finishes the dialog reopens. No edit was submitted. |
| R06 | Open Milestones; [milestone grid](screenshots/06-milestones.png) | All 17 milestones are labelled Unsequenced. Alphabetical ordering puts “Accept and launch the full release” first. Contract/addendum records have 0/0 tasks. Completed and incomplete milestones appear together. Several cards expose literal `## Goal` text and individual small description scrollbars. |
| R07 | Click Edit m-16; [editor below grid](screenshots/07-milestone-edit-jump.png) | Focus and viewport move to the editor after all milestone cards, next to the last card rather than the selected first card. The task assignment list appears further below, with its own bounded scrolling. Closed without saving. |
| R08 | Open Documents → Task contract; [reader](screenshots/08-document-reader.png) | Reader already provides formatted Markdown, independently scrollable document navigation, heading links and code-copy controls. This is a useful internal pattern to reuse for task prose. Read only. |
| R09 | Open Insights; [statistics](screenshots/09-insights.png) | 65% “Share marked Done” is correctly qualified. Milestone distribution uses IDs rather than outcome names; 96 of 97 tasks have no priority. Done-task table follows all distributions and contains 63 entries. These statistics do not identify the next owner action. |
| R10 | Open global search and type “search”; [results](screenshots/10-global-search.png) | 40 results presented as one list of title + type + ID. No state/owner/blocker, result-type tabs or continuation is visible. Source request limit is 40; this observation does not establish total possible matches. |
| R11 | Open New initiative at 390 × 844; [creation form](screenshots/11-create-initiative-mobile.png) | Clear outcome prompt, title, dictation alternative, optional detailed review and Start intake action. Form fits reasonably within the narrow dialog. Nothing submitted; no agent started. |
| R12 | Open Tasks at 390 × 844; [mobile task view](screenshots/12-tasks-mobile.png) | Global controls, horizontally scrolling destination tabs, heading, search, layout and six filters fill the first screen. No task card is visible above the fold. Connection indicator is hidden at this size. |
| R13 | Search Tasks for AN-35 | One matching task remains, but status still says “97 tasks.” Empty board columns remain, placing the match in the third column. Switching to List exposes the single match without board panning. |
| R14 | Open AN-35 at 390 × 844; [mobile task detail](screenshots/13-task-mobile.png) | Seven metadata controls precede Description. Its label is near the bottom of the first screen, with content below the visible working area. Title is a single-line input that clips the end. Sticky Close/Save footer remains present. |
| R15 | Open Decisions, Drafts, Skills and Settings | Destinations load. Decisions has six records; Drafts is a separate work-item collection, not a browser-unsaved-edit recovery centre. Settings clearly labels several native-only fields, but mixes them into the general workspace Settings page. Skills is labelled Read only. No settings changed. |

## Boundaries

The live project contains no initiatives. Populated Intake, Planning, UAT, recovery, active-run and long initiative-history states are reviewed from current source, not claimed as live walkthroughs. Save, move, approve, archive, delete, settings changes, dictation permission, concurrent-write conflicts and real agent execution were not triggered on this active project. The report evaluates their visible design and source-defined interaction paths separately.

Desktop and narrow layouts were inspected in the app browser. This is not a complete screen-reader, touch-device, zoom, contrast or assistive-technology certification. No participant usability timings were collected. Proposed timing targets in the main report are future acceptance criteria.

The review-switchflow operations helper could not inspect this maintainer project's external ledgers because its context resolution attempted a restricted directory creation. No permission expansion was needed for the UI review. No interruption-frequency, cost or delivery-performance claims are inferred from missing ledgers.
