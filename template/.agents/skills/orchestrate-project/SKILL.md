---
name: orchestrate-project
description: 'Run the {{PROJECT_NAME_YAML_SINGLE}} lifecycle from browser initiation through Intake, Planning and guided UAT, automatically delivering all approved phases.'
---

# Orchestrate Project

Use when the owner explicitly starts or resumes a project run, including its browser initiation action. Read `AGENTS.md`, doc-03's project grant, the current run checkpoint, its linked intake, accepted scope revision, plan and open owner comments. Do not read unrelated repository content or framework friction bodies. Delegate bounded fact-finding and delivery under existing role contracts.

1. Resume a matching durable run before creating another. Reconcile active workers, phase/task state, candidate and approval evidence after interruption; never replay completed mutations or assume an interrupted dispatch failed.
2. Invoke `intake` for unresolved scope. Preserve capability inventory and decisions across sessions. Respect its review toggle. Return the owner to the same Intake gate only for a remaining material question.
3. Invoke `plan-milestone` to prepare all intended phases and final guided UAT. Respect its review toggle. Present the concrete plan and existing boundaries for the Planning decision. Record the owner's actual approval against its revision; agent-written approval text alone does not authorize execution.
4. Under that grant, execute each eligible listed phase using `orchestrate-phase`. Preserve task boundaries, independent review, integrated gates and cleanup. Start successors automatically when their prerequisites pass; do not ask for phase starts or technical milestone acceptance. At each boundary persist run identity, phase/task IDs, scope and plan revisions, active workers, worktrees, integrated SHA, evidence, blockers and next action.
5. When execution reveals changed scope, checkpoint affected work and use doc-09's revision procedure. Continue unaffected authorized work. A scope edit or task status change does not silently extend the approved phase set. Honour pause/cancel requests at a safe checkpoint and preserve work. A read-only update does not dispatch anything.
6. At technical completion prepare the exact candidate and invoke `guided-uat`. Stop automatic delivery at the human verdict. On failure distinguish correction within accepted scope from new scope; continue only under the applicable recorded correction authority and independently review changes before returning the updated candidate to UAT.

Record every clarification/permission request in external operations friction, including which existing instruction was checked and why interruption remained necessary. Never use this record to dispatch framework work. Lead replies with the next action and its owner; report partial or blocked proof honestly.

Exit with the current human gate or completed UAT verdict, candidate, concise evidence, retained exceptions and exact next action. A launched process, completed phase or green suite is not project acceptance.
