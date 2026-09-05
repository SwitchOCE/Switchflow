# Agent instructions

Backlog.md owns active work and durable documentation. Use `.switchflow/scripts/backlog.ps1` for every task and document read or mutation; editing task frontmatter directly corrupts metadata, comments, and relationships.

**Read what your role requires, not everything.** Each skill states what it reads and what it must not read. Those limits are deliberate. Do not load policy above your task's risk class.

## Roles

| Skill | Use it to |
| --- | --- |
| `intake` | Establish a milestone's scope contract with {{OWNER_NAME}} before any planning. |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. |
| `orchestrate-phase` | Deliver and checkpoint one authorized phase. |
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
| This project's goal, gates, boundaries | `backlog/docs/doc-02 - Project-profile.md` |

Build the simplest implementation and smallest validation set that satisfy the accepted outcome and its risk class. Do not invent a stricter quality tier.

## Hard boundaries

- Never commit credentials, secrets, personal data, or restricted data, in code or documentation.
- Never commit unrelated changes.
- Pushing, rewriting shared history, and deleting branches require explicit {{OWNER_NAME}} authorization. The one standing exception is `cleanup-phase.ps1`, whose predicate `doc-03` grants.
- Do not deploy, alter live data, rotate credentials, or change access controls without authorization for that specific action.
- Account for every open {{OWNER_NAME}} comment before acting on a task. Never implement against stale scope.

- Keep the board running during application dependency setup. Stop it only when replacing the `.switchflow` installation it uses; restart and verify HTTP availability after maintenance. Stop only processes using the dependency directory being replaced. Reuse matching pinned tooling across worktrees.

## How to write

Write task fields, documentation, and replies as the smallest text that clearly carries the problem, the proposed step, or the decision required. Link tasks by short name in prose; use raw `{{TASK_PREFIX}}-xx` IDs only where a machine identifier is required.

Contract artifacts are required output: the three-line plan, the five-line envelope, the handoff comment, the review verdict with its blast-radius declaration, and the phase record. Produce each in the shape its skill defines.

## Commands

```powershell
npm --prefix .switchflow ci --ignore-scripts          # setup; never repair with an unpinned install
.\.switchflow\scripts\backlog.ps1 task view {{TASK_PREFIX}}-02 --json
.\.switchflow\scripts\backlog.ps1 browser             # human board and documents
.\.switchflow\scripts\backlog.ps1 doctor              # after task mutations
.\.switchflow\scripts\check-docs.ps1                  # after documentation changes
```
