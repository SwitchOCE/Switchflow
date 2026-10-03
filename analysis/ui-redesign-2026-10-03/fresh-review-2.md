# Switchflow UI: second independent review (fixture build, 2026-10-03)

**Verdict: SHIP WITH FIXES.** Most of the last review was fixed, and the review gates now live in the sheet footer. Both P1s below are about the owner's first request, "make it obvious what's next". The new milestone reorder gives a list whose numbers jump around, and the Overview still says "Nothing is ready to start" beside five tasks that are ready. Both fixes are small. Neither needs another redesign.

**Method:** fixture on :65480, own tab. Tested at 1920×1080, 1600×900, 1100×800 and 375×812, in light and dark, with a contrast script run over all 11 views. I walked these flows end to end:

- Overview → plan sheet → Request changes → sent.
- A UAT pass: preview start / running / fail / invalid / in use / multi-candidate, 20 checks, Request rework, Accept.
- Milestone reorder (Alt+↓ and Order these).
- Task quick status and edit/save.
- Document edit/save.
- Steering an agent, live and offline.
- Cold load while offline, then Retry.
- The recovery hold panel. I injected `activeRun.status='interrupted'` with 3 held processes, because the fixture has no scenario for it.

The pane was hidden, so close and animation timing was checked through the DOM, not screenshots.

## P1: blocks the owner's "what's next" requirement

**P1-1 · Milestones: reordering gives a list whose numbers don't match its order.**
- **Seen** (scale scenario):
  - Alt+↓ on the unordered "Accept and launch" gives it order 1. A second Alt+↓ says "Accept and launch is already last.", while the row sits at the top of the list with 11 rows below it.
  - After "Order these", Alt+↓ announces "moved down", but the row doesn't move. It now shows **2** at the top of the list, and **1 Milestone 13** appears 12 rows lower.
  - The list reads `2, –, –, –, –, –, –, –, –, –, –, –, 1, 3, 4, …`.
- **Why:** the list is grouped by state (In progress, then Up next), but the order numbers span both groups. Moving a milestone changes a number, not its place. Elsewhere:
  - "Order these" appears only on the *Not yet ordered* group, so the 11 in-progress milestones can never be bulk-ordered.
  - Drag only drops onto rows that already have an order (`target.dataset.ordered !== 'true'` returns early).
  - In Linear, Jira and Plane, the list you drag *is* the order.
- **Fix:**
  - Sort each group by execution order and number within the group, or show one flat list in execution order whenever any order exists.
  - Put "Order these" on every group that has unordered rows.
  - Let unordered rows accept drops. A drop should assign that row its order too.
  - Make the keyboard announcement name the neighbour ("Moved below Milestone 13").

**P1-2 · Overview: "Up next" still contradicts "Needs you".**
- **Seen:** the "Up next" card shows **0** with "Ready in an approved plan", and the panel says "Nothing is ready to start." In the same view, "Needs you" lists DEMO-1…5 as "Your task, ready to start", and Milestones shows "NEXT UP: DEMO-1". This was P1-1 last time. Needs you is now ranked by milestone, which is good, but the headline still says the opposite.
- **Fix:**
  - Rename the card and panel to "Agents up next".
  - Change the empty copy to "No agent work is ready. 5 of your tasks are ready → Needs you."
  - Better still: put a one-line "Next: DEMO-1 · Accept and launch" hero above the four stats, taken from the top of the Needs you ranking.

## P2: material friction or visible inconsistency

1. **Initiative footer: "request changes" works one way on Plan and another on UAT.**
   - **Plan:** "Request changes…" expands a textarea in the footer, with Cancel and "Send to the agent". This is good.
   - **UAT:** "Request rework…" scrolls the body to a separate "Something needs to change?" form, which has its own second "Request rework" button.
   - **UAT with a check marked Needs rework:**
     - The primary button is still the disabled "Accept delivered outcome", and Request rework stays `button quiet`.
     - "Your next action" still says "Try the result and record each check." even at 20 of 20 checked.
     - The required free-text field ignores the per-check notes you already wrote, so the same feedback gets typed twice.
   - **Fix:**
     - Use the Plan pattern on UAT.
     - When any check is marked rework, make "Request rework (n)" the primary button and the Accept button secondary or hidden.
     - Prefill the field with the failed checks and their notes, and make extra text optional.
2. **Feedback you send disappears.**
   - After "Send to the agent" on a plan, the message ("Split DEMO-2…") appears nowhere in the sheet, even with every disclosure open. It is stored in `messages` as type `update`, and the sheet never renders that type.
   - The activity log shows only the raw slug `request-changes` and "Human: request changes."
   - The toast says "Project action saved. The board is up to date.", which is generic and refers to "board", the Overview's internal name.
   - UAT rework feedback *is* shown, under a collapsed "Previous rework observations".
   - **Fix:**
     - Render the latest owner message in a "You asked for" block near the top of the sheet.
     - Change the toast to "Sent to the planning agent."
3. **Initiative sheet prose has no reading measure.**
   - Scope and plan paragraphs are 820px wide at 14px, about 115 characters per line. The long scope in the UAT fixture reads as a wall of text.
   - Tasks and milestones already cap prose at 574px, and Documents at 656px. This is the brief's explicit markdown-measure requirement.
   - **Fix:** apply the shared prose max-width (about 72ch) to `.detail-body` sections.
4. **Recovery hold: the safety button is live when it shouldn't be, and the next action is labelled wrongly.**
   - **Release is enabled too early.** With 2 processes "still running", "Release recovery hold" is enabled (`disabled=false`, full opacity). The render sets `release.disabled = running.length > 0`, but `setBusy()` (`app.js:359`) then re-enables every `#detail-content button[data-action]` that has no `data-blocked`. The server rejects the release with a 409, so the owner gets a button that only errors.
   - **Wrong owner, wrong place.** The footer reads "AGENT NEXT ACTION · Recovery hold. Open to follow progress." It is the owner's action, nothing is progressing, and the Stop and Release buttons sit mid-body, below scope and plan. The initiative card repeats "Open to follow progress".
   - **Process list is plain text.** Entries read like "claude · execution agent · process 4120 · still running", with no status styling.
   - **Fix:**
     - Set `release.dataset.blocked = String(running.length > 0)`.
     - Move "Stop the 2 running processes" and "Release recovery hold" into the footer, under "YOUR NEXT ACTION · Stop the agent processes left by the interrupted run".
     - Show the processes as rows with a status pill.
5. **Task quick status throws away your place.**
   - With the sheet scrolled 3000px into the description, changing Status in the properties rail rebuilds the sheet. Scroll returns to 0 and focus jumps to "Edit".
   - **Fix:** update the sheet in place, or restore `scrollTop` and focus on the Status select after re-rendering.
6. **Agents: three dead ends.**
   - **Offline send fails silently.** While offline, the textarea, Send and Stop stay enabled. Pressing Send shows the failure ("Disposable connection interruption Your message is kept.") at y=1084 in a 1080px viewport, in grey: the error banner and the "Transcript unavailable" line push the page to 1170px. Disable sending while offline and show send errors in `--danger-text` above the composer.
   - **Mobile composer is off-screen.** In the 375×812 detail view, the composer starts at y=923, below the fold, because the page header and provider chips take 258px. Pin the composer to the bottom and collapse the page header in the detail view.
   - **Failed session has no way forward.** The footer says "Retry or add an update on its initiative to continue." but there is no link to the initiative. Add an "Open initiative →" button. Rename "Settle" to "Mark handled".
7. **Milestone detail at 1920 wastes the main column.**
   - The scope column is 576px wide and stretched to 1005px tall, mostly empty.
   - Linked tasks are squeezed into the 460px rail, where titles are cut to 267px ("Read a substantial task and preserve the exa…").
   - **Fix:** keep Progress and Next up in the rail, and move Linked tasks under Scope in the main column.
8. **Visual separation is unchanged from the last review.**
   - **Panel borders:** 1.15:1 against the page in light, 1.41:1 in dark. The surface itself differs from the page by only 1.10:1 (light) and 1.11:1 (dark).
   - **Segmented controls:** in Board/List, the milestone filters and Steer now/Queue, the selected background `rgb(22,29,40)` sits on a track of `rgb(18,24,33)`, about 1.05:1. Only the text colour changes.
   - The owner named "strong contrast and clear visual separation" explicitly.
   - **Fix:**
     - Raise `--border` to about 1.5:1 in light (e.g. `#cfd5de`) and about 1.9:1 in dark (e.g. `#334155`).
     - Give `.segmented [aria-pressed=true]` a `--surface-3` or accent-tint fill plus a 1px border.

## P3: polish

- **Preview bar:**
  - It scrolls out of view while you work through 20 checks. Mirror "Preview running · Open ↗" in the sticky "n of 20 checked" header.
  - An *invalid* config shows "Not configured" plus "add .switchflow/preview.json…" before the actual error. Label it "Config invalid" and lead with the error.
  - "In use" doesn't say which initiative is using it.
  - The candidate picker renders after the Start button.
- **Activity log copy:**
  - "1 retained events" (plural bug).
  - "Runtime retention is limited to the latest 200; older discarded records are unavailable." is the kind of disclaimer the spec bans.
  - The filter shows raw slugs ("request-changes").
  - Dates read "10/3/2026, 5:43:42 PM" here but "05:42 PM" elsewhere.
- **Plurals and labels:**
  - "1 reviews · 5 tasks".
  - Primary verbs mix "New document / New milestone" with "Create task / Create draft".
  - The offline banner says "…then refresh", but the app recovers by itself (about 1s after the server returns).
- **Not fixed from last time:**
  - The Overview's URL is `view=board`, and Insights is `view=statistics`.
  - The tab title never names the view or record.
  - Ctrl K still can't find milestones: "Establish" returns "No matching records".
  - The Overview ID tags are 11px (28 nodes), below the 12px floor.
- **Editor bar:** "No changes yet · Discard · Cancel · Save". Hide Discard until something has changed.
- **Footer weight:**
  - At 1100×800 the plan footer is 163px at rest (20% of the sheet) and 320px with Request changes open (40%). Move the gate notes ("Approving this plan authorizes…" and the routing sentence) into the body.
  - On mobile, the sheet header (137px) and footer (125px) take 32% of the height, and the footer buttons are 32px tall, under the 44px touch target.
- **Milestone drag handle:** 6×14px, and invisible until hover. Make the whole row draggable, or the handle 24×24px.
- **Agents:**
  - The provider glyphs are 2.10:1 (Codex "X", dark) and 2.71:1 (Claude "C", dark).
  - "Working" uses a grey dot, the same as neutral states.
  - The collapsed rail hides the live indicator.
- **Page height:** at 1080 and 900 heights, the Tasks page scrolls 8–9px on top of each lane's own scroll. Trim the lane `max-height` calc.
- **Sidebar:** at 1100×800 it still needs its own scrollbar. Consider switching to the rail automatically below 1200px.
- **Too many feedback routes:** an initiative under review has three ways to give feedback (Request changes, Add a project update, Propose a scope change). Keep Request changes in the footer and fold the other two into one "More" disclosure.

## Fixed since the last review

- [x] Request changes sits beside Approve (old P2-4).
- [x] Initiative URLs: `?initiative=` opens the sheet on load (P2-5).
- [x] Cold load while offline: the requested view is active, with "Can't reach the Switchflow service", start instructions and "Retry now" (P2-6).
- [x] "Decisions" in the Overview is now "reviews" (P2-7).
- [x] The collapsed rail shows an attention dot, and the badge contrast passes (P2-8).
- [x] Milestones scroll once: page height equals the viewport, and list and detail scroll separately (P2-9).
- [x] Prose is about 574px in the two-column milestone detail (P1-3).
- [x] One shared editor bar for tasks, documents and milestones. No false "unsaved edits" after Cancel. The milestone editor header shows the title (P2-1, P2-2).
- [x] Task quick status in the rail; the sheet stays open after Save with "Saved." (P2-10). There is a scroll regression (P2-5 above).
- [x] Board fits five lanes at 1600 (Done ends at 1558px). Done shows the newest 20, then "Show 20 more · 130 not shown" (P2-12).
- [x] Agents: ended sessions lose the composer; mobile goes list → detail with "← Sessions" (P2-11, partly).
- [x] One refresh control ("Updated hh:mm" + icon) in every view header. Documents and Decisions no longer list records twice.
- [~] Milestone reorder exists (drag, Alt+↑/↓, Order these), but see P1-1.
- [ ] Overview "next" contradiction (P1-1, carried over as P1-2), border contrast, segmented selected state, Ctrl K milestones, tab title, 11px text.

## What's genuinely good

- **Gate footer:** "YOUR NEXT ACTION" with the decision buttons, docked on every review sheet. Request changes asks for the text in place and keeps the plan visible.
- **Guided UAT:** a sticky "n of 20 checked" header with a segmented progress bar. Marking "Needs rework" opens "What you observed". Progress survives a reload.
- **Preview bar:** compact, polls by itself, and handles every state. A failure opens the last output automatically. It stops itself on accept or rework, and "Open ↗" only links to loopback addresses.
- **Offline:** recovery is quick and keeps your drafts, including the agent composer draft.
- **Bounded histories everywhere:** comments, the Done lane, the Needs you list ("Show 2 more") and the milestone list ("Show 3 more").
- **Dark theme:** blue-grey (`rgb(13,18,25)` page), and body text passes AA in every view in both themes.
- **Task sheet:** a sticky header and properties rail, a 574px reading measure, and an edit textarea that grows to fit (756px for the 45-step description).
