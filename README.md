# Switchflow

A governance layer for agent-assisted development. It starts with a simple claim. Intelligence is cheap. Context is not.

Coding agents are capable and easy to start. When work lives only in a conversation, a new agent must reconstruct it. Repeated history increases input volume, but caching and compaction affect the cost; a longer session is not automatically more expensive than restarting.

This system keeps durable state in the repository. Plans go on the board. Decisions go in the docs. Progress goes on task records. A new agent can start cold, read the relevant files, and get to work.

I built this for one person directing several agents on a codebase they care about. That person wants to approve the work before it starts, reviews the result, and pays the token bill. This is not a team process or a CI system. It is a way for one owner to manage work without becoming buried in agent transcripts.

## What it assumes

- The board is the record. If something still matters after an agent exits, write it down. Do not leave it buried in a reply.
- Each role reads only what it needs. The role definition says what it may read and what it must ignore. Those limits are intentional.
- A milestone ends where I can judge the result. Phases divide work for the agents. Milestones give me something I can accept or reject.
- Fixing a bad plan is cheaper than fixing bad code. A correction before implementation costs a few hundred tokens. The same correction after implementation may waste the whole attempt.
- Workers finish their assigned task and hand it off. Orchestrators checkpoint each phase and may retain useful context for another authorized phase. Restart when context becomes stale or crowded.

## What I do

1. Say what I want. `intake` asks questions until the intent is clear, then writes a scope contract. This is the cheapest point to remove ambiguity.
2. Approve the plan. `plan-milestone` turns the contract into phases and board tasks. Each task gets a risk class and a required evidence set. I review the board, not a transcript.
3. Run a phase. Invoke `orchestrate-phase` and leave it alone.
4. Accept the milestone. The result should be usable enough that I can try it and give real feedback.

Between steps 2 and 3, changing my mind is cheap. Once step 3 starts, changing direction costs tokens and discarded work. That is why step 1 exists.

## What the agents do

`orchestrate-phase` delivers serial tasks directly and coordinates workers for planned parallel groups. It retains useful context across related serial tasks, refreshes each task and owner comments, and keeps separate evidence and independent review for every candidate. Delegated workers confirm a three-line approach before implementation; direct delivery uses the same scope check without a self-confirmation wait.

The orchestrator uses event waits within host limits and avoids redundant status reads or unchanged updates when the host permits quiet waiting. Serial successors can reuse the phase agent after acceptance; delegated workers remain scoped to one task, with review corrections returning to the author. Delegation for a serial task needs a stated capability or isolation benefit.

`deliver-task` completes one task and returns an envelope with the result. `review-task` reads the diff independently and returns a verdict. `create-human-task` records work that only I can do, such as supplying a credential, creating an account, or making a decision. Planning identifies those tasks up front, so they do not stop the agents halfway through.

Prepare the next ready group; prewarm gated worktrees only for a stated setup benefit. At the phase gate, Documentation-only work uses applicable document and board checks plus diff review. Runtime or operational changes require the repository suite on the integrated candidate, where conflicts between tasks become visible. The cleanup process removes merged branches when the result is certain. If anything is unclear, it reports the branch and leaves it alone.

Work that costs more than expected goes into the friction log. The log is for me. Delivery agents never read it.

Finally, the orchestrator records what the next phase needs. Another phase still requires authorization, but may reuse the same focused context. Compaction or a fresh context is appropriate when capacity or relevance requires it; without compaction, checkpoint and hand off before context is exhausted.

## What it imports

In an imported project, run `.\.switchflow\scripts\backlog.ps1 flow` for worker queues, separate coordination parents, blocker notes, and recently updated records. Add `--json` for structured output. Backlog needs definition; Blocked is prepared work waiting on a named prerequisite; Ready passes the full readiness gate. Planning and orchestration maintain these statuses without granting execution authority.

- `AGENTS.md` repository instructions.
- An empty Backlog.md board with a fixed status lifecycle.
- Durable Backlog documents and native decision records.
- A project profile for the few values each repository must own.
- Six agent skills for scope intake, milestone planning, phase orchestration, delivery, review, and human-owned work.
- Pinned Backlog.md tooling and documentation validation under `.switchflow/`.

It does not import tasks, milestones, roadmaps, product decisions, application dependencies, credentials, or deployment configuration.

The template is intentionally isolated from the projects that produced it. Changes can be tested here and imported into a disposable repository before they reach ongoing work.

Start with [SETUP.md](SETUP.md). The [role contracts](docs/role-contracts.md) define what each role reads, writes, and must not read, and record the measured cost those limits come from. The [architecture and delivery model](docs/architecture.md) defines the module boundaries and dependency direction, and [Skills](docs/skills.md) indexes the six imported skills. The [workflow diagrams](<template/backlog/docs/doc-06 - Workflow-diagrams.md>) show how artifacts move between roles.

Known defects and outstanding work are tracked in [BACKLOG.md](BACKLOG.md).

## Status

Switchflow is at version `0.2.1` and is still experimental. I have measured some parts of it. Others are working assumptions that I have not proved yet, and the docs say which is which.

Test template changes with a fresh import, review the rendered files, and only then update an active project deliberately using the [manual update procedure](SETUP.md#update-an-existing-project). Automatic upgrades remain out of scope.
