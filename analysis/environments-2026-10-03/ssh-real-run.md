# SSH environment: real runs on the WSL box

Date: 2026-10-04. Box: Ubuntu on WSL2 on this PC, key-only sshd on port 2222, Node 22.22.1, git 2.53.0, codex-cli 0.160.0 and Claude Code 2.1.288 signed in as `keech`. Work root `/home/keech/sf-envtest`, removed afterwards. Nothing in `~/.codex` or `~/.claude` on Windows was touched.

Script: [ssh-real-run.mjs](ssh-real-run.mjs). It drives the same `Orchestration` and `AgentHost` the service uses, with the owner settings an owner would save (`environments: [wsl]`, `placement.delivery: "wsl"`), against a throwaway repository under `%TEMP%`. The task: add `shout(name)` to `greet.js`.

Sequence per run: health check, `delegate_task` (placed on `wsl` by role placement), steer mid-turn during the read-only approach turn, wait for the approach, confirm it, interrupt the writing turn, send a follow-up, wait for the handoff, check the local candidate, finish the worker.

## Results

| | Codex (app-server, effort low) | Claude (haiku) |
|---|---|---|
| Health | ok, both CLIs signed in | ok |
| Streaming events | `session.started`, `turn.started` ×3, `command` ×8, `message` ×3, `file_change`, `turn.completed` ×3 | `session.started` ×3 (one per process: read-only, then resumed writable), `tool` ×3, `command`, `message` ×4, `file_change`, `turn.completed` ×3 |
| Steer during the approach turn | `mode: "steer"` accepted mid-turn; the approach named the file as steered ("Touch only greet.js.") | accepted; approach named `greet.js` |
| Approach gate | approach turn ran read-only; `awaiting-confirmation`; writes only after `confirm: true` | same |
| Interrupt | `interrupted: true` on the writing turn; worker went idle; collect found no changes | same |
| Follow-up | implemented and handed off | implemented and handed off |
| Result in the local candidate | `4b773cf DEMO-1: work from WSL Ubuntu` on top of `Base`; `greet.js` has `export const shout = name => greet(name).toUpperCase();` | `2ab6dfd DEMO-1: work from WSL Ubuntu`; same line |
| Usage | 70k tokens (ChatGPT plan) | $0.081 |
| Wall time | 46 s | 25 s |
| Cleanup | remote worktree, temp folder and PID files removed; branch kept in the mirror; no agent or `wsl.exe`/`ssh.exe` process left | same |

Before these, a smoke test of the environment alone (`prepareWorkspace`, a `sh` child over the wrapper, `collect`, `cleanup`) checked quoting (`it's $PWD`, a value with a space, a quote and `$HOME` stayed literal), stdin piping, PID reporting, and `stopTree` killing a `sleep 60` remote group (local `close` with a signal, no remote process left).

## Problems found and fixed

1. **WSL stops the distro under live ssh sessions.** The first two Codex runs died about 14 s after the wake command exited: "Connection to localhost closed by remote host", Codex exit `4294967295`. WSL shuts a distro down when no `wsl.exe` client is attached; ssh sessions do not count. Fix: an owner `keepAwake` command (`wsl.exe -d Ubuntu -- sleep infinity`) that the environment runs while any agent process is open on the box, and `collect`/`cleanup` wake the box first. Those two runs' remote worktrees were left behind (cleanup ran against a stopped distro); the work root was removed at the end.
2. **keepAwake leaked once.** The Claude run restarts its process when the approach is confirmed (read-only process, then resumed writable). A late `close` of the previous keeper cleared the reference to the new one, so the script did not exit. Fix: a keeper only clears itself, and its whole tree is stopped (`wsl.exe` starts a child `wsl.exe`). The later Codex run exited cleanly with nothing left running. Covered by a fake-ssh test.
3. **Haiku answered a steer that arrived before it read the prompt** ("Awaiting actual task instructions"). Not a transport fault: the script now steers once the agent shows activity, and corrects a draft approach with a non-confirming follow-up if needed.

Incident during manual checking: one hand-typed PowerShell `ssh` probe lost its inner quotes, so the remote shell piped `ps` output into `claude` and `sleep`. It ran once in the box user's account; no Switchflow code was involved.

## Not exercised here

- Restart recovery with a live remote worker (the host records `environment` and `remotePid` in the run's worker record and the engine lists such entries for the owner to confirm, but the engine is not bound in this script and no test covers that path yet).
- A remote reviewer (same path, read-only, no collect).
- Leases from a remote worker (not offered: the loopback lease server is not reachable from the box).
