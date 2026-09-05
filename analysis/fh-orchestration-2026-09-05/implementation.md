# Orchestration changes implemented

Applied on 5 September 2026 to the Switchflow template and FH Dev Tooling's installed guidance, in the recommended order. Existing FH edits and its local push policy were preserved. The original audit remains a snapshot of the earlier runs.

1. **Serial delivery:** the phase agent uses `deliver-task` directly when one task in the planned group is ready. Related successors retain context after acceptance. Every task still has its own criteria, evidence, handoff and independent verdict on the exact candidate. Parallel groups use workers; serial delegation requires a capability or isolation reason. Dispatch includes verified environment facts, not transferred permissions.
2. **Complete document transport:** `backlog.ps1 doc update <id> --content-file <path>` reads a UTF-8 Markdown body and uses the pinned Backlog MCP document update interface over stdin. Content never enters the native command line. Native create and metadata commands remain separate. Documentation now records valid command forms and requires semantic example coverage as well as syntax and link checks.
3. **Waiting:** use event waits within host limits, without redundant status reads or repetitive unchanged updates where the host permits quiet waiting. No host configuration was changed. The installed configuration and [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) did not establish a setting for the host's 60-second commentary/wait policy. Repository guidance explicitly defers to that policy.
4. **Setup and gates:** prepare the next ready group; prewarming requires a concrete benefit and a recorded prerequisite revision refresh. Documentation-only phases use affected documentation/board checks and diff review. Runtime and operational changes keep full phase suites and boundary checks. Existing explicit gates require an authorized, explained amendment before being narrowed.

The phase record now captures execution mode and, where available, total tree cached/uncached input, output, models, active elapsed time, first-review acceptance and correction count. Compare similar future serial tasks with the audit baseline; no savings percentage has been established by this implementation.

## Validation

- 12 Switchflow regression tests passed, including a real pinned Backlog round trip exceeding 90,000 characters with Unicode, quotes, literal shell syntax, CRLF, a BOM and a final required JSON example. Document identity and metadata were preserved. Missing files and unknown document IDs failed without changing the existing document.
- Fresh import: eight documents, six rendered skills and phase-cleanup fixtures passed. Changed FH skills passed the skill validator.
- FH: 24 documents, six decisions, browser routes and local links passed; doctor reported no duplicate IDs and the Ready dependency check passed.
- Backlog browser displayed the updated transport instructions and rendered all three workflow diagrams.
- Both installed transport scripts match their templates byte for byte. Delivery and planning skills match after token substitution; orchestration retains FH's existing local push policy.
- Git whitespace checks passed. No application runtime code, dependencies or existing task gates were changed.

To include the real Backlog transport test in framework validation:

```powershell
$env:BACKLOG_TEST_CLI = 'C:/Users/keech/Documents/FH Dev Tooling/.switchflow/node_modules/backlog.md/cli.js'
.\scripts\validate-switchflow.ps1 -PythonPath 'C:/Users/keech/Documents/FH Dev Tooling/.venv/Scripts/python.exe' -ValidatorPath 'C:/Users/keech/.codex/skills/.system/skill-creator/scripts/quick_validate.py'
```

The regression fixture writes only to an isolated temporary project. Without `BACKLOG_TEST_CLI`, the two argument/file failure checks run and the real-runtime test is explicitly skipped.
