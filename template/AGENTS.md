# Agent instructions

Backlog.md owns active work and durable documentation. Use `.switchflow/scripts/backlog.ps1` for every task and document read or mutation; editing task frontmatter directly corrupts metadata, comments, and relationships.

**Read what your role requires, not everything.** Each skill states what it reads and what it must not read. Those limits are deliberate. Do not load policy above your task's risk class.

## Roles

| Skill | Use it to |
| --- | --- |
| `intake` | Establish a milestone's scope contract with {{OWNER_NAME}} before any planning. |
| `plan-milestone` | Turn a frozen scope contract into ordered phases and ready tasks. |
| `orchestrate-phase` | Deliver one phase, then exit. |
| `deliver-task` | Implement one task and stop at Review. |
| `review-task` | Independently review a fixed diff. |
| `create-human-task` | Define work requiring {{OWNER_NAME}} or someone they coordinate. Always assigns `Human`. |

Skills do not expand authority, review count, or task scope.

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
- Pushing, rewriting shared history, and deleting branches require explicit {{OWNER_NAME}} authorization.
- Do not deploy, alter live data, rotate credentials, or change access controls without authorization for that specific action.
- Account for every open {{OWNER_NAME}} comment before acting on a task. Never implement against stale scope.

## Commands

```powershell
npm --prefix .switchflow ci --ignore-scripts          # setup; never repair with an unpinned install
.\.switchflow\scripts\backlog.ps1 task view {{TASK_PREFIX}}-02 --json
.\.switchflow\scripts\backlog.ps1 browser             # human board and documents
.\.switchflow\scripts\backlog.ps1 doctor              # after task mutations
.\.switchflow\scripts\check-docs.ps1                  # after documentation changes
```

Write task fields and documentation in direct, complete language. Link tasks by short name in prose; use raw `{{TASK_PREFIX}}-xx` IDs only where a machine identifier is required.
