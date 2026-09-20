# Workspace 0.5.0 verification

Verified locally on Windows on 20 September 2026. This record covers the uncommitted candidate and disposable Atlas/Beacon trial. Active consumer projects were not upgraded, and no human UAT acceptance is implied.

## Current interface and automated evidence

Switchflow's own interface is restored. Normal entry points serve its top navigation and custom views; the rejected Backlog layout is neither served nor embedded. Its data handlers remain available through the protected project gateway.

The complete `scripts/validate-switchflow.ps1` gate passed **136 tests, zero failures and zero skips**, with `BACKLOG_TEST_CLI` and the official Codex skill validator supplied. Fresh import, all nine durable documents and links, eleven rendered skills, and phase-cleanup fixtures passed. The local log is `.tmp/validation-0.5.0-switchflow-ui-final.log` (ignored).

The pinned runtime is `1.50.1-switchflow-workflow.3`, content identity `0152bcefe5e12bee0b586a26`. Its executable, diagnostic web bundle and launchers passed receipt verification. Targeted source tests cover draft CAS/lifecycle locking, atomic milestone creation and decision publication. The expanded real compiled bridge suite passed both tests.

An initial sandboxed full run failed on Bun imports from the external runtime source directory with EPERM. The isolated source-lock test passed outside the sandbox, followed by the full successful gate in that environment. These permission failures are distinguished from the persistence defect below.

Independent source review found and prompted fixes for disabled task-form serialization, stale settings checklist arrays, settings draft remounting, editable fields during pending saves, cross-project history navigation and misleading completion dates. Safe local image rendering was also added. After the final accessibility/history and contrast polish, syntax checks, 16 focused UI/client tests and whitespace checks passed.

## Rendered browser evidence

The disposable trial runs the real compiled fork and shared service on port 57183. Browser verification covered:

- Task title, description and labels saved through Switchflow, then reopened from global search and a reloaded record bookmark with saved values intact.
- A real governance draft created, edited under its revision, and promoted to a task. The draft disappeared from Drafts and the promoted task appeared in search.
- A milestone created with description, two labels and execution order 5 in one request. It sorted before milestones with lower numeric IDs but later execution orders.
- A nested document edited with title, tags and Markdown; its canonical folder and ID survived. Headings, lists, code blocks and a canonical local SVG image rendered. The nested folder tree was inspected.
- A decision title and all four structured sections saved on the final backend and immediately rendered correctly.
- Two different settings checklist rows edited, retained through Beacon to Atlas to Beacon, and saved together. The form confirmed success with both entries intact.
- Global search returned task, document and decision results and opened the selected record in the correct project.
- Insights showed five actual tasks, one Done, 20% progress and no drafts, matching the promoted draft and current task records. Done-task dates are labelled Last updated.
- Light and dark appearances and a 390-pixel viewport were inspected. Task navigation, project controls, insights, documentation and the three-checkpoint initiative entry remained usable. Temporary viewport overrides were reset.
- The New initiative dialog still exposes one-click Start intake, detailed review mode and optional dictation. This trial did not dispatch an agent run.

## Persistence and retained evidence

The earlier native-interface trial passed 111 tests and exercised dependency release/manual blocks, milestone stale revisions, worktree identity and shared-port behavior. That interface was subsequently rejected; its observations are historical evidence, not proof of the current rendering. The current full gate retains those backend checks.

The previously unexplained intermittent decision-save failure was captured by the improved harness: Windows returned EPERM while renaming the staged decision file over its existing destination. Decision publication now retries only Windows EPERM/EACCES/EBUSY, for at most five attempts with bounded delays. It never deletes the destination as a fallback. Tests verify eventual success, non-retryable errors, retry exhaustion and preservation of original bytes.

## Boundaries

- Task and milestone edits use cooperating revision protection. Documents/decisions compare before saving, but their APIs do not provide atomic CAS; configuration merges edited fields into a fresh read.
- Milestone restore has no supported backend route. Archived records can be listed; restore is not offered.
- Task cleanup confirms an age rule evaluated at execution, including newly eligible Done tasks. It does not claim exact-set atomicity.
- Raw HTML is inert, external images are not fetched automatically and Mermaid remains code. Local images live in canonical backlog/assets.
- Real agent delivery, long-running multi-project throughput and owner acceptance remain distinct from these UI, package and filesystem checks.
- Changes remain local and uncommitted. No active consumer project, personal MCP registration or remote branch was updated.
