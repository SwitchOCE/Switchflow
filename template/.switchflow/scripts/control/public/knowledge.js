import {renderDocument, renderMarkdown, resolveDocumentLink, documentImageUrl} from './documents.js';
import {escapeHtml as esc, draftFrom, folderOf, knowledgePayload, recordFingerprint} from './knowledge-model.js';

// The native endpoints do not offer compare-and-swap. A pre-save comparison catches
// observed changes; the UI explicitly describes the remaining concurrent-write window.
export function mountKnowledge(container, {api, projectId, canWrite = () => true, onChange = () => {}, onNavigate = () => {}, onOpenRecord = async () => {}, kind = 'documents'}) {
  const endpoint = kind === 'decisions' ? '/decisions' : '/docs';
  const noun = kind === 'decisions' ? 'decision' : 'document';
  const key = `switchflow:knowledge:${projectId}:${kind}`;
  let records = [], linkedRecords = [], current = null, draft = null, baseline = null, destroyed = false, generation = 0, listGeneration = 0, busy = false;
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* Storage can be unavailable. */ }
  if (stored && (!stored.draft || typeof stored.draft.title !== 'string' || typeof stored.draft.content !== 'string')) stored = null;
  container.classList.add('docs-reader', 'knowledge-reader');
  container.innerHTML = `<div class="docs-toolbar"><label>Search ${kind}<input type="search" placeholder="Search titles, tags and content" aria-label="Search ${kind}"></label><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="new">New ${noun}</button></div><p class="docs-status" role="status" aria-live="polite"></p><div class="knowledge-resume"></div><div class="docs-layout"><nav class="docs-nav" aria-label="${kind} folders"></nav><div class="docs-content"><p>Select a ${noun}, or create one.</p></div><nav class="docs-toc" aria-label="On this page"></nav></div>`;
  const find = s => container.querySelector(s), content = find('.docs-content'), nav = find('.docs-nav'), toc = find('.docs-toc'), status = find('.docs-status'), search = find('input[type=search]');
  function report(text, error = false) { if (destroyed) return; status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); }
  function permission() { return typeof canWrite === 'function' ? canWrite() : !!canWrite; }
  function controls() { for (const b of container.querySelectorAll('[data-action="save"],[data-action="edit"],[data-action="new"]')) { b.disabled = busy || !permission(); b.title = !permission() ? 'Editing is paused while an agent is active.' : ''; } }
  function persist() { stored = draft ? {draft, baseline} : null; try { if (stored) sessionStorage.setItem(key, JSON.stringify(stored)); else sessionStorage.removeItem(key); } catch { report('Draft remains open, but this browser could not store it for recovery.', true); } }
  function resumeNotice() { find('.knowledge-resume').innerHTML = stored && !draft ? '<p>A saved draft is available in this project. <button type="button" data-action="resume">Resume draft</button> <button type="button" data-action="discard-stored">Discard saved draft</button></p>' : ''; }
  function list() {
    const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const visible = records.filter(r => terms.every(t => [r.title,r.rawContent,r.context,r.decision,r.consequences,...(r.tags || [])].join(' ').toLowerCase().includes(t)));
    const closed = new Set([...nav.querySelectorAll('details:not([open])')].map(node => node.dataset.folder));
    const root = {folders:new Map(),records:[]};
    for (const record of visible) { let folder = root; for (const part of folderOf(record).split('/').filter(Boolean)) { if (!folder.folders.has(part)) folder.folders.set(part,{folders:new Map(),records:[]}); folder = folder.folders.get(part); } folder.records.push(record); }
    const rows = records => `<ul>${records.map(r => `<li><button type="button" data-record="${esc(r.id)}"${r.id === current?.id ? ' aria-current="page"' : ''}>${esc(r.title)}<small>${esc(r.id)}${r.status ? ` · ${esc(r.status)}` : ''}</small></button></li>`).join('')}</ul>`;
    const tree = (folder,parent = '') => rows(folder.records) + [...folder.folders].sort(([a],[b]) => a.localeCompare(b)).map(([name,child]) => { const path = `${parent}/${name}`; return `<details data-folder="${esc(path)}"${closed.has(path) && !terms.length ? '' : ' open'}><summary>${esc(name)}</summary>${tree(child,path)}</details>`; }).join('');
    nav.innerHTML = visible.length ? tree(root) : `<p>${terms.length ? 'No matches.' : `No ${kind} yet.`}</p>`;
  }
  function anchor(id) { try { id = decodeURIComponent(id); } catch {} const heading = [...content.querySelectorAll('[id]')].find(el => el.id === `doc-heading-${id}`); heading?.scrollIntoView({block:'start'}); heading?.focus(); }
  function linkRecords() {
    const map = (values,view) => values.map(r => ({id:r.path || r.id,record:r.id,view,...(view === 'documents' ? {documentId:r.id} : {decisionId:r.id})}));
    return [...map(records,kind),...map(linkedRecords,kind === 'documents' ? 'decisions' : 'documents')];
  }
  function hydrateLinks() {
    if (!current || draft) return;
    for (const a of content.querySelectorAll('[data-doc-link]')) {
      const target = resolveDocumentLink(a.dataset.docLink,current.path || current.id,linkRecords(),kind);
      if (target?.external) { a.href = target.external; a.target = '_blank'; a.rel = 'noopener noreferrer'; delete a.dataset.docLink; }
      else if (target) { a.href = '#'; a.removeAttribute('title'); }
      else { a.removeAttribute('href'); a.title = 'Link is outside the project documentation or unsupported.'; }
    }
  }
  function reader() {
    if (!current) { content.innerHTML = `<p>Select a ${noun}, or create one.</p>`; toc.innerHTML = ''; return; }
    const rendered = renderDocument({id:current.path || current.id, title:current.title, markdown:current.rawContent || ''});
    content.innerHTML = `<div class="knowledge-actions"><button type="button" data-action="edit">Edit ${noun}</button></div>${rendered.html}`;
    for (const placeholder of content.querySelectorAll('[data-doc-image]')) {
      const url = documentImageUrl(placeholder.dataset.docImage,current.path,projectId);
      if (url) { const image = document.createElement('img'); image.src = url; image.alt = placeholder.dataset.imageAlt || ''; image.loading = 'lazy'; image.className = 'docs-image'; image.addEventListener('error', () => image.replaceWith(placeholder)); placeholder.replaceWith(image); }
    }
    toc.innerHTML = '<strong>On this page</strong>' + rendered.headings.map(h => `<a href="#${esc(h.id)}" data-doc-anchor="${esc(h.id)}">${esc(h.text)}</a>`).join('');
    hydrateLinks();
    controls();
  }
  async function open(id, fragment = '') {
    if (draft || busy) { report('Save or cancel the open draft before switching records.', true); return; }
    const ticket = ++generation; report(`Loading ${noun}…`);
    try { const result = await api(`${endpoint}/${encodeURIComponent(id)}`); if (destroyed || ticket !== generation) return; current = result; reader(); list(); onNavigate({view:kind,record:result.id}); report(''); if (fragment) anchor(fragment); }
    catch (error) { if (!destroyed && ticket === generation) report(error.message, true); }
  }
  async function refresh() {
    controls(); const ticket = ++listGeneration;
    try {
      const result = await api(endpoint); if (destroyed || ticket !== listGeneration) return;
      // Docs list metadata excludes body; fetch bounded batches for genuine full-text search.
      const full = []; let unreadable = 0;
      for (let i = 0; i < result.length; i += 6) { const batch = await Promise.all(result.slice(i,i+6).map(async r => { try { return {...r,...await api(`${endpoint}/${encodeURIComponent(r.id)}`)}; } catch { unreadable++; return r; } })); if (destroyed || ticket !== listGeneration) return; full.push(...batch); }
      let cross = [];
      try { cross = await api(kind === 'documents' ? '/decisions' : '/docs'); }
      catch { unreadable++; }
      if (destroyed || ticket !== listGeneration) return;
      const changed = JSON.stringify(records) !== JSON.stringify(full); records = full; linkedRecords = cross; if (changed) list(); hydrateLinks(); controls();
      if (unreadable) report(`${unreadable} records could not be read. Content search is incomplete; opening a record shows its error.`, true);
    } catch (error) { if (!destroyed && ticket === listGeneration) report(error.message, true); }
  }
  function preview() { const panel = find('.knowledge-preview'); if (panel) panel.innerHTML = renderMarkdown(draft.content).html; }
  function editor() {
    generation++; toc.innerHTML = ''; resumeNotice();
    content.innerHTML = `<form class="knowledge-editor"><h2>${draft.id ? 'Edit' : 'New'} ${noun}</h2><label>Title<input name="title" required maxlength="300" value="${esc(draft.title)}"></label>${kind === 'documents' ? `<div class="knowledge-fields"><label>Type<select name="type">${['readme','guide','specification','other'].map(t => `<option${draft.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label><label>Folder<input name="folder" placeholder="e.g. Guides" value="${esc(draft.folder)}"></label></div><label>Tags (comma separated)<input name="tags" value="${esc(draft.tags)}"></label>` : '<p>Keep Context, Decision and Consequences sections. Alternatives is optional. Existing status and date are preserved.</p>'}<div class="knowledge-format" role="group" aria-label="Markdown formatting">${[['heading','Heading'],['bold','Bold'],['italic','Italic'],['list','List'],['link','Link'],['code','Code']].map(([action,title]) => `<button type="button" data-format="${action}">${title}</button>`).join('')}</div><label>Markdown<textarea name="content" rows="18" spellcheck="true">${esc(draft.content)}</textarea></label><details><summary>Preview</summary><article class="knowledge-preview docs-prose"></article></details><p class="knowledge-note">Your draft is checked against the latest saved version. Avoid simultaneous edits to this document.</p><div class="knowledge-conflict"></div><div class="knowledge-actions"><button type="submit" data-action="save">Save ${noun}</button><button type="button" data-action="cancel">Cancel · keep draft</button><button type="button" data-action="discard">Discard draft</button><button type="button" data-action="compare"${draft.id ? '' : ' disabled'}>Compare with latest</button></div></form>`;
    preview(); controls(); find('[name=title]').focus();
  }
  function collect() { for (const field of content.querySelectorAll('[name]')) draft[field.name] = field.value; persist(); }
  async function compare() {
    if (!draft?.id) return true;
    const comparingDraft = draft;
    const latest = await api(`${endpoint}/${encodeURIComponent(draft.id)}`);
    if (destroyed || draft !== comparingDraft) return false;
    if (recordFingerprint(latest) === baseline) return true;
    find('.knowledge-conflict').innerHTML = `<div role="alert"><p>The saved record changed. Your draft is intact. Review the latest content and metadata below; cancel keeps your draft, or discard it to load the current record.</p><details open><summary>Latest saved version</summary><pre>${esc(JSON.stringify({title:latest.title,type:latest.type,tags:latest.tags,path:latest.path,status:latest.status},null,2))}</pre><pre>${esc(latest.rawContent)}</pre></details></div>`;
    return false;
  }
  async function save() {
    if (!draft || busy) return;
    if (!permission()) { report('Editing is paused while an agent is active. Your draft is retained.', true); return; }
    collect(); let payload;
    try { payload = knowledgePayload(draft, kind); } catch (error) { report(error.message, true); return; }
    busy = true; controls(); for (const f of content.querySelectorAll('input,textarea,select,button')) f.disabled = true;
    try {
      if (!await compare()) { report('Save stopped because the saved version changed.', true); return; }
      if (destroyed || !permission()) return;
      const id = draft.id; const result = await api(id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint, {method:id ? 'PUT' : 'POST',body:payload});
      if (destroyed) return;
      draft = null; baseline = null; persist(); resumeNotice(); busy = false;
      await refresh(); if (id || result?.id) await open(id || result.id); else reader();
      report(`${noun[0].toUpperCase()+noun.slice(1)} saved.`); onChange();
    } catch (error) { report(`${error.message} Your draft is retained.`, true); }
    finally { busy = false; if (!destroyed) { for (const f of content.querySelectorAll('input,textarea,select,button')) f.disabled = false; controls(); } }
  }
  const click = async event => {
    const target = event.target.closest('button,a'); if (!target || !container.contains(target)) return;
    if (target.dataset.record) return open(target.dataset.record);
    if (target.hasAttribute('data-doc-anchor')) { event.preventDefault(); anchor(target.dataset.docAnchor); return; }
    if (target.hasAttribute('data-doc-link')) {
      event.preventDefault(); if (draft || busy) return;
      const dest = resolveDocumentLink(target.dataset.docLink,current?.path || current?.id || '',linkRecords(),kind);
      if (dest?.view && dest.view !== kind) { try { await onOpenRecord(dest); } catch (error) { report(error.message,true); } }
      else if (dest?.id) {
        const record = records.find(r => (r.path || r.id) === dest.id);
        if (record && record.id !== current.id) await open(record.id,dest.anchor);
        else if (dest.anchor) anchor(dest.anchor);
      }
      return;
    }
    if (target.hasAttribute('data-copy-code')) { try { await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent); report('Code copied.'); } catch { report('Copy unavailable. Select the text and copy manually.',true); } return; }
    if (busy) return;
    if (target.dataset.format && draft) { const area = find('textarea'); const pair = {heading:['\n## ',''],bold:['**','**'],italic:['_','_'],list:['\n- ',''],link:['[','](relative-document.md)'],code:['\n```\n','\n```\n']}[target.dataset.format]; area.setRangeText(pair[0]+area.value.slice(area.selectionStart,area.selectionEnd)+pair[1],area.selectionStart,area.selectionEnd,'select'); collect(); preview(); area.focus(); return; }
    switch (target.dataset.action) {
      case 'refresh': await refresh(); if (current && !draft) await open(current.id); break;
      case 'new': case 'edit': if (!permission() || draft) { report('Finish the open draft before starting another.',true); break; } if (stored) { report('Resume or discard the saved draft before starting another.',true); break; } draft = draftFrom(target.dataset.action === 'edit' ? current : null,kind); baseline = target.dataset.action === 'edit' ? recordFingerprint(current) : null; persist(); editor(); break;
      case 'resume': draft = stored?.draft; baseline = stored?.baseline; if (draft) editor(); break;
      case 'cancel': collect(); draft = null; reader(); resumeNotice(); report('Draft kept in this browser tab.'); break;
      case 'discard': { const id = draft?.id; draft = null; baseline = null; persist(); resumeNotice(); if (id) await open(id); else reader(); report('Draft discarded.'); break; }
      case 'discard-stored': stored = null; persist(); resumeNotice(); report('Saved draft discarded.'); break;
      case 'compare': collect(); try { if (await compare()) report('No saved changes found. Your draft is retained.'); } catch (error) { report(error.message,true); } break;
    }
  };
  const input = event => { if (event.target === search) list(); else if (draft && event.target.name) { collect(); preview(); } };
  const submit = event => { if (event.target.matches('.knowledge-editor')) { event.preventDefault(); void save(); } };
  container.addEventListener('click',click); container.addEventListener('input',input); container.addEventListener('submit',submit); resumeNotice(); controls(); void refresh();
  return {refresh,open,destroy() { destroyed = true; generation++; listGeneration++; container.removeEventListener('click',click); container.removeEventListener('input',input); container.removeEventListener('submit',submit); container.replaceChildren(); }};
}
