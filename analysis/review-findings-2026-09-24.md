# First-review block findings, 24 September 2026

Source for the `deliver-task` pre-handoff checklist. Read-only analysis of task records in FH Dev Tooling (template 0.2.2) and Anagrind (0.5.1); neither project was changed.

## Method

Reviewer-authored comments and comments beginning "Independent review" were classified by keyword, because neither board recorded a structured verdict. Accepting phrases ("no findings", "0 blocking", "review: accept") were checked before blocking phrases. Spot checks confirmed the classification; one of 55 extracted blocks was an acceptance and is excluded.

| Project | Tasks with a review verdict | Blocked on first review |
| --- | ---: | ---: |
| FH Dev Tooling | 84 | 41 (49%) |
| Anagrind | 25 | 14 (56%) |

These are heuristic counts. From 0.6.0, `backlog.ps1 reviews` counts only the structured `Verdict:` line and does not reproduce them.

## Classes

Counted per task; a task can fall in more than one class.

| Class | Tasks | Examples |
| --- | ---: | --- |
| Contract edges: limits, units, ranges, versions, identity | ~18 | UTF-16 length against a Unicode-scalar limit (FH-15.05); asset limit exceeded by added defaults (FH-106.02); display label submitted as asset ID (FH-100.03); schema version not checked at the database boundary (FH-30.04) |
| In-flight and failed operations | 14 | Edits discarded when a slower load finished (FH-101.01); retry created a duplicate because the idempotency key changed (AN-02.04); late success labelled newer edits saved (AN-17.03); unbounded cleanup after failure (AN-22.02) |
| Focus, keyboard and accessible text | 6 | Focus left on BODY after dialog close (FH-99.03); listbox options all tabbable (FH-16.03) |
| Layout against specification | 6 | Page scroll pushed Save off screen (FH-29.01); clipped panel at 125% text (FH-103.01) |
| Checks that fail open | 5 | Layer checker skipped unclassified files (FH-91.01); style checker skipped unresolved identifiers (FH-78.07) |
| Tests that could not fail | ~5 | Packaged proof pre-populated values through IPC, hiding the defect (FH-75.01); separate storage root missed a same-root conflict (FH-79.02) |
| Shipped artifact contents | 3 | Installer payload omitted the credential launcher (FH-87.01); retired launcher still packaged (FH-106.04) |
| Raw input overwritten by normalization | 3 | Per-keystroke filtering removed separators (FH-100.02, FH-101.01) |

Most rework came from implementation edge cases rather than wrong direction, which the three-line plan checkpoint is not designed to catch.

## Measuring the change

Compare `backlog.ps1 reviews --since <adoption date>` with the rates above after about twenty reviewed tasks. The heuristic baseline and the structured count are different instruments, so treat a small difference as noise.
