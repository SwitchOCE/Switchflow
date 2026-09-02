---
id: doc-04
title: Engineering standards
type: reference
tags: ["engineering", "governance"]
---

# Engineering standards

## Current quality target

Deliver the smallest useful, reviewable slice with the shortest credible feedback loop while protecting the task's material correctness, data, credential, recovery, and external-write boundaries.

This is the single active engineering target. Project phase is descriptive context and does not select another quality level. Do not infer production, enterprise, regulated, multi-tenant, or high-scale requirements. Change this target only through an explicit owner decision that updates this document. Record task-specific affected-axis overrides in the task; do not create named quality tiers.

## VAPS posture

- **Velocity:** Deliver the smallest useful slice and get feedback early.
- **Adaptability:** Prefer replaceable choices while requirements and architecture are still changing. Add abstractions or compatibility paths only for a current need.
- **Performance:** Measure against an accepted requirement, observed problem, or material risk.
- **Stability:** Prevent data loss, correctness failures, credential disclosure, and unauthorized external writes.

Treat these axes independently. Speed does not offset a material stability risk. Apply the current target, then raise only an affected surface for accepted task risk. Only task acceptance or an explicit owner decision changes the posture. Record an override with its risk class, affected axes, and reason.

Do not calculate a combined score across the axes. Project phase, technical complexity, and the word "production" do not select a stricter tier. Do not introduce numeric weights, coverage quotas, latency budgets, uptime targets, platform matrices, or enterprise controls without a stated owner need and a repeatable way to measure them. A reviewer may make an accepted task-specific affected-axis decision; that does not create a second project-wide quality level.

When the owner changes the active target, update this document and any affected planning guidance. A phase change updates the project profile only. Do not rewrite existing tasks or remove low-cost safeguards without a concrete maintenance or behaviour problem.

## Delivery rules

- Build the simplest implementation that satisfies the accepted outcome and risk.
- Prefer a thin, useful vertical slice over a complete subsystem.
- Treat legacy behavior as evidence, not an implicit requirement.
- Defer speculative generalization, exhaustive edge cases, and operational machinery.
- Follow owner scope and risk decisions unless they are unsafe or impossible.
- Do not deploy, alter live data, rotate credentials, or change access controls without explicit authorization for that external action.

## Universal protected boundaries

- Never commit credentials, private keys, personal data, or restricted source data.
- Preserve original imported records and version derived analysis instead of overwriting source evidence.
- Inspect remote state before any destructive or production mutation.
- Prefer recoverable operations and prove rollback when a task can destroy or irreversibly transform material data.
- Add project-specific domain, licensing, deployment, and compatibility boundaries to the project profile before work affects them.

## Risk and verification

Classify each task by its highest material risk and use the smallest evidence set that proves the changed outcome.

Evidence is required at two levels. Task evidence proves the changed outcome and runs on the task branch. Phase evidence proves the integrated state and runs once, at the phase gate, on the integration branch.

| Class | Typical work | Task evidence | Phase-gate evidence |
| --- | --- | --- | --- |
| **Documentation-only** | Document, task, skill, or governance changes with no runtime or operational risk. | Relevant documentation or board check plus diff review. | Documentation check on the integrated state. |
| **Standard** | Ordinary domain, internal, or UI behavior. | Changed-outcome tests only. | Full repository suite. |
| **Elevated** | Persistence, migration, imports, authentication, deterministic domain behavior, or deployment configuration. | Changed-outcome tests plus focused failure-path and affected-boundary checks. | Full repository suite plus the affected boundary exercised on the integrated state. |
| **Critical** | Secrets, destructive migration, live external writes, public restricted-data exposure, or another identified high-impact boundary. | Elevated task evidence plus an independent reviewer with the relevant expertise. | Elevated phase evidence. Use live proof only when acceptance requires a live claim. |

**Do not run the full repository suite per task.** It runs once per phase. A full suite on an isolated task branch cannot detect what it is being run for, because cross-task interference only becomes observable after integration. Running it per task also fills the worker's context with output that displaces the code it needs to reason about.

Do not re-run any suite that no change has invalidated since its last run.

If documentation changes a safety-sensitive operating procedure, classify it by the underlying risk rather than as Documentation-only.

## Review threshold

Follow the [delivery review contract](/documentation/08/delivery-contract#independent-review). One independent reviewer normally checks the accepted outcome and these standards. Add another reviewer only for a separate expertise gap.

A finding blocks acceptance when it violates acceptance, risks data loss or credential disclosure, exposes restricted data, breaks an accepted contract, or creates a likely user-facing correctness failure. Improvements beyond the accepted boundary become follow-up work unless the owner expands scope.
