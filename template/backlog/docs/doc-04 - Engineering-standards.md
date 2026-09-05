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

- Build the simplest implementation that satisfies the accepted outcome and risk. Minimize the effort to understand, change, and verify the behavior; do not optimize for the fewest files or lines.
- Give each business rule and state transition a clear owner. Keep values that must change together behind one transition, and avoid multiple independent update paths for the same state. Extract a function, component, or module when it isolates that responsibility or removes unrelated setup from verification. Moving code into another file without improving ownership is insufficient.
- In UI code, extract components around coherent interactions and state ownership. Separate substantial domain rules and data access from rendering when they obscure those boundaries. A simple screen may remain one file.
- A local function, component, or module may be justified by clarity at one use site. Shared abstractions, configurable frameworks, and compatibility layers require a demonstrated current need.
- Prefer existing repository and platform capabilities when they satisfy the required behavior. Keep custom mechanisms only for a concrete gap, and isolate that exception. Do not remove necessary synchronization or behavior merely to reduce effects, hooks, or code size.
- Make local structural improvements needed for the changed behavior as part of implementation. Keep unrelated cleanup outside the task. Do not split code solely to meet a size limit or introduce interfaces solely to satisfy a principle.
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

Classify each task by its highest material risk. Verify behavior at the narrowest layer that can faithfully exercise it, with integration checks for the boundaries that layer cannot prove. Repeatedly needing unrelated application setup or packaging for a local behavior is evidence to examine the dependency boundary.

Evidence is required at two levels. Task evidence proves the changed outcome and runs on the task branch. Phase evidence proves the integrated state and runs once, at the phase gate, on the integration branch.

| Class | Typical work | Task evidence | Phase-gate evidence |
| --- | --- | --- | --- |
| **Documentation-only** | Document, task, skill, or governance changes with no runtime or operational risk. | Relevant documentation or board check plus diff review. | Documentation check on the integrated state. |
| **Standard** | Ordinary domain, internal, or UI behavior. | Changed-outcome tests only. | Full repository suite. |
| **Elevated** | Persistence, migration, imports, authentication, deterministic domain behavior, or deployment configuration. | Changed-outcome tests plus focused failure-path and affected-boundary checks. | Full repository suite plus the affected boundary exercised on the integrated state. |
| **Critical** | Secrets, destructive migration, live external writes, public restricted-data exposure, or another identified high-impact boundary. | Elevated task evidence plus an independent reviewer with the relevant expertise. | Elevated phase evidence. Use live proof only when acceptance requires a live claim. |

**Choose the phase gate from the affected risk.** Documentation-only phases run the applicable documentation and board checks plus integrated diff review. Phases with runtime or operational changes run the full repository suite once on the integrated candidate, plus required boundary checks. Task branches use focused evidence. Preserve an explicit recorded gate unless an authorized amendment records why it changes; do not silently skip it.

Do not re-run any suite that no change has invalidated since its last run.

If documentation changes a safety-sensitive operating procedure, classify it by the underlying risk rather than as Documentation-only.

## Review threshold

Follow the [delivery review contract](/documentation/08/delivery-contract#independent-review). One independent reviewer normally checks the accepted outcome and these standards. Add another reviewer only for a separate expertise gap.

A finding blocks acceptance when it violates acceptance, risks data loss or credential disclosure, exposes restricted data, breaks an accepted contract, or creates a likely user-facing correctness failure.

Structural findings block when the change introduces or materially worsens conflicting ownership of a rule or state, duplicated decision logic, or dependencies that force unrelated changes or setup. Identify the concrete consequence and smallest correction. File length, pattern preference, and hypothetical future requirements do not establish a finding.

Unrelated pre-existing structural debt remains outside the task unless the owner expands scope. Improvements outside the accepted boundary become follow-up work only when authorized.
