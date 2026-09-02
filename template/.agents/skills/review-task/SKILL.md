---
name: review-task
description: 'Independently review a fixed {{PROJECT_NAME_YAML_SINGLE}} task diff against its accepted outcome and repository standards, escalating to blast-radius analysis only when a stated trigger fires.'
---

# Review Task

Produce an independent verdict on a fixed change surface.

## Pin and read

Pin the accepted base, the exact HEAD, and the fixed diff. Read the complete task and its comments, the affected contracts, the review contract in `backlog/docs/doc-08 - Delivery-contract.md`, and the risk class in `backlog/docs/doc-04 - Engineering-standards.md`.

Do not read the worker's reasoning beyond the factual handoff. Judge the artifact, not the argument. Reading the rationale converts independent review into agreement with it.

Identify open {{OWNER_NAME}} comments using `doc-07` and include unresolved input in the findings. Review is read-only, so do not close them.

## Review two axes

1. **Outcome** — does the change deliver the accepted task without material omission or unrelated scope?
2. **Standards** — is it sound for the active quality posture and the task's material risks?

Reproduce only the evidence the decision needs. Author self-check is not independent acceptance.

A finding blocks when it violates acceptance, risks data loss or credential disclosure, exposes restricted data, breaks an accepted contract, or creates a likely user-facing correctness failure. An improvement outside the accepted boundary becomes follow-up work only when authorised; it does not block.

## Declare the blast-radius trigger

Every verdict states whether non-local analysis was warranted:

```text
blast-radius: none — no durable boundary, diff proportionate to task
blast-radius: Elevated — persisted shape changed at src/store/schema.ts:88
```

Escalate only when a trigger fires: a suspiciously small diff for the change described, or a durable Elevated or Critical boundary. Nearby sensitive code does not make an ordinary change Critical.

When escalating, identify changed symbols, persisted shapes, wire formats, artifacts, external calls, and downstream readers. Look past direct references when the change reaches serialised data, migrations, IPC, packaged paths, deterministic outputs, or another process. Name the one or two facts safety depends on and prove each with the cheapest credible evidence: exact contract, walked failure path, focused execution, or real artifact observation. Say where proof stopped.

The declaration is required because an escalation phrased as permission gets run every time, which buys correlated findings from one model at double the cost instead of independent coverage.

## Report and stop

Report actionable findings first with precise references, then verification, uncertainty, and the acceptance decision. State clearly when there are no findings.

Write full findings as a task comment. Return five lines to the orchestrator:

```text
task: {{TASK_PREFIX}}-14
verdict: accept | block
findings: 0 blocking, 2 follow-up
blast-radius: none
next: integrate
```

Do not fix, integrate, expand scope, or create hardening tasks. Change task status only when {{OWNER_NAME}} has separately granted status or acceptance authority, and then use `.switchflow/scripts/backlog.ps1`. With status authority, a blocking finding returns **Review** to **Ready** with a comment; otherwise report and await an authorised actor.
