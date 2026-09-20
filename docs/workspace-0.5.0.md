# Shared project workspace

The 0.5.0 candidate adds one browser service for multiple local projects, editable milestone metadata and dependency readiness. The primary interface uses Switchflow's design and top navigation. Initiatives retain Intake, Planning and UAT as the routine human gates; task management, documents and project controls are available alongside them. The [functionality review](backlog-ui-review.md) records the restored capabilities and their boundaries.

See the [verification record](verification-0.5.0.md) for automated checks, the live browser trial and its evidence boundaries.

## Projects and worktrees

Launch `Start Switchflow.cmd` in an updated project. The first launch opens a loopback service; subsequent project launches reuse it. Add another installed project from the top bar or launch that project's shortcut. The selector shows projects with running agents and pending attention. Each browser tab selects its own project, and every read or mutation names that project explicitly.

Registration requires an updated 0.5.x installation so older writers cannot silently skip the new record rules. Projects are identified by their canonical Git common directory. A linked code worktree resolves to the primary checkout, so it cannot register a second board. Tasks, milestones, documents, CLI and MCP operations use the primary governance wrapper and pinned runtime. If primary governance is unavailable, commands fail visibly rather than adopt a copied board. Existing worktree files are preserved as historical snapshots; the update neither deletes them nor merges potentially divergent records silently.

The shared service keeps the registry at `control-service/projects.json` beneath `SWITCHFLOW_HOME`, normally `%LOCALAPPDATA%/Switchflow`. Per-project approvals, logs and engine locks stay in the existing project state directories. Engines remain separate: at most one agent run per project, with separate projects able to progress simultaneously. Old service locks prevent a second engine from attaching to a project already running elsewhere. Updating or changing the shared port requires stopping the known service first.

## Milestone records

| Field | Meaning |
| --- | --- |
| `id` | Stable identity such as `m-12`; never execution priority |
| `title` | Human-readable outcome name |
| `description` | Scope and acceptance context |
| `labels` | Optional list of classifications |
| `executionOrder` | Optional non-negative integer; lower values sort first, without renumbering IDs |
| `revision` | Current record hash used to reject stale edits |

Open **Milestones**, select a record, edit its metadata and save. Blank execution order means unspecified. Ties do not create an execution dependency. Dependencies, the approved plan and readiness govern dispatch. Existing numeric IDs and task associations stay unchanged.

Milestone edits use the same cooperating fork lock and revision contract across CLI, MCP and the browser. A stale draft remains visible; load the latest record, compare and reconcile before saving again. Title changes preserve identity and references. Accepted scope changes still require the established scope-revision workflow; changing a metadata field does not grant new delivery authority.

## Dependency readiness

`blockReason` is optional through APIs and MCP, and serializes as `block_reason`. The exact value `dependent` is reserved for a task waiting only for unfinished dependencies. Any other nonempty text is a manual reason, such as `awaiting credentials`.

| Situation after a cooperating task write | Result |
| --- | --- |
| Ready task has an unfinished or missing dependency | Blocked, reason `dependent` |
| Blocked task with reason `dependent`, all dependencies Done or in completed storage | Ready, reason cleared |
| Another nonempty block reason exists | Remains Blocked until that reason is cleared |
| Legacy Blocked task has no recorded reason | Remains Blocked; classify or clear it explicitly |
| Backlog, In Progress, Review or Done task | No automatic promotion or regression |

Clearing an explicit reason permits readiness reconciliation; it does not erase dependencies. Reopening a dependency reblocks a Ready successor. Missing dependencies never count as complete. Reconciliation and task writes use the fork's shared workflow lock; every cooperating CLI/MCP/native writer must use that fork. Direct Markdown writes and old running binaries are outside the contract.

## Documentation

The Documents tab reads and edits canonical `backlog/docs`. Switchflow supports document creation, metadata, nested folders, full-text search, Markdown previews, heading navigation, code copy and record links. Decisions have their own tab and editor. Files retain their IDs and contents. Local image links resolve only into the selected project's `backlog/assets`; attachment responses remain sandboxed. External image requests and raw HTML execution are disabled.

Decision editing keeps Backlog's structured format: Context, Decision and Consequences, with optional Alternatives. The editor starts with these headings and saves the title and sections together. Unsupported structure produces an error without discarding the draft or partially creating a record.

The feature choices borrow from Material for MkDocs' [navigation](https://squidfunk.github.io/mkdocs-material/setup/setting-up-navigation/) and [search](https://squidfunk.github.io/mkdocs-material/setup/setting-up-site-search/) patterns. A separate MkDocs installation or second server is unnecessary for this local reader.

Document and decision editors retain drafts across navigation and browser-tab reloads. A pre-save comparison detects observed concurrent changes, but the native APIs have no atomic revision check for these record types. Coordinate simultaneous writers. Mermaid remains a code block; this is a bounded Markdown implementation rather than the full Material plugin collection. The `/control` route aliases the same Switchflow workspace.

## Upgrade and recovery

Use the reviewed [existing-project update](../SETUP.md#update-an-existing-project). Bring in wrappers, service, fork and governance rules together, with old services stopped. Existing fields expand compatibly and no user records are automatically removed. Back up governance and external state before updating; rollback restores runtime and data together so older serializers cannot discard new metadata.

This repository change does not upgrade active consumer projects or change personal MCP registrations automatically. Configure MCP through the canonical `.switchflow/scripts/backlog.ps1 mcp start` entry point. The explicit `browser-native` command remains for diagnostics; normal `browser`, `control` and shortcut entry points use the shared workspace.
