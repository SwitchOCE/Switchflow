// A deliberately bounded Markdown reader: raw HTML is displayed as text, never executed.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function documentImageUrl(href, currentPath, projectId) {
  if (!/^[a-f0-9]{64}$/.test(projectId || '') || typeof href !== 'string') return null;
  let target;
  try { target = decodeURIComponent(href); } catch { return null; }
  if (/[\\\u0000-\u0020?#%]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return null;
  let parts;
  if (target.startsWith('/assets/')) parts = target.slice(1).split('/');
  else {
    const current = String(currentPath || '').replace(/\\/g,'/').replace(/^.*?backlog\/docs\//,'docs/');
    parts = (current.startsWith('docs/') ? current : `docs/${current}`).split('/').slice(0,-1);
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
    }
  }
  if (parts[0] !== 'assets' || parts.some(part => ['.','..'].includes(part)) || !/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(parts.at(-1))) return null;
  return `/projects/${projectId}/backlog-assets/${parts.slice(1).map(encodeURIComponent).join('/')}`;
}
export function resolveDocumentLink(href, currentId, documents) {
  if (typeof href !== 'string' || /[\u0000-\u001f\\]/.test(href) || href !== href.trim()) return null;
  if (/^https?:\/\//i.test(href)) {
    try { const url = new URL(href); return { external: url.href }; } catch { return null; }
  }
  if (href.startsWith('#')) return { id: currentId, anchor: href.slice(1) };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  const [target, anchor = ''] = decoded.split('#');
  if (target.includes('?') || target.includes('\\') || target.includes('\0')) return null;
  const legacy = target.match(/^\/documentation\/(\d+)(?:\/[^/]*)?$/);
  if (legacy) {
    const matches = documents.filter(doc => doc.documentId ? Number(doc.documentId.slice(4)) === Number(legacy[1]) : new RegExp(`^doc-0*${Number(legacy[1])}(?:\\s|[-.])`, 'i').test(doc.id.split('/').at(-1)));
    return matches.length === 1 ? { id: matches[0].id, anchor } : null;
  }
  if (target.startsWith('/')) return null;
  const parts = currentId.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  const id = parts.join('/');
  return documents.some(doc => doc.id === id) ? { id, anchor } : null;
}
function inline(text, depth = 0) {
  if (depth > 5) return escape(text);
  const pattern = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\((<[^>]+>|[^)]*)\)|<(https?:\/\/[^>]+)>|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~/g;
  let html = ''; let end = 0;
  for (const m of text.matchAll(pattern)) {
    html += escape(text.slice(end, m.index)); end = m.index + m[0].length;
    if (m[1]) html += `<code>${escape(m[2])}</code>`;
    else if (m[3] !== undefined) html += `<span class="docs-image-note" data-doc-image="${escape(m[4])}" data-image-alt="${escape(m[3])}">[Image: ${escape(m[3] || 'illustration')}]</span>`;
    else if (m[5] !== undefined || m[7]) {
      const label = m[5] || m[7]; const href = m[7] || m[6].replace(/^<|>$/g, '');
      html += `<a href="#" data-doc-link="${escape(href)}">${inline(label, depth + 1)}</a>`;
    } else if (m[8] || m[9]) html += `<strong>${inline(m[8] || m[9], depth + 1)}</strong>`;
    else if (m[10] || m[11]) html += `<em>${inline(m[10] || m[11], depth + 1)}</em>`;
    else html += `<del>${inline(m[12], depth + 1)}</del>`;
  }
  return html + escape(text.slice(end));
}
export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'); const headings = []; const slugs = new Map();
  const heading = (level, text) => {
    const plain = text.replace(/[*_`~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const base = plain.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const count = slugs.get(base) || 0; slugs.set(base, count + 1); const id = base + (count ? `-${count}` : '');
    headings.push({ level, text: plain, id });
    return `<h${level} id="doc-heading-${escape(id)}" tabindex="-1">${inline(text)}<a class="docs-heading-anchor" href="#${escape(id)}" data-doc-anchor="${escape(id)}" aria-label="Link to ${escape(plain)}">#</a></h${level}>`;
  };
  function blocks(source, depth = 0) {
    if (depth > 32) return `<pre>${escape(source.join('\n'))}</pre>`;
    let html = ''; let i = 0;
    const starts = line => /^(?:\s*$|#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*(?:[-+*]|\d+[.)])\s)/.test(line);
    while (i < source.length) {
      const line = source[i]; if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const content = []; i++;
        while (i < source.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(source[i])) content.push(source[i++]);
        i++;
        html += `<div class="docs-code"><div class="docs-code-bar"><span>${escape(fence[2].trim() || 'Code')}</span><button type="button" data-copy-code>Copy code</button></div><pre><code>${escape(content.join('\n'))}</code></pre></div>`; continue;
      }
      const h = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
      if (h) { html += heading(h[1].length, h[2]); i++; continue; }
      if (i + 1 < source.length && /^(?:={3,}|-{3,})\s*$/.test(source[i + 1])) { html += heading(source[i + 1][0] === '=' ? 1 : 2, line); i += 2; continue; }
      if (/^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) { html += '<hr>'; i++; continue; }
      if (/^\s*>/.test(line)) {
        const quote = []; while (i < source.length && /^\s*>/.test(source[i])) quote.push(source[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${blocks(quote, depth + 1)}</blockquote>`; continue;
      }
      const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (list) {
        const indent = list[1].length; const ordered = /^\d/.test(list[2]); const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}${ordered ? ` start="${parseInt(list[2], 10)}"` : ''}>`;
        while (i < source.length) {
          const item = source[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
          if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
          const body = [item[3]]; i++;
          while (i < source.length && source[i].trim() && (source[i].match(/^\s*/)[0].length > indent)) body.push(source[i++].slice(indent + 2));
          let checkbox = ''; const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) { checkbox = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? 'Complete' : 'Incomplete'}"> `; body[0] = task[2]; }
          html += `<li>${checkbox}${blocks(body, depth + 1)}</li>`;
        }
        html += `</${tag}>`; continue;
      }
      if (i + 1 < source.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)*\s*$/.test(source[i + 1])) {
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        const header = cells(line); html += `<div class="docs-table"><table><thead><tr>${header.map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>`; i += 2;
        while (i < source.length && source[i].includes('|') && source[i].trim()) { html += `<tr>${cells(source[i++]).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`; }
        html += '</tbody></table></div>'; continue;
      }
      const paragraph = [line]; i++;
      while (i < source.length && !starts(source[i]) && !(i + 1 < source.length && /^(?:={3,}|-{3,})\s*$/.test(source[i + 1]))) paragraph.push(source[i++]);
      html += `<p>${inline(paragraph.join('\n')).replace(/ {2}\n/g, '<br>')}</p>`;
    }
    return html;
  }
  return { html: blocks(lines), headings };
}

export function renderDocument(doc) {
  const rendered = renderMarkdown(doc.markdown);
  const first = rendered.headings[0];
  const sameTitle = rendered.html.startsWith('<h1 ') && first?.level === 1 && first.text.trim() === doc.title.trim();
  const body = sameTitle ? rendered.html.replace(/^<h1 /, '<h1 class="docs-page-title" ') : rendered.html;
  const title = sameTitle ? '' : `<h2 class="docs-page-title" tabindex="-1">${escape(doc.title)}</h2>`;
  return { ...rendered, html: `<div class="docs-breadcrumb">${escape(doc.id)}</div>${title}<article class="docs-prose">${body}</article>` };
}

export function mountDocuments(container, { request }) {
  let destroyed = false; let generation = 0; let allDocs = []; let indexed = false; let warnings = []; let current = null; let timer;
  container.classList.add('docs-reader');
  container.innerHTML = '<div class="docs-toolbar"><label>Search documentation<input type="search" placeholder="Search titles and content" maxlength="200" aria-label="Search documentation"></label><button type="button" data-docs-refresh>Refresh docs</button></div><p class="docs-status" role="status" aria-live="polite"></p><div class="docs-layout"><nav class="docs-nav" aria-label="Documentation folders"></nav><div class="docs-content"><p>Select a document to read.</p></div><nav class="docs-toc" aria-label="On this page"></nav></div>';
  const find = selector => container.querySelector(selector); const nav = find('.docs-nav'); const content = find('.docs-content'); const toc = find('.docs-toc'); const status = find('.docs-status'); const search = find('input');
  const report = (message, error = false) => { status.textContent = message; status.setAttribute('role', error ? 'alert' : 'status'); };
  function scrollAnchor(anchor) {
    let decoded; try { decoded = decodeURIComponent(anchor); } catch { decoded = anchor; }
    const target = [...content.querySelectorAll('[id]')].find(el => el.id === `doc-heading-${decoded}`);
    if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); }
    else if (anchor) report(`Section “${decoded}” was not found in this document.`, true);
  }
  async function open(id, anchor = '', focus = true) {
    const ticket = ++generation; report('Loading document…');
    try {
      const doc = await request(`/docs/content?id=${encodeURIComponent(id)}`); if (destroyed || ticket !== generation) return;
      current = id; const rendered = renderDocument(doc);
      content.innerHTML = rendered.html;
      toc.innerHTML = '<strong>On this page</strong>' + rendered.headings.map(h => `<a class="docs-toc-level-${h.level}" href="#${escape(h.id)}" data-doc-anchor="${escape(h.id)}">${escape(h.text)}</a>`).join('');
      for (const link of content.querySelectorAll('[data-doc-link]')) {
        const destination = resolveDocumentLink(link.dataset.docLink, id, allDocs);
        if (destination?.external) { link.href = destination.external; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.removeAttribute('data-doc-link'); }
        else if (!destination) { link.removeAttribute('href'); link.classList.add('docs-unavailable-link'); link.title = 'This link is not a document in this project or uses an unsupported address.'; }
      }
      for (const button of nav.querySelectorAll('[data-doc-id]')) { if (button.dataset.docId === id) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
      report(warnings.join(' ')); if (anchor) scrollAnchor(anchor); else if (focus) find('.docs-page-title').focus();
    } catch (error) { if (!destroyed && ticket === generation) report(error.message || 'Unable to read documentation.', true); }
  }
  function tree(documents) {
    const root = { folders: new Map(), docs: [] };
    for (const doc of documents) { let node = root; for (const part of doc.folder.split('/').filter(Boolean)) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), docs: [] }); node = node.folders.get(part); } node.docs.push(doc); }
    const render = node => `<ul>${[...node.folders].map(([name, child]) => `<li><details open><summary>${escape(name)}</summary>${render(child)}</details></li>`).join('')}${node.docs.map(doc => `<li><button type="button" data-doc-id="${escape(doc.id)}"${doc.id === current ? ' aria-current="page"' : ''}>${escape(doc.title)}</button>${search.value.trim() ? `<p class="docs-excerpt">${escape(doc.excerpt)}</p>` : ''}</li>`).join('')}</ul>`;
    nav.innerHTML = documents.length ? render(root) : '<p>No documents match.</p>';
  }
  let searchTicket = 0;
  async function refresh() {
    const ticket = ++searchTicket; report('Loading documentation…');
    try {
      const query = search.value.trim();
      if (query && !indexed) { const index = await request('/docs'); if (destroyed || ticket !== searchTicket) return; allDocs = index.documents; indexed = true; }
      const result = await request(`/docs${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      if (destroyed || ticket !== searchTicket) return;
      if (!query) { allDocs = result.documents; indexed = true; } warnings = result.warnings || []; tree(result.documents);
      report(`${result.documents.length} document${result.documents.length === 1 ? '' : 's'}${query ? ' found' : ''}.${result.warnings?.length ? ` ${result.warnings.join(' ')}` : ''}`);
      if (!current && !query && result.documents.length) await open(result.documents[0].id, '', false);
    } catch (error) { if (!destroyed && ticket === searchTicket) report(error.message || 'Unable to load documentation.', true); }
  }
  const click = async event => {
    const target = event.target.closest('button,a'); if (!target || !container.contains(target)) return;
    if (target.matches('[data-docs-refresh]')) { await refresh(); if (current) await open(current, '', false); }
    else if (target.dataset.docId) await open(target.dataset.docId);
    else if (target.hasAttribute('data-doc-anchor')) { event.preventDefault(); scrollAnchor(target.dataset.docAnchor); }
    else if (target.hasAttribute('data-doc-link')) { event.preventDefault(); const destination = resolveDocumentLink(target.dataset.docLink, current, allDocs); if (destination?.id) await open(destination.id, destination.anchor); }
    else if (target.hasAttribute('data-copy-code')) {
      try { await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent); target.textContent = 'Copied'; report('Code copied.'); }
      catch { report('Copy is unavailable. Select the code text and copy it manually.', true); }
    }
  };
  const input = () => { clearTimeout(timer); timer = setTimeout(refresh, 200); };
  container.addEventListener('click', click); search.addEventListener('input', input); void refresh();
  return { refresh, destroy() { destroyed = true; generation++; searchTicket++; clearTimeout(timer); container.removeEventListener('click', click); search.removeEventListener('input', input); container.replaceChildren(); } };
}
