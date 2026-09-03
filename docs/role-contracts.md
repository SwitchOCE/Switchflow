# Role contracts and the artifact pipeline

This document defines what each pillar of Switchflow owns, the contract each agent role works to, and the measured cost the design is built around. It is the specification the six skills implement: the skills carry the instructions, this document carries the boundaries and the reasons.

The diagrams are not repeated here. The artifact pipeline, the phase loop, and the status lifecycle live in the imported [workflow diagrams](<../template/backlog/docs/doc-06 - Workflow-diagrams.md>), so framework maintainers and imported projects read the same picture.

## 1. Content placement

Content is placed by lifetime and mutation rate, not by subject.

| Content | Home | Placement test |
| --- | --- | --- |
| True about the product, independent of any task | Backlog documents (`backlog/docs/`) | Would this still be true if the board were empty? |
| True about one unit of work, right now | Board (`backlog/tasks/`, `backlog/milestones/`) | Does it die when the task closes? |
| True about how work moves, across all tasks | One governing document | Is it policy rather than fact? |
| A repeatable multi-step procedure an agent runs | Skill (`.agents/skills/`) | Are the steps both non-obvious and repeated? |
| How the framework itself performed | Friction log (`.switchflow/friction/`) | Is it about the process rather than the product? |
| What every agent needs before it can act safely | `AGENTS.md` | Would an agent be unsafe without it? |

`AGENTS.md` is loaded on every agent invocation and is therefore the most expensive file in the repository per token. Content earns a place in it only by the last test.

### Where each concern lives

| Concern | Source of truth |
| --- | --- |
| Product profile, gates, approval posture, protected boundaries | `doc-02` |
| Lifecycle, roles, statuses, and authority | `doc-03` |
| Quality target, risk classes, and required evidence | `doc-04` |
| Documentation placement and proof | `doc-05` |
| Artifact flow and status diagrams | `doc-06` |
| Task shape, readiness, and owner input | `doc-07` |
| Delivery, Git, blockers, handoff, and review | `doc-08` |
| Implemented product behaviour and contracts | Backlog documents under `backlog/docs/` |
| Durable decisions and their rationale | Backlog decision records under `backlog/decisions/` |
| Active tasks, milestones, status, and comments | Backlog.md files under `backlog/` |
| Agent boundaries and repository commands | `AGENTS.md` |
| Repeatable agent workflows | `.agents/skills/` |
| Pinned governance tooling and deterministic checks | `.switchflow/` |

The board carries a second responsibility that is easy to underuse: it is the durable message bus between agent roles. Any state that must survive a context window belongs on the board rather than in an agent's history.

## 2. Board representation

| Concept | Representation |
| --- | --- |
| Milestone | Backlog.md milestone record. Carries the scope contract and the UAT definition. |
| Phase | A native parent task created with `--parent`, labelled `phase-N`. Carries the phase plan in its description. |
| Phase record | A comment on the phase parent task. |
| Worker task | A child task carrying a context map, assigned to the milestone and labelled with its phase. |
| Friction entry | `.switchflow/friction/<milestone-id>.md`, append-only, outside the board. |

Verified against Backlog.md 1.50.1:

- `milestone add --description` accepts multi-line Markdown and stores it verbatim under a `## Description` heading, so the scope contract fits. A literal `\n` is stored as text, so the description must carry real newlines.
- There is **no `milestone edit` or `milestone update`**. A milestone record is write-once through the CLI. That suits a contract frozen at intake, but it means intake must iterate in conversation and write once at the end. Revision after freezing means `milestone remove` followed by `milestone add`, which also touches task assignments.
- `task create --parent` produces real hierarchical children (`TASK-1` / `TASK-1.1`) with `parent_task_id` in frontmatter. Phase parents are native, not a convention.
- Labels are not restricted to those declared in `backlog.config.yml`, so `phase-N` labels work without configuration changes.

Because the milestone record is write-once and the phase parent is editable, the split follows the mutation rate: the frozen contract sits on the milestone, and everything revised during delivery sits on the phase parent.

The phase parent is a tracking artifact. It is never promoted to Ready for worker execution, consistent with the coordination-parent rule in `doc-07`.

## 3. Role contracts

Each role declares what it must **not** read. That field is load-bearing: it is what keeps intake unbiased, the orchestrator bounded, and review independent.

### intake

| Field | Value |
| --- | --- |
| Purpose | Convert a proposed goal into a frozen scope contract. |
| Trigger | Owner, explicitly, at the start of a milestone. |
| Reads | The owner. `doc-01`, `doc-02`, durable product documents. Existing milestone records for overlapping scope. |
| Must not read | Source code, tasks, diffs. |
| Produces | Scope contract, written into the milestone record. |
| Exit condition | The owner freezes the contract. Every material question is answered or explicitly deferred with a recorded default. |
| Model and effort | Frontier, maximum reasoning, deliberately low token budget. |
| Authority | Creates and updates the milestone record. No tasks, no code. |

Intake reads the durable documents but not the code by design. An intake agent holding tens of thousands of tokens of implementation detail anchors the owner's answers to what is cheap to build, and starts proposing solutions instead of interrogating intent. Durable documents are the correct abstraction level for informed questions.

Intake is the cheapest phase in total tokens and the most expensive per token. The scope contract closes with a UAT definition stating what the owner will do to judge the milestone. That makes the milestone boundary enforceable and tells the planner where to stop.

### plan-milestone

| Field | Value |
| --- | --- |
| Purpose | Turn a frozen scope contract into ordered phases and ready tasks. |
| Trigger | Owner, after freezing the scope contract. |
| Reads | Scope contract, durable documents, the repository, existing tasks, prior phase records, the readiness gate in `doc-07`. |
| Must not read | The friction log. |
| Produces | Phase coordination parents carrying the phase plan and its dispatch groups; worker tasks with context maps; the closing UAT task. |
| Exit condition | Every worker task passes the readiness gate, phases are ordered, each phase has a verifiable gate condition and a dispatch grouping, and the last task is the UAT task. |
| Model and effort | Frontier, maximum effort, high token budget. This is where the repository is read, once. |
| Authority | Board mutations within the named milestone. No code. |

The planner absorbs the readiness gate, so there is no separate clarification pass. It does not re-open questions the scope contract settled. If the contract proves wrong, the planner stops and returns to intake rather than deciding on the owner's behalf.

Every worker task carries a context map. It is the planner's highest-value output and the reason its repository read is not wasted: it records what the next role would otherwise rediscover. The map is exempt from the task description word limit and is advisory rather than binding, so it never becomes a competing contract.

Dispatch grouping belongs here for the same reason. Deciding what can run in parallel means knowing which files each task touches, and the planner is the only role holding that: it wrote the maps, and the orchestrator's read limit excludes the descriptions they live in. An orchestrator asked to judge fan-out at dispatch would be applying a test it cannot check, and would sequence everything. Grouping at plan time makes the decision where the evidence is and leaves the orchestrator an instruction it can execute.

### orchestrate-phase

| Field | Value |
| --- | --- |
| Purpose | Dispatch, checkpoint, integrate, and close one phase. |
| Trigger | Owner, explicitly, per phase. |
| Reads | Milestone record; the phase coordination parent, its phase plan and dispatch groups, and its prior phase records; task identifiers, statuses and dependencies for this phase; worker envelopes; review verdicts. |
| Must not read | Diffs, file contents, full task descriptions, worker reasoning. When a diff must be judged, it dispatches a reviewer. |
| Produces | Worker briefs, checkpoint decisions, integration, phase record, friction entries, cleanup trigger. |
| Exit condition | Every phase task is Done or explicitly deferred, the gate condition is verified, cleanup has run and its exceptions are resolved, and the phase record and friction entries are written. |
| Model and effort | Frontier, maximum effort, context bounded by one phase. |
| Authority | Dispatch, integration into the milestone branch, acceptance of independently reviewed work, scripted cleanup. Not product decisions, pushing, history rewriting, or unscripted branch deletion. |

The orchestrator exits at the phase boundary rather than continuing into the next phase. This is the compaction mechanism: durable state moves to the board and the next context starts cold.

Its highest-value action is the pre-implementation checkpoint. A worker returns a three-line plan before implementing; the orchestrator confirms or corrects it. Roughly two hundred tokens prevent a wrong-direction implementation costing tens of thousands.

**Amending rather than implementing.** The orchestrator amends a task and re-dispatches when execution evidence shows the plan was wrong. That is the safety net: a frontier model with cross-task visibility correcting a planner miss, exercised by re-briefing rather than by implementing. Direct implementation is bounded to a single file, no new behaviour, and no new acceptance criterion.

That bound replaced a prohibition on orchestrators invoking the implementation skill. The prohibition did not achieve its purpose: it blocked the structured path while leaving the orchestrator free to implement inline, so deviation happened without the delivery contract's discipline. Naming the bound is stricter than banning the skill.

**Reading beyond the envelope.** The worker's return value is structurally bounded, because whatever the subagent's final message contains is what enters orchestrator context. What is not structurally enforced is whether the orchestrator then fetches the task detail anyway. That is governed by a trigger — a blocking issue in an envelope, or a contested verdict — rather than by a size limit, and it is the weakest guarantee in the design.

### deliver-task

| Field | Value |
| --- | --- |
| Purpose | Implement one task. |
| Trigger | Orchestrator brief, or the owner directly. |
| Reads | The task and its context map; the files the map names; `doc-04` at the task's risk class; the delivery loop in `doc-08`. |
| Must not read | Other tasks, the milestone plan, the friction log, policy above its risk class. |
| Produces | A three-line pre-implementation plan, the diff, a handoff comment on the task, and a five-line return envelope. |
| Exit condition | Criteria checked, handoff written, task moved to Review, envelope returned. |
| Model and effort | Selected by risk class. Documentation-only and Standard use a smaller model; Elevated and Critical use a frontier model. |
| Authority | Its own branch or worktree and scoped commits. Never `main`, never another task. |

Policy loading is proportional to risk, so a typo fix does not pay a migration's policy tax. The risk class is already computed for verification, so using it to select the worker model is free.

**One worker, one task, then end it.** A worker ends at its handoff. The next logical task gets a new worker, even when the finished worker already holds relevant context. This is the largest measured waste in the previous framework: five reused workers carried an estimated 175M excess input tokens after their first completed handoff, across 43 follow-up assignments and 20 compactions. One session opened as a reconciliation audit, finished it at line 111, then absorbed two reviews and five separate implementations across 692 turns.

Reuse is tempting because the context is already loaded and loading it again looks wasteful. The accounting runs the other way. Accumulated context is re-sent on every subsequent turn, so a worker's cost grows with the square of its lifetime, while a fresh worker's startup read is paid once. Cheap context is context you do not send again.

Corrections after review are part of the same task and stay with the same worker. A different task is a different worker.

### review-task

| Field | Value |
| --- | --- |
| Purpose | Produce an independent verdict on a fixed diff. |
| Trigger | Orchestrator, after a worker returns. |
| Reads | The task and its criteria; the fixed base, HEAD and diff; affected contracts; the risk class in `doc-04`. |
| Must not read | The worker's reasoning beyond the factual handoff. |
| Produces | A verdict, a five-line envelope to the orchestrator, and full findings as a task comment. |
| Exit condition | Verdict recorded. |
| Model and effort | At least as capable as the worker that produced the change. |
| Authority | Read-only unless status or acceptance authority is separately granted. |

The reviewer judges the artifact, not the argument. Reading the worker's rationale converts independent review into agreement. Reviewing is harder than writing, so the reviewer is never the weaker model.

Blast-radius analysis is an escalation section within this role rather than a separate skill, and it is gated by a declaration rather than by permission: every verdict states which trigger fired, or that none did. Requiring the declaration is what makes the gate real. A trigger phrased only as permission reads as an invitation and gets run on every task, which buys correlated findings from the same model at double the cost instead of independent coverage.

### create-human-task

| Field | Value |
| --- | --- |
| Purpose | Define work only a person can do. |
| Trigger | Any role reaching a human-only dependency; the planner always, at milestone end. |
| Reads | The human-task section of `doc-07`; the UAT definition in the scope contract. |
| Must not read | Source code. |
| Produces | A `Human`-assigned task with numbered steps and report-back evidence. |
| Exit condition | Task created, linked as a dependency, board check passes. |
| Model and effort | Small. This is templating. |
| Authority | Creates one task. |

This role is load-bearing rather than occasional, because every milestone closes with a UAT task. Naming human-only work during planning is what stops an orchestration run halting on it later.

## 4. Cleanup

Cleanup splits by whether judgement is required.

**Deterministic cleanup is a script**, `cleanup-phase.ps1`, run at the phase boundary. Its predicate: for each task in this phase whose status is Done, whose branch matches the task-branch pattern, and which Git reports fully merged into the integration branch, delete the branch and remove the worktree. No reasoning, no orchestrator tokens.

**Exceptions belong to the orchestrator.** An unmerged branch on a Done task, a worktree with uncommitted changes, or a branch whose task was archived each need a decision. These are few, and the script reports them rather than forcing past them.

This is a safety improvement rather than a relaxation. A blanket rule requiring explicit authority for any branch deletion is too broad to grant as a standing permission, so cleanup never runs and residue accumulates. A narrow standing grant covering exactly the predicate above is both safer and effective. It is recorded in `doc-03`, and general branch deletion remains separately authorized.

## 5. The friction log

Findings divide by lifetime. **Task-level findings** — bad scope, a wrong dependency, an inaccurate context map — belong on the task, where the blocker record in `doc-08` already asks whether readiness could have detected the obstruction. **Framework-level findings** — the readiness gate misses a class of problem, workers keep rediscovering the same setup, a policy is ambiguous — are not product knowledge and outlive their task, so they go to `.switchflow/friction/<milestone-id>.md`. That directory's README owns the format and the rules.

The orchestrator writes entries at the phase boundary, in the same action that writes the phase record. It is the only role that sees across tasks, so it is the correct author, and the marginal cost is near zero. No delivery role reads the log, so it costs nothing in the hot path.

## 6. Governing test

The framework can become the project. Six roles, six artifacts, and a learning log are already close to the limit of what is worth carrying.

**If an artifact is written but never read by the next role, delete it.**

Apply this to the scope contract, the context map, the phase record, and the friction log after several milestones. Anything failing the test is removed rather than improved.

Two questions remain open against this design:

- **Model selection.** Whether the Codex subagent interface lets the orchestrator select a model per worker determines whether risk-based model selection is automatic or a documented owner action.
- **Envelope discipline.** The return size is structurally enforced by dispatch. Whether the orchestrator honours the no-further-fetch trigger is behavioural and unmeasured.

## 7. Cost baseline

Taken from 326 Codex session logs for one project running the previous framework, 2026-08-26 to 2026-09-02. Cumulative input includes cached tokens, which bill at a discount, so these are volume figures rather than spend.

| Measure | Value |
| --- | --- |
| Sessions | 326 |
| Cumulative tokens | 1,717,974,119 |
| Cached share of input | 96.8% |
| Output share of total | 0.3% |
| Median session | 1,069,491 |
| p99 session | 82,825,074 |
| Longest session | 118.8 hours |

Waste by cause. These overlap and must not be summed.

| Cause | Volume | Nature |
| --- | --- | --- |
| Approval transcript replay | ~401M | Client configuration |
| Reusing finished workers | ~175M | Lifecycle rule |
| Short-timeout polling | ~113M | Tool parameter |
| Re-reads with no intervening change | ~28M | Missing context map |
| Test runs with no intervening change | ~9M | `doc-04` ambiguity |

Three conclusions follow.

**Orchestrator-first delegation is not the cost.** No entry above is caused by having an orchestrator. Orchestration sessions were large because the orchestrator kept workers alive that should have ended and polled waits that should have blocked, and both are instructions rather than architecture. The one-worker-one-task rule, the wait rule, the context map, and the task/phase evidence split address the second through fifth entries directly.

**The largest cost is outside the framework entirely.** Sixty-six sessions made zero tool calls across 3,798 turns and consumed 401M tokens — 23.4% of all volume — deciding whether to permit actions. That is roughly 105,000 tokens per approval decision, because each decision replays the accumulated transcript. No framework change reaches this. It is a client setting, and it is worth more than every rule in this document combined. What Switchflow can do is make the cost visible, which is why approval posture is a `doc-02` concern recorded alongside the verification commands it must stay aligned with.

**Longevity is the expense.** The pattern behind the first three entries is that things are kept alive because ending them feels wasteful — workers, sessions, approval contexts. Under per-turn cumulative billing, early termination is the optimisation. Every phase-exit, worker-lifecycle, and wait rule in this document is one application of that.
