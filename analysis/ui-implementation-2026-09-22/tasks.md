# Task interaction implementation — 22 September 2026

Implemented in `template/.switchflow/scripts/control/public/tasks.js`, `tasks-editor.js`, `tasks-model.js`, and `tasks.css`. Focused tests: `scripts/control-task-interactions.test.mjs`.

## Finding coverage

- F07/F08/F24: read-first formatted task narrative, wrapping title, concise saved status/owner/milestone properties, explicit edit and full-page expansion. Desktop >=1400px uses right-side detail beside the source; narrow layouts retain one main reading scroll. Empty optional narrative fields have Add disclosures in edit mode. Blocked tasks without a reason explicitly show missing evidence. Dark task prose receives theme tokens.
- F09: linked prerequisite/dependent titles and states in read mode; title/ID search picker adds prerequisites without requiring remembered IDs. Unknown relationship state is explicit. Existing dependency ID entry remains for records outside the currently loaded collection.
- F10: consistent completion/text/remove rows, immediate Undo remove before save. Indexed native definition-of-done operations remain unchanged. Native API only adds text and operates on existing indices, so new/edited DoD text explicitly requires save before completion; the UI disables its completion box until then.
- F11/F12/F27/F31: visible saved/tab-unsaved policy, explicit discard, tab-local discarded snapshot and recover action across reopen; field-by-field conflict comparison with saved-value selection. Existing revision and DoD-index rebase protection remains. Unknown existing-task saves force comparison, expose recent saved comments before retry, and offer clearing an already-saved comment. Unknown creation disables blind resubmission and directs collection reconciliation. Unknown review actions remain disabled until close/refresh.
- F13/F32/F33: keyboard/touch Move review offers named status plus top/bottom/before/after. Canonical ordering includes filtered-out siblings. Native drag reveals pre-existing hidden empty columns in a deferred callback, preserving the lifted node; upper/lower insertion markers, edge scrolling, unchanged/self-drop no-op, compact restoration. Reorder is explicitly presentation/status change, not execution approval.
- F14: separate reachable Discussion view; composer precedes newest 10 comments; older batches remain accessible with shown/total count.
- F16/F17/F18: bounded board lanes, 30-row list pages, truthful matching/total counts and page ranges, collapsed filter controls with active count, restrained sort/density selectors, aligned desktop list rows. Per-project session retention includes filters/layout/sort/density/page, board horizontal scroll and individual lane positions. Changing filters resets board scroll so matches are visible.
- F20/F23: user editor close calls `onClose`; destroy and `closeTask({navigate:false})` suppress navigation. Shell owns exact origin route restoration. Task reviews have accessible names; close restores connected opener focus. Existing generation guards preserved.

## Evidence and limits

- Parent reproduced before-fix actual native gestures against immutable baseline fixture on port 65439 before drag changes: missing Done target and self-drop reversing two-card order. Parent owns gesture receipts and candidate rendered checks.
- `node --test scripts/control-task-interactions.test.mjs`: 6/6 pass (self/unchanged drop, before/after with hidden siblings, empty/top/bottom moves, indexed checklist semantics, concurrent recovery snapshots, filtered count).
- `node --test scripts/tasks-ui.test.mjs`: existing 4/4 pass.
- `node --check` tasks/editor modules passes; owned diff whitespace check passes.
- Parent rendered critique incorporated: dark prose colors, wide-screen side panel, top Discussion access.
- No production writes, API contract changes, commits, or pushes. Browser gesture/native lifecycle/authority evidence must come from the parent's disposable fixture run; helper tests do not establish rendered acceptance.

## Integration

Shell callback contract coordinated directly with shell_gates: `onClose`, `closeTask({navigate:false})`, existing `onNavigate({view:'tasks',task:id})`; destroy suppresses close callback. Root owns shared client outcome metadata. Authoritative APIs retain final write enforcement; read-only/active-agent editor controls remain disabled.

### Narrow follow-up

After parent measured the first title near y735 at390px, moved sort/density and maintenance into Filters, retained their selected values in its summary, placed Refresh in the Board/List toolbar row, and collapsed the narrow heading to title/Create. Narrow-only spacing is reduced, with 36–38px routine controls and viewport-sized first board lane. Parent owns final390/320 screenshot measurements. Saving from Discussion now reveals/focuses an invalid required task field before reporting validity, retaining the comment instead of leaving an unfocusable hidden validation target.

### Refresh and blocker follow-up

Separated collection counts from operation/error notices. Refresh updates the filtered matching/total count even when its data signature is unchanged, clears only its own recovered loading feedback, and preserves unrelated move/error messages. A mounted UI fixture regression exercises search → unchanged refresh with retained operation feedback. Reserved `dependent` blockers render prerequisite titles and states on cards and read detail; unresolved relationships and Blocked without a reason explicitly name missing evidence, while empty optional blocker prose remains absent. Payload values remain untouched. Focused plus existing tests now pass12/12.

### R1/R2 review repairs

Task prose now consumes the shared `bindProseInteractions` handler for safe external URLs, actual workspace document/decision links, scoped headings, and code copy. Discussion paging cleans up and rebinds handlers; destroyed readers reject late callbacks. Shell owns single-entry record routing and source-view restoration on navigation failure. Task link failures reopen the captured task context, with tab writing retained.

Per-project task detail state is separate from draft data: scrollTop, focused control/link identity, Details/Discussion, expanded view, loaded comment count, and open disclosures are captured before task replacement, record navigation, route-close, and destroy. The latest40 task snapshots persist in tab session storage. Reopen restores focus with preventScroll and then exact scroll after layout. Suppressed dialog teardown cannot steal focus from a replacement editor; normally closed editor references are cleared so detached DOM cannot overwrite the captured state. API/CAS/draft payload contracts are unchanged.

`node --test scripts/control-task-interactions.test.mjs scripts/tasks-ui.test.mjs`:14/14 pass, including changed-control-order focus restoration at scroll692 and hidden-control safety. Module syntax checks pass. Browser acceptance for actual document links and task Back/Forward remains assigned to the parent/fresh reviewer; these focused tests do not establish native rendered behavior.

### F31 access-reason follow-up

`writeBlockedReason()` now propagates through task mounting to every existing/new editor. Task counts, locked actions, review dialogs and editor policy use the supplied connection/runtime/saving cause; absent a reason, they state temporary unavailability without guessing an active agent. `updateAccess()` refreshes create/promote/drag and editor/review controls without remounting or modifying writing. Reconnection clears only the review's own prior access warning. Focused offline/generic/reconnected state regression passes; task suites now15/15 pass and module syntax remains valid.

### Saved-reader follow-up

Reopening a saved task now restores prior edit mode only when its tab-local unsaved draft still exists. Save/Discard-cleared drafts cannot be resurrected into an empty editor by the independent reading-position snapshot. New tasks remain editable; retained unsaved task drafts keep their prior detail mode. Syntax and15 task tests pass.

### Repeated-link focus follow-up

Focus restoration prefers the recorded control index only when identity still matches and the control is visible. Otherwise it searches visible identity matches, so a hidden Description link cannot intercept restoration to the same document link in Discussion. Visibility includes rendered client rectangles to exclude closed disclosures. Repeated visible-comment and hidden-description regression added;16 task tests pass. Parent owns native browser recheck.
