# Agent instructions

Backlog.md owns active work and durable documentation. Use `.switchflow/scripts/backlog.ps1` for every task and document read or mutation; editing task frontmatter directly corrupts metadata, comments, and relationships.

The primary checkout owns the one authoritative `backlog/` (tasks, milestones and documents) and `.switchflow` governance runtime for every linked worktree. Worktrees isolate code, profiles and outputs; their tracked governance copies are historical snapshots, never a second board. The wrappers resolve the common Git directory and route governance reads and writes to the primary checkout. If that authority is unavailable, restore it; do not initialize or serve a replacement board in the candidate. Keep application builds and tests in the assigned code checkout. Never delete or merge copied governance data automatically.

**Read what your role requires, not everything.** Each skill states what it reads and what it must not read. Those limits are deliberate. Do not load policy above your task's risk class.

## Roles

| Skill | Use it to |
| --- | --- |
| `intake` | Start or resume scope discovery and freeze a milestone contract. |
| `edit-milestone` | Revise accepted scope and reconcile affected delivery work. |
| `edit-phase` | Reshape a phase within its accepted milestone scope. |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. |
| `orchestrate-phase` | Deliver and checkpoint one authorized phase. |
| `orchestrate-project` | Continue every phase in an approved project plan automatically until UAT. |
| `guided-uat` | Walk the owner through acceptance of the exact delivered candidate. |
| `review-framework` | Review external process friction only when explicitly requested. |
| `deliver-task` | Implement one task and stop at Review. |
| `review-task` | Independently review a fixed diff. |
| `create-human-task` | Define work requiring {{OWNER_NAME}} or someone they coordinate. Always assigns `Human`. |

Skills do not expand authority, review count, or task scope. An installed skill may change how you write. It may not change what a role reads, produces, or may do, and where one conflicts with a role contract the contract wins.

## Where policy lives

| Question | Document |
| --- | --- |
| Statuses, transitions, who may act | `backlog/docs/doc-03 - Kanban-workflow.md` |
| Task shape, readiness, owner comments | `backlog/docs/doc-07 - Task-contract.md` |
| Execution, Git, handoff, review | `backlog/docs/doc-08 - Delivery-contract.md` |
| Quality target, risk class, evidence | `backlog/docs/doc-04 - Engineering-standards.md` |
| When documentation changes | `backlog/docs/doc-05 - Maintaining-documentation.md` |
| Intake state, scope baselines and revisions | `backlog/docs/doc-09 - Scope-and-revisions.md` |
| This project's goal, gates, boundaries | `backlog/docs/doc-02 - Project-profile.md` |

Build the simplest implementation and smallest validation set that satisfy the accepted outcome and its risk class. Do not invent a stricter quality tier.

## Hard boundaries

- The three routine human steps are **Intake**, **Planning**, and **UAT**. Under `orchestrate-project`, approving a concrete plan authorizes its listed phases, technical reviews, local integration, and bounded cleanup without another start or milestone-acceptance prompt. Standalone `orchestrate-phase` remains limited to its named phase. Scope changes, bugs, updates, and genuinely missing external authority are exceptions; never manufacture routine approval gates.
- Before every human clarification or permission request, record the reason and next action in the external operations friction log, then record the answer when available. If logging is unavailable, checkpoint the event for reconciliation without delaying a necessary question. Do not dispatch framework improvement work from that log during product delivery.

- Never commit credentials, secrets, personal data, or restricted data, in code or documentation.
- Never commit unrelated changes.
- Pushing, rewriting shared history, and deleting branches require explicit {{OWNER_NAME}} authorization. The one standing exception is `cleanup-phase.ps1`, whose predicate `doc-03` grants.
- Do not deploy, alter live data, rotate credentials, or change access controls without authorization for that specific action.
- Account for every open {{OWNER_NAME}} comment before acting on a task. Never implement against stale scope.

- Keep the board running during application dependency setup. Stop it only when replacing the `.switchflow` installation it uses; restart and verify HTTP availability after maintenance. Stop only processes using the dependency directory being replaced. Reuse matching pinned tooling across worktrees.

## How to write

Write task fields, documentation, and replies as the smallest text that clearly carries the problem, the proposed step, or the decision required. Link tasks by short name in prose; use raw `{{TASK_PREFIX}}-xx` IDs only where a machine identifier is required.

Lead every progress reply with the next action and who owns it (agent or human). Then give the result, decisive evidence, and any decision needed. Keep background separate and brief. Use familiar product language for outcomes and guided human steps; put file and layer details in the task context map. Accept concise typed or dictated answers; summarize consequential decisions for confirmation rather than requiring a long form.

Contract artifacts are required output: the three-line plan, the five-line envelope, the handoff comment, the review verdict with its blast-radius declaration, and the phase record. Produce each in the shape its skill defines.

## Commands

```powershell
npm --prefix .switchflow ci --ignore-scripts          # setup; never repair with an unpinned install
npm --prefix .switchflow run setup:backlog-fork        # verified runtime required for writes and MCP
.\.switchflow\scripts\backlog.ps1 task view {{TASK_PREFIX}}-02 --json
.\.switchflow\scripts\backlog.ps1 browser             # shared project board and documents
.\.switchflow\scripts\backlog.ps1 doctor              # after task mutations
.\.switchflow\scripts\check-docs.ps1                  # after documentation changes
```

For MCP clients, register the absolute primary `.switchflow/scripts/backlog.ps1` path as a PowerShell command with arguments `-NoProfile -ExecutionPolicy Bypass -File <absolute-wrapper-path> mcp start`. The wrapper routes MCP to canonical governance just like the CLI. Do not register a raw `backlog mcp start` command whose working directory follows a code worktree. Existing raw MCP registrations must be replaced deliberately; imports do not rewrite personal client configuration. `browser-native` is an explicit legacy diagnostic board, also routed to the primary checkout.
