# Three-step delivery implementation

This record maps the owner's September 19 diagram and request to the 0.4.0 candidate. The diagram is problem evidence; the accepted request replaces separate human phase starts and milestone acceptance with three routine steps: Intake, Planning, UAT. Plan approval authorizes every planned phase automatically. Execution uses local Codex.

See the [local verification record](verification-0.4.0.md) for test counts, rendered checks, real runtime evidence and remaining acceptance boundaries.

| Concern | Implemented path | Verification boundary |
| --- | --- | --- |
| Browser initiation | Local Kanban, one-click Intake, explicit scope/plan/UAT actions, durable run admission | API/state tests and isolated rendered trial |
| Worktree ownership | Codex/orchestrator/human registry, canonical Git project identity, primary governance root, isolated managed candidates and a fixed host Git helper | Cross-worktree identity, isolated Git-operation tests and candidate execution evidence recorded per run |
| Code/governance/scratch separation | Versioned rules and Backlog stay deliberate; external control/operations/scratch avoid code-tree churn | Storage/path/retention tests; no automatic migration of consumer boards |
| Duplicate testing | Exact evidence receipts, latest-attempt cache eligibility, dependency/environment input tags | Real local subprocess/cache-invalidating tests |
| Docker | Explicit runtime/environment tagging and documented command execution | Docker presence never treated as a passed container test |
| External issue tracking | Clarification, permission, scope change and friction ledger, metrics, read-only browser health view | Concurrent cross-process logging and no-dispatch tests |
| Framework self-review | Explicit-only review-framework skill, narrow evidence-led recommendation process | Rendered skill validation; no automatic out-of-phase tasks |
| UI/UX versus headless work | Planning declares applicable evidence; real rendered evidence for UI, deferred named host prerequisites for headless work | Policy and candidate-specific proof remain distinct |
| Git and CI maturity | Exact grants, candidate review/cleanup contracts, governance CI, CAS fork for safe board editing | Local Git/cleanup fixtures and validation; hosted CI requires an actual remote run |
| Repository bloat | External run logs/build caches/scratch, retention previews and safe cleanup, no broad deletion | Changed/promoted/unknown/path-escape fixtures |
| Intake weaknesses | Existing-capability inventory, resumable discovery, multiphase plan and durable snapshots | Intake protocol and three-gate progression tests |
| Human task quality | Guided walkthrough, explicit requested decision and next action, recorded UAT results/rework and automatic Backlog finalization after the verdict | Human acceptance is never inferred from agent exit |
| Voice/conversation | Progressive browser dictation with typed fallback | Browser availability/permission dependent; no claim of captured microphone input |
| Unclear language/task detail | Glossary, human outcome before implementation map, bounded role reads | Policy and rendered UI review |
| Toggleable review | Optional independent Intake/Planning critique before the same human gates | Prompt contract tests and skill validation |
| Response style | Human/agent next action first; details expandable in board | Rendered UI and policy review |

The candidate preserves existing local skill edits and does not update existing consumer repositories. Mechanism checks and a small real local runner trial cannot establish delivery quality, token savings or reliability across many projects. Those remain measurements to collect from the external issue/evidence records during actual use, not claims made by this release.

The Windows runtime trial found that ordinary workspace sandboxing protects Git metadata even when explicit profile grants appear to permit it. The implementation retains that sandbox and uses the approved, fixed-operation host Git helper. A separate actual Codex shell probe confirmed that writes outside the agent's state subdirectories are denied, while scratch and request-inbox writes succeed. These are observed runtime results, not assumptions based only on configuration.
