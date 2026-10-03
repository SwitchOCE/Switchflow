# Switchflow UI redesign spec

3 October 2026. This governs the aggressive redesign pass. Read it fully before touching your area.

## Why

The owner's original brief (22 September):

- Move the top bar into a sidebar.
- Make it clear which milestone or task is next.
- Task detail boxes must show their content.
- No endless full-history scrolling.
- Every action, spacing choice and formatting decision should meet industry standard.

The Codex pass fixed behaviour, but the interface still reads as boxes inside boxes. It has weak contrast between layers, uneven spacing, centred modals, and defensive prose. The owner's feedback: "the milestone page particularly feels pretty poor, a lot of the contrast between elements and clear visual separation and spacing across the app also leave a lot to be desired. Do not hesitate to redesign more aggressively."

Comparator research is in `analysis/ui-review-2026-09-22/REPORT.md`, covering Asana, Jira, Trello, Plane and Backlog.md. Its strongest conclusion stands: **a focused workset plus a contextual detail surface**, so the person can **orient → choose → read → act → return**. Use its evidence; overrule its taste where the result looks timid.

## Visual language

- **Three layers, always distinguishable.** Page background `--bg`, panels and cards `--surface` with a `--border` and `--shadow-1`, sunken areas such as lanes, table headers and code `--surface-2`. Never place a bordered box inside another bordered box when a divider or spacing would do.
- **Use the tokens only.** No hex literals in view CSS. Tokens are in `public/tokens.css`. Status colours are `--status-backlog|ready|progress|review|blocked|done`. Providers are `--claude` and `--codex`.
- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48 (`--space-1`…`--space-7`). Page padding is 32. Gaps are 24 between sections, 16 inside panels, and 8 between related controls.
- **Type scale:** 12, 13, 14 (body), 16, 20, 24 (page title). Use weights 400, 600 and 700 only. Secondary text uses `--text-2`; tertiary and meta text use `--text-3`.
- **Density:** rows 36–44px; buttons 32px; inputs 34px. Wide screens show more, not bigger.
- **Status is shown, not written.** Use `.status-dot` or `.status-pill` with `data-status="ready|in progress|review|blocked|done"` (lower-case). Use `.progress` with `<span style="width:x%;--status:…">` segments for progress.
- **Copy:** short and plain. State facts and the next action. Never write disclaimers such as "this does not establish authority" or "display order is not execution priority". Say it once in docs, if anywhere.
- **Empty states:** `.empty` with a one-line explanation and the creation action where one exists.

## Primitives (in `public/system.css`)

| Class | Use |
| --- | --- |
| `.page-header` > `div` (h1 + p) + `.page-actions` | Every view starts with this |
| `.toolbar` | Search, filters and view switches under the header |
| `.segmented` > `button[aria-pressed]` | Board/List and similar view switches |
| `.panel`, `.panel-header`, `.panel-body` | Raised surfaces |
| `.lane` | Sunken columns (board lanes) |
| `.data-table` | Aligned lists with sticky headers |
| `.button.primary`, `.button.quiet`, `.button.danger`, `.icon-button`, `.button-small` | Actions; one primary per region |
| `.badge` / `.chip`, `.count` | Labels and counts |
| `.status-dot`, `.status-pill` | Status |
| `.progress` | Progress bars |
| `dialog.sheet` (+ `.sheet-wide`) | Detail surface docked right, with the workset visible behind it; full screen below 760px |
| `.empty` | Empty states |

If you need a new shared primitive, add it in **your own CSS file**, namespaced, and list it in your handoff so the integrator can promote it.

## Patterns

- **Workset + sheet:** lists and boards stay put, and detail opens in `dialog.sheet`. Detail layout is a content column (max ~720px reading width) plus a properties rail (~260px) on wide sheets, stacking on narrow ones. Keep the existing focus return, Back/Forward and draft behaviour.
- **Lists over cards** when items are compared, e.g. milestones and list views. Use cards only on boards.
- **Bounded history:** keep the existing paging and "show older" behaviour. Never render unbounded lists.

## Constraints

- **Own only your files** (listed in your brief). Do not edit `tokens.css`, `system.css`, `styles.css`, `app.js`, `index.html`, `server.mjs` or anything outside `public/` except your area's tests. If the shell must change, say so in your handoff.
- Preserve behaviour and contracts. The `scripts/*.test.mjs` tests must pass; update assertions only when a test pins removed copy or markup, and say which. Keep draft safety, conflict handling, revision checks, write fencing, focus management, keyboard paths and ARIA.
- Format with the pinned Prettier: `npx prettier --write <your files>`.
- Verify in a browser: `UI_PORT=<your port> node analysis/ui-implementation-2026-09-22/fixture-server.mjs`. Check at 1600×900 in both themes (`localStorage['switchflow:theme']='dark'|'light'`), and at 390px wide. Fixture scenarios are at `/__fixture/scenario?name=scale|drag|empty|ordered`. Save 3–6 screenshots to `analysis/ui-redesign-2026-10-03/screenshots/<area>-*.png` (keep them small; JPEG-quality PNG is fine).
- Commit on your branch in small coherent commits whose messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
