# Claude cloud environments: research notes

Researched 2026-10-03 by a documentation agent; CLI flags verified against the installed Claude Code 2.1.288 (`claude --help`). Items marked _unverified_ come from documentation only.

## Ways to run Claude off this PC

| Path | Start | Billing | Programmable control |
| --- | --- | --- | --- |
| Claude Code cloud sessions | claude.ai/code, or `claude --cloud [description\|session_id\|url]` (verified) | claude.ai subscription | attach by session ID or URL (`--cloud <id>`), `--teleport [session]` to resume locally (verified); streaming and steering from a local program _unverified_ |
| Self-hosted environment | `claude --environment <ccpool_…>` creates a cloud session that runs on the owner's own machine (verified flag) | subscription | as cloud sessions; execution stays on the owner's box, conversation goes through Anthropic |
| Routines | defined at claude.ai/code/routines, fired by schedule or `/fire` (research preview) | subscription, user-scoped | fire with limited context; a routine aimed at a running session starts a fresh one (observed in the Webatrice run) |
| Claude Managed Agents API | `sessions.create({agent, environment_id, …})` | `ANTHROPIC_API_KEY`, per token | full: environments create/list/archive; session events stream; follow-up events (steering); `user.interrupt`; usage events |

## Environments

- Configurable: network level (limited with allowed hosts and package managers, or unrestricted), environment variables, setup script (about 5 minutes at most), pre-installed packages (pip, npm, apt, cargo, gem, go); base image is Ubuntu with common tools. Managed Agents environments are created through the API; claude.ai/code environments through the UI.
- Repositories: GitHub only, through the Claude GitHub App; results arrive as `claude/*` branches. No local file mounting.
- Limits: CPU, RAM and disk are not documented for claude.ai/code (the Webatrice run measured a 16 GB box); sessions idle after about 10 minutes; storage is per session.

## Coordination and gaps

- No server-side fan-out or join: an orchestrator must create and poll each session itself.
- A cloud session cannot reach an MCP server on the owner's PC; private MCP needs MCP Tunnels (research preview, cloudflared plus a proxy). So Switchflow's orchestration tools stay host-side, and cloud workers report through git.
- Results are scattered branches; fetching, reviewing and merging stay local.
- The Webatrice run found: clearing connectors on a routine with an empty list is silently ignored; messaging a running routine session spawns a junk session; cloud workers cannot be resumed, so a fix means a new run.

## Sources

- https://code.claude.com/docs/en/web-quickstart.md
- https://code.claude.com/docs/en/cloud-environments.md
- https://code.claude.com/docs/en/routines.md
- https://code.claude.com/docs/en/authentication.md
- https://platform.claude.com/docs/en/managed-agents/sessions.md
- https://platform.claude.com/docs/en/managed-agents/environments.md
- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration.md
- https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview.md
