# Switchflow

Switchflow is a reusable, repository-local project governance system for Codex-assisted work. It packages a Backlog.md task and documentation workspace, risk-based engineering standards, and focused agent skills without carrying product plans or application choices between projects.

The template is intentionally isolated from the projects that produced it. Changes can be tested here and imported into a disposable repository before they reach ongoing work.

## What it imports

- `AGENTS.md` repository instructions.
- An empty Backlog.md board with a fixed status lifecycle.
- Durable Backlog documents and native decision records.
- A project profile for the few values each repository must own.
- Ten agent skills for task shaping, delivery, review, orchestration, quality, and stakeholder work.
- Pinned Backlog.md tooling and documentation validation under `.switchflow/`.

It does not import tasks, milestones, roadmaps, product decisions, application dependencies, credentials, or deployment configuration.

Start with [SETUP.md](SETUP.md). The framework and skill boundaries are described in [Governance system](docs/governance-system.md) and [Skills](docs/skills.md). The [architecture and delivery model](docs/architecture.md) defines the modular target and dependency direction. The [workflow diagrams](docs/workflow-diagrams.md) show the framework's key decisions at a glance.

The dated [current-state assessment](docs/current-state-assessment.md) records the verified baseline, known defects, and maturity gaps against the framework's goals.
Maintainer decisions and outstanding work are tracked in [BACKLOG.md](BACKLOG.md).

## Status

Switchflow is at version `0.2.0`. Treat it as an experimental system: test template changes with a fresh import, review the rendered files, and only then update an active project deliberately. Automatic upgrades remain out of scope.
