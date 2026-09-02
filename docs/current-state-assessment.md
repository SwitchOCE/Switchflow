# Current-state assessment

- **Assessment date:** 2026-09-01
- **Assessed version:** 0.1.0, uncommitted working tree

> This is the initial point-in-time assessment. User dispositions, current backlog status, and fixes made after the assessment are recorded in [BACKLOG.md](../BACKLOG.md). In particular, SF-01 was rejected; SF-03, SF-04, and SF-11 were resolved; and the superseding single-quality-target issue for SF-05 was later resolved.

> **Historical note:** This assessment records the pre-migration state. Switchflow later replaced the imported MkDocs site with Backlog.md documents; MkDocs findings below remain as historical evidence rather than current behavior.

## Scope

This assessment compares the repository with its intended role:

- a default project workflow for one developer working with software-development agents;
- a framework that can be improved using evidence from its own operation; and
- a system that may later be shared with other users.

The assessment covers the repository as it exists now, a normal disposable import, malformed-but-accepted importer inputs, the board lifecycle, documentation generation, and rendered skill structure. It does not assess the quality of an application built with Switchflow over a long period because the repository contains no recorded trial corpus or operating history.

## Summary

The design has a coherent separation between durable documentation, active tasks, agent instructions, skills, and isolated tooling. A normal fresh import works, the basic board and documentation checks run, and all ten rendered skills are structurally valid.

The current repository is not yet a dependable default or a measurable self-improving framework. Two routine operations are demonstrably broken: completing a dependency makes a valid Ready task fail `doctor`, and accepted project names can corrupt the generated YAML or silently change identity. The quality-phase contract is internally inconsistent. The framework repository also does not use its own workflow and has no repeatable evaluation or performance baseline, so changes cannot yet be compared objectively.

No issue is classified as Critical. The High findings should be resolved before Switchflow is used as the default for important work.

## What was verified successfully

- A normal disposable import completed without unresolved template tokens.
- `npm --prefix .switchflow ci --ignore-scripts` installed the pinned Backlog.md dependency.
- The empty board passed `backlog.ps1 doctor`.
- The imported wiki passed `mkdocs.ps1 build --strict` with `mkdocs-material==9.7.7`.
- Every PowerShell file parsed and both JavaScript modules passed `node --check`.
- All ten rendered skills passed the Codex skill validator when Python UTF-8 mode was enabled.
- The repository locations for imported `AGENTS.md` and `.agents/skills` match current Codex discovery rules. See the official OpenAI documentation for [AGENTS.md](https://developers.openai.com/codex/guides/agents-md) and [skills](https://developers.openai.com/codex/skills).

## Prioritized findings

| ID | Severity | Finding | Goal affected |
| --- | --- | --- | --- |
| SF-01 | High | The framework does not use its own workflow and has no committed baseline. | Improve the framework safely |
| SF-02 | High | There is no repeatable evaluation or performance-observation loop. | Observe the effect of changes |
| SF-03 | High | Completing a dependency makes a valid Ready task fail the board check. | Dependable agent workflow |
| SF-04 | High | Valid importer inputs can corrupt generated YAML or silently change project identity. | Safe reusable defaults |
| SF-05 | High | The project-phase and VAPS contract is contradictory and incomplete. | Consistent agent decisions |
| SF-06 | Medium | The board check does not enforce most of the documented lifecycle. | Workflow integrity |
| SF-07 | Medium | Improvements cannot be applied safely to an existing Switchflow project. | Framework evolution |
| SF-08 | Medium | The runtime is Windows-specific, but compatibility and prerequisites are not declared. | Reuse and later sharing |
| SF-09 | Medium | The workflow launcher can report unrelated services as ready. | Reliable daily operation |
| SF-10 | Medium | Import is non-transactional and assumes `main` for repository edit links. | Safe setup and recovery |
| SF-11 | Low | Skill validation is not exposed as a repository command and fails under the tested Windows default encoding. | Repeatable maintenance |
| SF-12 | Low | The repository is not ready for external distribution or contribution. | Future sharing |

## Findings

### SF-01 — The framework does not use its own workflow and has no committed baseline

The repository exports `AGENTS.md`, `.agents/skills`, `.switchflow`, a board, and project documentation only from `template/`. Those assets are not present at the repository root, so Codex working on Switchflow itself does not load the exported instructions or skills and cannot use the exported board. This contradicts the practical need to test the framework through normal use while improving it.

The Git repository also reported `No commits yet on main` during this assessment. There is therefore no stable base for a fixed-diff review, regression comparison, worktree workflow, release, or rollback, despite those concepts being central to [the template instructions](../template/AGENTS.md) and [Kanban workflow](<../template/backlog/docs/doc-03 - Kanban-workflow.md>).

**Required direction:** make Switchflow a consumer of its own workflow, or add a deliberately smaller maintainer workflow at the root. Commit an initial baseline before evaluating changes.

### SF-02 — There is no repeatable evaluation or performance-observation loop

The only package commands are board start/check, documentation check, and workflow start ([`template/.switchflow/package.json`, lines 7–15](../template/.switchflow/package.json)). There are no tests for the importer, custom board scripts, token rendering, lifecycle transitions, skills, or worktree behavior. There is also no representative task corpus, rubric, result schema, baseline, timing/token/cost capture, or comparison command.

The root [`.gitignore`](../.gitignore) excludes `.validation/`, but no committed validation harness documents or reproduces whatever that directory is intended to contain. The repository therefore cannot support its stated goal of observing whether framework changes improve outcomes. Manual disposable imports can find obvious breakage, but they cannot compare agent reliability, intervention count, task cycle time, review findings, context use, or cost across versions.

**Required direction:** add a small committed evaluation suite using representative independent-development tasks. Record version, model/configuration, success rubric, interventions, elapsed time, token/cost data when available, and failures. Compare one framework change at a time against a retained baseline.

### SF-03 — Completing a dependency makes a valid Ready task fail the board check

This was reproduced in a fresh import:

1. Create `AUD-01` as Done.
2. Create Ready task `AUD-02` depending on `AUD-01`.
3. `doctor` passes.
4. Run `task complete AUD-01`, which correctly moves the task to `backlog/completed/`.
5. `doctor` fails with `AUD-02 is Ready but AUD-01 is missing`.

[`check-ready-dependencies.mjs`, lines 15–35](../template/.switchflow/scripts/check-ready-dependencies.mjs) builds its status map only from the active `task list`. Lines 48–65 do not read completed task records. This conflicts with the workflow's use of completed records and makes the normal dependency lifecycle invalid as soon as completed work is removed from the active board.

**Required direction:** resolve dependency state across active and completed records, deduplicate by task ID, and add an integration test for Ready → Done → complete with an active dependent.

### SF-04 — Valid importer inputs can corrupt generated YAML or silently change project identity

[`import-switchflow.ps1`, lines 6–20](../scripts/import-switchflow.ps1) accepts any non-empty project name, owner name, and phase. Lines 80–100 then perform ordered raw string replacement in every template file.

Two accepted values reproduced different failures:

- Project name `Audit "Quoted" Project` generated `project_name: "Audit "Quoted" Project"` and an equivalent invalid `site_name`. The strict MkDocs build failed while parsing line 1 of `mkdocs.yml`.
- Project name `{{OWNER_NAME}}` was recorded literally in `.switchflow/project.json`, but the later replacement pass rendered `Audit Owner` into the wiki heading. The durable project record and generated files disagreed without an error.

The importer escapes repository fields for YAML but not the other values, and the unresolved-token check cannot detect a token that a later pass has already replaced.

**Required direction:** render by output context rather than repeated global replacement. At minimum, reject reserved token syntax, escape YAML values, constrain single-line text fields, validate the rendered YAML/JSON/skill metadata before writing, and add regression cases for quotes, apostrophes, Unicode, newlines, and token-shaped input.

### SF-05 — The project-phase and VAPS contract is contradictory and incomplete

The active phase was stored in the [project profile](<../template/backlog/docs/doc-02 - Project-profile.md>), and [engineering standards](<../template/backlog/docs/doc-04 - Engineering-standards.md>) told agents to read and update that profile. However, `quality-profile/SKILL.md` told the agent to find the active phase in engineering standards and update that same wrong file.

The project profile and governance overview also say that phase sets a baseline VAPS posture, but [engineering standards](<../template/backlog/docs/doc-04 - Engineering-standards.md>) contains only one generic VAPS posture and no phase names or phase-to-posture mapping. The importer accepts any non-empty phase string, so agents cannot derive a consistent baseline from it.

**Required direction:** choose one source of truth, define the allowed phases and their concrete VAPS consequences, validate `ProjectPhase`, and update the quality skill to read and mutate the same source. If phases do not materially change behavior, remove the phase abstraction instead of leaving agents to invent it.

### SF-06 — The board check does not enforce most of the documented lifecycle

The governance overview says a Ready task must have a useful outcome, observable acceptance, completed dependencies, evidence, authority, a stable baseline, and a reviewable boundary ([`docs/governance-system.md`, lines 14–20](governance-system.md)). The complete lifecycle also requires checked acceptance, final evidence, independent review, and controlled status transitions.

In the disposable test, Backlog.md accepted a Done task with no description and an unchecked acceptance criterion, and `doctor` passed. The Switchflow wrapper adds only the Ready-dependency check ([`backlog.ps1`, lines 6–21](../template/.switchflow/scripts/backlog.ps1)). Owner-comment closure, readiness content, handoff evidence, reviewer independence, and legal transitions are instructions rather than validated invariants.

This leaves the source of truth easy for an agent to place into a state that the documentation declares impossible.

**Required direction:** decide which lifecycle rules must be deterministic and add the smallest validator for them. At minimum, validate Ready task structure and Done/Review evidence, then test both accepted and rejected transitions. Clearly label rules that remain advisory.

### SF-07 — Improvements cannot be applied safely to an existing Switchflow project

Fresh-import-only behavior is explicit in [`README.md`, lines 20–22](../README.md) and [`docs/governance-system.md`, lines 37–41](governance-system.md). The importer rejects any existing rendered governance file ([`import-switchflow.ps1`, lines 108–119](../scripts/import-switchflow.ps1)), even though it records a schema and template version in `.switchflow/project.json`.

This is a reasonable 0.1.0 safety boundary, but it directly limits the framework-improvement goal: evidence gathered in an active project cannot be turned into a framework change and safely brought back to that project. Users must manually compare and copy intertwined instructions, skills, scripts, and documentation.

**Required direction:** define ownership and merge rules for generated versus project-owned files, then provide a dry-run diff and versioned upgrade path with rollback. Do not add automatic overwrite behavior.

### SF-08 — The runtime is Windows-specific, but compatibility and prerequisites are not declared

The setup path is entirely PowerShell and uses Windows virtual-environment paths ([`SETUP.md`, lines 3–32](../SETUP.md)). The launcher uses `Get-NetTCPConnection` ([`start-workflow.ps1`, lines 10–15](../template/.switchflow/scripts/start-workflow.ps1)), tooling resolution hard-codes `.venv\Scripts\python.exe`, package commands call `powershell`, and the board editor defaults to `notepad` ([`backlog.config.yml`, lines 1–9](../template/backlog.config.yml)).

Windows-only may fit the current owner's environment, but the repository does not say so and does not state minimum versions for PowerShell, Node/npm, Python, or Git. The claim of pinned tooling covers only direct governance packages; Python transitive dependencies and host runtimes are resolved at install time.

**Required direction:** declare the supported platform and tested runtime versions now. Add cross-platform wrappers only when another platform becomes an accepted requirement.

### SF-09 — The workflow launcher can report unrelated services as ready

[`start-workflow.ps1`, lines 21–43](../template/.switchflow/scripts/start-workflow.ps1) treats any listener on ports 6420 or 8000 as the required Backlog or MkDocs service. It does not verify process identity, project root, HTTP response, or successful startup. Two projects cannot use the defaults concurrently, and an unrelated process causes a false `Workflow ready` result.

**Required direction:** make ports configurable per project and verify a project-specific readiness response after launch before reporting success.

### SF-10 — Import is non-transactional and assumes `main` for repository edit links

The importer writes each file directly, then writes project configuration and `.gitignore`, then optionally initializes Git ([`import-switchflow.ps1`, lines 125–175](../scripts/import-switchflow.ps1)). A late filesystem or Git failure leaves a partial installation that a retry will reject as a collision. There is no staging directory, manifest-based rollback, or recovery instruction.

For any accepted HTTP(S) repository URL, lines 48–70 also generate `edit/main/docs/`. Existing repositories may use a different default branch or a host with a different edit URL.

**Required direction:** render and validate in a temporary staging directory, then move files into place with a recovery manifest. Accept or detect the default branch and repository host before emitting edit links; otherwise omit `edit_uri`.

### SF-11 — Skill validation is not a reproducible repository command

[`docs/skills.md`, line 20](skills.md) tells maintainers to use the Codex skill validator but does not identify the command, interpreter mode, or expected version. On the assessed Windows environment, the current validator crashed while reading three valid UTF-8 skill files under the default code page. All ten passed when invoked with Python `-X utf8`.

**Required direction:** add a repository validation command that imports to a disposable location and invokes the available validator in UTF-8 mode, or document an equivalent stable command. Treat structural validation as one check, not proof that skill decisions are good.

### SF-12 — The repository is not ready for external distribution or contribution

There is no project license, contribution guide, support policy, security policy, changelog, release history, or compatibility statement. There is also no plugin package. Current OpenAI guidance recommends repository-local skills for local workflows and a plugin when distributing multiple reusable skills to other users; see [Build skills](https://developers.openai.com/codex/skills).

This does not block private experimentation, but it blocks clear legal reuse and makes future contributions and upgrades ambiguous.

**Required direction:** defer public promotion until the High findings and evaluation loop are addressed. Before sharing, choose a license, document support and compatibility, add release notes, and decide whether Switchflow should remain an importer, become a plugin, or use both forms for different purposes.

## Suggested order of work

1. Commit the current baseline and make the framework repository exercise its own maintainer workflow.
2. Fix the completed-dependency check and importer rendering defects with integration tests.
3. Resolve the phase/VAPS source of truth and add deterministic lifecycle checks.
4. Add a small versioned evaluation corpus and capture baseline results before changing prompt or workflow policy further.
5. Add a dry-run upgrade path and explicitly declare Windows/runtime support.
6. Address launcher, validation-command, and distribution maturity after the core workflow is reliable and measured.

## Validation record

The assessment used a disposable project outside the Switchflow repository. It installed local npm and Python dependencies only in that disposable project. No application repository or live service was changed. The successful and failing cases above should be converted into committed automated tests; this report is evidence of the current state, not a substitute for that harness.
