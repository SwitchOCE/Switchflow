# Supporting views implementation handoff

Implemented the assigned F19, F26, F28, F29 and supporting F31 slice. No project records, settings, approvals, production agent runs, commits or pushes were changed.

- F19: Global search has explicit initiative/task/document/decision scopes, matched excerpts and status/milestone/path context. Arrow keys, Home/End and Enter operate the result set; closing returns focus to the Search trigger. Copy says the native request loads at most 40 mixed matches and, at the cap, says more may exist and asks the user to refine the words. Type filtering never claims it searched beyond that mixed native batch. Empty, busy, failed-navigation and connection-error states retain a clear retry/refine path.
- F26: Insights resolves milestone IDs through the native milestone catalogue and withholds the milestone breakdown if titles cannot be read. Done history uses 20-row pages with exact shown/total ranges. Task titles open the existing task reader through `onOpenTask`; the caller receives the exact originating button, allowing the shell's retained route, page, scroll and focus return. Configured dates are used for each Done row. A failed statistics refresh retains already-readable metrics/history and adds a local retry state.
- F28: Add checklist item now focuses the input in the newly appended Definition of Done row, rather than the first row matching `:last-of-type`.
- F29: Settings text now distinguishes shared project display, Backlog task/Git behavior, the separate native Backlog browser and Backlog CLI settings. Date help accurately names Insights plus reusable workspace date displays. New `public/ui-date.js` provides normalization and deterministic YYYY-MM-DD, DD/MM/YYYY and MM/DD/YYYY formatting for other views; stored values are untouched.
- F31: Skills exposes loading/busy state, keeps existing instructions when refresh fails, gives local retry for a failed skill read, and gives a clear empty/filter recovery action. Insights distinguishes initial loading, retained-content refresh failure, date/milestone lookup unavailability, read-only settings and preserved unsaved-setting failures. Search preserves the query after navigation failure and explains no-match/cap recovery.

## Evidence and bounded review

- `node --test scripts/insights.test.mjs scripts/workspace-search.test.mjs scripts/skills.test.mjs`: 10/10 passed. Coverage includes milestone-title mapping, 45-row page clamping/ranges, three configured date formats and fallback, search routes/snippet bounds, settings merge/validation, and skill catalogue safety.
- `node --check` passed for `insights.js`, `workspace-search.js`, `skills.js` and `ui-date.js`.
- Scoped `git diff --check` passed; output contained only the repository's CRLF conversion advisories.
- Lightweight source review checked stale-response tickets, no settings writes during statistics reads, cap wording, page clamping after refresh, retained content on refresh failure, linked-task failure containment, and focus targets. These are source/local synthetic results; rendered/browser integration and Human acceptance remain for the parent cycle.

## Integration and rendered checks

- Parent registered `ui-date.js` in the static-file whitelist. Shell passes `onOpenTask: openTask`, and Search styles cover the injected scope/help/snippet/selection classes.
- In the disposable browser fixture, verify 41+ mixed native search matches, type filtering after the mixed cap, repeated titles/snippets, arrow navigation and failed-open return; 45 Done tasks with named milestones and Back to the same page/row; three date settings; four existing DoD rows then Add; offline Insights refresh with retained rows; empty/filter/failure Skills states; desktop, narrow and dark theme layouts.
- The native search API has no continuation token in this integration. Refining the query is the truthful continuation path; the UI does not imply that the loaded 40 are the complete corpus.

## Rendered-review follow-up

The parent browser cycle verified 41 loaded search matches (one local initiative plus the 40 native cap), keyboard Down selection, and Insights page 2 → linked task → Close returning to the exact page and originating focus. Follow-up source corrections add native document `rawContent` to excerpts and place Hide empty board columns under shared Tasks views. Its help now names the available Actions → Move task path and drag-time empty destinations. Focused tests include the raw-content case; DoD focus remains for the parent rendered check.
