# Governance system

Switchflow separates durable project knowledge, active work, and agent operating rules so each has one clear source of truth.

| Concern | Source of truth |
| --- | --- |
| Product profile and protected boundaries | Backlog document `doc-02` |
| Lifecycle, roles, statuses, and authority | Backlog document `doc-03` |
| Task shape, readiness, evidence, and owner input | Backlog document `doc-07` |
| Delivery, Git, blockers, handoff, and review | Backlog document `doc-08` |
| Implemented behavior and contracts | Backlog documents under `backlog/docs/` |
| Durable decisions | Backlog decision records under `backlog/decisions/` |
| Active tasks, milestones, status, and comments | Backlog.md files under `backlog/` |
| Agent boundaries and repository commands | `AGENTS.md` |
| Repeatable agent workflows | `.agents/skills/` |
| Pinned governance tooling | `.switchflow/` |

## Work lifecycle

Tasks move through **Backlog → Ready → In Progress → Review → Done**. **Blocked** is a non-terminal execution state. `needs-decision` and `high-priority` are exception labels, not substitute statuses.

See the [architecture and delivery model](architecture.md) for module ownership and dependency direction. The [workflow diagrams](workflow-diagrams.md) expose the admission, delivery, review, and quality decisions.

A Ready task must have a useful outcome, observable acceptance, completed dependencies, available evidence and authority, a stable execution baseline, and a reviewable boundary. Readiness does not itself authorize implementation.

The project owner controls product goals, priority, accepted risk, and final accountability. Agents keep task text, comments, implementation, verification, and durable documentation aligned with those decisions.

## Quality posture

Switchflow uses four independent axes:

- **Velocity:** feedback speed and slice size.
- **Adaptability:** the cost of changing the design later.
- **Performance:** measured requirements and observed problems.
- **Stability:** data, deterministic behavior, credentials, recovery, and external writes.

Engineering standards own one active VAPS target. Project phase is descriptive context, not a quality level. Task risk raises only the affected surface. Credentials, destructive operations, user data, and live external writes remain protected at all times.

## Review and Git boundaries

One independent reviewer normally checks both accepted outcome and repository standards. Extra review is reserved for a separate expertise gap. Workers do not integrate into `main`; a user-authorized orchestrator owns integration. Pushing, rewriting shared history, branch deletion, secrets, and live external actions always need their own authority.

## Isolation and reuse

Governance dependencies live under `.switchflow/`, not in the application package. Imports begin with an empty board and no product decisions. Template changes should be forward-tested in a disposable repository before an active project adopts them.

Version `0.2.0` provides fresh imports only. Upgrade and merge automation is deferred until real use reveals the contracts it must preserve.
