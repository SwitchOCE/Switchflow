# Switchflow backlog

This file tracks framework issues while Switchflow is experimental. It is deliberately separate from the imported Backlog.md workflow so agents developing Switchflow are not governed by the system they are auditing.

## User-raised issues

- [x] **Set one quality target in engineering standards.** `template/backlog/docs/doc-04 - Engineering-standards.md` now owns one active VAPS target. Project phase remains context and no longer selects a second quality baseline; a method for changing the target remains deferred.
- [ ] **Define lifecycle enforcement and repository cleanup.** Decide which task lifecycle rules must be deterministic, then cover cleanup of completed worktrees, merged or stale branches, stale documentation, and other residue from agent work. Keep advisory guidance distinct from enforced checks.
- [ ] **Balance parallel and serial orchestration.** Refine the instructions so agents fan work out when independence makes it useful, but stay serial when coordination, shared files, unresolved interfaces, or task size make parallel work wasteful.
- [ ] **Review Backlog.md MCP and service usage.** Determine whether Switchflow is using Backlog.md correctly through its CLI wrapper and whether Backlog.md's MCP or service mode would improve agent access and replace parts of the stopgap launcher.
- [ ] **Define useful task-field conventions.** Investigate rules for labels, assignee, priority, type, implementation plan, definition of done, implementation notes, and references. Preserve useful agent judgment, avoid requiring every field, and remove fields or guidance that duplicate the same information.
- [ ] **Document frontier-model first principles.** State that Sol/Fable and above are the intended model class. Explain that most instructions are principles rather than hard rules so capable frontier models retain appropriate flexibility.
- [ ] **Research Backlog.md agentic-workflow guidance.** Find other guides and real examples, then adopt the useful practices that fit independent software development without importing unnecessary process.
- [ ] **Create a delegate-task skill for orchestrators.** It should let orchestrators create a delegate task without composing a custom prompt when one is unnecessary.

## Agent-raised issues

| ID | Status | Issue and disposition |
| --- | --- | --- |
| SF-01 | Rejected | Do not make Switchflow subject to the same imported rules it is intended to audit. This root backlog is the intentionally smaller maintainer mechanism. |
| SF-02 | Deferred | Add repeatable evaluation and performance observation after the framework is mature enough for comparisons to be meaningful. |
| SF-03 | Resolved | The Switchflow dependency check ignored completed task records. It now treats completed `Done` records as satisfied dependencies. This was a Switchflow wrapper bug, not a Backlog.md completion bug. |
| SF-04 | Resolved | First-time import now rejects reserved template-token input, restricts rendered identity fields to single-line text, and safely quotes project and owner values used in YAML. |
| SF-05 | Superseded | Replace the contradictory phase/VAPS design with the user-raised single-quality-target issue above. |
| SF-06 | Accepted | Lifecycle validation is too weak. This is expanded by the user-raised lifecycle and repository-cleanup issue above. |
| SF-07 | Deferred | Design safe upgrades only after Switchflow itself is more mature; automatic patching is not a current priority. |
| SF-08 | Accepted | Declare supported platforms, compatible runtime versions, and setup prerequisites. Cross-platform implementation is separate from documenting actual compatibility. |
| SF-09 | Deferred | The launcher is a known placeholder. Evaluate Backlog.md service/MCP support before investing in custom readiness behavior. |
| SF-10 | Accepted | Make import transactional and stop assuming `main` or one repository-host edit URL. |
| SF-11 | Resolved | Repository text is standardized as UTF-8 without BOM, and rendered skill validation is exposed through a UTF-8-aware repository command. |
| SF-12 | Deferred | Add licensing, contribution, security, release, compatibility, and distribution material when external sharing becomes an active goal. |
| SF-13 | Resolved | The importer rendered every template file as UTF-8 text, so any binary asset was corrupted by token substitution and then failed the unresolved-token scan. It now detects binary content and copies those files byte-for-byte without substitution. Found by installing `.switchflow` tooling inside `template/`, which made `backlog.exe` abort every import. |
| SF-14 | Resolved | The importer walked `template/` with no exclusions, so anything installed there reached an import, and the repository's own `.gitignore` did not cover `template/.switchflow/node_modules/` even though the importer writes that rule into target projects. Transient directories are now excluded with a warning, an empty-template guard was added, and the root `.gitignore` ignores `node_modules/`, `.venv/`, and `__pycache__/` at any depth. Related to SF-10 on importer robustness. |
