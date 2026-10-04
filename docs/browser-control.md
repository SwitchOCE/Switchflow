# Browser control

The browser is the owner workspace. Its routine decisions are Intake, Planning, and UAT. Delivery phases and independent technical acceptance stay with agents under the approved plan.

## Run the board

After the setup steps, double-click `Start Switchflow.cmd`, run `npm --prefix .switchflow run board`, or use `.switchflow/scripts/backlog.ps1 control`. The service binds only `127.0.0.1` and chooses a free port. Its launcher validates the shared service protocol and PID before reuse, then registers the canonical Git project. The project selector observes all registered projects on that port, including running and attention counts. Switching is local to the browser tab: every API request carries an explicit project ID. `board:native` retains the pinned Backlog browser.

New initiative starts Intake in one click. The form accepts typed text and offers dictation when the browser exposes it. Microphone access remains a normal browser decision; unsupported or denied dictation leaves the text form usable.

Intake inspects existing capabilities, asks material questions, and returns proposed scope. Scope approval starts Planning. Plan approval records the exact plan and scope hashes and starts delivery across every listed phase. A checkpoint marked in progress continues automatically. UAT is shown only after the execution result includes evidence, no blockers, and a walkthrough; every step needs a human pass before acceptance. The service validates record shape and authorization, while independent reviewers establish the evidence's meaning.

UAT acceptance saves the human verdict and candidate evidence immediately, then queues an agent to mirror that existing decision into the primary Backlog task and milestone records. The initiative becomes Complete when that record update has evidence. A failed update can be retried without another acceptance decision; it does not grant main-branch integration or publication.

Walkthrough file references can open a committed-text preview in the board. The service accepts only the exact file reference already in that initiative's UAT, within a candidate registered to its approved grant. It verifies the candidate identity and reads the recorded commit's blob, preserving its whitespace; working-file edits cannot change the displayed acceptance artifact. Binary, oversized, linked, protected and unrelated files are refused. Application walkthroughs use their real HTTP or HTTPS links and still require the owner to try the product.

## UAT preview

The UAT checklist has a **Preview** bar that starts the delivered candidate on this computer and links to it. Starting a preview runs delivered code with your own permissions, outside any agent sandbox, exactly as if you had started it yourself.

Configure it once in `.switchflow/preview.json` in the primary checkout, next to `project.json`, and commit it like other project configuration:

```json
{
  "schemaVersion": 1,
  "command": "npm",
  "args": ["run", "dev", "--", "--host", "127.0.0.1"],
  "cwd": "web",
  "port": 5173,
  "env": { "VITE_MODE": "uat" }
}
```

| Field | Meaning |
| --- | --- |
| `command` | One program: a name found on `PATH` (such as `npm` or `node`) or an absolute path. Never a shell command line. |
| `args` | Its arguments, one string each. Optional. |
| `cwd` | Folder inside the candidate to run in, with forward slashes. Optional; defaults to the candidate root. |
| `port` | Optional. The preview counts as running once this loopback port accepts connections, and is refused if the port is already busy. Without it, the first `http://localhost`, `127.0.0.1` or `[::1]` address the program prints is used. |
| `env` | Optional extra variables. Do not put secrets here; the file is committed. |
| `allowNetwork` | Optional, `true` or `false` (default). Set `true` only if the preview must be reachable from other devices; see **Network listeners** below. |

**Who decides the command.** Only this owner-edited file supplies the command; it is read from the primary checkout, never from the candidate. Agents may propose a command in their delivery evidence, but it runs only after you put it in this file. Agents can write the governance checkout for Backlog work, so the file alone is not a security boundary: the bar always shows the exact command, Start sends the hash of the command you saw, and the service refuses to start if the file changed since. Every start is an explicit click. A missing or invalid file shows how to configure it.

**What it runs.** The candidate is the managed worktree registered to the initiative's approved Git grant, the same registry the committed-file preview uses. The bar suggests the candidate the delivery evidence names (by path, then HEAD); when several are registered you can pick another. Before starting, the service verifies the worktree identity, its branch, that its HEAD is the recorded delivered commit, and that no tracked file is modified, so the preview shows the delivered commit rather than your working checkout. The program runs in the candidate folder; keep generated build output gitignored so later candidate merges see a clean worktree.

**How it runs.** No shell is used. On Windows, `npm` and `npx` run as Node with npm's own CLI script; other `.cmd` or `.bat` wrappers are refused with a message to name the program they wrap. Program lookup uses absolute `PATH` entries only, never the candidate folder. The program receives your environment plus `HOST=127.0.0.1`, `BROWSER=none`, `PORT` when configured, and then `env`. The service cannot force a program to bind loopback only; configure that in its arguments as above. The bar links only to loopback addresses. It shows the latest 40 output lines (ANSI colours removed); output stays in memory and is not saved.

**Network listeners.** Because a program can ignore `HOST`, the service checks where the preview actually listens: once it is running, then every 30 seconds while it runs. It collects the preview's whole process tree (a dev server usually runs as a grandchild of npm) and reads that tree's TCP listeners: on Windows with one PowerShell call (`Win32_Process` parent walk and `Get-NetTCPConnection -State Listen`), elsewhere with `ps` and `lsof`, or `ss` when `lsof` is missing. Any listener outside loopback (`0.0.0.0`, `::` or a LAN address) means other devices on your network can reach delivered, unaccepted code running with your permissions. By default the service then **stops the preview** and the bar says which address it used and how to fix it, usually by adding `--host 127.0.0.1` to `args` (after `--` for npm scripts). Stopping is the default because the risk is silent and the fix is one argument; a warning alone would leave the program reachable while you work through the checklist. If you need other devices to reach it, for example to try it on a phone, set `"allowNetwork": true`: the preview keeps running and the bar shows a standing warning with the address. Like the command, this field is part of the reviewed configuration, so changing it requires starting again from the board. Each check is bounded (10 seconds), never delays Start or Stop, and is cancelled when the preview stops. If the listeners cannot be read, or none is found in the tree after three quick tries (for example when Docker owns the port), the bar says it couldn't verify the listening address and the preview keeps running.

**Lifecycle.** One preview runs per project. Stop ends it whichever initiative started it. The service stops it, including its child processes (`taskkill /T /F` on Windows, the process group elsewhere), when you accept the delivery, request rework or change scope, when the initiative otherwise leaves UAT, and when the service shuts down. Starting requires the initiative to be waiting for your UAT decision with no agent working on it, and the board disables Start while any agent is active or queued, like other edits. A crash shows the exit code and last output; Start again retries. While a preview runs, the sticky checklist header repeats a compact "Preview running · Open ↗" (or the network warning) so the link stays in reach as you scroll.

**After a restart.** The service records the preview's process ID and start time in `<stateDir>/preview.json`, outside every agent write grant. On startup, if that process is still alive and its operating-system start time matches the record, the service stops its tree, because it is the previous session's own child. A live process that cannot be confirmed (for example a reused process ID) is left alone, and the bar says so. Unlike an agent run, a leftover preview does not fence other work.

Routes: `GET /api/projects/<id>/initiatives/<initiative>/preview` returns configuration, candidates and the running state; `POST …/preview/start` takes `{ "commandHash": "…", "candidate": "<optional name>" }`; `POST …/preview/stop` takes `{}`. Both POSTs need the page token.

## Capacity

Parallel workers share one computer, and memory, not CPU, is what runs out first: in the 2026-10-03 parity trial ten workers on a 32 GB PC each ran Vitest with its default of about 18 threads, five hit JavaScript heap out-of-memory errors and the Claude app crashed (`analysis/environments-2026-10-03/`). The host therefore admits workers by memory, shares heavy steps and singleton resources through leases, caps test runners through the environment, and cleans up what a worker leaves running. Configure it in `.switchflow/capacity.json` in the primary checkout, next to `project.json`. Without the file the defaults below apply.

```json
{
  "schemaVersion": 1,
  "memory": { "workerIdleGB": 1.5, "workerGatingGB": 6, "headroomGB": 3 },
  "leases": { "gate": 2, "e2e": { "count": 1, "maxMinutes": 60 }, "docker-stack": 1 },
  "workerEnv": { "VITEST_MAX_WORKERS": "2", "NODE_OPTIONS": "--max-old-space-size=4096" },
  "ports": { "base": 41000, "blockSize": 10, "blocks": 6 },
  "docker": { "composeDown": true }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `memory.admission` | `true` | `false` turns memory admission off; `limits.maxWorkers` still applies. |
| `memory.workerIdleGB` | 1.5 | Budget of a running worker (0.1–64). |
| `memory.workerGatingGB` | 6 | Budget while it holds a gating lease (at least `workerIdleGB`, at most 256). |
| `memory.headroomGB` | 3 | Kept free for you and the rest of the system (0–64). |
| `leases.<name>` | `suite` 1, `gate` 2, `e2e` 1 | A count (1–16), or `{ "count", "gating", "maxMinutes" }`. Names are lowercase letters, digits and dashes. `gating` defaults to `true` for `suite`, `gate` and `e2e` and `false` for other names; `maxMinutes` (1–480, default 120) caps a lease's time limit. Declaring a built-in name changes it. |
| `workerEnv` | none | At most 32 variables added to every agent process the host starts (stage agents and workers), see below. |
| `ports` | none | `{ "base", "blockSize", "blocks" }`: `blocks` (1–64) blocks of `blockSize` (1–1000) ports from `base` (1024–65535), one block per running worker in each environment, see below. |
| `docker.composeDown` | `false` | `true` stops each worker's own Docker Compose project when its session ends. |

The file is validated strictly: an unknown field, a wrong type or a refused variable is an error. An invalid or unreadable file does not stop delivery: the defaults apply and the Agents view says which line was ignored and why. Like `preview.json`, agents can write the governance checkout, so the agent prompt forbids editing this file and the host re-checks `workerEnv` where it spawns processes.

**Memory admission.** `delegate_task` admits a worker only when its idle budget fits:

`available = min(free − budgets of workers admitted in the last 2 minutes, total − all budgets reserved) − headroom`

`free` is `os.freemem()`: on Windows it equals the "Available MBytes" counter (free plus standby memory, checked on this PC), on Linux `MemAvailable`; on macOS it counts free pages only and so errs low. The first term holds back the budget of workers that have started but not yet grown into it, so a burst of delegations cannot all pass on the same free figure. The second keeps the sum of promised budgets within the machine. Budgets are reserved machine-wide, across every project the service runs. Holding a gating lease reserves the difference between the gating and idle budgets. When the budget does not fit, or `limits.maxWorkers` workers are starting or in a turn, the worker is **queued** instead of refused: `delegate_task` returns `status: "queued"` with `queue: { position, reason, since }`, for example `needs 1.5 GB, 0.8 GB available (3.8 GB free, 1.5 GB held for workers still starting, 3 GB headroom)`. The queue is strictly first in, first out per project; a later worker never overtakes an earlier one, and the others say `waiting behind N earlier workers`. Queued workers start by themselves when a worker finishes, goes idle or releases a lease, and on a 5-second recheck while anything waits, because memory can free without an event. When no other worker holds a reservation anywhere, one worker starts even if its budget does not fit, with a `capacityNote`, so a small machine still makes progress. `interrupt_worker` cancels a queued worker; `send_to_worker` refuses one until it starts.

**Leases.** A lease is a time-limited claim on a named resource: `gate` (full test, lint or build gate), `e2e` (end-to-end tests), or any resource the project declares, such as one Docker stack or a fixed port range. Workers and the orchestrator use `acquire_lease`, `release_lease` and `list_leases` (see [Orchestrator and workers](#orchestrator-and-workers)). `count` leases of a name can be held at once. Waiting is first in, first out, bounded per call (1–50 seconds, call again), and returns a reason when it times out, such as `e2e: 1 of 1 held by DEMO-2 deliver worker, 12 min left`. A gating lease also waits until the machine has its extra memory, except that the first gating lease on the machine is always granted. A lease is held by a session and ends when the holder releases it, when its time limit passes (default 30 minutes; acquiring again renews it), or when its session closes for any reason, including a crash or cancel. Its holder gets a `notice` event when it expires. The orchestrator may release any lease of its run, for example one a stuck worker holds. Leases persist in `<stateDir>/leases.json`, so a restart does not forget them: on the first use after a restart, leases of sessions that are gone are released, except those of a run the restart fence still holds, whose processes may still use the resource; they go when the fence is cleared. `acquire_suite_lock` and `release_suite_lock` remain as aliases for the lease `suite` with a 30-minute limit.

**Leases taken at delegation.** Workers on an SSH box or in the cloud cannot call the lease tools (the lease server runs beside the CLI on this PC), so `delegate_task` takes an optional `leases: ["gate"]`. The host takes every named lease for the worker in the admission step, all or none, before the worker starts; while one is taken the worker stays queued with the reason, for example `gate on wsl: 1 of 1 held by DEMO-1 deliver worker, 95 min left`. The leases are held by the worker's session for its whole length, up to each lease's `maxMinutes`, and released when the session ends for any reason, and they persist across restarts like any lease. A delegation lease comes after every `acquire_lease` call already waiting for that name. Local workers can use `leases` instead of the tools, for a worker that only runs a gate. Lease pools are per machine: this profile's leases describe only this PC (and only they reserve gating memory); an environment declares its own pool in its owner settings (`"leases": { "gate": 1 }`, see [Environments](#environments-and-ssh-boxes)), and a box or cloud worker can name only that pool's leases. An unknown name is refused (404) with the pool's names. `list_leases` adds `environments: [{ id, resources }]` for the environments that declare leases, and each lease shows its `environment` (`local` or the environment ID).

**Port blocks and compose projects.** With `ports` set, each worker that starts takes the lowest free block in its environment (this PC, or each SSH box separately) and the host injects `SWITCHFLOW_PORT_BASE` (the block's first port) and `SWITCHFLOW_PORT_COUNT` (`blockSize`) into its agent process. Every worker also gets `COMPOSE_PROJECT_NAME=sf-<first 8 hex digits of its session ID>`, so each worktree's `docker compose` stack is separate. A worker waits in the queue while no block is free (`no free port block: 6 of 6 in use (ports.blocks)`); declare at least as many blocks as workers you run at once. Blocks are held like leases: taken at admission, released when the session ends for any reason, kept in `<stateDir>/worker-resources.json` across a restart, and freed on the first delegation after it unless the restart fence still holds their run. Cloud workers get neither. The profile cannot set these three variables itself, and `SWITCHFLOW_PORT_*` and `COMPOSE_PROJECT_NAME` pass the worker-environment policy only in the host's exact shape. Map them in the project, for example with block offsets:

| Offset | Use | Example |
| --- | --- | --- |
| `+0` | Dev server | `vite --port $SWITCHFLOW_PORT_BASE`, or `server: { port: Number(process.env.SWITCHFLOW_PORT_BASE ?? 5173) }` |
| `+1` | Test or preview server | Playwright `webServer.port` and `use.baseURL` from `SWITCHFLOW_PORT_BASE + 1` |
| `+2`… | Compose published ports | `ports: ["${E2E_DB_PORT:-3306}:3306"]` with `E2E_DB_PORT=$((SWITCHFLOW_PORT_BASE + 2))` set by the e2e script |

Keep a fallback to the usual port when the variable is absent (owner runs, CI). Remove any `-p` flag from the e2e scripts so `COMPOSE_PROJECT_NAME` applies (`-p` wins over it; it wins over a compose file's top-level `name:`), and publish compose ports from the block rather than fixed host ports; containers then never collide, and the `e2e` lease is needed only for genuinely shared resources. Switchflow does not probe the ports: choose a range no other program or project on the machine uses.

**Compose cleanup.** With `docker.composeDown: true`, when a worker's session closes (after its leftover processes are stopped, before its port block is freed) the host runs, where the worker ran (on this PC, or on the box over ssh, from `/`): `docker compose version` (absent: skipped, with an info notice on the session), `docker compose ls --all --quiet`, and only if that exact `sf-…` project is listed, `docker compose -p sf-… down --remove-orphans`. Volumes are kept. It never names any other project. The outcome is a `notice` on the session (for example `Stopped Docker Compose project sf-1a2b3c4d on this PC (down --remove-orphans).`, or a warning with docker's first error line). After a restart, a worker that never closed has its project stopped the same way before its block is freed, and the outcome is written to the service log. Without the opt-in, no docker command runs.

**Worker environment caps.** `workerEnv` sets resource caps in every agent process, so test runners use fewer threads without each agent remembering a brief. Examples: `VITEST_MAX_WORKERS` and `JEST_WORKERS` are read only if your test configuration reads them (for example `maxWorkers: process.env.VITEST_MAX_WORKERS`); `NODE_OPTIONS` sizes every Node process's heap. Variables are added to the service's own environment; the host's own values (`TMP`, `TEMP`, `TMPDIR`, `NO_COLOR`, `CLAUDE_CODE_ENTRYPOINT`) always win. Codex also receives them as `shell_environment_policy.set` so its shell commands see them whatever `config.toml` says. A profile can only add plain caps:

- Names must be plain (`[A-Za-z_][A-Za-z0-9_]*`), values single-line and at most 1,024 characters.
- Refused names (case-insensitive): `PATH`, `PATHEXT`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `PSMODULEPATH`, `SHELL`, `TMP`, `TEMP`, `TMPDIR`, `NO_COLOR`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, Python, Perl, Ruby and Java start-up variables, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PS4`, proxy and CA-bundle variables, `DOCKER_HOST`, `DOCKER_CONFIG`, `KUBECONFIG`, `EDITOR`, `VISUAL`, `PAGER`, `BROWSER`.
- Refused prefixes: `CLAUDE`, `ANTHROPIC`, `OPENAI`, `CODEX`, `SWITCHFLOW`, `GIT_`, `SSH_`, `GPG`, `GNUPG`, `NPM_CONFIG`, `YARN_`, `PNPM_`, `BUN_`, `LD_`, `DYLD_`, `AWS_`, `AZURE_`, `GOOGLE_`, `GCLOUD`, `GH_`, `GITHUB_`.
- Refused as secrets: any name with a `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PWD`, `CREDENTIAL(S)`, `AUTH`, `KEY(S)`, `APIKEY`, `COOKIE` or `SESSION` part.
- `NODE_OPTIONS` may contain only `--max-old-space-size=<MB>` and `--max-semi-space-size=<MB>`; `--require`, `--import` and loaders would run code in every Node process.

The policy lives in `scripts/control/worker-env.mjs`.

**Process cleanup.** A provider's close ends the agent process it started, but programs that agent launched (dev servers, browsers, test runners) can outlive it; on Windows an orphan keeps running with nothing left to find it by. The host therefore snapshots each session's descendants while its agent runs (every 30 seconds, and just before close), with their operating-system start times, and after the session closes, for any reason, stops each recorded process that is still the same process (`taskkill /T /F` on Windows, `SIGKILL` elsewhere). It never stops the service or its ancestors, another session's agent or recorded descendants, a process whose start time no longer matches (a reused PID), or anything under a PID that existed before the session started. A child counts as a descendant only if it started after its parent, so a stale parent PID cannot adopt unrelated processes. What was stopped is recorded on the session as a `notice` with `processes: [{ pid, name }]`, for example `Stopped 2 processes this session left running: node.exe 4812, WebKitNetworkProcess 5120.` A snapshot costs one PowerShell `Win32_Process` query (about 0.4 s) or one `ps`, and is skipped while a session has no live agent process and nothing recorded.

**Pause local workers.** When you need this PC back, "Pause local workers" in the capacity strip stops new workers from starting here. Workers already running continue. New and queued workers placed on this PC wait with the reason `Paused by the owner to free this PC`; workers placed on an SSH box or in a cloud are not affected. The toggle is the owner setting `pauseLocalWorkers` in the agent settings, so it has a revision, survives restarts, and, unlike other settings, can change while a run is active. "Resume local workers" starts the queue first in first out, within the usual worker and memory limits. It applies per project and pauses delegated workers only; stage agents (the orchestrator) keep running.

**In the browser.** The Agents view shows a capacity strip above the sessions: memory free of total, running and queued workers, and each lease's held count; below it, every queued worker with its reason and every held lease with its holder and minutes left. `GET /agents` carries the same data as `capacity` (see [Agents API](#agents-api)).

**Shared dependencies (opt-in).** In the parity trial each worktree was about 565 MB, nearly all its own `node_modules`, and 18 worktrees took 9.4 GB and 1.3 M files. With `"dependencies": { "mode": "link" }` a new candidate whose npm lockfile matches gets its `node_modules` from a shared store in about half a second instead of a fresh install:

```json
{ "schemaVersion": 1, "dependencies": { "mode": "link", "paths": ["node_modules"], "private": [".prisma"] } }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `dependencies.mode` | absent (off) | `link` shares; `off` is the same as leaving it out. |
| `dependencies.paths` | `["node_modules"]` | 1–8 relative folders named `node_modules` that npm installs from the root lockfile, including the root one (for example `packages/web/node_modules` in an npm workspace). |
| `dependencies.private` | none | At most 32 top-level names in `node_modules` that each worktree gets as its own writable copy, for code a tool generates there (for example Prisma's `.prisma`). |

How it works:

- **Store.** `<stateDir>/dependencies/<lockfile hash>-<id>/` holds one copy of the primary checkout's folders, made once per lockfile and per install of the primary. It is made only when the primary's npm lockfile equals the worktree's (line endings aside, since Git may check one out with CRLF) and npm's record of the installed tree (`node_modules/.package-lock.json`) agrees with every lockfile entry, missing only optional packages for other platforms. Caches (`.cache`, `.vite`, `.vite-temp`, `.vitest`) are left out. A link inside the folder is re-pointed into the store; a package entry linking elsewhere in the checkout (an npm workspace package) is re-created in each worktree pointing at the worktree's own source; a link leaving the checkout refuses the store. If the primary is reinstalled while it is copied, the copy is discarded. The service starts the copy when the delivery run's Git helper starts, so the first candidate normally finds it ready; a create waits at most 45 seconds for it.
- **Seal.** Every file is made read-only. On Windows, read-only attributes cover only file contents (folders still accept new entries and renames, and tools clear the attribute before deleting), so the store's folders also get an inherited deny entry for Everyone on writing, appending, attributes, deleting and adding entries (`icacls … /deny *S-1-1-0:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`); reading is unaffected. On Linux and macOS every folder is made read-only too. A store that cannot be protected is not used. `store.json` records a manifest. Before each use the store's listing is checked (about 0.5 s for 67,000 files) and, at most every 10 minutes, every file's size and read-only state (about 3 s). A store that changed is never used again: the next create copies the primary afresh, and the damaged store is deleted once no worktree links it.
- **Worktree.** The candidate gets a real `node_modules` folder of its own whose entries are junctions (Windows) or symlinks into the store, except the `private` names and top-level files such as `.package-lock.json`, which are copied. Caches and anything a tool adds at the top level stay in the worktree. Nothing ever links to the primary's own `node_modules`, so no worktree can change the primary's dependencies. Native modules are shared as built for the primary, on the same machine.
- **Result.** The `create` result carries `dependencies: { mode, status, store?, reason?, note?, ms }`. `linked` means installed already; `install` means install normally, with the reason (no npm lockfile, lockfile differs from the primary's, the primary's install is out of date, the copy is still being made, a link leaves the checkout, the store could not be protected, the service runs as root, which POSIX permissions cannot stop); `present` means the folder already existed. The orchestrator prompt passes this on to the worker.
- **Changing dependencies in a worktree.** An install into the linked folder fails with a permission error (npm moves package folders aside first, and the store refuses). Delete `node_modules` first: `rm -rf`, `Remove-Item -Recurse`, `rmdir /s`, Node's `fs.rm` and `git clean -fdx` all remove only the links (checked on this PC). Then install as usual.
- **Why not hardlinks or copies.** Hardlinks share file contents and attributes, so an in-place edit or a cleared read-only flag in one worktree changes every other one, and hardlinks straight from the primary would change the primary. Copy-on-write clones (`cp --reflink`, Windows Dev Drive block cloning) are safe but fall back to full copies on NTFS and ext4, the usual file systems here. Junctions or symlinks into one protected copy cost nothing per file on any of them.
- **Removal.** After a new store is made, older stores that no registered worktree links any more are deleted. `git worktree remove` leaves a folder holding only the junctions on Windows; delete it with any of the tools above.

Measured on a throwaway fixture on this PC (Windows 11, NTFS, Node 24, npm 11; React, Vite, Vitest, ESLint, TypeScript, Playwright, MUI with icons, webpack: 347 packages, 66,933 files, 217 MB). Vitest, `vite build`, the Vite dev server (including CSS imported from a package), `tsc`, ESLint and Prettier ran from a linked worktree.

| Per worktree | Fresh `npm ci` (warm npm cache) | Linked |
| --- | --- | --- |
| Time | 55–75 s | 0.55–0.72 s (3.7 s with the full check) |
| Disk | 217 MB, 66,933 files | 0.2 MB: 1 file and 221 junctions |

The store costs 228 MB and 42–73 s once per lockfile (the deny entry takes about 15 s of that), so 18 such worktrees would take about 0.23 GB instead of 3.9 GB.

Limits: npm lockfiles (version 2 or 3) only; pnpm already shares through its own store, and Yarn is not supported yet. A package in the store cannot require a workspace package (Node resolves from the store); a dev server that restricts served files to the project (Vite's `server.fs.allow`) still serves what the code imports but refuses other direct `/@fs/` requests into the store. SSH and cloud workers install on their own machines.

**Not yet.** The Agents view does not show port blocks yet (worker summaries carry `ports` and `composeProject`), and has no editor for an environment's `leases` (set them through `PUT /api/agents/settings`; editing the environment in the view keeps them).

## Scope, concurrency and interruptions

The service admits one agent run per Git project at a time. Other initiatives can queue. Each human action carries the initiative revision actually displayed; stale actions fail and the browser retains typed drafts. Updates enter the next checkpoint. A scope change stops the current run, retains the old approvals for audit, revokes the current grant, and returns to Intake. New work waits for the stopped process to settle.

Plan approval covers its listed phases, local candidate delivery, and independent technical review. It does not grant remote pushes, deployment, live-data changes, credentials, or shared-history changes. Those unavailable actions become named exceptions; the local runner never bypasses its sandbox or approval controls. Framework friction is recorded without automatically dispatching unrelated work.

Planning records the committed source baseline. If that baseline changes before approval, the controller refreshes Planning and presents the revised plan before granting delivery. Each delivery grant binds the scope, plan, and baseline. Uncommitted source changes are preserved; they are not silently copied into a candidate.

The sandbox keeps Git metadata protected. During approved delivery, a local host helper accepts only three fixed operations: create a registered candidate worktree, commit explicitly named files in it, and merge a frozen managed candidate into another managed candidate. A file request/reply channel works without granting the agent network access. Candidates live under the external project state and use dedicated `codex/` branches. The helper has no operation for changing the primary checkout, pushing, resetting, deploying, deleting worktrees, or changing Git configuration. Required hooks, active filters, signing policies and custom merge drivers that would execute outside the sandbox stop the operation with a named exception; they are not silently skipped. Dormant diff/filter configuration does not prevent unrelated work. Cancellation stops admitting requests and lets an already-started Git operation settle; uncertain interrupted operations require inspection and are never replayed automatically.

Task edits use Backlog's partial-update path and the CAS fork's expected revision. They preserve unrelated fields and reject stale records. Native editing remains available when the project's agent-admission fence permits it; changes to an approved initiative's scope use the scope-change path. Direct manual Markdown writes remain outside Backlog's locking contract.

An ordinary conflict between managed candidates stays with the agents. The helper records both frozen heads and the exact conflicted paths. After correcting and reviewing those files in the sandbox, the agent resubmits the same merge with those paths. The helper rejects changed heads, additional edits, mismatched paths or altered unrelated index entries, then commits and verifies the two merge parents. Conflicts that cannot meet those constraints remain named exceptions. Windows Git calls enable long paths for that command only. New candidate roots use a compact hash of the full initiative and grant; existing registrations retain their recorded layout. Git's separate Windows root-length limit is checked before creating a branch. If an unusually long state-home still exceeds it, use a shorter host state-home for a new project or a shorter candidate name; never move a registered candidate or rewrite its records to bypass the check.

## Agents: providers, routing and steering

Each stage runs one agent session through a provider adapter in `scripts/control/providers/`: `codex-app-server.mjs` (`codex app-server`, JSON-RPC over stdio) or `claude-cli.mjs` (the installed `claude` CLI in stream-json mode). If app-server fails its initialize handshake, Codex falls back to `codex exec` (`codex-runner.mjs`), which cannot be steered. Both adapters keep the exec guardrails: approval `never` with no approval prompts, only the `workspace-write` or `read-only` sandbox, the host's explicit writable roots, a private temp folder, no sandbox network, and no bypass mode.

- **Codex** gets the policy twice: as `-c` process overrides (including `notify=[]`) and as explicit per-thread and per-turn settings (`approvalPolicy: never`, `approvalsReviewer: user`, `sandboxPolicy`), so `~/.codex/config.toml` cannot loosen it. The user's own MCP servers, ChatGPT apps (the `codex_apps` connector, which can reach live services and deploy) and bundled plugins such as computer use are disabled for runs (`features.apps`, `features.plugins`, `features.computer_use` set to false); runs see only servers Switchflow supplies. The `codex exec` fallback gets the same feature overrides and switches off each server `codex mcp list` reports; if that list cannot be read, the fallback refuses to run.
- **Claude** runs with `--restricted --strict-mcp-config --permission-prompts none`: user, project and local settings are ignored, file tools are confined to the working directory and `--add-dir` roots, and anything not pre-approved is denied. Writing roles use `acceptEdits` with `Read, Grep, Glob, Edit, Write, NotebookEdit, Bash`; read-only roles get no edit tools. Bash is limited to read-only Git and the Switchflow wrappers (`.switchflow/scripts/*`, plus the Git helper during delivery). Each session has `--max-turns`, a `--json-schema` result and an `is_error` check.

### Role routing

Settings live in `<stateDir>/agent-settings.json`. Defaults: Claude for `intake`, `planning`, `execution` (the phase orchestrator) and `uat`; Codex for `delivery` (task workers); `review: auto` (the provider that did not author the work). If the routed provider is unavailable (not installed, or Claude not signed in), the other one runs and the session records a `notice` and a `fallback`. Review never falls back to the author's provider; it fails with 409 instead.

### Agents API

All routes are project-scoped: prefix `/api/projects/<projectId>`. Writes need the page's `X-Switchflow-Token`, a loopback Host and a same-origin (or absent) Origin, like every other write. Errors are `{ "error": "<message>" }` with 400 (invalid input), 403 (token or origin), 404 (unknown session), 409 (state conflict) or 503.

**`GET /agents`** returns:

```json
{
  "providers": {
    "codex": { "available": true, "version": "codex-cli 0.153.4", "transport": "app-server", "diagnostic": "" },
    "claude": { "available": true, "version": "2.1.288", "transport": "cli", "loggedIn": true, "authMethod": "claude.ai" }
  },
  "settings": {
    "schemaVersion": 1,
    "revision": 0,
    "roles": { "intake": "claude", "planning": "claude", "execution": "claude", "delivery": "codex", "review": "auto", "uat": "claude" },
    "models": { "claude": null, "codex": null },
    "efforts": { "claude": null, "codex": null },
    "limits": { "timeoutMinutes": 60, "maxWorkers": 2, "maxReviewRounds": 2, "maxTurns": 200 },
    "environments": [],
    "placement": { "delivery": "local", "review": "local" },
    "pauseLocalWorkers": false
  },
  "routing": {
    "intake": { "provider": "claude", "fallback": null },
    "execution": { "provider": "codex", "fallback": { "from": "claude", "to": "codex", "reason": "claude is not signed in" } },
    "review": { "provider": null, "fallback": null, "error": "Independent review needs claude, but ..." }
  },
  "activeRun": { "id": "<uuid>", "initiativeId": "<uuid>", "stage": "execution", "status": "running" },
  "capacity": {
    "profile": { "source": ".switchflow/capacity.json", "error": null },
    "memory": { "admission": true, "freeGB": 3.8, "totalGB": 31.9, "reservedGB": 12, "startingGB": 1.5, "headroomGB": 3, "availableGB": 0.8, "workerIdleGB": 1.5, "workerGatingGB": 6 },
    "workers": { "admitted": 3, "queued": 1, "maxWorkers": 4 },
    "queue": [{ "workerId": "<uuid>", "runId": "<uuid>", "task": "DEMO-5", "kind": "deliver", "position": 1, "reason": "needs 1.5 GB, 0.8 GB available (...)", "since": "<ISO time>" }],
    "leases": [{ "id": "<uuid>", "name": "gate", "holder": "<session uuid>", "runId": "<uuid>", "task": "DEMO-2", "kind": "deliver", "acquiredAt": "<ISO time>", "expiresAt": "<ISO time>", "minutesLeft": 24 }],
    "resources": [{ "name": "gate", "count": 2, "gating": true, "maxMinutes": 120, "held": 1, "waiting": 0 }],
    "workerEnv": ["VITEST_MAX_WORKERS", "NODE_OPTIONS"]
  },
  "sessions": ["<Session>"]
}
```

`capacity` is described under [Capacity](#capacity); `profile.source` is `defaults` when the file is absent or invalid, with the reason in `error`. `workerEnv` lists names only. Queued workers have no session yet, so they appear only in `capacity.queue`.

`routing` has one entry per role (`intake`, `planning`, `execution`, `delivery`, `review`, `uat`), each `{ provider, fallback }` or `{ provider: null, fallback: null, error }`; `review` is computed against the routed delivery provider. A provider is `{ "available": false, "diagnostic": "..." }` when its CLI is missing. `activeRun` is `null` when idle. `sessions` lists live and recent sessions (up to 200), newest first.

A **Session** object:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | uuid | Session ID used in the routes below. |
| `parentId` | uuid or null | Orchestrator session for a worker; `null` for stage sessions. |
| `runId`, `initiativeId` | uuid | The run and initiative it belongs to. |
| `role` | `intake`, `planning`, `execution`, `delivery`, `review`, `uat` | Routed role. |
| `kind` | `stage`, `deliver`, `review` | Stage agent, or a delegated worker. |
| `provider` | `claude`, `codex` | |
| `transport` | `app-server`, `exec`, `cli` or null | `exec` cannot be steered. |
| `model`, `threadId` | string or null | Provider model and thread or session ID. |
| `task`, `worktree`, `reviewRound` | string, string, number, or null | Worker task ID, candidate path and review round (workers only). |
| `sandbox` | `workspace-write`, `read-only` | |
| `status` | `starting`, `working`, `idle`, `completed`, `failed`, `cancelled` | `working`: a turn is running. `idle`: open and waiting for a follow-up (workers). |
| `lastTurn` | `{ id, status, at }` or absent | Most recent finished turn; `status` is `completed`, `interrupted` or `failed`. |
| `startedAt`, `updatedAt`, `endedAt` | ISO time or null | |
| `usage` | `{ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, costUsd }` or null | Cumulative for the session; `costUsd` is Claude only. |
| `lastMessage` | string or null | Latest agent text, at most 4,000 characters. |
| `result` | object or null | Structured result once completed. |
| `error` | string or null | Failure or stop reason. |
| `fallback` | `{ from, to, reason }` or null | Provider substitution. |
| `eventCount` | number | Highest event `seq`. |
| `live` | boolean | The service holds the process. Only live sessions can be steered. |
| `canSteer`, `canInterrupt` | boolean | Whether the two write routes will currently be accepted. |

**`GET /agents/<sessionId>/events?after=<seq>&limit=<n>`** (`after` defaults to 0; `limit` is 1–500, default 200) returns events with `seq > after`, oldest first:

```json
{
  "sessionId": "<uuid>",
  "status": "working",
  "live": true,
  "events": [{ "seq": 1, "at": "2026-10-03T12:00:00.000Z", "kind": "session.started", "provider": "codex", "transport": "app-server", "threadId": "...", "pid": 1234, "model": "gpt-5.6-luna" }],
  "nextAfter": 1,
  "more": false
}
```

Poll with `after=nextAfter`. Every event has `seq`, `at` and `kind`:

| `kind` | Fields |
| --- | --- |
| `session.started` | `provider`, `transport`, `threadId`, `pid`, `model`. Exec may send it twice: pid first, then threadId. |
| `turn.started` | `turnId` (null on exec) |
| `message` | `text`, `final` (true for the turn's answer), `phase` (Codex only) |
| `tool` | `name`, `summary` (one line) |
| `command` | `command`, `status` (`started`, `completed`, `failed`, ...), `exitCode` |
| `file_change` | `paths[]`, `status` |
| `steer` | `text`, `by` (`owner` or `orchestrator`), `mode` (`steer`, `queue` or `followup`), `turnId` |
| `interrupt` | `by`, `turnId` |
| `turn.completed` | `turnId`, `status` (`completed` or `interrupted`), `usage` |
| `turn.failed` | `turnId`, `error` |
| `stderr` | `text`, ANSI stripped |
| `notice` | `level` (`info`, `warning` or `error`), `text`: fallbacks, declined requests, denied tools, expired leases, resumed workers; `processes: [{ pid, name }]` when the host stopped processes the session left running |
| `session.closed` | none |

Text fields are capped at 20,000 characters. Shell output and hidden reasoning are not included.

**`POST /agents/<sessionId>/steer`** takes `{ "message": "<1–20000 characters>", "mode": "steer" | "queue", "confirm": true | false }`; `mode` is optional and defaults to `steer`, `confirm` defaults to `false`. No other fields.

- `steer` reaches a running turn mid-turn: Codex through `turn/steer` with the active turn ID, Claude as a user message with `priority: "next"`, read at its next tool boundary.
- `queue` holds the message until the current turn ends. A worker then runs it as its next turn (several queued messages are joined in order). A stage agent has no next turn in this run, so a queued message becomes an ordinary owner update for the next checkpoint.
- An idle worker receives the message as a follow-up turn in either mode.
- `confirm: true` approves a delivery worker's returned approach and starts its first writable turn with the message (see the approach gate under [Orchestrator and workers](#orchestrator-and-workers)). It needs an idle delivery worker whose `approval` is `awaiting-confirmation`; otherwise 409 says why (no approach yet, a turn is running, already confirmed, or not a delivery worker).

Returns 202:

```json
{ "ok": true, "sessionId": "<uuid>", "mode": "steer", "turnId": "<id or null>" }
```

`mode` is the effective mode: `steer`, `queue` or `followup`. The session's `steer` event carries the same `mode`, and `confirm: true` when it confirmed an approach. For a delivery worker the reply adds `confirmed` (this message confirmed the approach) and `writable` (the worker may now write); while writes are still locked it also carries a `note` saying so. Returns 400 for an unknown mode, and 409 when the session is not live, has no running turn, or uses `exec` with `mode: "steer"`. Owner messages are appended to the initiative's message history as `{ "type": "steer", "message", "sessionId", "runId", "role", "provider", "mode", "at" }` (type `update` for a message queued to a stage agent) with a `steer` activity event, so they survive restarts. A steer delivered to a run is not repeated as new input to the next run.

**`POST /agents/<sessionId>/interrupt`** takes `{}` or no body and returns 202 `{ "sessionId": "<uuid>", "interrupted": true }`, or 409 when no turn is running. Interrupting a stage agent ends that run as failed with "The owner interrupted this agent. Add an update or retry." Interrupting a worker leaves it `idle` for its orchestrator.

**`PUT /agents/settings`** takes any subset of `{ "roles", "models", "efforts", "limits", "environments", "placement", "pauseLocalWorkers", "expectedRevision" }`. Roles take `claude` or `codex`, and `review` also takes `auto`. Models and efforts take `null` or a plain name. Limits are integers: `timeoutMinutes` 1–1440, `maxWorkers` 1–8, `maxReviewRounds` 1–5, `maxTurns` 1–1000. `pauseLocalWorkers` is `true` or `false` (see [Capacity](#capacity)). Unknown keys return 400, a stale `expectedRevision` returns 409, and so does any change while a run holds admission (`activeRun` is set), except a request that changes only `pauseLocalWorkers`. Returns 200 `{ "settings", "routing" }`.

### Orchestrator and workers

During Execution, the orchestrator session (either provider) gets a `switchflow` MCP server (`scripts/control/orchestration-mcp.mjs`, stdio, no dependencies). Claude receives it through `--mcp-config`; Codex through per-thread `mcp_servers` config with `default_tools_approval_mode = "approve"`, because under approval policy `never` Codex refuses any MCP tool it would otherwise ask about. The server forwards each call to `POST /api/projects/<projectId>/orchestration/<runId>/<tool>` with a per-run `X-Switchflow-Run-Token` instead of the page token; the token stops working when the run ends. Tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `delegate_task` | `task`, `kind` (`deliver` or `review`), `instructions`, `worktree` (candidate name or path), optional `provider`, `environment`, `leases` (up to 8 lease names the host takes before the worker starts, see [Capacity](#capacity)) | Worker summary: `workerId`, `task`, `kind`, `provider`, `worktree`, `reviewRound`, `status` (`queued`, `starting`, `working`, `idle`, `completed`, `failed`, `cancelled`), `queue` (`{ position, reason, since }`, only while queued), `leases` (when named), `ports` (`{ base, count }`) and `composeProject` while it holds them, `approval`, `writable`, `note` (only while an approach awaits confirmation), `resumedFrom` (a resumed worker's previous ID), `lastTurn`, `lastMessage`, `usage`, `result`, `error`, `fallback`, `capacityNote` (started below its memory budget) |
| `worker_status` | optional `workerId` | `{ workers: [summary] }` |
| `send_to_worker` | `workerId`, `message`, optional `mode` (`steer` or `queue`), optional `confirm` (boolean) | `{ ok, sessionId, mode, turnId }` as for owner steering; for a delivery worker also `confirmed` and `writable`. 409 while the worker is queued or starting |
| `interrupt_worker` | `workerId` | `{ workerId, interrupted }`; a queued worker is cancelled: `{ workerId, interrupted: true, cancelled: true }` |
| `wait_for_workers` | optional `workerIds`, `timeoutSeconds` (1–50, default 30) | `{ timedOut, workers: [summary] }`; returns when a listed worker finishes a turn the orchestrator has not seen, or none is queued, starting or running |
| `acquire_lease` | `name`, optional `ttlMinutes` (1 to the lease's `maxMinutes`, default 30), optional `timeoutSeconds` (1–50) | `{ acquired: true, id, name, holder, runId, task, kind, acquiredAt, expiresAt, minutesLeft }` (`renewed: true` when the caller already held it) or `{ acquired: false, name, reason }`; 404 for a name the project does not declare |
| `release_lease` | `id` | `{ released: true, id, name }`, or `{ released: false, reason }` when it is already gone; 403 unless the caller holds it or is its run's orchestrator |
| `list_leases` | none | `{ leases: [lease], resources: [{ name, count, gating, maxMinutes, held, waiting }], environments: [{ id, resources: [{ name, count, maxMinutes, held }] }] }`; each lease has `environment` (`local` or an environment ID) |
| `acquire_suite_lock` | optional `timeoutSeconds` (1–50) | Alias for the lease `suite`: `{ acquired: true, expiresAt }` or `{ acquired: false, heldBy, reason }` |
| `release_suite_lock` | none | `{ released }` |

The host enforces:

- The worktree must be a candidate the Git helper registered for this initiative's plan grant, and the task must exist in Backlog.
- At most `limits.maxWorkers` workers are starting or in a turn at once, and a worker starts only when its memory budget fits; otherwise it queues and starts by itself later (see [Capacity](#capacity)).
- Delivery workers get `workspace-write` with the candidate, governance root, operations, scratch and Git request inbox as writable roots, but only after their approach is confirmed (the approach gate below).
- Reviewers are `read-only`, use a different provider from the task's latest author (the orchestrator's provider when it delivered directly), and return their verdict comment for the orchestrator to record. A blocked review is not retried on the author's provider.
- At most `limits.maxReviewRounds` reviews per task in a run; the next is refused with "Escalate to the owner."
- The run's cancel or scope change aborts every worker. Workers appear in `GET /agents` with `parentId` set to the orchestrator and `kind` `deliver` or `review`. Owner steering and interrupts work on them too.

**Approach gate.** A delivery worker's turns are read-only until its approach is confirmed. Its summary and session carry `approval`:

| `approval` | Meaning |
| --- | --- |
| `drafting` | Approach turn running, or the last read-only turn returned no approach (`outcome` other than `approach`) |
| `awaiting-confirmation` | Idle with an approach (`result.outcome` `approach`); still read-only. The Agents view shows "Approach ready · waiting for confirmation" |
| `confirmed` | Confirmed by the orchestrator (`send_to_worker` with `confirm: true`) or the owner (steer with `confirm: true`); every later turn may write |

A message without `confirm` to an unconfirmed worker runs another read-only turn, for example to correct the approach. Confirmation records a `notice` event naming who confirmed. Reviewers have `approval: null` and stay read-only. The host enforces the read-only turn per provider:

- Codex app-server: `turn/start` carries `sandboxPolicy: { "type": "readOnly", "networkAccess": false }` for the approach turn and the worker's write policy afterwards. App-server applies a turn's policy to later turns too, so every turn sends its policy.
- `codex exec`: the approach run uses `--sandbox read-only` with no writable roots; the confirmed turn is `codex exec resume <thread>` with `workspace-write`.
- Claude CLI: tools and permission rules are fixed per process, so the approach runs in a process with the reviewer's set (Read, Grep, Glob and read-only Bash rules, `dontAsk`, no `--add-dir`) and session persistence on. Confirmation ends that process (stdin closed, its PID cleared from the restart fence) and starts one with `--resume <session>` and the write set; its PID is recorded before it receives input. The saved conversation (`~/.claude/projects/<folder>/<session>.jsonl`, or under `CLAUDE_CONFIG_DIR`) is deleted when the session closes.

Each local worker gets its own MCP server with only the lease tools (`acquire_lease`, `release_lease`, `list_leases` and the two suite-lock aliases) and its own token, valid while its session is open. The orchestrator gets the same lease tools besides delegation. Remote workers get no tools; the orchestrator names their leases in `delegate_task`. Leases are described under [Capacity](#capacity).

`GET /state` keeps its shape; `capabilities` is now `{ "codex": <provider>, "claude": <provider> }`. After a restart, sessions that were open are listed as `failed` (under Needs you) with an error naming their process, and their events stay readable. Their processes are fenced as described in [Recovery](#recovery).

### Environments and SSH boxes

A provider (Claude, Codex) is who runs a worker; an environment is where. `scripts/control/environments/index.mjs` holds the contract and the one registry: every environment has `id`, `kind` (`local`, `ssh`, `claude-cloud`, `codex-cloud`), `label`, `capabilities` (`stream`, `steer`, `interrupt`, `followUp`, `result`: `local-worktree`, `remote-branch` or `diff`) and `health()`. Process kinds (local, ssh) run the same provider CLIs through `spawnFor(workspace)` and add `prepareWorkspace`, `collect` and `cleanup`; cloud kinds add `submit`/`poll`/`collect` and wrap them in a session handle. Reviews, the approach gate and merges always stay on this PC.

**Owner settings, never the checkout.** Environments and placement are part of the agent settings (`PUT /api/agents/settings`, stored in external `agent-settings.json`), because an agent that could edit them could send workers and code to a host of its choosing:

```json
{
  "environments": [
    { "id": "wsl", "kind": "ssh", "label": "WSL Ubuntu", "host": "localhost", "port": 2222, "user": "me",
      "identityFile": "C:\\Users\\me\\.ssh\\switchflow_ed25519", "workRoot": "/home/me/switchflow",
      "wake": "wsl.exe -d Ubuntu -- true", "keepAwake": "wsl.exe -d Ubuntu -- sleep infinity" }
  ],
  "placement": { "delivery": "wsl", "review": "local" }
}
```

Unknown fields are refused, so no password or token can be stored inline; `identityFile` must be an absolute path to an existing file; `host`, `user` and `workRoot` are plain names (no options, no shell syntax, no `..`). `wake` runs once before connecting; `keepAwake` runs while any agent process is open on the box (WSL stops a distro that has no `wsl.exe` client, even with ssh sessions open, which dropped the first real runs). Both are plain words, run without a shell. `maxWorkers` (1–16, default 2) is how many workers may run on the box at once. Any environment may add `leases` (`{ "gate": 1, "e2e": { "count": 1, "maxMinutes": 90 } }`, no `gating`), its own lease pool for leases named at delegation (see [Capacity](#capacity)). Placement covers delivery and review workers; stage agents run on this PC. A placement must name a configured, enabled environment, and removing a placed environment is refused.

**Placement and refusal.** `delegate_task` uses the role's placement, or its optional `environment` (`local` or an environment the owner enabled). Before placing a worker on an SSH box the host runs `health()` (wake, connect, `git`, `setsid`, a writable work root, a signed-in `codex` or `claude`); an unhealthy, disabled or unconfigured environment is refused with its reason (409) and the task waits. Switchflow never falls back to this PC. Provider routing uses the box's own CLIs.

**Readiness before delivery.** Before each delivery run starts (after plan approval, a retry, rework or a resume), the service runs `health()` on every environment the placement uses, for delivery and review. If one is not ready, the run does not start: the initiative is `blocked` with `environmentHold: { checkedAt, environments: [{ id, label, roles, ok, reason }] }`, an `environment-hold` event names each reason, and the initiative shows the reasons with a "Test again" action (a `retry`, which checks again before starting). Nothing falls back to this PC. A placement of only this PC needs no check.

**SSH transport.** `ssh -F none -T` with `BatchMode=yes`, `ConnectTimeout=10`, `ServerAliveInterval=15`, `StrictHostKeyChecking=accept-new`, `IdentitiesOnly=yes` and a Switchflow-owned known-hosts file (`<state>/environments/<id>.known_hosts`); the user's ssh config is not read. Every remote command is built as argv and single-quoted word by word. Each CLI runs under a small `sh` wrapper that starts it with `setsid` (its own process group), keeps stdin attached, records its PID in `<workRoot>/run/` and reports it on stderr; the host fences that remote PID with the environment id in the run's worker record, so a restart lists it for the owner to confirm. Closing a session kills the remote process group over a second connection, then the local ssh client. Only the variables the provider added (temp folder, worker caps, `NO_COLOR`) reach the box. The sandbox is the same: Codex gets its writable roots and Claude its `--add-dir` as remote paths (the remote worktree and its temp folder).

**Workspace.** The host pushes the candidate's head to a bare mirror at `<workRoot>/mirror.git` (`git push ssh://…`) on `switchflow/<worker>`, and opens a fresh remote worktree on it. Remote workers cannot reach the Backlog, the Git helper or the loopback lease server, so they do not edit task records or commit, and get no lease tools: the lease tool is a stdio MCP server the CLI starts beside itself, which on the box would have neither the host's `node` and script paths nor its loopback service. Instead the orchestrator names their leases in `delegate_task` `leases`, from the box's own pool (this PC's leases describe this PC). Box workers also get a port block counted on the box and their compose project, and with `docker.composeDown` their project is stopped on the box through a second ssh connection. After each writable turn (and after an interrupt) the host commits the remote changes, fetches the branch and fast-forwards the local candidate; a candidate that moved meanwhile is reported as a warning, not overwritten. Summaries add `environment` and `collected: { changed, head, error }`. When the worker finishes, its remote worktree, temp folder and PID files are removed; the branch stays in the mirror. No GitHub or shared remote is needed.

**Capacity.** SSH workers skip this PC's memory admission and do not count against `limits.maxWorkers`. Each box has its own first-in-first-out lane limited by its `maxWorkers` (starting or in a turn, as for local workers); a full box queues its workers with the reason ("1 worker is running on WSL Ubuntu, its limit (maxWorkers)") and never holds up local ones.

**Agents view.** The routing panel has "Where workers run": the environment list with Test connection (`POST /api/agents/environments/<id>/test`, a health check that starts no agent) and Test all, add and edit for SSH, Claude cloud and Codex cloud environments, and a "Runs on" choice for delivery and review workers (cloud entries are marked Claude only or Codex only; Codex cloud is offered for review workers only). The SSH form includes the keep-awake command and workers at once; the Claude cloud form has the environment ID, GitHub repository URL, model, poll interval and the push grant; the Codex cloud form has the environment ID, GitHub repository URL, poll interval, the push grant and a required "experimental" opt-in. Unsaved changes in this panel survive the view's polling. Session rows and heads show where each session runs.

**After a restart.** The remote CLI dies with its ssh connection, so an SSH worker cannot be reattached; its remote worktree survives, and its path is kept in the worker ledger. Before **Resume held workers** starts a run (`worker-recovery.mjs`), the host commits that worktree's uncommitted changes on the box (a recovery commit by Switchflow, also on a detached HEAD), fetches it to this PC as `refs/switchflow/recovery/<worker>`, and removes the old remote worktree. The resumed delivery worker's new worktree starts from that commit, and its prompt says it continues interrupted work. A reviewer's old worktree is only removed. If a box does not answer (or its work cannot be saved), nothing is resumed: the workers stay held, the initiative shows the reason, and the owner resumes again once the box answers.

**Conversation files on the box.** When an SSH worker's workspace is removed, the host also removes Claude's saved conversations for that worktree: the one folder `~/.claude/projects/<encoded path>` (or under `CLAUDE_CONFIG_DIR`), where the encoding is Claude Code's own (every character other than a letter or digit becomes `-`). Only worktrees under `<workRoot>/worktrees/` are considered, and a folder is kept when any conversation in it records a `cwd` outside that worktree, since two paths can share a folder name. Paths whose folder name would exceed 200 characters get a hash suffix from Claude Code, which Switchflow does not reproduce, so those folders are left. Codex session files are left too: they sit in dated folders shared by every project (`~/.codex/sessions/YYYY/MM/DD/`), and Codex indexes threads in its own state database and `session_index.jsonl`, so removing a file behind its back could leave that index pointing at nothing.

### Claude cloud workers

`delegate_task` takes an optional `environment` (see [Environments](#environments-and-ssh-boxes)). `claude-cloud` (`scripts/control/environments/claude-cloud.mjs`) runs a Claude worker in a claude.ai/code cloud environment, billed to the owner's Claude subscription. An unconfigured environment is refused (409); it never falls back to local. Cloud workers are Claude only, skip memory admission and do not count against `limits.maxWorkers` or any per-environment limit; they get no lease tools (the session runs in Anthropic's sandbox), no port block and no compose project. A cloud worker whose `delegate_task` names leases from the environment's pool waits for them before it is submitted. Summaries add `environment` and, once started, `sessionUrl`.

What Claude Code 2.1.288 allows, verified on 2026-10-04:

| Need | How | Latency |
| --- | --- | --- |
| Start | `claude -p --cloud "<task>"` is refused ("interactive only"). Each environment has one routine that Switchflow reuses: the first worker creates it (disabled, so it has no schedule), later workers replace its job with `update`, and `run` starts a new session from it. Running sessions keep the job they started with. Every update clears the account's connectors (`clear_mcp_connections: true`; a bare `[]` is ignored). The routine's ID is kept in the service state, and a routine the owner deleted is replaced. The calls go through a local headless `claude -p --tools RemoteTrigger --model haiku` turn, so the CLI signs them and Switchflow never handles an OAuth token. The host reads the raw API JSON from the stream and ignores any call that differs from its request. | about 5 s per call; the session starts in about 5 s once the environment's setup is cached |
| Progress | `get_run_log` returns a condensed text log (commands, tool calls, messages, result), polled every `pollSeconds` (default 60) into `command`, `tool`, `message`, `notice`, `turn.completed` and `turn.failed` events | `pollSeconds`; each poll is one small Haiku turn |
| Steer and follow-up | `claude -p --cloud <session_id>` with the message on stdin delivers it into the same session; the worker takes it at its next turn boundary. Confirming an approach and returning review findings are follow-ups in the same session. | about 2 s to deliver |
| Questions | The worker pushes `status.md` (`STATUS …`, `QUESTION … \| default: …`) on `claude/sf-<key>-notes`; the host shows each new line as a notice (questions with `needs: "orchestrator"`). Unanswered questions fall back to the stated default after 20 minutes. | next poll |
| Interrupt | Not available. Interrupt and cancel send "STOP" to the session; the session ends at its next step. Archive it at its `sessionUrl` to stop it at once. | next step |
| Result | The worker commits on `claude/sf-<key>` and pushes it. After each writable turn the host fetches it into `refs/switchflow/cloud/<key>/result` and fast-forwards the candidate worktree when it is clean and the result descends from it, so review and merge run locally as for local workers. | one fetch |
| Cleanup | On close: `sf-task/<key>`, `sf-inbox/<key>` and the notes branch deleted; the result branch kept. The routine stays for the next worker; its run history lists every worker session. | |

**Approach gate.** The first turn is the approach turn. A routine's `allowed_tools` does not restrict the session (the probe wrote a file and pushed with only read tools allowed), so the read-only turn is enforced by instruction and checked by the host: if `claude/sf-<key>` or its notes branch exists after the approach turn, the turn fails. The cloud environment's own stop hook asks sessions to commit and push untracked files; the approach prompt tells the worker to ignore it. Confirmation is a follow-up message that allows writes.

**Branches.** Each worker has a key (`<task>-<8 hex>`). The host pushes the candidate head to `sf-task/<key>` and the task text to `task.md` on `sf-inbox/<key>`; the routine prompt stays short and fixed because the relaying model must echo it exactly. Both pushes need the owner's push grant (`push: true`); without it submit is refused.

**Configuration** (an entry in the agent settings' `environments`, never in the checkout): `{ "id": "claude-cloud", "kind": "claude-cloud", "environmentId": "env_…", "repository": "https://github.com/<owner>/<repo>", "remote": "origin", "model": "claude-opus-5-5", "push": true, "pollSeconds": 60 }`, validated when saved, or added in the Agents view's "Where workers run". Environments are created only in the claude.ai/code UI; the repository must be reachable by the Claude GitHub App. `health()` checks the configuration, `claude auth status`, that `remote` is the configured repository and answers, an optional pushed branch, and the push grant.

**After a restart.** A cloud worker keeps running while the service is down, so it is reconnected, not delegated again. Its handle is kept in the worker ledger (`cloud`: key, task, session and routine IDs, branches, URL, the run-log position, whether a turn was running, and the last result), updated after each poll without a result and at the end of each turn. **Resume held workers** opens a session from that record: no routine is updated or run, polling continues from the recorded position, and a turn that was running is followed to its result (a result seen just before the restart is read again, because positions are recorded only with the end of their turn). Steering and follow-ups go to the same session. A delivery worker's gate comes from the record: confirmed once a writable turn has run, otherwise awaiting confirmation after an approach. A worker whose handle was not recorded yet (the restart came while it was starting) is delegated again.

### Codex cloud workers

`codex-cloud` (`scripts/control/environments/codex-cloud.mjs`) runs one Codex task on an OpenAI VM per worker through the experimental `codex cloud` CLI. It is opt-in: the entry must set `"experimental": true`. It is fire-and-forget: submit, poll, diff, apply. Capabilities: `stream`, `steer`, `interrupt` and `followUp` are all false; `result` is `diff`; `approachGate` is false.

| Need | How (codex-cli 0.153.4, checked 2026-10-04) | Latency |
| --- | --- | --- |
| Start | The host pushes the candidate head to `sf-task/<key>`, then runs `codex cloud exec --env <environmentId> --branch sf-task/<key> "<prompt>"`, which prints only the task URL. The prompt goes in argv, so it is capped at 24,000 characters. | seconds to submit; the VM starts on OpenAI's side |
| Progress | `codex cloud status <task>` every `pollSeconds` (default 60): pending, ready, applied or error, plus diff stats. No log or messages are available. | `pollSeconds` |
| Steer, follow-up, interrupt | Not available from the CLI. A second turn, a steer or a confirm is refused; interrupt only stops Switchflow waiting, and the task keeps running until it ends or the owner stops it at its URL. | |
| Result | No CLI command returns the assistant's messages, so the worker writes its JSON reply to `.switchflow-result.json`, and the host reads it from `codex cloud diff`. For a writable task the host applies the rest of the diff to the candidate with `git apply --check` first, then commits it there. It refuses when the candidate is dirty or the diff does not apply, so nothing is half-applied. `codex cloud apply` is not used: it applies into its working folder and can leave a partial apply. | one diff |
| Cleanup | On close, `sf-task/<key>` is deleted. The task stays in ChatGPT (state is kept for 7 days). | |

**Approach gate: not supported.** A confirmed approach could only start a second, unrelated task, and no reply text comes back. So the kind has no approach turn, and `delegate_task` refuses to place a delivery worker there (409). Codex cloud takes reviews only. A review session is read-only on every turn: the host never applies its diff, and any files it changed are reported and discarded. Only Codex runs there; a Claude worker is refused, and Codex is refused on `claude-cloud`. An optional `provider` field in either entry must match its kind.

**Where code goes, and billing.** Codex cloud checks out from GitHub.com, never from local files, so the candidate head must be pushed. Switchflow pushes `sf-task/*` only when the owner sets `push: true` on the entry, as for Claude cloud. Without it, submit is refused and `health()` says why. Code goes to GitHub and OpenAI. Usage comes from the owner's ChatGPT plan allowance, the same allowance as local Codex, and cloud tasks use more of it. It requires ChatGPT sign-in; API keys get no cloud tasks.

**Configuration:** `{ "id": "codex-cloud", "kind": "codex-cloud", "experimental": true, "environmentId": "<id from codex cloud or chatgpt.com/codex>", "repository": "https://github.com/<owner>/<repo>", "remote": "origin", "push": true, "pollSeconds": 60 }`. Environment IDs cannot be listed from the CLI, so copy the ID by hand. "Add Codex cloud environment" in the Agents view writes this entry, and the list marks it reviews only. `health()` checks the configuration, `codex --version`, ChatGPT sign-in through `codex cloud list --json --env <id> --limit 1`, that `remote` is the configured repository and answers, and the push grant. Latency is minutes per task: plan reviews accordingly. After a restart a held task is reconnected by its task ID, recorded with its URL, branch and status in the worker ledger: polling continues and nothing is submitted again; a diff already collected is not applied twice. Not yet: `--attempts` (best-of-N).

## Where data lives

| Data | Owner/location |
| --- | --- |
| Code | Accepted project checkout and explicitly managed candidate worktrees |
| Active governance rules and documentation | Primary checkout; copies in code worktrees are historical snapshots |
| Shared browser service and project registry | External `control-service/`; one port per state-home |
| Delivery tasks, milestones, accepted product documents | Primary checkout's Backlog; worker worktrees use the same governance root |
| Browser scope/plan approvals, revision history, sessions and run receipts | External project state, `control.json` and `runs/<id>/` |
| Agent routing settings, environments, placement and the agent session index | External `agent-settings.json` and `agent-sessions.json`; per-session events in `runs/<id>/sessions/`; SSH known hosts in `environments/<id>.known_hosts` |
| UAT preview command / running preview record | Primary checkout's `.switchflow/preview.json` (owner-edited) / external `preview.json` (process ID and start time only) |
| Capacity profile / held leases / port blocks / delegation ledger | Primary checkout's `.switchflow/capacity.json` (owner-edited) / external `leases.json` / external `worker-resources.json` (each open worker's port block and compose project) / external `worker-ledger.json` (task, kind, candidate, provider, instructions and named leases of recent delegations, a cloud worker's handle and an SSH worker's remote worktree, for resuming after a restart) |
| Friction/issues, check evidence, worktree registrations | Separate external JSON ledgers in `operations/` |
| Investigation output | Managed external scratch; agents read only explicitly referenced material |
| Selected durable scratch output | Explicit promotion into the governance collection; never automatic ingestion |

External state defaults to `%LOCALAPPDATA%/Switchflow/projects/<SHA-256 of canonical Git common directory>`. `SWITCHFLOW_HOME` selects another external base. All worktrees sharing that Git common directory share the state. The `operations.mjs context <project>` command reports exact source, governance and state locations. Treat run prompts and tool logs as local project data when backing up or sharing; the web API only exposes human-facing activity and receipts.

Agent tools receive only the project/governance checkout, informational operations, scratch/promoted output, their managed candidate directory, and their Git request inbox as writable locations. Controller approvals, run records, responses, Git receipts and registries stay outside those grants. The runner excludes broad temporary-directory write access and supplies a dedicated temporary folder under its scratch area. Earlier local-candidate operations ledgers remain readable; the first update writes a separated copy without deleting the original. Stop older services before updating to this layout.

Scratch's default write-only use is a role boundary, not an operating-system ACL. Retention previews select only registered, expired, unpromoted scratch files. Applying cleanup rechecks exact ownership, hash and path containment; it leaves changed, unknown or promoted artifacts alone. It does not remove worktrees. Existing `cleanup-phase.ps1` retains its clean-and-merged predicate.

## Recovery

A normal cancel stops the owned process tree and records the interruption. Restart never treats an interrupted process as completed. Retry is an explicit action after recovery, not automatic replay of uncertain work.

The restart fence covers every agent process of the active run: the stage agent and each delegated worker or reviewer. A worker gets a durable entry in `control.json` (`activeRun.workers`: session, kind, provider, task, PID, time recorded) before its provider starts, and its PID is written as soon as the process exists: Codex app-server before its handshake, Claude CLI before its first input (again for the process that resumes a confirmed approach), `codex exec` at each turn's start. A cleanly closed worker's entry is removed. On restart each recorded process is classified:

| State | Meaning | Effect |
| --- | --- | --- |
| `running` | PID is alive and its start time is no later than when it was recorded | Holds the run until it stops or the owner stops it |
| `unverified` | PID is alive but its start time cannot be read | Holds the run until the owner confirms it stopped |
| `unknown` | No PID was recorded, for example a crash during startup | Holds the run until the owner confirms it stopped |
| gone | PID is not alive, or a later process reused it | No hold |

The hold lists each process (provider, stage or worker kind, task, PID) in `activeRun.held` and in the initiative's next action, and the Agents view lists those sessions as `failed`. Owner actions on the initiative:

- `stop-processes` ends the tree (`taskkill /T /F` on Windows, the process group elsewhere) of each process whose identity is verified again at that moment. Unverified and unknown entries are never stopped by the service. The hold is released when nothing remains.
- `recover-run` with `confirmedStopped: true` releases a hold whose remaining entries are unverified or unknown. It is refused while a verified process is still running.
- Any other action is refused while the hold remains; once every recorded process has stopped, the next action releases it.

**Resume held workers.** Every delegation is recorded in the external `worker-ledger.json` before its worker starts (task, kind, candidate name, provider, the orchestrator's instructions, approach state) and marked finished when the worker ends. On restart, the delegations of the interrupted run that were still queued or open are listed on the initiative as `heldWorkers`. Once the hold is released, a delivery initiative offers **Resume N held workers** next to Retry: the `resume-workers` action (`{ "action": "resume-workers", "expectedRevision" }`, no other fields) retries delivery, and the new execution run delegates those workers again before the orchestrator's first turn, deliveries before reviews and under the usual capacity limits. Cloud workers (Claude cloud, Codex cloud) kept running and are reconnected to the same session or task (see [Claude cloud workers](#claude-cloud-workers)). Every other worker gets a new session with its original instructions after a note that the previous session stopped with the service and that it must inspect the worktree (committed work, uncommitted edits, a half-finished rebase) before continuing; a delivery worker starts again at the approach gate. An SSH worker's uncommitted remote work is saved first and its new worktree starts from it (see [Environments](#environments-and-ssh-boxes)); if the box does not answer, nothing is resumed and the reason is shown. The orchestrator's state lists them as `resumedWorkers` so it follows them instead of delegating the same tasks again, and its session records a `notice` naming what was resumed, reconnected and what could not be. Provider-level resume of local sessions is not used: Claude workers run without saved conversations and Codex app-server thread resume is unverified. A plain Retry, or any new run, drops the list. A graceful service stop or an owner cancel ends workers normally, so nothing is held.

The service does not stop these processes on its own at startup. Recovery runs whenever a project attaches, possibly without the owner present, and acts on state written by a previous service; stopping is irreversible and the owner may want to inspect the worker's work first. When the service dies its agents' stdin closes. In live checks on Windows (2026-10-03), Codex app-server and Claude CLI exited within about 1.5 s of that even mid-turn, and Codex took its running shell command with it, so a hold on a live worker is the exception: a hung process, or one whose identity cannot be confirmed. Start-time verification makes a stop request safe against PID reuse; it costs one PowerShell `Get-Process` call (about 0.3 s) per live PID, only during recovery.

Native Backlog and MCP editing timeouts and invalid transport responses retain their request and write-admission lock until the owned child emits closure. Sending a termination signal alone does not establish that the writer stopped. If termination cannot be confirmed, the request remains pending and new writes remain fenced; inspect and stop that exact child before recovery. No replacement child starts while its predecessor is uncertain.

Agent checkpoints start with the complete chronological owner history and identify new input separately. Earlier answers survive fresh sessions and service restarts. Long histories are retained in a run-local `owner-history.json` that the agent is instructed to read before deciding; superseded scope requests do not override current approvals.

Planning returns the exact native Backlog ID in each plan entry's `task` field, with its readable title and result in `outcome`. The initiative's Delivery tasks section uses those IDs from the approved plan; it never guesses associations from matching titles or ID fragments in prose. Older plans without explicit IDs remain usable and display an unlinked state with access to the project's task list.

Malformed state and unexplained stale data locks fail closed. Stop the service, back up its external state, inspect the lock's owner, and remove only a proven stale lock. Do not delete `control.json` or approve work to bypass a recovery failure. Service-lock recovery itself is serialized so simultaneous launches cannot steal a replacement lock.

## Verification and security boundaries

The server accepts only its loopback Host and same-origin browser requests. Every mutation requires a per-service token; JSON payloads and native decision-editor UTF-8 text are bounded. It launches fixed local executables with argument arrays and stdin, never browser-supplied shell commands. The one owner-configured program, the [UAT preview](#uat-preview), also runs without a shell and only after the owner starts the exact command shown. Native Backlog request handlers run through a private process pipe per canonical project, with no additional HTTP listeners. All writes share the agent-admission fence. Repository attachment responses are sandboxed and cannot execute scripts with workspace authority. The native web bundle is hashed alongside the executable in the fork receipt. Only local users and processes that can access this host should use this service; it is not a remotely authenticated multi-user server.

Agent results, events and completion receipts are bounded and persisted. A malformed final result, missing durable session, failed turn, timeout or process error cannot advance to UAT. Each agent runs under the owner's existing local Codex or Claude login with sandboxing and no approval bypass. Success in adapter tests is not real agent proof; a successful agent run is not human UAT.

`operations.mjs check` reuses only the latest successful matching attempt, with identical tracked/untracked source content, Git HEAD, command/arguments, working directory, declared scope and environment digest. Include digests for ignored dependencies, fixtures, external services and container images in `inputs`, or disable reuse when those inputs are not known. Container availability alone is not a container test result. Workers and reviewers reuse applicable evidence; the integrated changed candidate still gets its required gate.

## Milestones and documentation

Switchflow's Milestones view supports atomic creation, task assignment, removal and archive workflows, and edits an existing ID's title, description, labels and optional non-negative execution order. Revision conflicts retain the draft. Unspecified order remains unspecified; numeric identifiers never grant scheduling priority. The Switchflow task editor exposes an optional block reason and the fork updates dependency readiness on cooperating task mutations.

Documents and Decisions have Switchflow readers and editors, folder navigation, full-text search, Markdown previews, code copy and project-bound links. Local documentation images resolve only from canonical backlog/assets. Raw HTML stays inert; Mermaid is shown as code. Task and milestone edits use captured revisions. Document/decision saves compare the latest record before writing but their native APIs do not provide atomic compare-and-swap. See [workspace details](workspace-0.5.0.md) and the [full functionality review](backlog-ui-review.md).
