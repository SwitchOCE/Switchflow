# Switchflow UI implementation and verification

Scope: the 33 findings and interaction contracts in the original [UI report](../ui-review-2026-09-22/REPORT.md). The report remains the acceptance baseline. Implementation does not change existing project sequence, approvals, statuses, or consumer installations.

## Delivered candidate

The framework template now includes grouped sidebar navigation and an honest next-work overview, read-first task details with adaptive editing and full-page expansion, compact milestone readers, bounded discussion/history/task collections, and safer authoring/navigation recovery. The [finding matrix](finding-coverage.md) maps all 33 findings to their implementation and evidence.

The required [fresh review](fresh-review.md) found two material navigation defects, which were repaired through bounded follow-up cycles. Its current verdict is **no remaining material issue found in the rechecked scope**. It does not claim full Human acceptance of every original scenario. The reviewer initially used its own fresh browser; after that browser surface became unavailable, it directed the exact rechecks, assessed raw parent-operated browser observations, and independently inspected source/tests. This provenance is recorded in its report.

This is a maintainer template candidate. Existing consumer installations were not rolled forward, and no commit, push or real project mutation was performed.

## Cycles

1. Build four bounded slices: shell/human gates, task interactions, milestones/documents, supporting views. Each implementer reviews their own changed scope.
2. Integrate and exercise the real UI against disposable API data; repair concrete failures and run the repository regression/import validator.
3. Once complete, give a fresh reviewer only the original report, the resulting source/build and independent access to the fixture. No implementation history or worker handoffs. Resolve findings and recheck affected paths.

## Baseline gesture evidence

The baseline server serves source from commit `763297b`, with two disposable Ready tasks and hidden empty Done column. Browser native drag from card 1 onto itself emitted `/tasks/reorder` with `orderedTaskIds: [DEMO-2, DEMO-1]`. A second native drag into the empty destination area recorded `Native drag active; destinations: Ready; ended`, with no request: Done remained absent. These are actual browser gestures, distinct from the previous report's handler doubles. No project data was involved.

## Verification environment

`node analysis/ui-implementation-2026-09-22/fixture-server.mjs` serves the real working UI at localhost:65440 with in-memory task/document/milestone APIs. It includes 200 tasks, 40 milestones, a long narrative, 100 comments, 50 runs, 60 events and 20 UAT checks. UAT actions use the actual lifecycle function, without any real agent execution. This proves UI interactions against a disposable API, not native Backlog persistence or Human acceptance; repository integration tests cover the underlying contracts separately.

## Verification results

- Final integrated `scripts/validate-switchflow.ps1` with `BACKLOG_TEST_CLI` set to the installed pinned Backlog 1.50.1 CLI: **207 passed, zero failed, zero skipped**. Fresh disposable import, documentation routing/local links, 11 rendered skills and phase cleanup checks also passed.
- Subsequent bounded return-focus refinements passed **42 targeted tests** in the fresh review. These overlap the integrated checks and are not added to the 207 as distinct cases. The final shell return behavior was also browser-rechecked.
- A new smoke test starts the production control server and recursively requests the UI's HTML, JavaScript imports and CSS, including the new overview/date modules. Missing assets return 404.
- `git diff --check` passed. Browser observations and their limits are recorded in [browser verification](browser-verification.md); original finding coverage is mapped in [finding coverage](finding-coverage.md).

Passing automated checks is not presented as Human acceptance or authorization to update installed consumer projects. Formal screen-reader/contrast/native-zoom verification and representative-user timing/acceptance remain outstanding; the evidence documents distinguish direct observations, source/tests and unverified variants.

## Fresh review repair cycle

The fresh reviewer independently reproduced two P2 gaps: task/milestone read-mode Markdown links lacked interaction wiring, and browser Back from a linked task lost the earlier task's reading position and focus (F07/F20). Shared safe prose-link handling and per-task reading snapshots now preserve links, draft text, selected tab, expansion, scroll and focus. Follow-up checks also repaired duplicate-link focus in Discussion, milestone-to-document return, saved tasks reopening in edit mode, and inaccurate offline pause wording. The final reviewer-directed checks closed both findings and rechecked existing milestone/task and Insights return paths.

## Screenshots

These show the actual candidate with disposable review data, not a live consumer installation.

- [Desktop overview](screenshots/overview-desktop.png)
- [Long task reader](screenshots/task-reader-desktop.png)
- [390px task reader](screenshots/task-reader-390.png)
- [320px document layout](screenshots/document-320.png)
