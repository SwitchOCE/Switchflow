# Video insights: "If you have a Claude sub, watch this"

Theo (t3.gg), published 2026-10-01, 66:36.

**Source.** The owner-supplied transcript is YouTube's transcript export, with chapters. Like my earlier caption pull it is speech recognition and garbles names ("cloud code", "codeex"). Items marked [seen] were checked on screen.

**Chapters.** Intro 0:00 · Sponsor 1:31 · Getting more tokens 2:43 · Accessing tokens 5:26 · Practical token management 12:46 · Using tokens well 29:11 · T3 Code workflow 38:35 · Using tokens poorly 50:12 · Tokens while sleeping 59:08. The titles lag the content by about one section; the timestamps below follow the content.

## What the video says

- **2:43–12:40, subscriptions instead of the API.** Theo says $200 subs return about $8k (Claude) and $12k (Codex) of tokens, and that turning off model training makes a personal sub equivalent to a team account. These are his claims. User-facing traffic stays on the API.
- **12:46–28:58, a multi-account proxy.** CLIProxyAPI (forked from VibeProxy) pools 5 Claude and 4 Codex accounts behind one home IP, and other machines reach it over Tailscale. It routes to the account that resets soonest, uses WebSockets for Codex, and keeps session affinity so prompt caches survive. [seen] the quota console. He admits it may get accounts banned (14:43).
- **23:01, a fleet repo.** Setup docs per machine, so an agent can configure a new box. [seen]
- **30:03–31:37, de-risk both sides of merge.** Most of his tokens go to verification, not coding. If reverting takes more than about 15 seconds, fix that first.
- **33:06–37:39, bring the agent in early.** Give it the problem, not your solution, and ask for the simplest fix. If the agent fails, the problem deserves your own thought.
- **38:35–45:04, threads as an inbox.** Settle a thread when handled (distinct from archive), snooze one to defer it, send prompts in the background, and pick a machine per thread or load-balance. [seen]
- **43:13, the prompt pattern.** State the problem plus ideas. If confident, the agent does it; if not, it makes HTML mocks through his own skill.
- **45:43–47:45, feasibility probe, then finish-line prompts.** He asks first how hard the work is and ignores the model's time estimate. Then the prompt is: build it, file a PR, spin up a preview, babysit the PR. If merge conditions are stated, about half his threads close unread. [seen]
- **47:52–50:03, defaults.** A worktree per thread, auto-settle after 3 days, running threads dimmed. On failure, ask the agent why.
- **50:59–59:03, "use tokens instead of your brain".** Agents triage PRs, find abandoned projects, and use up leftover quota before resets.
- **59:08–1:04:00, an always-on Linux box at home.** No VPS and no Mac. Heavy CI goes to GitHub, Blacksmith or Depot, or into a queue.

## Work more efficiently

1. **Probe, then start Intake early** (33:06, 45:43). Open with the symptom or screenshot and ask how hard the fix is and whether there's a simple one. Drop ideas with friction before planning.
2. **Write the finish line into every outcome** (46:18): a runnable candidate, how to reach it, and the evidence.
3. **Don't watch sessions** (44:36, 49:47). Check only Done or needs-input sessions, and queue the next intake meanwhile.
4. **The 15-second revert test** (31:29) before granting larger plans.
5. **Spend expiring quota on read-only work** (28:11, 55:21): triage, a stale-branch audit, doc checks. Output nobody reads still costs review time.
6. **Ignore agent time estimates** (46:09). Size work by scope and risk.
7. **Check data-sharing settings in both apps** (11:00).

## Switchflow features (ranked by value/effort)

| # | Idea | Extends | Value / effort | Principle check |
|---|---|---|---|---|
| 1 | **Attention inbox**: sort by "needs you", dim running items; Settle, Snooze, auto-settle after N days | Agents view, Overview | High / low | Fits, as long as it is view state only and never changes the board |
| 2 | **Queued message vs. steer now** (pending until the next tool or turn boundary) | DESIGN §3 `send_to_worker`, §4 | High / low–med | Fits; Theo is building it too (41:13) |
| 3 | **Suite queue**: a host lock runs one repository suite or heavy build at a time across workers | Phase gate, `maxWorkers` | Med–high / low | Fits; prevents false failures when workers saturate the machine (1:03:07) |
| 4 | **UAT candidate launcher**: delivery ends with a running preview and a link | Guided UAT | High / med | Partial conflict: Theo's preview copied real user data and secrets [seen]. Use fixture data only |
| 5 | **Cache-aware continuity**: same-thread follow-ups and review returns; record cache reads and writes | DESIGN §1, §3; outcome measurement | Med / low | Fits |
| 6 | **Mocks when a UI choice is ambiguous**, offered as an Intake or Planning question | Skills | Med / low | Fits, inside an existing gate |
| 7 | **Stale-work brief**: state, value, merge or drop (56:43) | Overview, `flow` | Med / low–med | Fits as a read-only report |
| 8 | **Quota-aware routing**: limits and reset times per provider; prefer the one about to expire | Capability probe, routing | Med / med–high | Fits if logged as events; data source unverified |
| 9 | **Idle-quota jobs**: standing, owner-defined reports | Insights | Med / med | Read-only only; otherwise they bypass Intake |
| 10 | **Reviewer worktree hygiene**: the reviewer reads the diff or a detached checkout | Bridge worktrees | Low / low | Fits; mostly a check of the current design |
| — | **Conditional merge** (47:28) | — | Don't | Merging past UAT breaks the gate; agents already accept phases |
| — | **Multi-machine workers** | — | Defer | Conflicts with the loopback-only security model and Windows-only support (SF-08) |

## Other tools

- **T3 Code**: borrow its interaction patterns. It could host ungoverned ad hoc work, but it has no gates and keeps no board record.
- **Tailscale**: would give phone access to the control service, but changes the loopback security model, so it needs a design note first.
- **CLIProxyAPI / VibeProxy**: don't adopt. The ToS and ban risk is admitted on camera, and it means running a service that holds credentials.
- **Macroscope** (AI PR review, [seen]): only if first-pass review acceptance stays low.
- **Blacksmith / Depot**: only if a suite saturates the machine; feature 3 comes first.
- **Parallel** (sponsor): search and extract APIs with an MCP server, possibly for Intake research. Its claims come from the ad read and are untested.

## Verification status

- **Settled by the transcript:**
  - The mock prompt names an "HTML skill"; the earlier captions said "HTML scale".
  - Snooze is a real T3 feature, separate from Settle and Archive; the earlier captions said "news feature".
  - "vibe coders", not "five coders".
  - Both transcripts agree on `npx t3 connect` / `npx t3 serve` with built-in Tailscale, and on the 3-day auto-settle.
- **Still spoken only:**
  - Those commands and flags, and the auto-settle default.
  - The proxy port: the transcripts say 318 or 4318, but the screen shows 8318.
  - The sponsor link: the transcript's "swordv.link" is wrong; the description gives soydev.link.
- **Unverifiable from the video:**
  - All price, subsidy, margin and reset figures; the ToS and training claims; the claim that Opus 5.5 rarely hits limits.
  - Whether proxy affinity works by default.
  - Pinned comments were not checked.
