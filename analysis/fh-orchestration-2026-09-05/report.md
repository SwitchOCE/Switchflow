**FH dev orchestration efficiency — 5 September 2026**

The evidence supports allowing the phase agent to deliver serial work directly, with a separate independent reviewer. The current workflow creates coordination even when there are no simultaneous delivery tasks. However, repeated context is mostly cached, and the largest delay in the latest run came from an incomplete specification and correction. Removing the orchestrator layer would not by itself remove that rework.

This is a review and proposal. No workflow rules or FH project files were changed.

**Measured sample**

The three latest phase orchestration runs found in active and archived FH Dev Tooling tasks, including all seven associated delivery/review agents. All ran on 5 September, Sydney time. The older UI Cleanup task was inspected during discovery but excluded from this comparison because its longer history spans different telemetry versions.

| Task title | Delivered tasks | Active elapsed time | Orchestrator responses | Empty waits / all agent waits | Orchestrator input | Cached | Uncached input |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Orchestrate advanced foundations | 1 | 66.6 min | 126 | 42 / 52 | 9,684,296 | 97.85% | 208,200 |
| Orchestrate designer release | 2, sequential | 50.9 min | 106 | 30 / 45 | 7,322,671 | 98.56% | 105,647 |
| Prepare designer phase | 1 | 14.9 min | 44 | 7 / 12 | 2,340,586 | 96.92% | 72,170 |

Active elapsed time includes tooling, agent waits and delivery/review within completed root turns. It excludes the release run's approximately 28.8-minute gap awaiting publication approval. Parallel child time is never added to parent elapsed time. Advanced Foundations was stopped after its first task at the user's request; the three deferred tasks are not counted as failures.

Sources: [foundations usage and completion](<C:/Users/keech/.codex/sessions/2026/09/05/rollout-2026-09-05T15-32-36-01a0700d-eef1-78b0-949c-b573deae12f2.jsonl:883>), [release usage and completion](<C:/Users/keech/.codex/archived_sessions/rollout-2026-09-05T13-06-27-01a06f88-2017-7f32-a830-18f516a4ad42.jsonl:714>), [preparation usage and completion](<C:/Users/keech/.codex/archived_sessions/rollout-2026-09-05T12-20-40-01a06f5e-35f8-7241-ba84-d3ab2c4b9bf5.jsonl:336>). Per-agent figures and timeout source lines are in [metrics.json](<C:/Users/keech/Documents/Switchflow/analysis/fh-orchestration-2026-09-05/metrics.json>).

Across the complete delivery/review trees, there were **702 model responses, 1,459,801 uncached input tokens and 228,927 output tokens**. Orchestrators accounted for **276 responses (39.3%), 386,017 uncached input tokens (26.4%) and 30,839 output tokens (13.5%)**. Those shares are coordination footprint, not an estimate of removable waste: task-state handling, integration, validation and reporting would still be needed under direct delivery.

Orchestrators used GPT-6 Astra: high reasoning for foundations, medium for both designer phases. All seven actual delivery/review agents used GPT-5.6 Sol. Copied parent contexts in forked logs were excluded when identifying worker models and counting work.

**1. Serial work pays for a coordinator and a delivery agent**

There was no overlap between two different delivery-task execution intervals in any of the three runs. Preparation used one delivery worker and one reviewer; foundations used one delivery worker and one reviewer; release used a build worker, then a publication worker, plus a reviewer. Orchestrators sometimes did useful checks or setup while workers ran, but the delivery tasks themselves were serial.

The cleanest example is preparation: **44 orchestrator responses versus 43 delivery responses and 12 review responses**, for one task. Its orchestrator consumed 72,170 uncached input tokens; the delivery worker consumed 95,351; the reviewer consumed 58,555.

This is structurally encouraged by the current [orchestrate-phase skill](<C:/Users/keech/Documents/FH Dev Tooling/.agents/skills/orchestrate-phase/SKILL.md:31>): “One worker, one task.” Its direct implementation allowance is only “a single file, no new behaviour, no new acceptance criterion.” Serial delivery is therefore outside the normal orchestrator role even when it already understands the task.

**Proposed change:** choose execution mode from the existing phase plan. When only one delivery task can run, let the phase agent invoke the delivery procedure itself, retain task ownership through corrections, and obtain a separate review of the exact candidate. For related serial successors, retain useful context and refresh the new task and owner comments. Use delivery workers when there are at least two independent ready tasks, or when a stated capability/isolation benefit warrants the extra agent.

Keep each task's acceptance criteria, evidence and review separate. Direct delivery does not authorize self-review, additional phases, or external actions. When a planned parallel group becomes ready, switch to coordination. This changes who delivers; it does not widen the planner's groups.

**2. Empty polling is measurable, and the instructions conflict**

The roots made **109 agent waits; 79 timed out without a message (72.5%)**. Of these empty waits, 78 requested 60 seconds and one requested 10 seconds. The model responses issuing those 79 waits consumed:

| Input | Cached input | Uncached input | Output |
| ---: | ---: | ---: | ---: |
| 6,038,576 | 6,004,224 | 34,352 | 5,215 |

These are the measured responses that issued waits which later timed out. They are not the cost of waiting itself, nor a promise that every response disappears under another design. They show why repeated wakeups matter even with a 99.43% cache hit rate for this subset. The waiting interval is not saved delivery time: the worker still has to finish.

The [skill](<C:/Users/keech/Documents/FH Dev Tooling/.agents/skills/orchestrate-phase/SKILL.md:41>) says “minutes, not seconds” and “Never narrate a timeout.” However, all three session headers contain higher-priority host instructions to avoid waits longer than 60 seconds and to provide commentary within 60 seconds. See [the foundations session header](<C:/Users/keech/.codex/sessions/2026/09/05/rollout-2026-09-05T15-32-36-01a0700d-eef1-78b0-949c-b573deae12f2.jsonl:1>).

**Proposed change:** remove the idle coordinator for serial delivery first. For parallel work, prefer a host-supported event wait that resumes on a worker checkpoint, completion, blocker or user input. Align the host's progress-update policy with passive waiting if that layer is configurable. A repository instruction demanding longer waits cannot override the host rule. While that limit remains, avoid additional status queries and repetitive commentary after empty waits; do not claim the local skill alone can eliminate wakeups.

**3. The latest run's biggest correction followed a document-transport failure**

The contract worker first produced a **43,410-character document with seven parseable JSON blocks**. Publication failed with “The filename or extension is too long.” It then published a **23,412-character version with three JSON blocks**. Review blocked acceptance on three issues: incomplete examples, a missing field-label rule, and incomplete version-2 record/hash shapes.

The first delivery turn took **21.0 minutes**. The correction turn took **30.9 minutes**, followed by **2.6 minutes** of re-review. The correction alone occupies roughly 46% of the parent's 66.6-minute elapsed run. It is not valid to attribute all correction time to the argument limit: the evidence establishes the sequence and missing content, not that the original longer draft would have passed review.

Sources: [original size and JSON checks](<C:/Users/keech/.codex/sessions/2026/09/05/rollout-2026-09-05T15-35-55-01a07010-f702-74c3-b965-28b0c3eedcc2.jsonl:212>), [failed publication](<C:/Users/keech/.codex/sessions/2026/09/05/rollout-2026-09-05T15-35-55-01a07010-f702-74c3-b965-28b0c3eedcc2.jsonl:219>), [shortened version](<C:/Users/keech/.codex/sessions/2026/09/05/rollout-2026-09-05T15-35-55-01a07010-f702-74c3-b965-28b0c3eedcc2.jsonl:246>).

**Proposed change:** add a supported content-file or stdin route to the Backlog document interface. Until then, split long documents before publication while preserving complete schemas/examples. Validate required case coverage before handoff, in addition to JSON syntax and documentation links. Do not shorten required content to fit transport. This is likely a larger latency opportunity for foundations than coordinator token trimming.

Independent review should stay: it caught those contract omissions and also caught the release installer's missing credential launcher, which the package smoke test had missed.

**4. Repeated discovery is narrower than the original concern suggests**

The root contexts grew from approximately **32–34k tokens initially to 65–97k at completion**, with **zero root compactions**. Each root explicitly read doc-02, doc-03 and doc-08 once. The latest root also read doc-04 and doc-07 once. The logs do not support a claim that the orchestrator continually reread all governance documents.

Task views did repeat: the roots invoked views of the active child 4 times in preparation, 8 times for the release build task, and 7 times for the foundations contract. Some were already projected to the latest comment or selected fields. Many followed handoffs, reviews or status changes, so they are not all redundant reads.

There is avoidable discovery across roles: the preparation reviewer tried unsupported `doc view --json` four times in one batch; the publication worker later made the same mistake once. The publisher also rediscovered the sandbox's GitHub access problem after the root had already found an authenticated working route.

**Proposed change:** put a compact, factual environment note in dispatch: accepted SHA/worktree, valid Backlog command forms, installed dependency state, and the applicable access route. This is operational information, not a transferable permission grant. Read task changes and the latest verdict after checkpoints; reread full source documents only when changed or needed. Preserve independent reviewers' access to authoritative evidence.

Four child spawns inherited history and three started without it. Their first input sizes were approximately 35.8–38.5k tokens, and some already had cached input. That is not a controlled comparison proving that either fork mode is cheaper. Avoid prescribing fresh workers or full-history forks on token-count intuition alone.

**5. Eager preparation was unused in this run, but overlapped useful work**

The foundations root created and installed dependencies for three future implementation worktrees before the contract was accepted. The interval from creating the first future worktrees to verifying the restarted board was **8.3 minutes**, concurrent with contract authoring. All three were unused when the user later requested stopping after the first task.

This was within the original four-task authorization and was not eight minutes of added critical-path delay. It did leave three worktrees on the pre-contract baseline, which the closing record says must be advanced and preflighted before later dispatch.

**Proposed change:** prepare only the next ready group by default. Prewarm gated worktrees only when dispatch is likely and the setup benefit warrants it; record the prerequisite revision refresh. Once dependency setup is reusable, avoid repeating environment investigation at every dispatch.

**Recommended implementation order and proof**

1. Amend the Switchflow template and FH's installed orchestration/delivery contracts together to allow serial direct delivery with independent review. Start the serial runner on the lowest capability adequate for the whole task; do not assume moving work from Sol to Astra automatically saves money.
2. Fix long-document transport and retain complete acceptance examples. Record the valid CLI syntax so future workers do not rediscover it.
3. Resolve the host/skill waiting conflict where configurable; otherwise use serial direct delivery to remove the largest source of idle coordination and keep parallel waits as quiet as the host allows.
4. Defer speculative worktree setup. Make documentation-only phase gates proportional: preparation ran all 534 tests, taking 35.9 seconds in the test runner. That is a smaller opportunity and was required by the recorded phase gate, not worker noncompliance. Re-running the release suite after the launcher correction was justified by the changed candidate.

Compare the next several similar serial tasks with this baseline using total tree uncached input, cached input, output, model, active elapsed time, first-review acceptance and correction count. Prefer matched small tasks or isolated replays over comparing different phases. Keep the change if coordination responses fall without worse review outcomes and total model-weighted cost/latency improves. No exact savings percentage is established by these observational runs.

**Accounting and reproduction**

Counts come from unique `token_usage_record.response_id` entries attributed to each thread, not repeated cumulative counters. Each thread's sum reconciles with its final recorded `thread_token_usage`. One contract-worker compaction causes the legacy token-count snapshot to differ; the per-response records and final thread aggregate agree and are used here. Reasoning output is included within output, not added again. Approval guardian agents and this audit are excluded. Response counts measure model responses, not user turns or repository commands.

Uncached input is input minus cached input; all sampled cache-write counters are zero. Cached tokens still have a distinct cost, and prefix reuse depends on matching context. [Official OpenAI prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) supports separating those categories. The logs do not provide a reliable account-charge or subscription-quota conversion, so this review does not infer dollars or percentage of plan allowance from raw token volume.

Run [inspect_runs.py](<C:/Users/keech/Documents/Switchflow/analysis/fh-orchestration-2026-09-05/inspect_runs.py>) followed by [measure.py](<C:/Users/keech/Documents/Switchflow/analysis/fh-orchestration-2026-09-05/measure.py>) with Python. Both read the local session logs; they only write audit artifacts beside the scripts. [metrics.json](<C:/Users/keech/Documents/Switchflow/analysis/fh-orchestration-2026-09-05/metrics.json>) contains the compact measurements, source paths and empty-wait line references.
