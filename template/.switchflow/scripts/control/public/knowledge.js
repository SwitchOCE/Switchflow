import { renderDocument, renderMarkdown, resolveDocumentLink, documentImageUrl } from './documents.js';
import { formatProjectDate } from './ui-date.js';
import {
  escapeHtml as esc,
  draftFrom,
  folderOf,
  knowledgePayload,
  recordFingerprint,
  knowledgeFieldComparison,
  matchesSearch,
  decisionTone,
  statusLabel,
  tocEntries,
  draftChanged,
} from './knowledge-model.js';

// Markdown inserted around the selection by the editor toolbar and its shortcuts.
const FORMATS = [
  ['heading', 'Heading', ['\n## ', '']],
  ['bold', 'Bold', ['**', '**'], 'b'],
  ['italic', 'Italic', ['_', '_'], 'i'],
  ['link', 'Link', ['[', '](relative-document.md)'], 'k'],
  ['code', 'Code', ['\n```\n', '\n```\n']],
  ['list', 'List', ['\n- ', '']],
  ['checklist', 'Checklist', ['\n- [ ] ', '']],
  ['quote', 'Quote', ['\n> ', '']],
];
const DOCUMENT_TYPES = ['readme', 'guide', 'specification', 'other'];
// Reader widths (px) at which the contents rail and the navigator get their own columns.
const WIDE = 1080;
const MEDIUM = 640;

// The native endpoints do not offer compare-and-swap. A pre-save comparison catches
// observed changes; the UI explicitly describes the remaining concurrent-write window.
export function mountKnowledge(
  container,
  {
    api,
    projectId,
    canWrite = () => true,
    onChange = () => {},
    onNavigate = () => {},
    onOpenRecord = async () => {},
    kind = 'documents',
  },
) {
  const endpoint = kind === 'decisions' ? '/decisions' : '/docs';
  const noun = kind === 'decisions' ? 'decision' : 'document';
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  const Kind = kind[0].toUpperCase() + kind.slice(1);
  const key = `switchflow:knowledge:${projectId}:${kind}`;
  let discarded = null;
  let records = [],
    loaded = false,
    linkedRecords = [],
    current = null,
    draft = null,
    baseline = null,
    original = null,
    destroyed = false,
    generation = 0,
    listGeneration = 0,
    busy = false,
    layout = '',
    spy = null,
    resize = null;
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    /* Storage can be unavailable. */
  }
  if (stored && (!stored.draft || typeof stored.draft.title !== 'string' || typeof stored.draft.content !== 'string'))
    stored = null;
  container.classList.add('knowledge-reader');
  container.innerHTML = `<header class="page-header"><div><h1>${Kind}</h1><p>${kind === 'decisions' ? 'Choices the project has made, with their context and consequences.' : 'Project instructions, guides and specifications agents read.'}</p></div><div class="page-actions"><button type="button" class="button primary" data-action="new">New ${noun}</button></div></header><div class="toolbar kn-toolbar"><input type="search" placeholder="Search titles, tags and content" aria-label="Search ${kind}"><button type="button" class="button quiet" data-action="refresh">Refresh</button><span class="kn-total"></span><p class="docs-status" role="status" aria-live="polite"></p></div><div class="knowledge-resume"></div><div class="kn-layout" data-layout="wide" data-mode="read"><details class="knowledge-browse kn-browse" open><summary>Browse</summary><nav class="kn-nav" aria-label="${Kind}"></nav></details><details class="knowledge-contents kn-contents" open><summary><span class="kn-label-long">On this page</span><span class="kn-label-short">Contents</span></summary><nav class="kn-toc" aria-label="On this page"></nav></details><div class="kn-main"></div></div>`;
  const find = s => container.querySelector(s),
    content = find('.kn-main'),
    nav = find('.kn-nav'),
    toc = find('.kn-toc'),
    status = find('.docs-status'),
    search = find('input[type=search]'),
    frame = find('.kn-layout');
  const narrow = window.matchMedia('(max-width: 799px)');
  // Layout follows the reader's own width, so the sidebar state is accounted for.
  function applyLayout(width) {
    const next = width >= WIDE ? 'wide' : width >= MEDIUM ? 'medium' : 'narrow';
    if (next === layout) return;
    layout = next;
    frame.setAttribute('data-layout', next);
    find('.knowledge-browse').open = next !== 'narrow';
    find('.knowledge-contents').open = next === 'wide';
  }
  const mediaLayout = () => applyLayout(narrow.matches ? 0 : WIDE);
  if (typeof ResizeObserver === 'function') {
    resize = new ResizeObserver(([entry]) => applyLayout(entry.contentRect.width));
    resize.observe(frame);
  } else {
    mediaLayout();
    narrow.addEventListener('change', mediaLayout);
  }
  function report(text, error = false) {
    if (destroyed) return;
    status.textContent = text;
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function permission() {
    return typeof canWrite === 'function' ? canWrite() : !!canWrite;
  }
  function controls() {
    for (const b of container.querySelectorAll('[data-action="save"],[data-action="edit"],[data-action="new"]')) {
      b.disabled = busy || !permission();
      b.title = !permission() ? 'Editing is paused while an agent is active.' : '';
    }
  }
  function persist() {
    // An editor opened and left untouched is not a draft worth recovering.
    stored = draft && changed() ? { draft, baseline } : null;
    try {
      if (stored) sessionStorage.setItem(key, JSON.stringify(stored));
      else sessionStorage.removeItem(key);
    } catch {
      report('Draft remains open, but this browser could not store it for recovery.', true);
    }
  }
  // The editable fields a draft started from, when they are still known.
  function startingPoint() {
    if (!draft) return null;
    if (!draft.id) return draftFrom(null, kind);
    return current?.id === draft.id && recordFingerprint(current) === baseline ? draftFrom(current, kind) : null;
  }
  function changed() {
    return draftChanged(draft, original);
  }
  function resumeNotice() {
    const name = stored?.draft?.title?.trim();
    find('.knowledge-resume').innerHTML =
      (stored && !draft
        ? `<div class="banner kn-banner"><span>Unsaved edits${name ? ` to <strong>${esc(name)}</strong>` : ` to a new ${noun}`} are kept in this tab.</span><span class="kn-banner-actions"><button type="button" class="button primary button-small" data-action="resume">Resume editing</button><button type="button" class="button quiet button-small" data-action="discard-stored">Discard edits</button></span></div>`
        : '') +
      (discarded
        ? `<div class="banner kn-banner"><span>Edits discarded. You can restore them until you leave this view.</span><span class="kn-banner-actions"><button type="button" class="button quiet button-small" data-action="undo-discard">Undo discard</button></span></div>`
        : '');
  }
  function updatedOf(record) {
    return kind === 'decisions' ? record.date : record.updatedDate || record.createdDate;
  }
  function date(value) {
    return value ? formatProjectDate(value) : '';
  }
  function pill(record) {
    return record.status
      ? `<span class="status-pill" data-status="${decisionTone(record.status)}">${esc(statusLabel(record.status))}</span>`
      : '';
  }
  // Secondary line in the navigator and index: decisions show status and date.
  function rowMeta(record) {
    if (kind === 'decisions')
      return `${pill(record)}${record.date ? `<time datetime="${esc(record.date)}">${esc(date(record.date))}</time>` : ''}`;
    return record.type && record.type !== 'other' ? `<span>${esc(statusLabel(record.type))}</span>` : '';
  }
  function visibleRecords() {
    return records.filter(r => matchesSearch(r, search.value));
  }
  function list() {
    const searching = !!search.value.trim();
    const visible = visibleRecords();
    find('.kn-total').textContent = !loaded
      ? ''
      : searching
        ? `${visible.length} of ${records.length}`
        : `${records.length} ${records.length === 1 ? noun : kind}`;
    frame.setAttribute('data-empty', String(loaded && !records.length));
    const closed = new Set([...nav.querySelectorAll('details:not([open])')].map(node => node.dataset.folder));
    const currentFolder = current ? `/${folderOf(current)}` : '';
    const root = { folders: new Map(), records: [], total: 0 };
    for (const record of visible) {
      let folder = root;
      folder.total++;
      for (const part of folderOf(record).split('/').filter(Boolean)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), records: [], total: 0 });
        folder = folder.folders.get(part);
        folder.total++;
      }
      folder.records.push(record);
    }
    const rows = items =>
      items.length
        ? `<ul>${items
            .map(r => {
              const meta = rowMeta(r);
              return `<li><button type="button" class="kn-item" data-record="${esc(r.id)}"${r.id === current?.id ? ' aria-current="page"' : ''}><span class="kn-item-title">${esc(r.title)}</span>${meta ? `<span class="kn-item-meta">${meta}</span>` : ''}</button></li>`;
            })
            .join('')}</ul>`
        : '';
    const tree = (folder, parent = '') =>
      rows(folder.records) +
      [...folder.folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => {
          const path = `${parent}/${name}`;
          const open = searching || !closed.has(path) || currentFolder === path || currentFolder.startsWith(`${path}/`);
          return `<details class="kn-folder" data-folder="${esc(path)}"${open ? ' open' : ''}><summary><span class="kn-folder-name">${esc(name)}</span><span class="count">${child.total}</span></summary>${tree(child, path)}</details>`;
        })
        .join('');
    nav.innerHTML = visible.length
      ? tree(root)
      : !loaded
        ? `<p class="kn-nav-note">Loading ${kind}…</p>`
        : searching
          ? '<p class="kn-nav-note">No matches.</p>'
          : `<p class="kn-nav-note">No ${kind} yet.</p>`;
  }
  function setActiveSection(id) {
    let active = null;
    for (const link of toc.querySelectorAll('[data-doc-anchor]')) {
      if (link.dataset.docAnchor === id) {
        link.setAttribute('aria-current', 'location');
        active = link;
      } else link.removeAttribute('aria-current');
    }
    // Keep the highlighted entry visible inside a long, independently scrolling rail.
    const rail = find('.knowledge-contents');
    if (active && layout === 'wide' && rail.scrollHeight > rail.clientHeight) {
      const top = active.offsetTop;
      if (top < rail.scrollTop || top + active.offsetHeight > rail.scrollTop + rail.clientHeight)
        rail.scrollTop = Math.max(0, top - rail.clientHeight / 3);
    }
  }
  function watchSections(entries) {
    spy?.disconnect();
    spy = null;
    if (typeof IntersectionObserver !== 'function' || !entries.length) return;
    const byId = new Map([...content.querySelectorAll('[id^="doc-heading-"]')].map(node => [node.id, node]));
    const headings = entries.map(entry => byId.get(`doc-heading-${entry.id}`)).filter(Boolean);
    if (!headings.length) return;
    const update = () => {
      if (destroyed || !headings[0].isConnected) return;
      const line = window.innerHeight / 3;
      let active = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= line) active = heading;
        else break;
      }
      const end = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= end.scrollHeight - 4) active = headings.at(-1);
      setActiveSection(active.id.slice('doc-heading-'.length));
    };
    spy = new IntersectionObserver(update, { rootMargin: '0px 0px -66% 0px', threshold: [0, 1] });
    for (const heading of headings) spy.observe(heading);
  }
  function anchor(id) {
    try {
      id = decodeURIComponent(id);
    } catch {}
    const heading = [...content.querySelectorAll('[id]')].find(el => el.id === `doc-heading-${id}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
    if (heading) setActiveSection(id);
  }
  function linkRecords() {
    const map = (values, view) =>
      values.map(r => ({
        id: r.path || r.id,
        record: r.id,
        view,
        ...(view === 'documents' ? { documentId: r.id } : { decisionId: r.id }),
      }));
    return [...map(records, kind), ...map(linkedRecords, kind === 'documents' ? 'decisions' : 'documents')];
  }
  function hydrateLinks() {
    if (!current || draft) return;
    for (const a of content.querySelectorAll('[data-doc-link]')) {
      const target = resolveDocumentLink(a.dataset.docLink, current.path || current.id, linkRecords(), kind);
      if (target?.external) {
        a.href = target.external;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        delete a.dataset.docLink;
      } else if (target) {
        a.href = '#';
        a.removeAttribute('title');
      } else {
        a.removeAttribute('href');
        a.title = 'Link is outside the project documentation or unsupported.';
      }
    }
  }
  // With nothing selected the centre column lists every record with its metadata.
  function landing() {
    const visible = visibleRecords();
    const searching = !!search.value.trim();
    if (!loaded) return `<div class="panel kn-index"><p class="kn-nav-note">Loading ${kind}…</p></div>`;
    if (!records.length)
      return `<div class="panel kn-index"><div class="empty"><strong>No ${kind} yet</strong><span>${kind === 'decisions' ? 'Record a choice with its context and consequences so agents follow it.' : 'Write guides and specifications that agents read before they work.'}</span><button type="button" class="button primary" data-action="new">New ${noun}</button></div></div>`;
    if (!visible.length)
      return `<div class="panel kn-index"><div class="empty"><strong>No matches</strong><span>Nothing matches “${esc(search.value.trim())}”.</span><button type="button" class="button quiet" data-action="clear-search">Clear search</button></div></div>`;
    return `<section class="panel kn-index" aria-label="${searching ? 'Search results' : `All ${kind}`}"><header class="panel-header"><h2>${searching ? 'Search results' : `All ${kind}`}</h2><span class="count">${visible.length}</span></header><ul>${visible
      .map(r => {
        const folder = folderOf(r);
        const when = updatedOf(r);
        return `<li><button type="button" class="kn-index-row" data-record="${esc(r.id)}"><span class="kn-index-title">${esc(r.title)}</span><span class="kn-index-meta">${kind === 'decisions' ? pill(r) : `${folder ? `<span class="kn-index-folder">${esc(folder)}</span>` : ''}${r.type && r.type !== 'other' ? `<span class="chip">${esc(statusLabel(r.type))}</span>` : ''}`}${when ? `<time datetime="${esc(when)}">${esc(date(when))}</time>` : ''}</span></button></li>`;
      })
      .join('')}</ul></section>`;
  }
  function reader() {
    frame.setAttribute('data-mode', 'read');
    // With nothing selected the index is the list, so the navigator steps aside.
    frame.setAttribute('data-selected', String(!!current));
    if (!current) {
      spy?.disconnect();
      spy = null;
      frame.setAttribute('data-toc', 'none');
      content.innerHTML = landing();
      toc.innerHTML = '';
      controls();
      return;
    }
    const rendered = renderDocument({
      id: current.path || current.id,
      title: current.title,
      markdown: current.rawContent || '',
    });
    const parts = rendered.parts || { title: '', article: rendered.html, titleHeading: null };
    const when = updatedOf(current);
    const chips =
      kind === 'decisions'
        ? pill(current)
        : `${current.type && current.type !== 'other' ? `<span class="chip">${esc(statusLabel(current.type))}</span>` : ''}${(current.tags || []).map(tag => `<span class="chip kn-tag">${esc(tag)}</span>`).join('')}`;
    const meta = `${chips}${when ? `<span class="kn-doc-date">${kind === 'decisions' ? 'Decided' : 'Updated'} <time datetime="${esc(when)}">${esc(date(when))}</time></span>` : ''}`;
    content.innerHTML = `<article class="panel kn-doc" aria-label="${esc(current.title)}"><header class="kn-doc-header"><p class="kn-doc-path">${esc(current.path || current.id)}</p><div class="kn-doc-titlebar">${parts.title}<div class="knowledge-actions"><button type="button" class="button quiet" data-action="edit" aria-label="Edit ${noun}">Edit</button></div></div>${meta ? `<div class="kn-doc-meta">${meta}</div>` : ''}</header>${parts.article}</article>`;
    for (const placeholder of content.querySelectorAll('[data-doc-image]')) {
      const url = documentImageUrl(placeholder.dataset.docImage, current.path, projectId);
      if (url) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = placeholder.dataset.imageAlt || '';
        image.loading = 'lazy';
        image.className = 'docs-image';
        image.addEventListener('error', () => image.replaceWith(placeholder));
        placeholder.replaceWith(image);
      }
    }
    const entries = tocEntries(rendered.headings, parts.titleHeading);
    frame.setAttribute('data-toc', entries.length ? 'some' : 'none');
    toc.innerHTML = entries.length
      ? `<p class="kn-toc-title">On this page</p><ul>${entries.map(h => `<li><a href="#${esc(h.id)}" class="kn-toc-link" data-depth="${h.depth}" data-doc-anchor="${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul>`
      : '';
    hydrateLinks();
    controls();
    watchSections(entries);
  }
  async function open(id, fragment = '') {
    if (draft || busy) {
      report('Save or close the unsaved edits before switching records.', true);
      return false;
    }
    const ticket = ++generation;
    report(`Loading ${noun}…`);
    try {
      const result = await api(`${endpoint}/${encodeURIComponent(id)}`);
      if (destroyed || ticket !== generation) return false;
      current = result;
      reader();
      list();
      find('.knowledge-browse').open = layout !== 'narrow';
      onNavigate({ view: kind, record: result.id });
      report('');
      if (fragment) anchor(fragment);
      else if (frame.getBoundingClientRect?.().top < 0) frame.scrollIntoView({ block: 'start' });
      return true;
    } catch (error) {
      if (!destroyed && ticket === generation) report(error.message, true);
      return false;
    }
  }
  async function refresh() {
    controls();
    const ticket = ++listGeneration;
    if (!records.length) report(`Loading ${kind}…`);
    try {
      const result = await api(endpoint);
      if (destroyed || ticket !== listGeneration) return;
      // Docs list metadata excludes body; fetch bounded batches for genuine full-text search.
      const full = [];
      let unreadable = 0;
      for (let i = 0; i < result.length; i += 6) {
        const batch = await Promise.all(
          result.slice(i, i + 6).map(async r => {
            try {
              return { ...r, ...(await api(`${endpoint}/${encodeURIComponent(r.id)}`)) };
            } catch {
              unreadable++;
              return r;
            }
          }),
        );
        if (destroyed || ticket !== listGeneration) return;
        full.push(...batch);
      }
      let cross = [];
      try {
        cross = await api(kind === 'documents' ? '/decisions' : '/docs');
      } catch {
        unreadable++;
      }
      if (destroyed || ticket !== listGeneration) return;
      const changed = !loaded || JSON.stringify(records) !== JSON.stringify(full);
      records = full;
      loaded = true;
      linkedRecords = cross;
      if (changed) {
        list();
        if (!current && !draft) reader();
      }
      hydrateLinks();
      controls();
      if (!unreadable && !draft) report('');
      if (unreadable)
        report(
          `${unreadable} records could not be read. Content search is incomplete; opening a record shows its error.`,
          true,
        );
    } catch (error) {
      if (!destroyed && ticket === listGeneration) report(error.message, true);
    }
  }
  function preview() {
    const panel = find('.knowledge-preview');
    if (panel)
      panel.innerHTML = renderMarkdown(draft.content).html || '<p class="kn-preview-empty">Nothing to preview yet.</p>';
  }
  function editor() {
    generation++;
    spy?.disconnect();
    spy = null;
    toc.innerHTML = '';
    frame.setAttribute('data-mode', 'edit');
    original = startingPoint();
    resumeNotice();
    const fields =
      kind === 'documents'
        ? `<div class="kn-editor-fields"><label class="kn-field-title">Title<input name="title" required maxlength="300" value="${esc(draft.title)}"></label><label>Type<select name="type">${DOCUMENT_TYPES.map(t => `<option value="${t}"${draft.type === t ? ' selected' : ''}>${statusLabel(t)}</option>`).join('')}</select></label><label>Folder<input name="folder" placeholder="e.g. guides" value="${esc(draft.folder)}"></label><label>Tags<input name="tags" placeholder="Comma separated" value="${esc(draft.tags)}"></label></div>`
        : `<div class="kn-editor-fields"><label class="kn-field-title">Title<input name="title" required maxlength="300" value="${esc(draft.title)}"></label></div><p class="kn-editor-hint">Keep the Context, Decision and Consequences sections. Alternatives is optional. Status and date are kept.</p>`;
    content.innerHTML = `<form class="panel knowledge-editor kn-editor" data-pane="write" aria-label="${draft.id ? 'Edit' : 'New'} ${noun}"><header class="kn-editor-head"><p class="kn-editor-kicker">${draft.id ? `Editing ${noun}` : `New ${noun}`}</p><h2 class="kn-editor-title">${esc(draft.title.trim() || `Untitled ${noun}`)}</h2>${fields}</header><div class="knowledge-conflict"></div><div class="kn-split"><section class="kn-pane kn-pane-source" aria-label="Markdown"><div class="kn-pane-bar"><div class="knowledge-format" role="group" aria-label="Markdown formatting">${FORMATS.map(([action, title, , shortcut]) => `<button type="button" class="button quiet button-small" data-format="${action}"${shortcut ? ` title="${title} (Ctrl+${shortcut.toUpperCase()})" aria-keyshortcuts="Control+${shortcut.toUpperCase()}"` : ''}>${title}</button>`).join('')}</div><div class="segmented kn-pane-switch" role="group" aria-label="Editor view"><button type="button" data-pane-switch="write" aria-pressed="true">Write</button><button type="button" data-pane-switch="preview" aria-pressed="false">Preview</button></div></div><textarea name="content" rows="18" spellcheck="true" aria-label="Markdown">${esc(draft.content)}</textarea></section><section class="kn-pane kn-pane-preview" aria-label="Preview"><div class="kn-pane-bar"><span class="kn-pane-label">Preview</span><div class="segmented kn-pane-switch" role="group" aria-label="Editor view"><button type="button" data-pane-switch="write" aria-pressed="false">Write</button><button type="button" data-pane-switch="preview" aria-pressed="true">Preview</button></div></div><article class="knowledge-preview docs-prose"></article></section></div><div class="editor-bar knowledge-savebar"><span class="editor-state knowledge-save-state" role="status"></span><div class="editor-actions"><button type="button" class="button quiet" data-action="compare" hidden title="Check the saved ${noun} again">Compare again</button><button type="button" class="button quiet" data-action="discard">Discard</button><button type="button" class="button quiet" data-action="cancel" title="Close the editor. Unsaved changes stay in this tab.">Cancel</button><button type="submit" class="button primary" data-action="save">Save ${noun}</button></div></div></form>`;
    preview();
    editorState();
    controls();
    find('[name=title]').focus();
  }
  function collect() {
    for (const field of content.querySelectorAll('[name]')) draft[field.name] = field.value;
    persist();
  }
  function saveState(text, state = 'dirty') {
    const node = find('.knowledge-save-state');
    if (!node) return;
    node.textContent = text;
    node.setAttribute('data-state', state);
  }
  // Reflect whether there is anything to save, and keep the heading on the current title.
  function editorState() {
    if (!draft) return;
    const heading = find('.kn-editor-title');
    if (heading) heading.textContent = draft.title.trim() || `Untitled ${noun}`;
    if (changed()) saveState('Unsaved changes · kept in this tab');
    else saveState('No changes yet', '');
  }
  async function compare() {
    if (!draft?.id) return true;
    const comparingDraft = draft;
    const latest = await api(`${endpoint}/${encodeURIComponent(draft.id)}`);
    if (destroyed || draft !== comparingDraft) return false;
    if (recordFingerprint(latest) === baseline) return true;
    saveState('Saved version changed · your edits are kept', 'error');
    find('[data-action="compare"]')?.removeAttribute('hidden');
    find('.knowledge-conflict').innerHTML =
      `<div class="kn-conflict" role="alert"><div class="kn-conflict-head"><strong>The saved ${noun} changed while you were editing.</strong><p>Your edits are kept. Compare the differences below and copy what you need. Discard loads the saved version and offers Undo.</p></div>${
        knowledgeFieldComparison(draft, latest, kind)
          .map(
            row =>
              `<section class="knowledge-field-comparison"><h3>${esc(row.label)}</h3><div><h4>Your unsaved version</h4><pre>${esc(row.mine || '(empty)')}</pre></div><div><h4>Latest saved version</h4><pre>${esc(row.saved || '(empty)')}</pre></div></section>`,
          )
          .join('') || '<p>Record metadata changed. Reload before editing again.</p>'
      }</div>`;
    find('.knowledge-conflict').scrollIntoView?.({ block: 'nearest' });
    return false;
  }
  async function save() {
    if (!draft || busy) return;
    if (!permission()) {
      report('Editing is paused while an agent is active. Your draft is retained.', true);
      return;
    }
    collect();
    let payload;
    try {
      payload = knowledgePayload(draft, kind);
    } catch (error) {
      report(error.message, true);
      return;
    }
    busy = true;
    controls();
    saveState('Saving…');
    for (const f of content.querySelectorAll('input,textarea,select,button')) f.disabled = true;
    try {
      if (!(await compare())) {
        report('Save stopped because the saved version changed.', true);
        return;
      }
      if (destroyed || !permission()) return;
      const id = draft.id;
      const result = await api(id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint, {
        method: id ? 'PUT' : 'POST',
        body: payload,
      });
      if (destroyed) return;
      draft = null;
      baseline = null;
      persist();
      resumeNotice();
      busy = false;
      await refresh();
      if (id || result?.id) await open(id || result.id);
      else reader();
      report(`${Noun} saved.`);
      onChange();
    } catch (error) {
      saveState('Not saved · your edits are kept', 'error');
      report(`${error.message} Your draft is retained.`, true);
    } finally {
      busy = false;
      if (!destroyed) {
        for (const f of content.querySelectorAll('input,textarea,select,button')) f.disabled = false;
        controls();
      }
    }
  }
  function format(action) {
    const area = find('textarea');
    const pair = FORMATS.find(([name]) => name === action)?.[2];
    if (!area || !pair) return;
    area.setRangeText(
      pair[0] + area.value.slice(area.selectionStart, area.selectionEnd) + pair[1],
      area.selectionStart,
      area.selectionEnd,
      'select',
    );
    collect();
    preview();
    area.focus();
  }
  function showPane(pane) {
    const form = find('.kn-editor');
    if (!form) return;
    form.setAttribute('data-pane', pane);
    for (const button of form.querySelectorAll('[data-pane-switch]'))
      button.setAttribute('aria-pressed', String(button.dataset.paneSwitch === pane));
    if (pane === 'write') find('textarea').focus();
  }
  const click = async event => {
    const target = event.target.closest('button,a');
    if (!target || !container.contains(target)) return;
    if (target.dataset.record) return open(target.dataset.record);
    if (target.hasAttribute('data-doc-anchor')) {
      event.preventDefault();
      // Collapse the disclosure first so the scroll lands on the final layout.
      if (layout !== 'wide' && target.closest('.knowledge-contents')) find('.knowledge-contents').open = false;
      anchor(target.dataset.docAnchor);
      return;
    }
    if (target.hasAttribute('data-doc-link')) {
      event.preventDefault();
      if (draft || busy) return;
      const dest = resolveDocumentLink(target.dataset.docLink, current?.path || current?.id || '', linkRecords(), kind);
      if (dest?.view && dest.view !== kind) {
        try {
          await onOpenRecord(dest);
        } catch (error) {
          report(error.message, true);
        }
      } else if (dest?.id) {
        const record = records.find(r => (r.path || r.id) === dest.id);
        if (record && record.id !== current.id) await open(record.id, dest.anchor);
        else if (dest.anchor) anchor(dest.anchor);
      }
      return;
    }
    if (target.hasAttribute('data-copy-code')) {
      try {
        await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent);
        report('Code copied.');
      } catch {
        report('Copy unavailable. Select the text and copy manually.', true);
      }
      return;
    }
    if (target.dataset.paneSwitch && draft) {
      showPane(target.dataset.paneSwitch);
      return;
    }
    if (busy) return;
    if (target.dataset.format && draft) {
      format(target.dataset.format);
      return;
    }
    switch (target.dataset.action) {
      case 'refresh':
        await refresh();
        if (current && !draft) await open(current.id);
        break;
      case 'clear-search':
        search.value = '';
        list();
        reader();
        search.focus();
        break;
      case 'new':
      case 'edit':
        if (!permission() || draft) {
          report('Finish the open draft before starting another.', true);
          break;
        }
        if (stored) {
          report('Resume or discard the saved draft before starting another.', true);
          break;
        }
        draft = draftFrom(target.dataset.action === 'edit' ? current : null, kind);
        baseline = target.dataset.action === 'edit' ? recordFingerprint(current) : null;
        original = startingPoint();
        persist();
        editor();
        break;
      case 'resume':
        draft = stored?.draft;
        baseline = stored?.baseline;
        if (draft) editor();
        break;
      case 'cancel': {
        collect();
        const kept = changed();
        draft = null;
        original = null;
        reader();
        resumeNotice();
        report(kept ? 'Unsaved changes kept in this tab. Resume them above.' : '');
        break;
      }
      case 'discard': {
        collect();
        const lost = changed();
        if (lost) discarded = { draft: { ...draft }, baseline };
        const id = draft?.id;
        draft = null;
        baseline = null;
        persist();
        resumeNotice();
        original = null;
        if (id) await open(id);
        else reader();
        report(lost ? 'Edits discarded. Undo discard is available above.' : '');
        break;
      }
      case 'discard-stored':
        discarded = stored;
        stored = null;
        persist();
        resumeNotice();
        report('Edits discarded. Undo discard is available above.');
        break;
      case 'undo-discard':
        if (draft || stored) {
          report('Close or discard the current unsaved edits before restoring discarded edits.', true);
          break;
        }
        draft = discarded?.draft;
        baseline = discarded?.baseline;
        discarded = null;
        if (draft) {
          persist();
          editor();
          report('Discarded edits restored.');
        }
        break;
      case 'compare':
        collect();
        try {
          if (await compare()) report('No saved changes found. Your draft is retained.');
        } catch (error) {
          report(error.message, true);
        }
        break;
    }
  };
  const input = event => {
    if (event.target === search) {
      list();
      if (!current && !draft) reader();
    } else if (draft && event.target.name) {
      collect();
      preview();
      editorState();
    }
  };
  const keydown = event => {
    if (!draft || busy || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const pressed = event.key.toLowerCase();
    if (pressed === 's' && event.target.closest?.('.kn-editor')) {
      event.preventDefault();
      void save();
      return;
    }
    const shortcut = event.target.name === 'content' && FORMATS.find(([, , , letter]) => letter === pressed);
    if (shortcut && !event.shiftKey) {
      event.preventDefault();
      format(shortcut[0]);
    }
  };
  const submit = event => {
    if (event.target.matches('.knowledge-editor')) {
      event.preventDefault();
      void save();
    }
  };
  container.addEventListener('click', click);
  container.addEventListener('input', input);
  container.addEventListener('keydown', keydown);
  container.addEventListener('submit', submit);
  resumeNotice();
  list();
  reader();
  void refresh();
  return {
    refresh,
    open,
    destroy() {
      destroyed = true;
      narrow.removeEventListener('change', mediaLayout);
      resize?.disconnect();
      spy?.disconnect();
      generation++;
      listGeneration++;
      container.removeEventListener('click', click);
      container.removeEventListener('input', input);
      container.removeEventListener('keydown', keydown);
      container.removeEventListener('submit', submit);
      container.classList.remove?.('knowledge-reader');
      container.replaceChildren();
    },
  };
}
