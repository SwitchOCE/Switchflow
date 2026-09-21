# Browser control

The browser is the owner workspace. Its routine decisions are Intake, Planning, and UAT. Delivery phases and independent technical acceptance stay with agents under the approved plan.

## Run the board

After the setup steps, double-click `Start Switchflow.cmd`, run `npm --prefix .switchflow run board`, or use `.switchflow/scripts/backlog.ps1 control`. The service binds only `127.0.0.1` and chooses a free port. Its launcher validates the shared service protocol and PID before reuse, then registers the canonical Git project. The project selector observes all registered projects on that port, including running and attention counts. Switching is local to the browser tab: every API request carries an explicit project ID. `board:native` retains the pinned Backlog browser.

New initiative starts Intake in one click. The form accepts typed text and offers dictation when the browser exposes it. Microphone access remains a normal browser decision; unsupported or denied dictation leaves the text form usable.

Intake inspects existing capabilities, asks material questions, and returns proposed scope. Scope approval starts Planning. Plan approval records the exact plan and scope hashes and starts delivery across every listed phase. A checkpoint marked in progress continues automatically. UAT is shown only after the execution result includes evidence, no blockers, and a walkthrough; every step needs a human pass before acceptance. The service validates record shape and authorization, while independent reviewers establish the evidence's meaning.

UAT acceptance saves the human verdict and candidate evidence immediately, then queues an agent to mirror that existing decision into the primary Backlog task and milestone records. The initiative becomes Complete when that record update has evidence. A failed update can be retried without another acceptance decision; it does not grant main-branch integration or publication.

Walkthrough file references can open a committed-text preview in the board. The service accepts only the exact file reference already in that initiative's UAT, within a candidate registered to its approved grant. It verifies the candidate identity and reads the recorded commit's blob, preserving its whitespace; working-file edits cannot change the displayed acceptance artifact. Binary, oversized, linked, protected and unrelated files are refused. Application walkthroughs use their real HTTP or HTTPS links and still require the owner to try the product.

## Scope, concurrency and interruptions

The service admits one Codex process per Git project at a time. Other initiatives can queue. Each human action carries the initiative revision actually displayed; stale actions fail and the browser retains typed drafts. Updates enter the next checkpoint. A scope change stops the current run, retains the old approvals for audit, revokes the current grant, and returns to Intake. New work waits for the stopped process to settle.

Plan approval covers its listed phases, local candidate delivery, and independent technical review. It does not grant remote pushes, deployment, live-data changes, credentials, or shared-history changes. Those unavailable actions become named exceptions; the local runner never bypasses its sandbox or approval controls. Framework friction is recorded without automatically dispatching unrelated work.

Planning records the committed source baseline. If that baseline changes before approval, the controller refreshes Planning and presents the revised plan before granting delivery. Each delivery grant binds the scope, plan, and baseline. Uncommitted source changes are preserved; they are not silently copied into a candidate.

The sandbox keeps Git metadata protected. During approved delivery, a local host helper accepts only three fixed operations: create a registered candidate worktree, commit explicitly named files in it, and merge a frozen managed candidate into another managed candidate. A file request/reply channel works without granting the agent network access. Candidates live under the external project state and use dedicated `codex/` branches. The helper has no operation for changing the primary checkout, pushing, resetting, deploying, deleting worktrees, or changing Git configuration. Required hooks, active filters, signing policies and custom merge drivers that would execute outside the sandbox stop the operation with a named exception; they are not silently skipped. Dormant diff/filter configuration does not prevent unrelated work. Cancellation stops admitting requests and lets an already-started Git operation settle; uncertain interrupted operations require inspection and are never replayed automatically.

Task edits use Backlog's partial-update path and the CAS fork's expected revision. They preserve unrelated fields and reject stale records. Native editing remains available when the project's agent-admission fence permits it; changes to an approved initiative's scope use the scope-change path. Direct manual Markdown writes remain outside Backlog's locking contract.

An ordinary conflict between managed candidates stays with the agents. The helper records both frozen heads and the exact conflicted paths. After correcting and reviewing those files in the sandbox, the agent resubmits the same merge with those paths. The helper rejects changed heads, additional edits, mismatched paths or altered unrelated index entries, then commits and verifies the two merge parents. Conflicts that cannot meet those constraints remain named exceptions. Windows Git calls enable long paths for that command only. New candidate roots use a compact hash of the full initiative and grant; existing registrations retain their recorded layout. Git's separate Windows root-length limit is checked before creating a branch. If an unusually long state-home still exceeds it, use a shorter host state-home for a new project or a shorter candidate name; never move a registered candidate or rewrite its records to bypass the check.

## Where data lives

| Data | Owner/location |
| --- | --- |
| Code | Accepted project checkout and explicitly managed candidate worktrees |
| Active governance rules and documentation | Primary checkout; copies in code worktrees are historical snapshots |
| Shared browser service and project registry | External `control-service/`; one port per state-home |
| Delivery tasks, milestones, accepted product documents | Primary checkout's Backlog; worker worktrees use the same governance root |
| Browser scope/plan approvals, revision history, sessions and run receipts | External project state, `control.json` and `runs/<id>/` |
| Friction/issues, check evidence, worktree registrations | Separate external JSON ledgers in `operations/` |
| Investigation output | Managed external scratch; agents read only explicitly referenced material |
| Selected durable scratch output | Explicit promotion into the governance collection; never automatic ingestion |

External state defaults to `%LOCALAPPDATA%/Switchflow/projects/<SHA-256 of canonical Git common directory>`. `SWITCHFLOW_HOME` selects another external base. All worktrees sharing that Git common directory share the state. The `operations.mjs context <project>` command reports exact source, governance and state locations. Treat run prompts and tool logs as local project data when backing up or sharing; the web API only exposes human-facing activity and receipts.

Agent tools receive only the project/governance checkout, informational operations, scratch/promoted output, their managed candidate directory, and their Git request inbox as writable locations. Controller approvals, run records, responses, Git receipts and registries stay outside those grants. The runner excludes broad temporary-directory write access and supplies a dedicated temporary folder under its scratch area. Earlier local-candidate operations ledgers remain readable; the first update writes a separated copy without deleting the original. Stop older services before updating to this layout.

Scratch's default write-only use is a role boundary, not an operating-system ACL. Retention previews select only registered, expired, unpromoted scratch files. Applying cleanup rechecks exact ownership, hash and path containment; it leaves changed, unknown or promoted artifacts alone. It does not remove worktrees. Existing `cleanup-phase.ps1` retains its clean-and-merged predicate.

## Recovery

A normal cancel stops the owned process tree and records the interruption. Restart never treats an interrupted process as completed. A still-live recorded PID fences new work. A missing PID retains an unknown-process hold: inspect the previous process and checkpoint, then explicitly confirm it has stopped in the board before releasing recovery. The server does not kill a possibly reused or unknown PID. Retry is an explicit action after recovery, not automatic replay of uncertain work.

Native Backlog and MCP editing timeouts and invalid transport responses retain their request and write-admission lock until the owned child emits closure. Sending a termination signal alone does not establish that the writer stopped. If termination cannot be confirmed, the request remains pending and new writes remain fenced; inspect and stop that exact child before recovery. No replacement child starts while its predecessor is uncertain.

Agent checkpoints start with the complete chronological owner history and identify new input separately. Earlier answers survive fresh sessions and service restarts. Long histories are retained in a run-local `owner-history.json` that the agent is instructed to read before deciding; superseded scope requests do not override current approvals.

Planning returns the exact native Backlog ID in each plan entry's `task` field, with its readable title and result in `outcome`. The initiative's Delivery tasks section uses those IDs from the approved plan; it never guesses associations from matching titles or ID fragments in prose. Older plans without explicit IDs remain usable and display an unlinked state with access to the project's task list.

Malformed state and unexplained stale data locks fail closed. Stop the service, back up its external state, inspect the lock's owner, and remove only a proven stale lock. Do not delete `control.json` or approve work to bypass a recovery failure. Service-lock recovery itself is serialized so simultaneous launches cannot steal a replacement lock.

## Verification and security boundaries

The server accepts only its loopback Host and same-origin browser requests. Every mutation requires a per-service token; JSON payloads and native decision-editor UTF-8 text are bounded. It launches fixed local executables with argument arrays and stdin, never browser-supplied shell commands. Native Backlog request handlers run through a private process pipe per canonical project, with no additional HTTP listeners. All writes share the agent-admission fence. Repository attachment responses are sandboxed and cannot execute scripts with workspace authority. The native web bundle is hashed alongside the executable in the fork receipt. Only local users and processes that can access this host should use this service; it is not a remotely authenticated multi-user server.

Codex results, stdout and completion receipts are bounded and persisted. A malformed final result, missing durable session, failed turn, timeout or process error cannot advance to UAT. The process runs under the existing local Codex account with workspace sandboxing and no approval bypass. Success in adapter tests is not real Codex proof; successful Codex execution is not human UAT.

`operations.mjs check` reuses only the latest successful matching attempt, with identical tracked/untracked source content, Git HEAD, command/arguments, working directory, declared scope and environment digest. Include digests for ignored dependencies, fixtures, external services and container images in `inputs`, or disable reuse when those inputs are not known. Container availability alone is not a container test result. Workers and reviewers reuse applicable evidence; the integrated changed candidate still gets its required gate.

## Milestones and documentation

Switchflow's Milestones view supports atomic creation, task assignment, removal and archive workflows, and edits an existing ID's title, description, labels and optional non-negative execution order. Revision conflicts retain the draft. Unspecified order remains unspecified; numeric identifiers never grant scheduling priority. The Switchflow task editor exposes an optional block reason and the fork updates dependency readiness on cooperating task mutations.

Documents and Decisions have Switchflow readers and editors, folder navigation, full-text search, Markdown previews, code copy and project-bound links. Local documentation images resolve only from canonical backlog/assets. Raw HTML stays inert; Mermaid is shown as code. Task and milestone edits use captured revisions. Document/decision saves compare the latest record before writing but their native APIs do not provide atomic compare-and-swap. See [workspace details](workspace-0.5.0.md) and the [full functionality review](backlog-ui-review.md).
