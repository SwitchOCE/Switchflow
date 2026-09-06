# Scope workflow implementation

Implemented for the Switchflow 0.3.0 template. Existing consumer projects are not changed by this work.

## Changes

- `intake` creates an editable board checkpoint from the beginning and resumes by task ID. It distinguishes confirmed answers, unaccepted recommendations, accepted deferrals, unresolved questions and the next action.
- Branching discovery uses optional child questions with native dependencies and linked evidence. The compact parent remains the index; discovery stays outside delivery milestone counts and worker queues.
- `edit-milestone` revises scope while retaining milestone identity and previous content. `edit-phase` reshapes delivery within that accepted outcome. Both use the single procedure in doc-09 and existing planner rules.
- The wrapper adds milestone view/edit, expected-revision checks, prior-record snapshots and a writer lock. Task checkpoints gain file-based description transport through pinned Backlog MCP, preserving the current task status explicitly.
- Phase plans and checkpoints record their scope baseline; revisions coordinate active work, preserve accepted history and reassess affected readiness and UAT.
- Upgrade guidance covers existing product documents occupying doc-09. Preserve their identity and remap the new governance document references during a reviewed import.

## Verification

Final gate passed: 19 regression tests, no skips; nine rendered Backlog documents; eight skills validated by the repository and Codex validators; cleanup fixtures; and `git diff --check`.

Run the full gate with installed Backlog.md 1.50.1:

```powershell
$env:BACKLOG_TEST_CLI = (Resolve-Path 'template/.switchflow/node_modules/backlog.md/cli.js').Path
.\scripts\validate-switchflow.ps1 -PythonPath python -ValidatorPath 'C:/Users/keech/.codex/skills/.system/skill-creator/scripts/quick_validate.py'
```

The deterministic suite covers current and completed dependencies, provenance/preflight, discovery queue separation, milestone identity and metadata preservation, long Unicode bodies, restoration, stale revisions, competing writer locks, failed history writes, native rename/archive compatibility, and description updates retaining comments, relationships and active status. Invalid/mixed file inputs and oversized checkpoint bodies leave saved state unchanged. Fresh-import checks cover nine documents, eight rendered skills, and real cleanup fixtures.

## Independent fresh-context exercises

Both exercises used separate disposable imports and independent agents given only the fixture and a realistic request. No implementation or live application was involved.

**Resume an unfinished intake.** The checkpoint contained local-only CSV with three agreed fields, an older thirty-day retention statement, and an unaccepted all-dates default. A newer owner comment rejected retention and left the date range unresolved. Asked to resume without creating a milestone, the agent corrected retention, preserved agreed fields, retained the date default as provisional, and asked for the date-range decision. Parent readback confirmed those results, both owner comments remained intact, no milestone was created, and doctor passed.

**Change scope after partial delivery.** A CSV milestone had an accepted Done serializer, an unstarted download task and blocked human UAT. The request changed exports to JSON while preserving fields and exclusions. The agent retained milestone m-0, saved a prior-scope snapshot, preserved the Done CSV record and its evidence, created JSON follow-up work, updated the phase/download/UAT, and rewired dependencies. It recorded no execution grant and correctly retained blockers because the synthetic project lacked application configuration. Parent readback confirmed the resulting contract and queues; doctor passed.

The second exercise exposed a literal-newline transport mistake that readback caught and the agent repaired. The resulting implementation adds `task edit --description-file`; a pinned-runtime regression verifies Unicode, real newlines, and retention of status, criteria, labels, comments and relationships. Both agents also tried unsupported native `--json` flags; doc-09 now distinguishes supported read forms.

## Proof limits

These are local fixture and two behavioral exercises, not a benchmark of long-running real intakes. They do not establish token-cost savings or prove every possible agent decision. Browser/native milestone edits do not participate in the adapter lock; the revision procedure requires coordinating them. Task checkpoint replacement uses a documented single-writer convention. A failed milestone replacement can leave an unused snapshot; current content remains authoritative. Prior history and recovery instructions remain on the board.

## Design sources

Adapted the ideas of a compact discovery index, question dependencies and incremental decisions from [Wayfinder](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md), dependency-aware questions from [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md), and precise conditional references from [writing-for-agents](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md). Existing Switchflow board placement, scope authority and delivery review remain governing policy; the external suite is not installed.
