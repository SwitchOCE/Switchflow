# Switchflow as a Claude Code plugin — plan

Date: 2026-10-10. Base: `main` at `274ef67` (VERSION 0.6.0). Claude Code 2.1.288, Node 24.19.0.

## Goals (from the survey)

- **Main goal:** Switchflow should feel native in Claude Code. It is driven from the session, with no separate setup.
- **Target (amended 2026-10-10):** the Claude Code **Desktop app's Code tab** only. The terminal, VS Code and `-p` don't matter.
  - The Desktop app runs on Windows and macOS, not Linux. So "Windows + Linux" now means:
    - **Windows:** where Desktop and the service run.
    - **Linux:** worker hosts only, meaning the SSH box and cloud sessions.
  - Desktop sessions inside WSL don't load plugins, so the WSL box stays a worker host and nothing more.
- **Who installs it:** you and a few others, through a GitHub marketplace.
- **What goes where:** the UI moves into Claude Code. Everything else ships inside the plugin, and the project keeps only its data.
- **Old template installs:** keep working alongside the plugin for now.
- **Control service:** stays always on, so SSH and cloud workers are watched with no session open.
- **Platforms:** Windows and Linux.
- **Codex:** stays as it is today.
- **UI:** use the best native surfaces available. If something can't be done in Claude Code, fall back rather than force it.

## What exists today (short)

- **Install:** `scripts/import-switchflow.ps1` copies `template/` into each project:
  - 102 script files under `.switchflow/`;
  - 11 skills in `.agents/skills`;
  - `AGENTS.md`, `backlog/`, and a CI workflow.
  
  There is no update path (SF-07). The importer writes nothing for Claude Code: no `.claude/`, hooks, commands or `.mcp.json`.
- **Control service:** `control/server.mjs`, about 13.5k lines with no npm dependencies.
  - It is already a detached daemon on 127.0.0.1, one per machine, serving every project.
  - State lives in `%LOCALAPPDATA%\Switchflow` (Linux: `~/.local/state/switchflow`).
  - It runs from whichever project's `.switchflow/scripts` started it.
- **Browser UI:** `control/public/`, 11k lines of JS and 8.7k of CSS, polling every 3 s.
  - Views: Overview, Initiatives (stage actions and approvals), Agents (feed, steer, approach gate, routing, environments, capacity, pause), Tasks kanban, Milestones, Documents, Insights, Skills.
- **How agents get skills:** the service tells each worker to read `.agents/skills/<skill>/SKILL.md` from its worktree. Claude Code's own skill system isn't used.
- **Windows dependencies:** importer, `start-control.ps1`, `backlog.ps1` routing, `cleanup-phase.ps1`, and `check-worktree-tools.ps1` are PowerShell-only. Linux was only partly run.
- **Bug found while investigating:** `control/projects.mjs:30` only accepts `templateVersion` 0.5.x, but the importer now writes 0.6.0. So a fresh import is refused when it registers with the service. This needs fixing regardless of the plugin.

## What Claude Code gives a plugin (checked 2026-10-10)

| Need | Plugin feature | Limits |
| --- | --- | --- |
| Install, update, share | Marketplace file in a GitHub repo. `version` in `plugin.json` decides when users update, and auto-update is opt-in per user. | Needs Git for Windows. This repo is public, so no auth is needed. |
| Code and state | `${CLAUDE_PLUGIN_ROOT}`: the installed copy, which changes with every version; old copies are deleted after 14 days. `${CLAUDE_PLUGIN_DATA}` survives updates. | The daemon must not run from `CLAUDE_PLUGIN_ROOT`, or an update deletes its code while it runs. |
| Live UI | **Mods:** a JS/TS hooks module that can draw a **pane** (a sidebar from 144 columns wide), a **band** above the prompt, a **status line entry**, and **toasts**. It also has buttons, inputs and selects, slash commands, `$.http.fetch`, timers, and `$.prompt.submit` to wake an idle session. | Needs CLI 2.1.287 or later, or Desktop 2.1.286 or later. Drawn in the Desktop Code tab (the target). **Not drawn** in cloud sessions or Desktop WSL sessions. The API is "early access" and changes between releases. |
| Tools Claude can call | A plugin `.mcp.json` (stdio). Works on every surface, including VS Code and `-p`. | Normal permission prompts apply. |
| Workflows | Skills `/switchflow:<name>`, agents `switchflow:<name>`, hooks (SessionStart and others). | A plugin can't set the user's main `statusLine` setting. The mod's `$.ui.status` adds an entry instead. |
| A daemon that outlives the session | Not offered directly. A process the plugin starts and lets go of keeps running. Login start-up is the OS's job: Task Scheduler on Windows, a systemd user unit on Linux. | |

## Proposed design

```text
Claude Code session ──────────────────────────────┐
  mod (pane, band, status, toasts, buttons)       │  HTTP to 127.0.0.1
  .mcp.json stdio shim (tools for Claude)         ├──────────────► switchflow daemon (always on)
  skills /switchflow:*                            │                 runs from ${CLAUDE_PLUGIN_DATA}/runtime/<version>/
  SessionStart hook: start daemon if not running  │                 state: %LOCALAPPDATA%\Switchflow (unchanged)
──────────────────────────────────────────────────┘                 drives claude / codex / ssh / cloud workers
```

### 1. Packaging

- Add `.claude-plugin/marketplace.json` at the repo root. The plugin lives in `plugin/`, and the marketplace entry points at it with `"source": "./plugin"`.
- The plugin contains:
  - `service/`: the control service, moved from `template/.switchflow/scripts/control/` and shared, not copied;
  - `mod/`: the hooks module and UI;
  - `mcp/`: the stdio shim;
  - `skills/`, `agents/`, `hooks/`;
  - `backlog-fork/`: the setup scripts.
  
  The template keeps its own copy until it is retired, generated from `plugin/` by a build step so the two can't drift.
- Install in one line:

  ```text
  /plugin install switchflow@switchflow --marketplace SwitchOCE/Switchflow
  ```

  This needs Node 24 and Git on PATH.

  The Desktop Code tab doesn't offer the `/plugin` command, so the first install is two commands run once in any shell. Phase 0 checks whether Desktop's own plugin settings can do this instead.

  ```text
  claude plugin marketplace add SwitchOCE/Switchflow
  claude plugin install switchflow@switchflow
  ```

  A plugin installed at user scope loads in Desktop's local sessions.

### 2. Always-on daemon

- **Runtime copy:** on start, the launcher (`service/launch.mjs`, replacing `start-control.ps1`) copies `service/` to `${CLAUDE_PLUGIN_DATA}/runtime/<version>/` and runs it from there, detached. Plugin updates and their 14-day cleanup then never touch running code.
- **Starting it:** a SessionStart hook runs the launcher, exec form (`node`, not a `.cmd` shim). If a healthy daemon of the same or a newer version answers `/api/health`, it does nothing.
- **Start at login:**
  - `/switchflow:service install` creates a per-user Windows logon task.
  - `/switchflow:service remove` undoes it.
  - It is opt-in, because it changes OS configuration.
- **Upgrades:** `/api/health` reports the daemon's version.
  - When a session sees a newer plugin version, the band shows "Update ready".
  - The swap happens only when no run is active, or when you press Restart. Restart recovery (fences, reattach, SSH recovery refs) already covers a stop in the middle of a run.
- **Stopping:** add `POST /api/shutdown` (CSRF-protected) and `/switchflow:service stop`.

### 3. Project layout in plugin mode

- `/switchflow:init` replaces `import-switchflow.ps1` with a Node port. It writes data only:
  - `.switchflow/project.json` (new field `"install": "plugin"`);
  - `backlog.config.yml` and `backlog/`;
  - `AGENTS.md`, kept for Codex and Codex-only users;
  - the `.gitignore` block;
  - optionally, `.claude/settings.json` with `extraKnownMarketplaces` and `enabledPlugins`, so collaborators are offered the plugin.
  
  No scripts, `node_modules`, or `.agents/skills`.
- **Tool root:** the service resolves the paths it now hard-codes against either the project (template mode) or the plugin (plugin mode): `.switchflow/node_modules/backlog.md`, `.switchflow/scripts/backlog.ps1`, `.agents/skills`, and `check-ready-dependencies.mjs`. The Backlog fork build already lives in a per-machine cache (`%LOCALAPPDATA%\Switchflow\backlog-fork`), and `backlog.md` becomes a plugin dependency.
- **Skills reach workers by being included in their prompt,** not read from the worktree. That works the same for local, SSH, Claude cloud and Codex workers; cloud workers can't see a local plugin path anyway. `{{PROJECT_NAME}}` and the other placeholders are filled from `project.json` at run time instead of at import.
- **Node instead of PowerShell:**
  - **Must port** (they run on Linux workers): the `backlog.ps1` routing that workers call. It becomes `backlog.mjs` in `bin/`, which puts it on the Bash tool's PATH, and the service adds it to workers' PATH. Worker Bash allowlists switch from `powershell … backlog.ps1` to `switchflow-backlog …`.
  - **Port as part of the move** (Windows only, but Node is simpler to ship): `start-control.ps1` becomes `launch.mjs`, and the importer becomes `/switchflow:init`.
  - **Can stay PowerShell:** `cleanup-phase.ps1` and `check-worktree-tools.ps1`, because the service only runs on Windows now.

### 4. Native UI

The mod is thin: it draws and sends button presses, and all logic stays in the daemon. It polls a new compact endpoint, `GET /api/summary?since=<version>`, every 3 s through `$.http.fetch`. It finds the daemon through `service-info.json` and authenticates with the token the browser already uses.

| Today in the browser | In Claude Code |
| --- | --- |
| Is anything running? Does it need me? | **Status line entry:** `SF ▸ Delivery · 4 workers · 1 needs you`. **Band** above the prompt, only when something needs you, with the action buttons inline. |
| Approve scope or plan, confirm approach, accept UAT, release hold, Test again | **Band buttons** (approval band) that work with hotkeys. These are the only way to approve; see Decisions. |
| Initiatives and stage track, workers by environment, capacity, held workers | **Pane** "Switchflow", opened with `/switchflow:board`. A sidebar when the terminal is wide enough; otherwise it opens inline. |
| Worker feed, steer, stop | Pane worker detail: event feed (`Markdown`), an `Input` to steer, and a Stop button. |
| Environment forms (SSH, Claude cloud, Codex cloud), Test all, Pause local workers | `/switchflow:env`: Claude asks the questions (AskUserQuestion) and saves through an MCP tool. Pause is a pane toggle and also `/switchflow:pause`. |
| Worker finished, review ready, environment down, run held | **Toasts.** `$.prompt.submit` can wake an idle session; this is opt-in. |
| Answering intake questions | In your session: the question appears in the band, and `/switchflow:answer` or the pane's Input sends the answer. See Decision 1 for moving intake fully into the session. |
| Tasks kanban, milestone editor, Documents, Insights | Phase 1: a read-only list in the pane, and Claude reads `backlog/` directly. Full editing stays in the browser board (`/switchflow:board --browser`) until we know whether it's missed. |

Everything above is drawn for the `desktop` surface only. Phase 0 checks two Desktop details:
- **Where the pane sits:** whether Desktop docks it beside the chat or opens it inline (`e.viewport.isFullscreen`).
- **The browser board:** whether a localhost `Link` opens the board in Desktop's built-in browser pane. If it does, that's the fallback for the kanban and milestone editor, and they stay inside the app.

Desktop also allows a `Client` element, a custom drawing module. If Phase 0 shows it is capable enough, it's the candidate for a native kanban later.

### 5. Tools and skills for your session

- **MCP shim** (`mcp/server.mjs`, the same pattern as `orchestration-mcp.mjs`). Tools:
  - `status`, `list_initiatives`, `start_initiative`, `answer`;
  - `worker_feed`, `steer_worker`, `interrupt_worker`;
  - `list_environments`, `add_environment`, `test_environment`;
  - `pause_local_workers`, `open_board`.
  
  It doesn't expose approval actions.
- **User skills:**
  - `/switchflow:init`, `/switchflow:start` (new initiative), `/switchflow:status`, `/switchflow:board`;
  - `/switchflow:env`, `/switchflow:pause`, `/switchflow:service`, `/switchflow:migrate`.
- **Workflow skills** (intake, plan-milestone, orchestrate-*, deliver-task, review-task, and the rest) ship in the plugin as the single source. They are marked `disable-model-invocation: true` so they don't fill your session's skill list, and the daemon includes them in workers' prompts.
- **Codex:** unchanged. The daemon still drives `codex app-server` and Codex cloud, and gets the skill text the same way.

### 6. Template and plugin side by side

- **One daemon and one state folder.** A template project's `start-control.ps1` finds the plugin daemon healthy (apiVersion 2) and attaches; the reverse also works. The tool root keeps each project on its own Backlog CLI.
- **Version check:** replace the `0.5.x` regex with "schema 1, template 0.5 or later, or plugin install". This also fixes the 0.6.0 bug above.
- **Moving a project over:** `/switchflow:migrate` works on a branch.
  - It removes `.switchflow/scripts`, `.switchflow/package*.json`, `.agents/skills` and `Start Switchflow.cmd`.
  - It sets `"install": "plugin"` and keeps `backlog/`, `AGENTS.md` and the state.
  - It shows the diff and you commit it.
- **Retiring the template:** once every project you use has moved over. Not scheduled.

## Phases

| Phase | Work | Exit check |
| --- | --- | --- |
| **0. Spike** (about 1 day) | A bare plugin with a mod pane that reads `/api/state` from the running daemon, an MCP stdio tool, and a SessionStart hook that starts the daemon detached. Check that one plugin can carry a mod module, ordinary hooks and `.mcp.json` together. Check drawing in the Desktop Code tab: where the pane sits, and whether a localhost link opens Desktop's browser pane. Check whether Desktop can install plugins itself. Install from a local marketplace, then update, and check that the daemon keeps running. (The 0.6.0 version check is already being fixed in a separate session.) | All of the above seen working in Desktop on Windows. |
| **1. Package and daemon** | Create `plugin/` and the marketplace file. Move `service/` with a build step that copies it to the template. Add the runtime copy to plugin data, `launch.mjs`, `/api/shutdown`, the upgrade-when-idle flow, and the Windows logon task. Add the tool root. Port `backlog.ps1` routing to Node for Linux workers. | The full suite passes on Windows, and the worker-side tests pass on Linux. Template projects still work unchanged. |
| **2. Native UI** | `/api/summary`, the status entry, the approval band, the pane (initiatives, workers, environments, capacity, feed and steer), toasts, and `claude plugin test` coverage on the `desktop` surface. | In Desktop, an initiative goes from intake to UAT approvals without opening the browser. |
| **3. Session tools and skills** | MCP shim tools, user skills, conversational `/switchflow:env`, and skills included in worker prompts for every environment. | A delivery on SSH and Claude cloud with workers getting skills from the plugin. |
| **4. Init, migrate, ship** | `/switchflow:init` and `/switchflow:migrate`, docs (README install section and requirements), CI (`claude plugin validate --strict`, a Linux job), and version 0.7.0 tagged in the marketplace. | One other person installs it from the marketplace and runs `/switchflow:init` on a scratch repo. |
| **5. Later, if wanted** | Run intake and UAT in your own session (Decision 1). Retire the browser board (Decision 2). Retire the template. | — |

## Risks

- **The mod API is early access:** keep the mod thin (drawing only), set a minimum CLI version, and keep the browser board as the fallback. MCP and skills carry the essential path.
- **Desktop only:** the people you share it with need the Desktop app on Windows. macOS would run Desktop, but the service is untested there.
- **Logon task:** it changes OS configuration, so it's opt-in through a command, never done at install.
- **Two code copies during the side-by-side period:** a single source in `plugin/` with a generated template copy, enforced in `validate-switchflow.ps1`.
- **Plugin dependency install** runs npm with no lifecycle scripts and a 60 s limit. That's fine for `backlog.md`; the fork build stays a separate, first-run setup step.

## Phase 0 spike results (2026-10-10)

The spike mod lives at `~/.claude/dev-mods/<session>/switchflow-spike`. It ran against a throwaway fixture project with its own `SWITCHFLOW_HOME`.

| Check | Result |
| --- | --- |
| Pane in Desktop | **Works.** It docks beside the chat (`isFullscreen: true`), 88 columns wide in a 106-column viewport. |
| Bar above the prompt, status entry, pop-ups, input box, buttons | **Work** on the `desktop` surface. |
| Starting the service from the mod (`$.process.run` of a launcher that spawns detached and exits) | **Works.** The service started in 5.7 s. |
| Service survives a mod reload | **Yes.** After a reload the launcher reused the same pid in 46 ms. |
| One plugin with a mod module, ordinary hooks and `.mcp.json` | **Passes** `claude plugin validate --strict`. Not yet run inside a real session start. |
| Links | Desktop only links `https:` and `http://localhost` (127.0.0.1 is shown as plain text). The service already accepts `localhost:<port>`, so all links must use that. A link opens in the browser your Claude Code settings choose, which here is your default browser. |
| Screenshots of Desktop | Not possible: Claude can't take screenshots of its own app. Visual checks need you, or a report the mod writes. |
| First start | **Failed once.** The service exited with `Command failed: git … rev-parse --show-toplevel` and the error message had no stderr in it. It didn't happen again on the next load. The mod's environment has no `HOME`. The launcher should record git's stderr and retry once. |

**Install and update test.** A local marketplace holding a stand-in service, installed at local scope in the fixture project, then removed:

| Check | Result |
| --- | --- |
| Install from a marketplace | **Works.** A plugin source of a git URL (`file:///…` locally) copies the plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. A plain folder source is read from the folder itself, with no copy. |
| SessionStart hook, exec form (`node` + args) | **Fires.** `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are filled in, and `CLAUDE_PLUGIN_ROOT` is also set in the hook's environment. It runs before Claude's login check. |
| Service started from `${CLAUDE_PLUGIN_DATA}/runtime/<version>` | **Works.** |
| Update 0.1.0 → 0.2.0 | The code path moves to `…/0.2.0` and the data folder stays the same. The 0.1.0 copy is kept and marked `.orphaned_at`. **The 0.1.0 service kept running**, and the 0.2.0 hook found and reused it. |
| Plugin MCP server | `claude mcp list` shows `plugin:<plugin>:<server>` as **Connected**, with the paths filled in. |

Still open:
- the service surviving a full quit and restart of Desktop (owner will restart later);
- installing through Desktop's own plugin settings.

The standalone `claude` CLI login has expired (`claude auth status` shows `loggedIn: false`). That blocks headless runs, local Claude workers, and the Claude cloud adapter's routine calls, until the owner runs `claude auth login`.

## Running the work in the cloud

Most of the build can run in Claude cloud sessions on the Switchflow environment (`env_01GCmxMt1zESEPw1oYusiee2`). Each one pushes a `claude/…` branch; a local session then checks it on Windows and in Desktop before merging.

| Work | Where | Why |
| --- | --- | --- |
| Phase 0 spike | **Local** | It checks Desktop drawing, Desktop install, and a detached start on Windows. A cloud session can't do any of these. |
| Phase 1: moving the code, the build step that copies it to the template, the tool root, `backlog.mjs`, `/api/shutdown`, the upgrade flow | **Cloud** | It is Node code with Node tests. The Linux suite already passes (321 pass, 0 fail). |
| Phase 1: logon task, launcher on Windows, `validate-switchflow.ps1` | **Local** | These are Windows-only. |
| Phase 2: mod code | **Cloud**, then a local look | `claude plugin validate` and `claude plugin test` run headless and can test the `desktop` surface. The visual check happens in Desktop. |
| Phase 3: MCP shim, skills, skills in worker prompts | **Cloud** | Plain Node. |
| Phase 4: init and migrate in Node, docs, CI | **Cloud**, then a local install test | The install from the marketplace happens on this PC. |

Rules for the cloud sessions:
- **One branch per workstream,** not one per phase, so they can run side by side. Phase 1 has to land first, because the later phases build on its `plugin/` layout.
- **Nothing is pushed to `main` from the cloud.** Each session pushes only its own branch.

## Decisions for you

1. **Where intake, planning and UAT conversations run.**
   - (a) In the daemon as today, with questions relayed to the band and pane.
   - (b) In your own Claude Code session, where Claude asks you directly and saves through tools.
   
   (b) is more native but ties those stages to an open session. **Recommend (a) first, then (b) in phase 5.**
2. **Browser board.** Keep it as the fallback for kanban and milestone editing (**recommended**), or aim for native-only and drop it.
3. **Approvals only by button.** Plan approval, the approach gate and UAT acceptance would be band or pane buttons only, never MCP tools. That stops Claude from approving its own work, even in auto mode. **Recommended.**
4. **Marketplace location.** This public repo with `plugin/` (**recommended**: one repo, no auth for others), or a separate repo.
