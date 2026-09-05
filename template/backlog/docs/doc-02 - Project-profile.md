---
id: doc-02
title: Project profile
type: reference
tags: ["governance", "project"]
---

# Project profile

## Identity

- **Project:** {{PROJECT_NAME}}
- **Product owner comment name:** {{OWNER_NAME}}
- **Task prefix:** `{{TASK_PREFIX}}`
- **Repository:** {{REPOSITORY_DISPLAY}}

## Product goal

No product goal has been recorded yet. Replace this paragraph before creating the first product milestone.

## Current phase

**{{PROJECT_PHASE}}.** Confirm or change this phase when product context changes. Phase is descriptive context; it does not select a different engineering quality level. The single active quality target is owned by [Engineering standards](/documentation/04/engineering-standards).

## Task branch naming

The task branch pattern is `task/{0}`, where `{0}` is the task ID. Replace this value when the project uses another convention, such as `codex/{0}`. Workers use the recorded pattern when creating branches; orchestration passes it to `cleanup-phase.ps1 -BranchPattern` together with the exact board-unique phase label.

## Normal verification

No application-specific build, test, lint, type-check, or artifact commands have been recorded yet. Add the smallest normal gate before the first runtime change.

## Approval posture

Record which command families run without escalation in this project, and which always require a decision. Planning uses this: a task needing an action outside the approved set will halt mid-execution, which readiness condition 7 in the [task contract](/documentation/07/task-contract) is meant to catch before work starts.

No approval posture has been recorded yet. Record the approved families, the always-escalate families, and where the rules live before relying on unattended orchestration.

Keep this list aligned with **Normal verification** above. A verification command that is not pre-approved costs an approval round trip on every task that runs it, and each of those replays the session transcript. Divergence between the two lists is a cost defect rather than a safety measure.

Three rules constrain what belongs here:

- **Prefix rules do not constrain what follows them.** Approving a prefix approves every flag after it. Verify that the dangerous variants of a family are actually rejected before approving the prefix.
- **A command that uses shell features is not matched at all.** Redirection, substitution, an environment-variable prefix, or a wildcard makes the whole invocation evaluate as a single opaque shell command, so it matches no rule and escalates regardless. Plain pipelines and `&&` chains are split into segments and matched normally. An approved command still costs a round trip when an agent writes it with a redirect.
- **Approve the narrowest thing that carries the guarantee.** Where a script already enforces a safe predicate, approve the script rather than the commands it runs. `.switchflow/scripts/cleanup-phase.ps1` deletes branches, but only ones its own checks prove are Done and fully merged; approving the script is safer than approving branch deletion.

Verify a rule rather than reasoning about it. Where the agent client provides a policy checker, run the dangerous variant of each approved family through it before relying on the rule.

The sandbox, not this list, is the security boundary. These rules control interruption, not permission.

## Protected boundaries

The universal credential, user-data, destructive-operation, and live-write safeguards in [Engineering standards](/documentation/04/engineering-standards) apply.

No additional project-specific boundary has been recorded. Add any domain correctness, licensing, regulated data, deployment, migration, or compatibility boundary before work can affect it.
