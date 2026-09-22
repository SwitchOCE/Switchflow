# Original finding coverage

| Original finding | Implementation owner/surface | Relevant verification |
| --- | --- | --- |
| F01–F02 | Overview model and labelled queues; exact approved-plan task association, dependency reasons, recorded-state/runtime distinction, milestone ambiguity | Shell model fixtures; rendered Overview and UAT |
| F03 | Grouped collapsible sidebar; narrow drawer and focus return | Desktop/390/320 navigation |
| F04–F06 | Grouped milestones, compact scope cards, read detail adjacent to origin, paged linked tasks | Milestone tests and browser exact return |
| F07–F08 | Read-first task, wrapping title, secondary properties, adaptive edit/full-page/side detail, concise cards | Long task desktop/narrow; both themes |
| F09 | Searchable dependency picker and named predecessor/successor links/states | Task helper tests and rendered dependency states |
| F10 | Checklist completion/edit/remove/Undo | Indexed payload regression; task editor |
| F11–F12 | Explicit saved/draft state, discard recovery, human field comparisons | Browser reopen/discard/Undo/concurrent save; revision tests |
| F13 | Keyboard/touch-friendly Move status and placement controls | Keyboard Move and canonical order regression |
| F14–F16 | Separate discussion with recent loading; paged retained event/run history; bounded board columns and paged lists/Done history | 100 comments, 50 runs, 61 events, 150 completed rows |
| F17–F18 | Correct filtered totals; aligned paged list; sort/density/workset/scroll retention | Browser one-result state, refresh regression, source-return check |
| F19 | Search scopes, snippets, keyboard navigation, explicit cap/refinement | Broad query and ArrowDown; model tests |
| F20 | Open/close routes, Back/Forward handling, exact cross-view task origin | Close/reload; Insights page and milestone return |
| F21–F22 | Stable decision region; evidence jumps; UAT progress/scenario navigation; rework observations retained | Actual lifecycle tests and disposable UAT submission |
| F23 | Named native task/review dialogs with deliberate focus return | Browser Move dialog, existing native-dialog semantics |
| F24–F25 | Compact narrow shell/tasks; visible connection; document disclosures and stable save region | 390/320 screenshots and overflow checks |
| F26 | Milestone titles and linked paged Done history | Page two → task → exact return |
| F27 | Draft task versus tab-unsaved-edit labels and recovery | Source labels; browser recovered document/task drafts |
| F28 | Newly appended DoD input focus | Browser fourth-row focus |
| F29 | Scoped setting explanations and configured Insights dates | Supporting model tests; rendered settings/history |
| F30 | Shared readable typography/spacing and action hierarchy | Rendered desktop/narrow and theme review |
| F31 | Preserved-content refresh errors, distinct recovery states, unknown write reconciliation | Failed-save browser path; client outcome and draft regressions |
| F32–F33 | Deferred empty target reveal, insertion direction, self-drop no-op, full canonical sibling order | Before/after native fixture comparison and helper regression |

The [fresh review](fresh-review.md) closed its two material findings after bounded repairs and rechecks. Shared task/discussion/milestone prose-link handling and per-reader return state supplement F07/F09/F18/F20; accurate connection/run pause reasons supplement F31. This implementation map is not a claim that every variant of all 15 scenarios passed. Formal accessibility conformance and Human acceptance are not asserted.
