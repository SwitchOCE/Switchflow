---
name: migrate
description: Move a Switchflow project from a copied template install to plugin mode. Removes the copied scripts and skills on a new branch, marks .switchflow/project.json as a plugin install and rewrites the AGENTS.md commands, keeping the backlog, documents and state.
when_to_use: The owner runs /switchflow:migrate, or asks to switch a project from the copied Switchflow scripts to the plugin.
argument-hint: '[project folder]'
---

# Migrate a project to plugin mode

You move a template-mode Switchflow project to plugin mode. Afterwards the project holds only data and the plugin supplies the runtime, the board and the workflow skills.

## 1. Check the project

The target is `$ARGUMENTS` when given, else the current project folder `${CLAUDE_PROJECT_DIR}`. Confirm, and stop with an explanation when one fails:

- `.switchflow/project.json` exists and does not already say `"install": "plugin"`;
- the folder is the primary checkout, not a linked worktree;
- `git status --porcelain` is empty. If it is not, show the changes and let the owner commit or stash them; never stash, reset or discard for them.

## 2. Explain and ask

Tell the owner what the tool will do:

- create and switch to the branch `switchflow/migrate-to-plugin`;
- `git rm` the template-only files that are tracked: `.switchflow/scripts`, `.switchflow/package.json`, `.switchflow/package-lock.json`, `.agents/skills`, `Start Switchflow.cmd` and `.github/workflows/switchflow.yml` (the CI workflow that ran the copied validation scripts);
- set `"install": "plugin"` in `.switchflow/project.json` and point the `AGENTS.md` commands at `switchflow-backlog`;
- keep `backlog/`, `backlog.config.yml`, the documents and all Switchflow state.

Use AskUserQuestion to ask whether to commit the result on the new branch, or leave it staged for review.

## 3. Run the tool

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/migrate.mjs" --target "<folder>" [--commit]
```

If `${CLAUDE_PLUGIN_ROOT}` above was not replaced with a real path, run `switchflow-migrate` with the same arguments instead; it is on the Bash PATH while the plugin is enabled.

## 4. Report

Relay the tool's summary. Point out:

- the removed CI workflow, if any;
- the tracked files the summary lists as still mentioning `.switchflow/scripts`; offer to update them, but change nothing without the owner's go-ahead;
- `.switchflow/node_modules`, if reported: it is ignored by Git and can be deleted once no board runs from this project's old copy;
- that the branch is local. Merging it and pushing are the owner's decisions; do not do either unless asked.

If the tool fails part-way, it restores the checkout and deletes the branch. Show its message as it is.
