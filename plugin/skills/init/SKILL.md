---
name: init
description: Set up Switchflow in a project folder as a plugin-mode project. Asks the owner for the project name, task prefix and options, then writes the backlog, documents, AGENTS.md and .switchflow/project.json without copying any Switchflow scripts.
when_to_use: The owner runs /switchflow:init, or asks to add, import or initialize Switchflow in a project.
argument-hint: '[target folder]'
---

# Initialize a Switchflow project

You set up a plugin-mode Switchflow project. The plugin keeps the control service, the backlog runtime and the workflow skills; the project only receives data: `backlog/`, `backlog.config.yml`, `AGENTS.md`, `.switchflow/project.json` and a `.gitignore` block.

## 1. Pick the folder

The target is `$ARGUMENTS` when given, else the current project folder `${CLAUDE_PROJECT_DIR}`. Resolve it to an absolute path and show it to the owner.

Stop and explain instead of running the tool when:

- `.switchflow/project.json` already exists. If it has no `"install": "plugin"`, the project uses a copied template install; offer `/switchflow:migrate` instead.
- the folder is a linked Git worktree (`git rev-parse --git-common-dir` is not `<folder>/.git`). Switchflow belongs in the primary checkout.

## 2. Ask for the inputs

Gather the values with as few questions as possible. Use AskUserQuestion for the choices and offer your suggestion as the first option; the owner can type their own answer.

| Input | Flag | Suggestion |
| --- | --- | --- |
| Project name | `--project-name` | The folder name in plain words. |
| Task prefix | `--task-prefix` | 2 to 8 capital letters or digits starting with a letter, from the project name (for example `SHOP`). |
| Owner name | `--owner` | The name in `git config user.name`, else `Project owner`. |
| Repository URL | `--repo-url` | `git remote get-url origin` when it is an `https://` URL; otherwise leave it out. Only HTTP or HTTPS URLs are accepted. |
| Starting phase | `--phase` | `Discovery`. |
| Initialize Git | `--initialize-git` | Offer only when the folder has no `.git`. |
| Share with collaborators | `--share` | Ask whether collaborators who clone the repository should be offered the Switchflow plugin. This adds the marketplace and `switchflow@switchflow` to `.claude/settings.json`, keeping every existing setting. |

Values must be single-line text and may not contain `{{...}}`.

## 3. Run the tool

Run it with the Bash tool. Quote every value; use single quotes when a value contains `$`, a backtick or `"`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/init.mjs" --target "<folder>" --project-name "<name>" --task-prefix <PREFIX> --owner "<owner>" [--repo-url "<url>"] [--phase "<phase>"] [--initialize-git] [--share]
```

If `${CLAUDE_PLUGIN_ROOT}` above was not replaced with a real path, run `switchflow-init` with the same arguments instead; it is on the Bash PATH while the plugin is enabled.

## 4. Handle the result

The tool writes nothing unless every check passes, and rolls back what it moved if a later step fails. When it refuses, show its message and the fix it names. Never delete, move or overwrite the owner's files to get past a refusal. If it reports an interrupted import, show the `recovery.json` path it names and leave that folder for the owner to inspect.

On success, tell the owner:

- what was created, and any warnings the tool printed;
- the next step: describe the project in `backlog/docs/doc-02 - Project-profile.md`, then start with intake;
- that nothing was committed. Offer to commit the new files, and with `--share` mention that `.claude/settings.json` must be committed for collaborators to see the plugin. Do not commit or push unless the owner says so.
