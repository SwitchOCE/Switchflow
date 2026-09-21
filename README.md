# Switchflow

A governance layer for agent-assisted development. It starts with a simple claim. Intelligence is cheap. Context is not.

Coding agents are capable and easy to start. When work lives only in a conversation, a new agent must reconstruct it. Repeated history increases input volume, but caching and compaction affect the cost; a longer session is not automatically more expensive than restarting.

Plans go on the board, decisions in the docs, and progress on task records. Browser approvals, sessions, and operational evidence live in shared external project state. A new agent can start cold, read the relevant records, and get to work.

I built this for one person directing several agents on a codebase they care about. That person wants to approve the work before it starts, reviews the result, and pays the token bill. This is not a team process or a CI system. It is a way for one owner to manage work without becoming buried in agent transcripts.

## What it assumes

- The board is the record. If something still matters after an agent exits, write it down. Do not leave it buried in a reply.
- Each role reads only what it needs. The role definition says what it may read and what it must ignore. Those limits are intentional.
- A milestone ends where I can judge the result. Phases divide work for the agents. Milestones give me something I can accept or reject.
- Fixing a bad plan is cheaper than fixing bad code. A correction before implementation costs a few hundred tokens. The same correction after implementation may waste the whole attempt.
- Workers finish their assigned task and hand it off. Orchestrators checkpoint each phase and may retain useful context for another authorized phase. Restart when context becomes stale or crowded.

## What I do

1. **Intake:** describe the outcome in the browser. The agent checks what already exists, retains discovery state, and brings back questions or a proposed scope. Accept that scope.
2. **Planning:** review the ordered work and its acceptance evidence. Approving the plan authorizes agents to deliver every listed phase, obtain independent review, and prepare UAT.
3. **UAT:** follow a short walkthrough against the real candidate. Accept the result or describe the rework it needs.

Phase starts and technical milestone acceptance belong to the agents. Scope changes revoke the current plan grant and return to Intake; project updates are durable input for the next checkpoint. Genuine missing access or an interrupted process is an exception shown with its next action. A plan grant does not authorize remote pushes, deployment, credentials, or live-data changes.

## Start from the browser

After [project setup](SETUP.md), double-click **Start Switchflow.cmd**, or run `npm --prefix .switchflow run board`. The workspace uses Switchflow's top navigation and design, with task boards/lists, full editors, milestones, documents, decisions, drafts, insights and settings. Open **Initiatives** for **New initiative → Start intake**, scope and plan approval, live agent activity, guided UAT and framework health. The top bar switches projects on one local service; linked code worktrees always resolve to their primary governance checkout. `.switchflow/scripts/backlog.ps1 control` and `backlog.ps1 browser` open the same workspace. `browser-native` retains the standalone Backlog server for diagnostics. See the [functionality review](docs/backlog-ui-review.md) for the corrected omissions and retained boundaries.

The service uses the installed, signed-in local Codex CLI. Runs keep its workspace sandbox, use structured results, and stop visibly when required authority or access is missing. Optional review mode adds independent critique during Intake and Planning without adding human gates. Dictation is a browser capability enhancement; text entry always works.

Approved scope, plan grants, revisions, sessions, and recovery state live outside the code checkout, shared by Git worktrees. Backlog retains delivery tasks and durable project documents. See [browser control and storage](docs/browser-control.md) for the exact boundaries, recovery procedure, and local security model.

Use `edit-milestone` to change an accepted outcome or UAT definition, and `edit-phase` to change tasks, order or gates within that outcome. Both preserve history and coordinate affected active work. Long intakes can expand into linked research, prototype or discussion questions; short intakes stay in one board record. [Scope and revisions](<template/backlog/docs/doc-09 - Scope-and-revisions.md>) describes resumption and the shared editing procedure.

## What the agents do

`orchestrate-phase` delivers serial tasks directly and coordinates workers for planned parallel groups. It retains useful context across related serial tasks, refreshes each task and owner comments, and keeps separate evidence and independent review for every candidate. Delegated workers confirm a three-line approach before implementation; direct delivery uses the same scope check without a self-confirmation wait.

The orchestrator uses event waits within host limits and avoids redundant status reads or unchanged updates when the host permits quiet waiting. Serial successors can reuse the phase agent after acceptance; delegated workers remain scoped to one task, with review corrections returning to the author. Delegation for a serial task needs a stated capability or isolation benefit.

`deliver-task` completes one task and returns an envelope with the result. `review-task` reads the diff independently and returns a verdict. `create-human-task` records work that only I can do, such as supplying a credential, creating an account, or making a decision. Planning identifies those tasks up front, so they do not stop the agents halfway through.

Prepare the next ready group; prewarm gated worktrees only for a stated setup benefit. At the phase gate, Documentation-only work uses applicable document and board checks plus diff review. Runtime or operational changes require the repository suite on the integrated candidate, where conflicts between tasks become visible. The cleanup process removes merged branches when the result is certain. If anything is unclear, it reports the branch and leaves it alone.

Work that costs more than expected goes into the friction log. The log is for me. Delivery agents never read it.

Finally, the orchestrator records what the next phase needs. `orchestrate-project` continues phases covered by the approved plan; a separately invoked `orchestrate-phase` remains limited to its named phase. Compaction or a fresh context uses the durable checkpoint without requiring another routine human start.

## What it imports

In an imported project, run `.\.switchflow\scripts\backlog.ps1 flow` for worker queues, separate coordination parents, blocker notes, and recently updated records. Add `--json` for structured output. Backlog needs definition; Blocked is prepared work waiting on a named prerequisite; Ready passes the full readiness gate. The fork reconciles dependency readiness after task writes: Ready tasks with unfinished dependencies become Blocked with reason `dependent`; once those dependencies are Done, they become Ready. Other block reasons and unexplained legacy blocks remain until explicitly resolved. Backlog, active, review and completed tasks are never automatically promoted or regressed. Readiness does not grant execution authority.

- `AGENTS.md` repository instructions.
- An empty Backlog.md board with a fixed status lifecycle.
- Durable Backlog documents and native decision records.
- A project profile for the few values each repository must own.
- Eleven agent skills for resumable intake, scope editing, planning, project and phase orchestration, delivery, independent review, guided UAT, human-owned exceptions, and explicit framework review.
- A local browser control service, Codex runner, and external operations ledgers.
- Pinned Backlog.md tooling and documentation validation under `.switchflow/`.

It does not import tasks, milestones, roadmaps, product decisions, application dependencies, credentials, or deployment configuration.

The template is intentionally isolated from the projects that produced it. Changes can be tested here and imported into a disposable repository before they reach ongoing work.

Start with [SETUP.md](SETUP.md). The [role contracts](docs/role-contracts.md) define role boundaries and evidence. The [architecture and delivery model](docs/architecture.md) defines module ownership, and [Skills](docs/skills.md) indexes the imported skills. The [workflow diagrams](<template/backlog/docs/doc-06 - Workflow-diagrams.md>) show how artifacts move between roles.

See [multi-project workspace and structured records](docs/workspace-0.5.0.md) for milestone metadata, ordering, dependency rules, documentation features and upgrade boundaries.

Known defects and outstanding work are tracked in [BACKLOG.md](BACKLOG.md).

## Status

Switchflow is at version `0.5.1`. The browser-driven model is a local release candidate. Mechanism tests, local Codex execution, and rendered checks are distinct from owner acceptance or measured delivery performance over multiple projects. [The implementation record](docs/three-step-delivery.md) maps the proposed improvements to their implementation and evidence.

Test template changes with a fresh import, review the rendered files, and only then update an active project deliberately using the [manual update procedure](SETUP.md#update-an-existing-project). Automatic upgrades remain out of scope.
