# Browser verification of the UI rework

The browser exercised working UI modules at localhost:65440 against disposable in-memory APIs. Actions here are synthetic project actions, not real Human UAT, native Backlog persistence, or agent delivery. Production API/Backlog contracts are tested separately by the repository validator. No consumer installation was updated.

## Build/review cycles

- Four bounded implementation slices each ran focused tests and self-review. Parent integration then tested rendered interactions, sent concrete defects back to the owning slice, and rechecked changed behavior.
- Browser review corrected mixed file encoding, task heading colors in dark mode, excess narrow-screen task controls, history dumping of untouched UAT checks, periodic refresh overwriting filtered counts, unresolved dependency wording, and settings copy referring to a removed control.
- Final fresh review is recorded separately in `fresh-review.md`. That reviewer receives the original report and build without these implementation notes or prior verdicts.

## Observations

| Journey | Evidence observed |
| --- | --- |
| Baseline native drag | Two Ready tasks at original revision: self-drop requested reversed order. Hidden Done was still absent during native drag. `baseline-server.mjs` reproduces this without project writes. |
| Hidden destination after repair | Actual browser pointer drag moved DEMO-1 from Ready into the initially hidden Backlog in the six-status fixture, and separately into Done in the two-status fixture. The in-memory API received the correct destination/order; unused empty columns disappeared after the gesture. |
| Placement and non-drag equivalent | Lower-half drop onto DEMO-2 saved `[DEMO-2, DEMO-1]`. A before-card cross-column drop saved `[DEMO-1, DEMO-2]`. Self/cancel attempts did not add a reorder write. Actions → Position Bottom → Enter produced the matching board order. Pure order tests additionally cover self-drop no-op and filtered-out siblings. |
| Task search | Searching a distinctive title displayed one card with `1 of 200 tasks`. Read-only refresh regression verifies the count and operation message remain distinct. |
| Read/edit | Long task opens as formatted prose; title wraps and purpose precedes properties. At narrow width, one primary narrative scroll remains. At wide width, the task uses a side detail surface; Expand is available. The narrative editor grew to 650px in the long-record fixture, rather than the original 100px. |
| Task draft and route | Edit title → Close → reopen retained the draft. Discard restored saved fields. Close → reload left zero open dialogs and removed the task query parameter while retaining the search. Explicit Save updated the disposable task. |
| Discussion | The top Discussion tab exposes the composer immediately and initially shows ten of 100 comments, newest first, with older access. Opening it does not require traversing the long description. |
| Conflict | Concurrent description and label changes produced labelled field comparisons. Selecting saved description/labels retained the user's draft title. A simulated server failure disabled Save and required comparing the saved record before retrying; the draft title remained intact. |
| Milestone return | Opening the sixth visible milestone and using Back focused `m-3`, its exact originating card, and restored its window position. Read scope was formatted; task count and ordering ambiguity remained visible. |
| Document recovery | Edit Markdown → Discard → Undo restored `# A recoverable draft` and its body. The 320px document view used Browse/Contents disclosures without horizontal overflow. |
| UAT observations | Mark check 1 Needs rework, enter detailed notes, choose Next unchecked, then return to check 1: notes remained. Request rework preserved check ID, failure and notes in the actual lifecycle result and exposed previous observations. Follow-up source/lifecycle tests verify untouched checks do not acquire Human authorship and reviews remain bounded. |
| Complete retained history | Initiative history showed `1–10 of 61 matching retained events` and `1–10 of 50 matching retained runs`. Six Older actions reached `61–61 of 61` and the named original decision. |
| Insights return | Done history initially showed 20 of 150 rows. Page two → task 71 → Close restored `21–40 of 150 completed tasks`, the Insights URL and focus on task 71. Milestone names and configured dates appeared in rows. |
| Search | A broad query showed 41 loaded results: one initiative plus the first 40 native results, explicitly stating the native cap and refinement path. ArrowDown focused/highlighted the first result. |
| Settings | With three Definition of Done defaults, Add focused the new fourth input (`insights-ui-fixture-done-3`). Disposable unsaved changes were discarded. |
| Narrow task layout | At 320 × 800, the first task card began around y=512; document width was 305 CSS px within the 320px viewport, with no page overflow. The first task purpose was visible. The 390px task reader displayed wrapping title, narrative and reachable stable actions. |
| Themes and errors | Task heading contrast defect found in dark mode was repaired and re-rendered. Both themes were exercised. Browser console error checks during the recorded walkthrough were empty. |

## Final repair and recovery checks

The fresh review's R1/R2 findings were repaired and rechecked under the reviewer's specified steps. Its [final verdict and raw observations](fresh-review.md) record exact task relationship scroll/focus/expansion restoration, Discussion draft/link return, milestone scope-link return, unchanged milestone/task and Insights origin return, and accurate offline versus active-run pause messages. Both findings are closed in that bounded recheck. The saved-versus-dirty reader guard and duplicate-link focus cases were included in subsequent targeted regressions.

An additional controlled race was exercised after that verdict: the next read of DEMO-2 was delayed by 2,000ms; the browser opened DEMO-2 and immediately DEMO-3. After the delayed response had settled, the URL still identified DEMO-3, the sole open dialog was titled “Outcome 3: demonstrate clear human interaction”, and task B remained visible. This is parent-operated evidence for that one delayed A→B case, not an exhaustive navigation race matrix.

The uncertain-write fixture applied the task title but returned a 503 response. The UI kept the draft, disabled Save and exposed Compare. The recorded server title matched the submitted title with exactly one write; no repeated write occurred during reconciliation. Offline and simulated active-run interruptions separately kept the exact `fresh-offline-draft` text and disabled Save. Ending the interruption re-enabled Save before deliberate discard. These runs do not launch an agent or persist native project records.

Final desktop and 390px task-reader screenshots were captured after the repair cycle. The temporary viewport was reset. The direct fresh review's own unverified cases remain accurately recorded; these supplementary parent observations do not retroactively become independently operated review evidence.

## Scope and limits

This demonstrates browser/DOM/pointer and keyboard behavior against a controlled API. It does not establish screen-reader usability, touch-device behavior, participant task times, or real owner acceptance. The backend retains bounded history; the UI labels retained records and provides access to that complete retained set. Global native search has a 40-result cap, and the UI explains refinement rather than inventing an unsupported continuation cursor.

The original report remains unchanged as the design baseline. Its screenshot evidence describes the prior UI; screenshots in this implementation directory describe the candidate.
