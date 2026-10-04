# Open issues: proposed solutions

Written 2026-10-04 after `environments` merged into `main` (1732677). Items marked **building** have an agent on them; the rest need an owner decision first.

## Building now

| Issue | Proposed solution |
|---|---|
| Remote workers are lost or restarted after a service restart | Cloud workers keep running, so reattach: persist the session or task handle in the worker record and resume polling. SSH workers die with their connection, so commit the box worktree's uncommitted changes to a recovery ref first and start the new worker from it. An unreachable box keeps the run held with its reason. |
| Claude keeps SSH workers' conversation files in the box user's `~/.claude` | On cleanup, delete only the project folders whose encoded path is that worker's worktree under `workRoot`. |
| Remote workers can't use leases | Leases taken at delegation: `delegate_task` names the leases, the host holds them for the worker's session and releases them at the end. Pools are per environment, so a box's leases describe the box. |
| One Docker stack and fixed ports serialise e2e runs | A port block and a `COMPOSE_PROJECT_NAME` per worker, injected by the host; optional `compose down` for that project only when the session ends. |
| Each worktree carries its own `node_modules` | Opt-in reuse when the lockfile matches the primary's, through a shared store that cannot write back into the primary's dependencies; normal install otherwise. |
| No Codex cloud settings screen | Add it to "Where workers run", offered for reviews only. |
| Workers queue silently when a remote environment is down | A readiness check of the placed environments when delivery starts; a failure holds the initiative with the reason and "Test again". |
| No way to free this PC | A "Pause local workers" toggle: running workers finish, new local work queues, remote work continues. |
| SF-28: the fork CLI loses piped output past 64 KiB on Linux | Callers on Linux read the CLI's output from a temp file instead of a pipe; the fork itself, and its identity, stay unchanged. Linux verification still to do. |

## Need a decision

### SF-29: the Git bridge refuses Claude cloud's commit signing

The bridge refuses any global signing or helper setting because those run programs on the host. Claude cloud enables `commit.gpgsign` for every session, so bridge operations stop there.

**Proposal:** an owner-approved signing policy, stored service-side like other owner settings. The owner approves the exact values once, for example `gpg.format=ssh` and the signing program path. The bridge then accepts exactly those values and still refuses anything else. Until approved, the refusal stays.

**Alternative:** for host-run checks only, run with a private Git home, as the tests now do. This is simpler, but host commits would then be unsigned on that machine.

**Decision:** approve the policy design, or keep refusing.

### Claude cloud ignores a session's tool allow-list

A read-only probe still wrote a file and pushed a branch. So the approach step relies on instructions, plus a host check that nothing was pushed during it.

**Proposals, cheapest first:**
1. **GitHub ruleset.** Restrict what the Claude GitHub App can push in the repository to `claude/sf-*` branches. This doesn't enforce the read-only turn, but it limits a misbehaving worker to its own branches. It is a GitHub setting you add yourself (Settings → Rules → Rulesets).
2. **Run the approach turn on a read-only clone.** The approach session's repository source would be a mirror the GitHub App can't push to. The confirmed second turn would run on the real repository. This costs a second session and setup.
3. **Report it to Anthropic as a bug.** The allow-list is documented as restricting tools.

**Recommendation:** 1 now and 3 in parallel; 2 only if a worker is ever caught writing during an approach.

### Stacked branches: integration queue

The Webatrice run hand-managed restacks and an integration line.

**Proposal:** a host-owned queue of finished candidates in dependency order:
- Each is rebased onto the line, gated once (holding the `gate` lease), and fast-forwarded.
- A conflict or failed gate sends that candidate back to its worker with the failure. The rest continue.
- The owner sees one ordered list instead of N branches.

This is the largest remaining item.

**Decision:** whether to build it next.

### Managed Agents API

This is only worth it if you want per-token billing and full programmatic control (streaming, interrupt) in the cloud. Subscription cloud, SSH and Codex cloud cover the current needs.

**Recommendation:** leave it.
