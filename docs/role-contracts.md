# Role contracts and the artifact pipeline

This document defines role boundaries and their rationale. The eight skills implement these roles; governing Backlog documents own shared procedures and policy. Scope checkpoints and revisions live in doc-09.

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
| How every agent writes | `AGENTS.md` | Is it identical for every role? |

`AGENTS.md` is shared context on agent invocations. Keep it concise and stable so it can be reused where caching is available. Content earns a place in it only by one of the last two tests: an agent is unsafe without it, or it holds for every role and would otherwise be repeated in each skill.

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
| Intake checkpoints, scope baselines and shared revision procedure | `doc-09` |
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
| Intake and revision discovery | Unmilestoned task labelled `discovery` and `coordination`; optional discovery children. Current checkpoint in description, answers in comments. |
| Previous scope baseline | Exact record snapshot under `backlog/archive/milestone-revisions/<id>/`, written before an adapter replacement. |
| Phase | A native parent task whose children are created with `--parent`, carrying a board-unique phase label and the `coordination` label. Carries the phase plan in its description. |
| Phase record | A comment on the phase parent task. |
| Worker task | A child task carrying a context map, assigned to the milestone and labelled with its phase. |
| Friction entry | `.switchflow/friction/<milestone-id>.md`, append-only, outside the board. |

Verified against Backlog.md 1.50.1:

- `milestone add --description` accepts multi-line Markdown and stores it verbatim under a `## Description` heading, so the scope contract fits. A literal `\n` is stored as text, so the description must carry real newlines.
- Native CLI/MCP have no milestone description edit. Switchflow adds `milestone view` and `milestone edit --input-file` through its wrapper, preserving identity and prior content with an expected-revision check. Native rename remains available. The adapter protocol and recovery limits live in doc-09.
- `task create --parent` produces real hierarchical children (`TASK-1` / `TASK-1.1`) with `parent_task_id` in frontmatter. Phase parents are native, not a convention.
- Labels are not restricted to those declared in `backlog.config.yml`, so board-unique phase labels work without configuration changes.

The accepted contract sits on the milestone; discovery is editable before acceptance, and phase parents hold delivery plans. A frozen contract is an accepted baseline that the owner can deliberately supersede without losing its identity or history.

The phase parent is a tracking artifact. It is never promoted to Ready for worker execution, consistent with the coordination-parent rule in `doc-07`.

## 3. Role contracts

Each role declares what it must **not** read. That field is load-bearing: it is what keeps intake unbiased, the orchestrator bounded, and review independent.

### intake

| Field | Value |
| --- | --- |
| Purpose | Establish or resume scope discovery, then freeze a contract. |
| Trigger | Owner, explicitly, with a goal or existing intake ID. |
| Reads | Owner input, doc-01, doc-02, doc-09, relevant durable documents and overlapping milestones; its own discovery records and bounded investigation findings. |
| Must not read | Broad source implementation, delivery tasks or diffs. Targeted research runs as a separate investigation and returns decisive evidence. |
| Produces | Editable intake checkpoint, optional linked discovery questions, confirmed terminology/decisions and the accepted milestone contract. |
| Exit condition | Checkpoint is resumable; final closure requires owner acceptance and readback of the saved contract. |
| Model and effort | Frontier reasoning with focused context; checkpoint as relevance and capacity require. |
| Authority | Maintains its discovery records, bounded local fact-finding and new milestone creation under doc-03/doc-09. Existing frozen contracts change through edit-milestone. No product implementation. |

Intake keeps the product discussion above implementation detail. Bounded research findings can test assumptions without pulling a repository-wide implementation model into the interview. Its checkpoint records unresolved state from the first session, not just the final contract.

The contract closes with a UAT definition stating what the owner will do to judge the milestone. This tells the planner where to stop. Multi-session discovery has no measured cost advantage yet; its immediate proof is correct resumption without lost decisions.

### edit-milestone and edit-phase

Both roles use the single revision procedure in doc-09. They read the accepted contract, relevant discovery, affected phase/task records and owner comments, active assignments and targeted impact evidence. Neither reads the friction log or unrelated implementation history. Both produce an explained revision, application checkpoint, reconciled board and current scope baseline; neither implements or grants new execution authority.

`edit-milestone` applies owner-authorized changes to outcome, exclusions, decisions or UAT while preserving milestone identity and prior scope. Its exit condition includes reconciliation of affected phase plans and acceptance work. `edit-phase` exercises existing planning authority for tasks, dependencies, sequencing, groups and gates within the accepted outcome. Changed product obligations return to `edit-milestone`. Both coordinate affected active work and preserve completed evidence.

### plan-milestone

| Field | Value |
| --- | --- |
| Purpose | Turn a frozen scope contract into ordered phases and ready tasks. |
| Trigger | Owner, after freezing the scope contract. |
| Reads | Scope contract, durable documents, the repository, existing tasks, prior phase records, the readiness gate in `doc-07`. |
| Must not read | The friction log. |
| Produces | Phase coordination parents carrying the phase plan and its dispatch groups; worker tasks with context maps; the closing UAT task. |
| Exit condition | Changed tasks are classified Backlog, Blocked or Ready under the full gate; phases name their scope revision, integrated gate and groups; closing UAT matches the contract. |
| Model and effort | Frontier, maximum effort, high token budget. This is where the repository is read, once. |
| Authority | Board mutations within the named milestone. No code. |

The planner owns readiness classification and respects settled scope. If the contract proves wrong, it checkpoints evidence for edit-milestone and uses intake only for unresolved owner decisions. Planning resumes against the accepted revision.

Every worker task carries a context map. It is the planner's highest-value output and the reason its repository read is not wasted: it records what the next role would otherwise rediscover. The map is exempt from the task description word limit and is advisory rather than binding, so it never becomes a competing contract.

Dispatch grouping belongs here for the same reason. The planner reads across the repository and writes the context maps. The orchestrator reads those maps and targeted details for dispatch and checkpoints, but does not repeat that repository-wide planning pass. It may collapse a group when execution evidence requires it; widening a group goes back to planning.

### orchestrate-phase

| Field | Value |
| --- | --- |
| Purpose | Dispatch, checkpoint, integrate, and close one phase. |
| Trigger | Owner, explicitly, per phase. |
| Reads | Milestone and phase records; dispatch groups; task identifiers, statuses, dependencies, risk classes and context maps; worker plans and envelopes; review verdicts. Targeted task detail for dispatch, checkpoints, blockers or contested verdicts; affected diff and file sections for permitted conflict resolution or corrections. |
| Must not read | Worker reasoning beyond the required plan and factual handoff; unrelated repository content. Targeted implementation reads do not replace independent review. |
| Produces | Worker briefs, checkpoint decisions, integration, phase record, friction entries, cleanup trigger. |
| Exit condition | Every phase task is Done or explicitly deferred, the gate condition is verified, cleanup has run and its exceptions are resolved, and the phase record and friction entries are written. |
| Model and effort | Frontier, maximum effort, focused context checkpointed each phase. |
| Authority | Dispatch, integration into the milestone branch, acceptance of independently reviewed work, scripted cleanup. Not product decisions, pushing, history rewriting, or unscripted branch deletion. |

Each phase ends with a durable record. A separately authorized related phase may use the same orchestrator when its context remains focused and useful; refresh board state and owner comments before dispatch. Restart when context is stale, crowded or irrelevant, not automatically at every phase boundary. Ending a turn does not clear context.

Use host compaction when available. Without it, checkpoint before exhausting context, including mid-phase: active task and worker IDs, branches/worktrees, integration SHA, completed actions, pending reviews, blockers and the next step. That handoff must support continuation without duplicated work. Returning control for an owner decision does not require discarding the context.

Its highest-value action is the pre-implementation checkpoint. A worker returns a three-line plan before implementing; the orchestrator confirms or corrects it. Roughly two hundred tokens prevent a wrong-direction implementation costing tens of thousands.

**Correcting against current scope.** Execution evidence can require task amendments within the accepted contract; direct-delivery corrections remain with the phase agent and delegated corrections return to their author. Material scope changes follow doc-09 before affected dispatch resumes. Independent review remains required for material authored changes.

That bound replaced a prohibition on orchestrators invoking the implementation skill. The prohibition did not achieve its purpose: it blocked the structured path while leaving the orchestrator free to implement inline, so deviation happened without the delivery contract's discipline. Naming the bound is stricter than banning the skill.

**Reading beyond the envelope.** The worker's return value is bounded by its handoff contract. Additional reads need a concrete dispatch, checkpoint, blocker, contested-verdict or permitted implementation decision. Read only the relevant fields or sections. This is a behavioural limit, not a tool-enforced size limit.

### deliver-task

| Field | Value |
| --- | --- |
| Purpose | Implement one task. |
| Trigger | Orchestrator brief, or the owner directly. |
| Reads | The task and its context map; the files the map names; Delivery rules and applicable Risk and verification guidance in `doc-04`; the delivery loop in `doc-08`. Elevated and Critical tasks also read `doc-03`, `doc-07`, and the protected boundaries in `doc-04`. |
| Must not read | Other tasks, the milestone plan, the friction log, policy above its risk class. |
| Produces | A three-line pre-implementation plan, the diff, a handoff comment on the task, and a five-line return envelope. |
| Exit condition | Criteria checked, handoff written, task moved to Review, envelope returned. |
| Model and effort | Selected by risk class. Documentation-only and Standard use a smaller model; Elevated and Critical use a frontier model. |
| Authority | Its own branch or worktree and scoped commits. Never `main`, never another task. |

Policy loading is proportional to risk, so a typo fix does not pay a migration's policy tax. The risk class is already computed for verification, so using it to select the worker model is free.

**One worker, one task, then end it.** A worker ends at its handoff. The next logical task gets a new worker to keep scope and ownership separate. In the previous framework, five reused workers carried an estimated 175M input tokens attributed to reuse after their first completed handoff, across 43 follow-up assignments and 20 compactions. One session opened as a reconciliation audit, finished it at line 111, then absorbed two reviews and five separate implementations across 692 turns. These observations do not establish the cost of an equivalent run with fresh workers.

Repeated history increases input volume, but cached input, compaction and new-worker startup reads affect actual cost. One worker per task is a scope boundary; the measurements do not prove restarting is always cheaper or that spending grows quadratically with worker lifetime.

Corrections after review are part of the same task and stay with the same worker. A different task is a different worker.

### review-task

| Field | Value |
| --- | --- |
| Purpose | Produce an independent verdict on a fixed diff. |
| Trigger | Orchestrator, after a worker returns. |
| Reads | The task and its criteria; the fixed base, HEAD and diff; affected contracts; the review contract in `doc-08`; Delivery rules and applicable Risk and verification guidance in `doc-04`. |
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

The framework can become the project. New entry points must reuse shared procedures and artifacts rather than multiply competing versions of the same rules.

**If an artifact is written but never read by the next role, delete it.**

Apply this to the scope contract, the context map, the phase record, and the friction log after several milestones. Anything failing the test is removed rather than improved.

Two questions remain open against this design:

- **Model selection.** Whether the Codex subagent interface lets the orchestrator select a model per worker determines whether risk-based model selection is automatic or a documented owner action.
- **Envelope discipline.** Whether workers keep to the return contract and orchestrators limit additional reads to a concrete decision is behavioural and unmeasured.

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

Input volume attributed to possible sources of waste. These overlap and must not be summed; they are not measured savings from removing each cause.

| Cause | Volume | Nature |
| --- | --- | --- |
| Approval transcript replay | ~401M | Client configuration |
| Reusing finished workers | ~175M | Lifecycle rule |
| Short-timeout polling | ~113M | Tool parameter |
| Re-reads with no intervening change | ~28M | Missing context map |
| Test runs with no intervening change | ~9M | `doc-04` ambiguity |

These observations suggest where to investigate; they do not isolate the cost or benefit of orchestration or session reuse.

**Compare equivalent outcomes.** Evaluate fresh and reused orchestration contexts on comparable tasks. Record model and settings, cached and uncached input, cache writes where reported, output, actual cost when available, wall time, owner interventions and review returns. If cost is unavailable, label any price-weighted estimate and its assumptions. Total token volume alone cannot rank the alternatives.

**Approval replay warrants separate measurement.** Sixty-six sessions made zero tool calls across 3,798 turns and consumed 401M tokens — 23.4% of all volume — deciding whether to permit actions. That is roughly 105,000 input tokens per approval decision. This is the largest volume category listed, but its spend cannot be inferred without its cache breakdown and applicable pricing. Keep approval posture aligned with owner authorization; the volume figures do not justify weakening it.

**Choose context lifetime from evidence.** Matching prompt prefixes may be cached, so useful stable history can be inexpensive to reuse. Restarting or compacting can reduce cache reuse while also reducing input size; neither guarantees lower total cost. Preserve useful context and durable checkpoints, then restart when relevance or capacity warrants it. See [OpenAI's prompt caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching). Codex documents automatic compaction through `model_auto_compact_token_limit`, with model defaults when unset; hosts without compaction need an explicit handoff before the context fills. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
