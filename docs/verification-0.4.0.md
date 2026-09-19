# 0.4.0 local verification

Verified on September 19, 2026 with Windows, PowerShell 7.6.5, Node 24.19.0, Git 2.55.0.windows.3 and Codex 0.155.0-alpha.9.2. This is evidence for the local candidate, not a hosted release or owner acceptance.

## Integrated gate

The final integrated `scripts/validate-switchflow.ps1` run passed **73/73 Node regressions, zero skips**, a disposable 0.4.0 import, nine rendered Backlog documents and local/browser links, eleven rendered skills through the supplied official skill validator, and actual phase-cleanup branch selection. The Node portion took 102 seconds on this host.

Run after installing the isolated npm tools and building the fork:

```powershell
$env:BACKLOG_TEST_CLI = (Resolve-Path template/.switchflow/node_modules/backlog.md/cli.js).Path
./scripts/validate-switchflow.ps1 -ValidatorPath 'C:\path\to\skill-creator\scripts\quick_validate.py'
```

Compatibility fixtures use the official npm package layout. Native CAS tests independently resolve and execute the verified fork; they are not substitutes or mocked calls. The Windows CI workflow uses the same separation.

The final fork identity is `33fe84e0be6084cfd7dad450`. An actual build from an all-CRLF disposable bootstrap succeeded. Its native mutation, stale-edit, locking, launcher-integrity, and portability regressions passed. The patched upstream suite also passed 36 tests / 160 assertions and TypeScript checking before the transport-only CRLF correction.

## Independent and rendered checks

- Independent operations/security review covered cancellation admission, recovery fences, grants, Git receipts, exact-file commits, managed merges, conflict resolution, UAT finalization, and writable-state separation. Findings were corrected and reviewed again.
- Actual Git regressions cover create/commit/merge, stale and uncertain operations, hooks/filters/helpers, unrelated edits, exact conflict correction, long nested files, compact Windows candidate roots and rejection before mutation when roots remain too long.
- Rendered browser checks used the real control service and native Backlog adapter with a synthetic runner: task preview, stale-save rejection, draft retention, completed-task recovery, UAT generation reset, actionable failures, keyboard controls, and a 390-by-844 viewport. An independent reviewer assessed the implementation and contrast; muted text and compact captions meet 4.5:1.
- The live board also verified that current run progress replaces stale approval instructions on running cards.
- The live committed-text preview displayed `HELLO.md`, its exact commit and greeting. Desktop and 390-by-844 screenshots were inspected; the modal remained readable. Escape returned focus to its trigger, retained UAT notes and left every result unchecked. The viewport was restored. The independent UI reviewer assessed source and accessibility behavior; its browser surface was unavailable, so these rendered checks were performed in the root session.
- An actual Codex shell probe was denied a write to protected controller-parent storage while writes to its scratch and request inbox succeeded. Thread: `01a0b913-fe9c-75f2-8435-e6b8ceb88f9c`. This demonstrates the observed temporary-directory boundary; it is not a claim that every possible protected filename was separately probed.

## Real browser-to-Codex trial

The disposable project is `switchflow-control-demo-20260919`, initiative `df494fb1-902a-4555-8608-ac3057c0bafa`. It requests one root-level `HELLO.md` containing exactly `Hello from Switchflow.` and one LF. Browser actions supplied test-owner scope and plan decisions, and real local Codex sessions performed Intake, Planning and delivery. These fixture decisions are not Alex accepting Switchflow.

The trial exposed and drove fixes for blank inapplicable result entries, sandbox-protected Git metadata, and Git's separate Windows root-length limit. Failed operations and checkpoints were retained. The reviewed host helper keeps the workspace sandbox and grants only fixed candidate Git operations. Runtime-only trial updates were made while its service was idle; the committed product baseline stayed `913f70f54f57adedde17c8bccee58edd67778e84`. The stranded failed-create branch was preserved, and recovery uses a fresh candidate name.

The corrected delivery reached UAT at 10:29:15 UTC using `hello-retry`, commit `c51910bdc062913f1bc57401f12e32410b975371`. Its clean diff adds only `HELLO.md`; working and committed content are both exactly 23 bytes, SHA-256 `a1067e6bb94a61c48e0b18ddb0b4ac0bb5bb267375226f7caa8dcc5124de55b2`. The independent reviewer accepted that fixed commit with no findings. Delivery session: `01a0b92a-569f-7a72-b315-a56c958728fc`.

The actual UAT handoff exposed unsupported local Markdown links. The new committed-text preview and browser-specific walkthrough instructions resolve that usability gap. At 10:41:34 UTC the browser recorded an explicitly labelled scripted fixture verdict after the preview was inspected, then automatically queued finalization. This verdict can close the disposable fixture; Alex's acceptance of Switchflow remains pending.

At **10:46:59 UTC the initiative reached Complete** without another approval action. All four board records are Done; milestone `m-0` is Completed with its three milestone tasks done. The finalization session is `01a0b941-da61-7d50-9b4b-4cd58829cec9`. It read back the fixture-only verdict, ran Backlog doctor, dependency and nine-document checks, and verified that main, the clean candidate and thirteen preexisting primary runtime paths were unchanged. Its result is retained in external project state at `operations/delivery/df494fb1/hello-retry/evidence/uat-finalization-rev22/result.json`.

The local trial board was left running at `http://127.0.0.1:57864`. This is a disposable demonstration, with a custom state-home under the host's temporary directory. Normal imported projects use the documented persistent external state location and their own `Start Switchflow.cmd` launcher.

## Remaining evidence boundaries

No active consumer repository was upgraded. The framework changes remain local and uncommitted. Hosted CI, microphone capture, application-specific container checks and Alex's UAT are unobserved. No remote fork, push, deployment or main-branch integration is claimed. Reliability, delivery quality and cost savings across projects require repeated project evidence; this small trial does not establish those outcomes.
