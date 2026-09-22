# Fresh independent UI acceptance review

22 September 2026. **Current verdict after bounded repair recheck: no remaining material issue found in the rechecked scope. R1 and R2 are closed. Full acceptance of all 33 findings and 15 scenarios is not established by this review.**

Task description/discussion and milestone evidence links now reach the matching document and return to the originating reading context. Related-task Back/Forward retains scroll, focus and expansion. Offline and active-run pauses retain writing and correctly explain why Save is unavailable. The original review and its broader validation gaps remain below; its historical NEEDS FIXES verdict is superseded only for the repaired and explicitly rechecked paths.

### Repair recheck evidence and provenance

The reviewer independently examined the final shared prose-link integration, task view-state capture/restore, saved-versus-dirty editing guard, non-task record-return restoration and explicit task write-block reasons. The reviewer's browser surface became unavailable in this recheck (`cua.getState()` returned no enabled browsers), so the rendered reruns below were **reviewer-directed and parent-operated**, with raw URL, focus, scroll, control and draft observations returned to the reviewer. They are not claimed as direct reviewer browser operation. The initial review below used the reviewer's own fresh browser tab. Implementation handoffs and cycle verdicts were not used to establish closure.

- **R1, task description:** the internal Guide link reached `?project=ui-fixture&view=documents&record=doc-1`; one Back returned to DEMO-2 in read mode, at scroll 0 with focus on the actual Guide anchor. The external evidence anchor had `https://example.com/`, `target="_blank"` and `rel="noopener noreferrer"`; external-page content was not opened or assessed.
- **R2, task relationships:** expanded DEMO-2 at scroll 692, focused `data-related="DEMO-26"`, opened DEMO-26, then Back restored DEMO-2 at scroll 692, the same relationship focus and expanded mode. Forward returned to DEMO-26; another Back restored the same DEMO-2 state again.
- **R1/R2, discussion and dirty writing:** an expanded Discussion with composer text `fresh-recheck-unsent` opened Comment guide and returned with Discussion selected, expansion and the exact unsent text retained, scroll 0 retained, and focus on the visible Comment guide anchor. The recheck exposed a duplicate-link focus defect when the same path occurred in hidden Description and visible Discussion; this was repaired and the stated final rerun passed.
- **R1, milestone evidence:** filtered Milestone 10 with its m-10 reader and 12 linked tasks, focused Milestone guide at window scroll 373.6, activated by native Return, reached document `doc-1`, then Back restored window scroll 373.6, the exact Milestone guide focus, filter and reader. An earlier rerun exposed missing non-task return restoration; the final shell repair was included before this passing rerun. Native key activation avoided locator-induced source scrolling.
- **Existing Insights return:** page 21–40 of 150 → Outcome 71 → Close returned to `view=statistics`, retained page 21–40 and focused the Outcome 71 trigger.
- **Existing milestone task return:** filter Milestone 10 → open m-10 → DEMO-142 → Close returned to `view=milestones`, retained the Milestone 10 filter and reader, and focused the DEMO-142 trigger. The final rerun reported identity, filter, detail and focus; the initial direct review below separately exercised its page position.
- **F31 offline and active-run pauses:** with `fresh-offline-draft` entered, a normal offline poll displayed “Connection lost. Editing resumes when the local connection returns. Your tab edits are retained.”, retained the exact value and disabled Save. With connection restored and an active run, the policy changed to “Editing paused while an agent is active or queued. Your tab edits are retained.”, retained the value and disabled Save. Clearing the active run re-enabled Save with the draft intact before deliberate discard.
- **Uncertain applied-write observation, supplementary operator evidence:** before the final navigation repair, the parent observed one applied write with title `Recovered after an uncertain saved response`, a retained editor title, Save disabled and Compare available after the response was lost. Comparison found no differences; no second write occurred during reconciliation/offline checks. The reviewer did not operate this run, and it was not rerun against the final navigation changes.
- **Final source verification:** `node --test scripts/prose-interactions.test.mjs scripts/control-task-interactions.test.mjs scripts/tasks-ui.test.mjs scripts/workspace-client.test.mjs scripts/milestone-panel.test.mjs scripts/ui-assets.test.mjs` completed with **42 passed, 0 failed** after the repairs, including repeated visible-link focus restoration. These scoped tests do not replace rendered acceptance.

### Updated coverage and remaining boundaries

R1/R2 no longer block the exercised portions of F07, F09, F18 and F20 or the tested “Return from evidence” and Back/Forward journeys. Their entries in the initial tables below record the historical state, not an outstanding defect. F31 and “Disconnection/active agent” now have the operator-mediated rendered evidence described above. No additional material defect remains confirmed in this bounded repair recheck.

This is not a blanket pass for all original requirements. Controlled same-project delayed A→B read navigation remains untested in a browser. Complete dirty task-field navigation variants, all deep links and refresh combinations, full document conflict/discard flow, oldest-evidence retrieval, the complete keyboard Move transaction, narrow-layout reruns after these repairs, native zoom, formal contrast and screen-reader testing remain outside this recheck. Successful pointer insertion, filtered drops and edge scrolling remain unverified by this reviewer. The supplementary uncertain-write observation does not establish native filesystem persistence. Fixture execution, actual native persistence, real agent execution and Human usability/acceptance remain distinct; no Human acceptance or production rollout is asserted.

The bounded repair review is complete. Application source and browser are released to the parent; no application files were modified by this reviewer.

## Initial review — retained historical evidence

22 September 2026. **Initial verdict before repairs: NEEDS FIXES.**

The presented build materially improves orientation, task reading, bounded history, human review and narrow navigation. It does not yet demonstrably solve every original issue: two reproducible navigation defects prevent the complete **read → inspect evidence → return to the same place** journey. Both are P2 material interaction failures. There is no evidence in this review of production data loss, an authority bypass, or automatic Human acceptance.

This verdict was written before reading any implementation handoff, cycle note, or other review verdict. Inputs were the original `analysis/ui-review-2026-09-22/REPORT.md`, `template/AGENTS.md`, current application source, selected current tests, and the disposable fixture. No application file was modified. Only this review artifact and in-memory fixture records were changed. Port 65315 was not used.

## Actionable findings

### R1 — P2: Task and milestone Markdown readers expose nonfunctional evidence links

**Original scope:** F07, F20; interaction contract 5C/5E; acceptance scenario “Return from evidence.”

**Reproduction:** In the disposable scale fixture, edit DEMO-2's description to include `[Interaction design guide](guides/design.md)` and `[External evidence](https://example.com)`, save, and reopen its read view. Both appear as links, but their rendered `href` is `#`. Clicking Interaction design guide changes the URL only to `?project=ui-fixture&view=tasks&task=DEMO-2#`; the task dialog remains open and no document appears. The fixture contains the matching document at `guides/design.md`.

**Cause/evidence:** `public/documents.js:65` deliberately emits placeholder anchors with `data-doc-link`; the established document readers subsequently resolve/hydrate them. `public/tasks-editor.js`, `renderRead()` and `comments()`, insert `renderMarkdown(...).html` without that resolution or a `data-doc-link` handler. `public/milestones.js`, `renderReader()`, repeats that unhydrated integration. Heading anchors also use the renderer's anchor protocol without its handler. Task behavior was browser-reproduced; the corresponding milestone/discussion behavior is source-confirmed, not separately clicked with seeded links.

**Fix:** Share a safe reader-link integration with the established document reader: resolve project document/decision links, preserve external HTTP(S) behavior and boundaries, handle headings, and route internal navigation with recoverable task/milestone context. Do not leave an apparently functional anchor pointed at `#` for unsupported content. Verify task description, discussion and milestone scope links, then Back/Close to the original reading location.

### R2 — P2: Returning from a related task resets the original reader's position and focus

**Original scope:** F20, related F09/F18; scenario “Return from evidence.”

**Reproduction:** Open DEMO-2, scroll to its later “Blocks” relationships (measured task-dialog `scrollTop = 692`), open “Outcome 26 … · Blocked,” then use browser Back. DEMO-2 reopens, but `scrollTop = 0` and focus is on Expand. The person loses the exact relationship/reading position. This was repeated with the same result.

**Cause/evidence:** `public/tasks.js`, `openTask()`, destroys the current editor; its related-task callback simply calls `openTask(route.task)`. `public/app.js:758–774`, `followLocation()`, reconstructs the task dialog from its ID without task-reader scroll/tab/expansion/focus state. The origin snapshot used for milestone/initiative entry captures the window and initiative dialog, not a stack of task readers.

**Fix:** Record each task reader's return state before related-task navigation and restore it on Back/Forward. At minimum restore task identity, scroll/reading section, selected content tab, expansion state and a useful focus anchor; preserve unsaved content. Verify a long task → prerequisite/dependent → Back, including discussion and dirty edit variants. Existing milestone and Insights return behavior must stay intact.

## Evidence exercised

- Browser: a fresh Codex in-app browser tab at `http://127.0.0.1:65440/?project=ui-fixture&view=board`, desktop 1440 × 1000, narrow 390 × 844 and 320 × 844, DOM/accessibility observations plus rendered screenshots. The fixture was reset to the scale seed before review because it initially contained a previous concurrent-edit mutation. Later it was reset to the two-task drag seed.
- Actual UI mutations were restricted to disposable task edits and a disposable UAT rework request. The UAT check-1 failed observation retained its title/status/note association in “Previous rework observations” after submission. Reopening before submission resumed check 2 with 1/20 checked. This proves UI + in-memory lifecycle behavior, not native disk persistence or a real correction agent.
- Task close removed `task` from the URL; reload stayed closed. Reopening restored the unsaved description. Discard restored reading mode; Recover discarded edits restored the exact draft. A concurrent description/labels edit produced understandable field comparisons and retained writing.
- A filtered milestone → its last linked task → Close returned to the milestone filter, original task trigger, and page position. Insights 21–40 of 150 → task → Close retained 21–40. These successful paths do not resolve R2.
- Overview showed 2 initiative decisions + 5 Ready Human tasks, separately recorded In Progress state, 20 waiting tasks, and explicit unresolved order for 40/40 unsequenced milestones. It did not label raw Ready status as execution authority.
- Task search showed 1 of 200 and a visible single matching column. Long task prose was rendered with a wrapping heading and one primary detail scroll. Discussion initially showed 10/100 with composer above history; Show older produced 20/100 while retaining focus on the load control and the previous viewport position.
- Initiative activity exposed explicit retained totals, type filters and page controls for 61 events (including the submitted review) and 50 runs. Its retention limit was disclosed. All oldest records were not traversed manually.
- At 390px, a complete first task card was visible in the initial viewport. Drawer Escape returned focus to Menu. At 320px, task purpose/content and footer actions remained usable; no page-width overflow was detected during that check. Narrow document Browse/Contents collapsed after selection and content was readable. Native 200%/400% zoom was not exercised.
- Settings Add checklist item with three defaults focused the new fourth input. Settings separated native-browser/CLI effects. Insights used the configured date format; task comments still showed stored timestamps and initiative history used locale dates. No claim of globally uniform formatting is made.
- Native pointer dragging started without rebuilding the source and revealed the hidden Done destination. Escape canceled and restored Done to hidden. A high-level after-card gesture produced dragstart/dragend but no drop; a subsequent CDP mouse step stalled for about 291 seconds before returning. Successful pointer insertion, actual marker/outcome alignment, filtered cross-column drops and scroll-edge behavior therefore remain unverified by this reviewer. This tool stall is not evidence of an application defect.
- Ran `node --test scripts/control-task-interactions.test.mjs scripts/tasks-ui.test.mjs scripts/workspace-client.test.mjs scripts/workspace-search.test.mjs scripts/milestone-panel.test.mjs scripts/insights.test.mjs scripts/ui-assets.test.mjs`: **41 passed, 0 failed**. These establish scoped model/handler/transport/asset behavior and are not substituted for rendered acceptance.

## Original finding coverage

“Verified” below means the stated exercised portion, not blanket production acceptance. “Partial” means meaningful improvement exists but a linked finding or untested contract prevents full closure.

| Original IDs | Fresh assessment |
|---|---|
| F01 | Verified corrected count/category presentation and task routes in fixture. |
| F02 | Verified conservative overview categories. Approved/stale/parallel next-work matrix source-reviewed, not all rendered. |
| F03 | Verified grouped desktop sidebar, narrow drawer and Escape focus return. |
| F04 | Verified explicit unsequenced state and planning-only order language. No milestone ordering mutation exercised. |
| F05 | Verified short milestone summaries, grouped states, meaningful task counts; no inner prose card scrollers. |
| F06 | Verified filtered milestone read/detail → linked task → Close returns correctly. |
| F07 | Partial: substantially improved long read mode, edit and narrow hierarchy; R1 breaks evidence links. |
| F08 | Verified wrapping task title, visible state/owner and Actions entry. |
| F09 | Partial: related task titles/statuses and Blocked by/Blocks work; R2 loses return position. Picker source-reviewed. |
| F10 | Checklist row implementation and payload preservation tests pass; full keyboard edit/remove/save round trip not exercised. |
| F11 | Verified close/reload/reopen draft policy and ordinary discard. |
| F12 | Verified task description/label conflict comparison and reversible task discard. Document discard implementation reviewed, not browser-reproduced. |
| F13 | Source/model tests cover top/bottom/before/after controls. Complete keyboard Move transaction not exercised. |
| F14 | Verified bounded initial comments/composer, older loading and collapsed initiative history. Oldest-comment search/retrieval not completed. |
| F15 | Verified disclosed event total and paging, source permits all retained records; oldest page not manually visited. |
| F16 | Verified bounded board lane styling and paged 150-row Insights history; full long-board edge-scrolling not exercised. |
| F17 | Verified one-result count/visible column; clear-filters control exists inside Filters. No-result browser case not exercised. |
| F18 | Verified task filter retention and aligned/paged list implementation; exact reading-context contract remains partial under R2. |
| F19 | Verified search type controls, contextual snippets and explicit 40 mixed-result cap wording; end-to-end result return not exercised. |
| F20 | Fails R1/R2. Task close/reload, milestone return and Insights return passed their narrower paths. |
| F21 | Verified sticky current-decision region and Scope/Plan/Evidence/Checks navigation; exhaustive long-plan focus testing not performed. |
| F22 | Verified check progress/resume and successful rework with preserved failed observation, using actual lifecycle in fixture. No native persistence/real agent/Human acceptance claim. |
| F23 | Task/initiative dialogs have accessible names; drawer/task Close focus paths exercised. Archive/promote/repair dialog paths source-reviewed only. |
| F24 | Verified 390px task and 320px task/document layout, visible connection status and narrow drawer. |
| F25 | Verified narrow document Browse/Contents collapse and reader. Long document editing/savebar/discard flow not fully exercised. |
| F26 | Verified milestone titles, openable Done rows, paging and return to page 21–40/150. |
| F27 | Task draft messages and restored writing verified; Draft tasks title/source route checked. Full new-draft promotion/recovery journey untested. |
| F28 | Verified new fourth DoD input gets focus. |
| F29 | Settings effects are scoped and Insights uses project date formatting. Comments/events are not uniformly formatted; broader consistency is not claimed. |
| F30 | Desktop/narrow rendered hierarchy materially improved. Formal contrast, both-theme review and screen-reader conformance unverified. |
| F31 | Conflict and retained drafts exercised; selected guard/unknown-write transport tests passed. Offline, active-agent fencing, same-project A→B races and uncertain applied-write UI recovery remain gaps. |
| F32 | Native drag revealed empty Done and Escape restored compact state. Successful drop to it/scroll edges unverified. |
| F33 | Self/no-op and canonical filtered sibling ordering tests passed. Actual before/after marker/outcome and pointer self-drop unverified. |

## Fifteen acceptance scenarios

| Scenario | Result and boundary |
|---|---|
| Morning orientation | Partial: correct categories/counts in scale fixture; no timed participant test, zero-initiative/active-runtime variant not rendered. |
| Ambiguous next work | Partial: ambiguity is explicit; full stale/blocked/parallel plan matrix not rendered. |
| Read a long task | Verified long formatted text, criteria and notes are readable without resizing; expansion continuity not exhaustively tested. |
| Return from evidence | **Failed: R1 and R2.** Milestone/Insights origin paths passed. |
| Close and refresh | Verified close/reload and related-task Back identity; Back reading position fails R2. Full Forward/deep-link matrix untested. |
| Find older evidence | Partial: bounded batches and retained totals verified; named oldest evidence retrieval not completed. |
| Complete/rework UAT | Rework/progress/resume verified in disposable lifecycle; acceptance intentionally not submitted. |
| Save/conflict/discard | Task draft/conflict/discard/recover verified. Full document variant and every conflict field not tested. |
| Work without dragging | Partial: controls/model contracts verified, not a complete keyboard-only workflow. |
| Drag through changing layout | Partial: actual reveal/cancel verified; successful insertion, edge scroll and self-drop not verified here. |
| Empty versus unavailable content | Partial: optional blank sections compact; empty discussion and missing blocker visible. Read-only/loading matrix not reproduced. |
| Rapid navigation and uncertain outcome | Partial source/tests only; no controlled delayed A→B or applied-but-response-lost browser run. |
| Narrow and zoom | 390/320 layouts exercised; native zoom, formal contrast and assistive technology untested. |
| Scale and filtering | 200/40/150 fixture, one-result filtering and Insights paging verified. Full no-result/list-page state matrix untested. |
| Disconnection/active agent | Not browser-verified; guard/transport tests and source only. |

## Required continuation

Repair R1/R2, then independently recheck those exact journeys and the existing successful return paths. The remaining partial/unverified scenarios must not be described as fully passed without additional evidence. Browser fixture success remains separate from native persistence, real agent execution and Human usability/acceptance. No production rollout is authorized by this verdict.

Review stopped with the fixture reset to the disposable two-task drag scenario and its drag canceled. The temporary viewport override was reset. Source and browser are released to the parent after this artifact is saved.
