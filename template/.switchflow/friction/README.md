# Friction log

Framework-level findings: where the workflow itself cost time or tokens.

This is not product knowledge and it does not belong in Backlog documents. It also does not belong on a task, because it outlives the task that revealed it.

## What goes here

Findings about the workflow, not the product:

- The readiness gate missed a class of problem.
- Workers repeatedly rediscover the same setup.
- A policy is ambiguous enough that two agents read it differently.
- A context map was systematically wrong in the same way.
- Coordination consumed more than the work it coordinated.

Findings about one task — bad scope, a wrong dependency, an inaccurate map — belong on that task instead. The blocker record in `doc-08` already asks whether readiness could have detected the obstruction.

## Who writes it

`orchestrate-phase`, at the phase boundary, in the same action that writes the phase record. The orchestrator is the only role that sees across tasks, so it is the only role that can tell a one-off from a pattern. The marginal cost there is near zero.

## Who reads it

The project owner, periodically. **No delivery role reads this directory**, which is why it costs nothing during a phase. Findings accumulate here until they are worth turning into a framework change.

## Format

One file per milestone, `<milestone-id>.md`, append-only. Never rewrite an earlier entry; add a new one when the picture changes.

```markdown
### 2026-09-03 phase 2

- Cost: what consumed time or tokens
- Estimate: tokens or wall time, roughly
- Preventable: which policy could have caught it, or none
- Proposed change: one sentence
```

Estimate honestly and say when a number is a guess. An entry with no cost estimate is still worth writing; an entry with a fabricated one is not.

`Preventable: none` is a valid and useful entry. It records that the cost was inherent rather than a policy failure, which stops the same finding being re-investigated later.
