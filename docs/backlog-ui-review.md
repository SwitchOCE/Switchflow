# Switchflow functionality review

The chosen interface is Switchflow's own top navigation, teal theme and initiative workflow. The native Backlog layout was rolled back at the user's request. Backlog's file model and request handlers remain underneath the custom interface; this reuses working behavior without restoring its sidebar.

## Capability review

| Area | Switchflow implementation |
| --- | --- |
| Human gates | Initiatives: Intake, Planning, autonomous delivery, UAT; scope changes, updates, recovery and framework health remain available |
| Tasks | Board/list, text and structured filters, full create/edit forms, acceptance criteria, indexed DoD, dependencies, block reason, owners, labels, priority, type, milestone, plans, notes, references and comments |
| Task movement | Drag reorder/status movement plus keyboard-accessible status and milestone selectors; complete/archive actions explain their effect |
| Drafts | Real governance drafts: create, edit with captured revision, promote into a task; browser unsaved drafts remain separate |
| Maintenance | Duplicate-ID review/repair and completed cleanup preview; cleanup explicitly applies its age rule at execution time, which can include newly eligible tasks |
| Milestones | Create metadata in one write; edit with captured revision; labels, descriptions and order separate from identity; assignments, counts, archive and remove handling |
| Documents | Authoring, metadata, nested folder navigation, full-text search, preview, headings, tables, lists, code copy, project-relative links and local asset images |
| Decisions | Create/edit title and structured Context, Decision, Consequences and optional Alternatives; invalid structure preserves the draft |
| Insights | Real status/priority/milestone counts and progress; Done tasks show last-updated dates without claiming completion timestamps |
| Settings | Human-readable configuration forms, latest-config merge preserving unknown fields, retained drafts and explicit discard |
| Navigation | Project selector, global search and Ctrl K, record bookmarks, legacy link redirects, light/dark appearance and responsive top navigation |
| Canonical governance | One service/port; worktrees resolve to primary governance; project identity accompanies every API request |

## Review repairs

Independent review found a disabled-form serialization bug, stale checklist edits, settings draft remount failure, edits accepted during pending saves, a cross-project browser-history race and misleading completion dates. These were corrected. Task values are captured before disabling and remain recoverable while read-only; settings and milestone forms freeze during writes. Project navigation cannot apply another project's record ID to the current project while a save is pending.

The backend review also closed missing draft revisions/locking and partial milestone creation. A captured Windows EPERM during decision-file replacement is handled by bounded retries without deleting the previous record; exhaustion remains an error and preserves the original bytes.

## Explicit boundaries

- Task and milestone edits use cooperating revision checks; document, decision and configuration APIs do not offer atomic CAS. Document/decision saves detect already-observed conflicts; settings merges edited fields into freshly read configuration.
- Archived milestones can be listed. Restore is unavailable in the native backend and is not offered as a working action.
- Raw HTML stays inert, external images do not load automatically, and Mermaid remains code. Local images must live in canonical backlog/assets.
- Task cleanup is an age-rule action, not an atomic exact-ID-set operation. Its confirmation describes that scope.
- The pinned fork's native diagnostic UI remains packaged, but normal Switchflow routes never serve or embed it.

See [verification](verification-0.5.0.md) for tested behavior and evidence boundaries. This candidate does not upgrade active consumer projects or imply human acceptance.
