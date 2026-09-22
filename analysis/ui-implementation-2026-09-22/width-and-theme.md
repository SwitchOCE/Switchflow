# Wide layouts and blue-gray dark mode

Follow-up to the owner's screenshot on 2026-09-22. Changes are in the maintained template; installed consumer projects were not modified.

## Changes

- Removed the 78-character Markdown cap shared by Documents, Decisions, Skills and previews. Reading content, tables and code use the available column, with navigation and contents kept separate.
- Removed additional narrow prose limits in task and milestone readers and initiative details. Reduced desktop document padding from a maximum of 45px to 30px.
- Increased desktop task panels from a 900px ceiling to `min(1440px, 72vw)`. Expanded tasks use the full dialog content width. Initiative detail dialogs use `min(1600px, 80vw)` above 1100px.
- Removed the 1280px limit on Insights and Settings and the 340px desktop task-lane limit. Existing responsive layouts and bounded scrolling remain.
- Dark mode uses a blue-gray canvas (#141b27), surfaces (#1d2635), raised backgrounds (#263449), blue links (#93b9ff) and blue primary buttons (#315eb5). Skills and shared Markdown headings, tables, quotes, code and controls use these tokens. Light-mode colors remain unchanged. Semantic success/error indicators retain their meaning.

## Verification

Real template UI modules were exercised through the disposable in-memory fixture on port 65440. This verifies rendering and interactions, not consumer installation or native persistence.

- 2560×1440: document body increased from 631px to 1765px in its 1825px content column. Decisions used 1780px. Insights used 2257px of a 2305px main area, leaving only padding.
- At the same viewport, five visible task lanes grew to 441px each and filled the board; no page overflow. Task reader content was 1367px, increasing to 2463px in expanded mode.
- 1920×1080: document content and an editor-preview table both measured 1125px; initiative content measured 1463px. Visually checked dark document, code/table preview and initiative layouts, and confirmed light-mode switching preserved its palette.
- 390×844 task and 320×740 document checks: no horizontal page overflow; task dialog also had no internal horizontal overflow. Narrow navigation disclosures remained usable.
- Key dark-mode contrast ratios: primary text 12.59:1, muted text 7.41:1, accent on raised surface 6.36:1, white button text 6.18:1 (hover 5.21:1). This is a token check, not a formal accessibility audit.
- Browser error log was empty. Screenshot: [wide dark reader](wide-dark-reader.png).
- Integrated validation passed: 208 tests, zero failures or skips; disposable import, nine documents, local links, eleven rendered skills and cleanup checks passed. The first sandboxed attempt failed on cached Backlog runtime access; the authorized rerun passed. The final backdrop-only color adjustment was browser-checked afterward.
- `git diff --check` passed. Temporary preview server and tab were stopped; viewport override reset.
