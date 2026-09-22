# Milestones and documents implementation handoff
Implemented F04-F06, F12, F25 and relevant F27/F31 in the owned UI files.
- Milestones group as Active work, Ordered upcoming work, Order not established, and Delivery tasks complete. Groups derive only from linked task facts and existing optional executionOrder; no sequence/status/approval writes are introduced. Copy explicitly separates planning sequence from authorization and delivery completion from acceptance.
- Cards show a bounded plain-text scope summary, linked task counts, blocker count and no progress element for zero linked tasks. Full Markdown scope opens in read mode beside the originating card. Back restores the exact card focus and captured window scroll. Linked tasks use the existing onTask callback while leaving milestone state mounted. Editing is explicit; retained edits are discoverable from read detail.
- Milestone conflict comparison now labels each field's unsaved and latest versions, keeping existing captured revision and mutation checks.
- Documents/decisions show field-level conflict comparisons; discard retains a recoverable copy and offers Undo until panel destruction. Existing pre-save fingerprint comparison remains unchanged and does not claim atomic compare-and-swap. Recovery language identifies unsaved edits in this browser tab.
- Narrow document Browse and Contents collapse independently; desktop opens both. The save bar is at the top of the edit form and sticks while reading long input. Loading, no-match and permission messages remain local to the relevant surface.
Validation: 31 checks pass across scripts/milestones-documents-review.test.mjs, scripts/milestone-panel.test.mjs, scripts/documents.test.mjs and scripts/knowledge.test.mjs. node --check passed for milestone/knowledge modules; git diff --check passed. Existing milestone harness now imports the module normally (shared Markdown import) and explicitly enters Edit after read-first open. New tests cover zero-task truthfulness, task-backed groups without mutation, compact scope, full field comparison, decision metadata boundaries and read-first rendering.
Bounded self-review checked no new writes on read, stale-response guards, revision preservation, full prose retained through conflicts, escaped comparison output, and disclosure media-listener cleanup. No live data, commits or pushes.
Integration caveats / remaining rendered checks:
- Parent owns desktop/mobile rendering and real browser behavior. Verify middle-card open -> linked task -> close task -> Back returns to the original filter/card/window position. onTask must retain its opener focus.
- Exercise Undo for both open and stored unsaved document edits, long conflict bodies, mobile Browse/Contents, and sticky save visibility.
- Milestone relative Markdown links render with the shared renderer but have no new cross-document navigation controller in this slice. Linked task buttons are wired.
- No persistence, approval, milestone order, native API or server route contracts were changed. Document concurrent-write window remains disclosed.

## Rendered-review follow-up
Repaired mixed encoding introduced by the Windows Python default codec: five new milestone bytes and one knowledge byte were CP1252 in otherwise UTF-8 files. All owned changed sources/tests now explicitly use UTF-8; a fatal UTF-8 decoding regression verifies no replacement glyphs. Existing Unicode and prose are preserved.
Linked milestone task reader and assignment lists now start with 20 results and expose Show more in batches of 20, with shown/total counts and no silent truncation. Assignment filters reset the visible batch while preserving the selected filter and task identifiers. Linked task buttons include their IDs; no mutation contract changed.
Validation after correction: 33 focused checks pass, including 45-task paging, filter reset, exact linked ID callbacks and strict UTF-8 decoding.


## R1 evidence-navigation repair

Added opt-in `bindProseInteractions` and `resolveProseLink` exports in documents.js. Existing document/knowledge hydration stays unchanged. New task and milestone consumers can hydrate external HTTP(S) links, route unique actual native document/decision records, scroll/focus section-local headings, copy scoped code, and show actionable unresolved/offline feedback. No guessed filesystem namespace or arbitrary local URL is introduced. Native record index reads are guarded against destroyed/replaced readers. Milestone binding is cleaned up on editor/read/close/reset transitions, retaining its source panel for return navigation.

The parent-requested knowledge.open result is now true for a completed read and false for blocked, failed or stale reads, retaining existing inline error reporting. This lets the shell restore the original view after a failed evidence navigation without changing other consumers to exception handling.

Changed in this follow-up: documents.js, milestones.js, knowledge.js; scripts/prose-interactions.test.mjs and scripts/knowledge-navigation.test.mjs added; existing milestone DOM test cleanup support updated. Forty focused tests pass across those tests plus milestone-panel, milestones-documents-review, documents and knowledge. Tests exercise mixed external/internal links, real guides/design.md lookup, explicit legacy routes, unsafe schemes/traversal, ambiguity, fragment focus, code copy, offline messaging, stale teardown and knowledge read outcomes.

Limitations: this is source/helper/DOM-double evidence only; fresh browser acceptance remains with the parent reviewer. Relative links require a real source path or a unique actual docs-root path; unresolved references explain that limitation. New image hydration is outside this repair. The previously documented unhydrated milestone link limitation is resolved by this follow-up.
