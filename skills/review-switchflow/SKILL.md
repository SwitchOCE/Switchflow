---
name: review-switchflow
description: Review Switchflow framework friction, human interruptions, evidence reuse and delivery outcomes when assessing or improving the framework. Separate from delivering an application phase.
---

# Review Switchflow

Review the framework from its recorded operations, without turning findings into delivery work. Establish the requested project and time range; default to the current Git project and its complete available history when that is unambiguous.

Use that project's `node .switchflow/scripts/operations/operations.mjs issues <project>` and `context <project>` to locate the external project-shared ledgers. In the Switchflow maintainer repository, the helper is under `template/.switchflow/scripts/operations/operations.mjs`. Do not scan unrelated projects or read arbitrary scratch. If the installation predates operations ledgers, report the missing evidence rather than inventing metrics.

Read only relevant issue entries, run receipts and check metadata. Do not ingest full prompts or tool logs unless a specific finding needs them. Group repeated clarification, permission, scope-change, review-return and setup failures. For each material pattern, separate:

- The actual user decision or external access that could not be automated.
- An avoidable interruption caused by missing state, contradictory instructions, unclear scope, duplication or a runtime defect.
- Evidence not available in the ledger. Do not infer token cost or saved effort from event counts alone.

Check whether the three routine human gates stayed Intake, Planning and UAT; approved phases continued without repeated starts; UAT remained a real human verdict; and scope revisions preserved their prior approvals and candidate evidence. A failed automated check is not owner rejection. Inspect evidence reuse only for matching candidate, command, declared inputs and environment.

Return the next recommended action and its owner first, then a concise evidence-backed findings table with record IDs, observed consequence, proposed smallest change and a testable success condition. Distinguish implementation defects from policy gaps and measured outcomes from hypotheses.

Do not dispatch agents, create project delivery tasks, resolve issues, change approvals, mutate consumer repositories or apply framework changes merely because the review discovered an issue. Those actions need a request that includes them. If the current user did authorize implementation, complete the bounded framework change under the applicable repository rules while preserving unrelated project work.
