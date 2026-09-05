---
name: create-human-task
description: 'Create or revise the {{PROJECT_NAME_YAML_SINGLE}} Backlog.md task for action by {{OWNER_NAME_YAML_SINGLE}} or a person {{OWNER_NAME_YAML_SINGLE}} coordinates. Always assigns Human and writes a concise step-by-step checklist.'
---

# Create Human Task

Use this skill when completion requires human access, judgement, physical observation, or coordination.

Every milestone closes with one of these. `plan-milestone` builds the closing acceptance test from the scope contract's **UAT definition** and makes it depend on the final phase. Naming human-only work while planning is what prevents an orchestration run halting on it later.

## Steps

1. Read `AGENTS.md`, `backlog/docs/doc-07 - Task-contract.md`, related tasks and comments, and the minimum relevant documentation. For a closing acceptance test, read the milestone's UAT definition and use its wording. Search for the same result before creating a task.
2. Define one human-owned result. Keep agent work and work for different people in separate tasks. Confirm required access, equipment, inputs, and dependencies.
3. Write a direct title and use the description shape below. Give numbered actions in execution order and, when applicable, observable acceptance criteria.
4. Set the assignee to exactly `Human`. Apply the task contract: Ready when the person can start, Blocked when prepared instructions wait on a named prerequisite, and Backlog when scope or acceptance needs definition. Record dependencies and every blocker's unblock owner and condition.
5. Create or update the task through `.switchflow/scripts/backlog.ps1`. When editing, resolve open {{OWNER_NAME}} comments before relying on the existing scope.
6. Re-read it with `task view --json`, verify every field, then run `.\.switchflow\scripts\backlog.ps1 doctor`.

## Description shape

```markdown
## Purpose

Why this is needed and the finished result.

## Before you start

- Required access, tools, inputs, or completed dependencies.

## Steps

1. First action.
2. Next action.
3. Verify the result.

## Report back

- Result or non-sensitive evidence to add to the task.
- Information needed if the task cannot be completed.
```

Omit **Before you start** when nothing is required. Write for someone who may not know the agent context:

- Name the application, screen, file, value, or observation needed.
- Prefer visible outcomes and familiar UI wording over repository detail.
- State when to stop and ask for help.
- Never request secrets or sensitive values in a task or comment.
- Do not repeat every step as an acceptance criterion.

Create with `--assignee Human`; never use a person's name as the Backlog assignee. When an agent task needs the result, add this human task as its dependency. Report the linked task name, status, and person {{OWNER_NAME}} needs to coordinate with when known.
