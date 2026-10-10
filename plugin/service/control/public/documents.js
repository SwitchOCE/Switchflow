// A deliberately bounded Markdown reader: raw HTML is displayed as text, never executed.
const escape = value =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function documentImageUrl(href, currentPath, projectId) {
  if (!/^[a-f0-9]{64}$/.test(projectId || '') || typeof href !== 'string') return null;
  let target;
  try {
    target = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (/[\\\u0000-\u0020?#%]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return null;
  let parts;
  if (target.startsWith('/assets/')) parts = target.slice(1).split('/');
  else {
    const current = String(currentPath || '')
      .replace(/\\/g, '/')
      .replace(/^.*?backlog\/docs\//, 'docs/');
    parts = (current.startsWith('docs/') ? current : `docs/${current}`).split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
  }
  if (
    parts[0] !== 'assets' ||
    parts.some(part => ['.', '..'].includes(part)) ||
    !/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(parts.at(-1))
  )
    return null;
  return `/projects/${projectId}/backlog-assets/${parts.slice(1).map(encodeURIComponent).join('/')}`;
}
export function resolveDocumentLink(href, currentId, documents, currentView) {
  if (typeof href !== 'string' || /[\u0000-\u001f\\]/.test(href) || href !== href.trim()) return null;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      return { external: url.href };
    } catch {
      return null;
    }
  }
  if (href.startsWith('#')) return { id: currentId, anchor: href.slice(1) };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  const [target, anchor = ''] = decoded.split('#');
  if (target.includes('?') || /[\\\u0000-\u001f]/.test(target)) return null;
  const destination = record => ({
    id: record.id,
    anchor,
    ...(record.view && record.record ? { view: record.view, record: record.record } : {}),
  });
  const decision = target.match(/^\/decisions\/(decision-\d+)$/i);
  if (decision) {
    const matches = documents.filter(
      doc =>
        (!doc.view || doc.view === 'decisions') &&
        /^decision-\d+$/i.test(doc.decisionId || doc.id) &&
        Number((doc.decisionId || doc.id).slice(9)) === Number(decision[1].slice(9)),
    );
    return matches.length === 1 ? destination(matches[0]) : null;
  }
  const legacy = target.match(/^\/documentation\/(\d+)(?:\/[^/]*)?$/);
  if (legacy) {
    const matches = documents.filter(
      doc =>
        (!doc.view || doc.view === 'documents') &&
        (doc.documentId
          ? Number(doc.documentId.slice(4)) === Number(legacy[1])
          : new RegExp(`^doc-0*${Number(legacy[1])}(?:\\s|[-.])`, 'i').test(doc.id.split('/').at(-1))),
    );
    return matches.length === 1 ? destination(matches[0]) : null;
  }
  if (target.startsWith('/')) return null;
  const parts = currentId.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const id = parts.join('/');
  const matches = documents.filter(doc => doc.id === id && (!currentView || !doc.view || doc.view === currentView));
  return matches.length === 1 ? destination(matches[0]) : null;
}
// Reader integration is opt-in: the established document reader keeps its own lifecycle.
export function resolveProseLink(href, sourcePath, records) {
  const resolved = resolveDocumentLink(href, sourcePath || '', records);
  if (resolved) return resolved;
  if (typeof href !== 'string' || href !== href.trim() || /[\u0000-\u001f\\]/.test(href)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  const [path, anchor = ''] = decoded.split('#');
  if (!path || /[?:\\\u0000-\u001f]/.test(path) || path.startsWith('/') || path.split('/').includes('..')) return null;
  const rootPath = path.replace(/^\.\//, '').replace(/^(?:backlog\/)?docs\//, '');
  const matches = records.filter(record => record.id.replace(/^(?:backlog\/)?docs\//, '') === rootPath);
  return matches.length === 1 ? { ...matches[0], anchor } : null;
}
export function bindProseInteractions(
  root,
  {
    api,
    onOpenRecord = async () => {},
    sourcePath = '',
    report = () => {},
    isCurrent = () => true,
    beforeNavigate = () => {},
  } = {},
) {
  let active = true,
    records = [],
    indexError = false;
  const current = () => active && isCurrent();
  const links = [...root.querySelectorAll('[data-doc-link]')];
  const unavailable = link => {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '0');
    link.setAttribute('role', 'link');
    link.title = indexError
      ? 'Project documents could not be loaded. Reopen this reader to retry.'
      : 'No unique supported project document matches this link. Check its path in Documents.';
  };
  function hydrate() {
    if (!current()) return;
    for (const link of links) {
      if (!link.hasAttribute('data-doc-link')) continue;
      const target = resolveProseLink(link.dataset.docLink, sourcePath, records);
      if (target?.external) {
        link.href = target.external;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        delete link.dataset.docLink;
      } else if (target) {
        link.href = '#';
        link.removeAttribute('aria-disabled');
        link.removeAttribute('title');
      } else unavailable(link);
    }
  }
  hydrate();
  const internal = links.some(link => link.dataset.docLink && !link.dataset.docLink.startsWith('#'));
  const ready =
    internal && api
      ? Promise.allSettled(['/docs', '/decisions'].map(endpoint => Promise.resolve().then(() => api(endpoint)))).then(
          results => {
            if (!current()) return;
            records = results.flatMap((result, index) => {
              if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
                indexError = true;
                return [];
              }
              const view = index ? 'decisions' : 'documents';
              return result.value.map(record => ({
                id: record.path || record.id,
                record: record.id,
                view,
                ...(index ? { decisionId: record.id } : { documentId: record.id }),
              }));
            });
            hydrate();
          },
        )
      : Promise.resolve();
  function anchor(value, trigger) {
    let id;
    try {
      id = decodeURIComponent(value);
    } catch {
      id = value;
    }
    const scope = trigger.closest('.docs-prose') || root;
    const heading = [...scope.querySelectorAll('[id]')].find(node => node.id === `doc-heading-${id}`);
    if (!heading) {
      report('That heading is not present in this section.', true);
      return;
    }
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }
  const click = async event => {
    const target = event.target.closest('[data-doc-link],[data-doc-anchor],[data-copy-code]');
    if (!target || !root.contains(target) || !current()) return;
    event.preventDefault();
    if (target.hasAttribute('data-copy-code')) {
      try {
        await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent);
        if (current()) report('Code copied.');
      } catch {
        if (current()) report('Copy unavailable. Select the code and copy it manually.', true);
      }
      return;
    }
    if (target.hasAttribute('data-doc-anchor')) {
      anchor(target.dataset.docAnchor, target);
      return;
    }
    if (target.dataset.docLink.startsWith('#')) {
      anchor(target.dataset.docLink.slice(1), target);
      return;
    }
    await ready;
    if (!current()) return;
    const destination = resolveProseLink(target.dataset.docLink, sourcePath, records);
    if (!destination?.view || !destination.record) {
      report(target.title || 'This evidence link cannot be opened. Check its path in Documents.', true);
      return;
    }
    try {
      await beforeNavigate(destination);
      await onOpenRecord(destination);
    } catch (error) {
      if (current()) report(`Unable to open linked evidence: ${error.message}`, true);
    }
  };
  const keydown = event => {
    if (event.key === 'Enter' && event.target.hasAttribute('data-doc-link') && !event.target.hasAttribute('href'))
      void click(event);
  };
  root.addEventListener('click', click);
  root.addEventListener('keydown', keydown);
  return () => {
    active = false;
    root.removeEventListener('click', click);
    root.removeEventListener('keydown', keydown);
  };
}
function inline(text, depth = 0) {
  if (depth > 5) return escape(text);
  const pattern =
    /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]+)\]\((<[^>]+>|[^)]*)\)|<(https?:\/\/[^>]+)>|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~/g;
  let html = '';
  let end = 0;
  for (const m of text.matchAll(pattern)) {
    html += escape(text.slice(end, m.index));
    end = m.index + m[0].length;
    if (m[1]) html += `<code>${escape(m[2])}</code>`;
    else if (m[3] !== undefined)
      html += `<span class="docs-image-note" data-doc-image="${escape(m[4])}" data-image-alt="${escape(m[3])}">[Image: ${escape(m[3] || 'illustration')}]</span>`;
    else if (m[5] !== undefined || m[7]) {
      const label = m[5] || m[7];
      const href = m[7] || m[6].replace(/^<|>$/g, '');
      html += `<a href="#" data-doc-link="${escape(href)}">${inline(label, depth + 1)}</a>`;
    } else if (m[8] || m[9]) html += `<strong>${inline(m[8] || m[9], depth + 1)}</strong>`;
    else if (m[10] || m[11]) html += `<em>${inline(m[10] || m[11], depth + 1)}</em>`;
    else html += `<del>${inline(m[12], depth + 1)}</del>`;
  }
  return html + escape(text.slice(end));
}
export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  const slugs = new Map();
  const heading = (level, text) => {
    const plain = text.replace(/[*_`~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const base =
      plain
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section';
    const count = slugs.get(base) || 0;
    slugs.set(base, count + 1);
    const id = base + (count ? `-${count}` : '');
    headings.push({ level, text: plain, id });
    return `<h${level} id="doc-heading-${escape(id)}" tabindex="-1">${inline(text)}<a class="docs-heading-anchor" href="#${escape(id)}" data-doc-anchor="${escape(id)}" aria-label="Link to ${escape(plain)}">#</a></h${level}>`;
  };
  function blocks(source, depth = 0) {
    if (depth > 32) return `<pre>${escape(source.join('\n'))}</pre>`;
    let html = '';
    let i = 0;
    const starts = line => /^(?:\s*$|#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*(?:[-+*]|\d+[.)])\s)/.test(line);
    while (i < source.length) {
      const line = source[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const content = [];
        i++;
        while (i < source.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(source[i]))
          content.push(source[i++]);
        i++;
        html += `<div class="docs-code"><div class="docs-code-bar"><span>${escape(fence[2].trim() || 'Code')}</span><button type="button" data-copy-code>Copy code</button></div><pre><code>${escape(content.join('\n'))}</code></pre></div>`;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
      if (h) {
        html += heading(h[1].length, h[2]);
        i++;
        continue;
      }
      if (i + 1 < source.length && /^(?:={3,}|-{3,})\s*$/.test(source[i + 1])) {
        html += heading(source[i + 1][0] === '=' ? 1 : 2, line);
        i += 2;
        continue;
      }
      if (/^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
        html += '<hr>';
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < source.length && /^\s*>/.test(source[i])) quote.push(source[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${blocks(quote, depth + 1)}</blockquote>`;
        continue;
      }
      const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (list) {
        const indent = list[1].length;
        const ordered = /^\d/.test(list[2]);
        const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}${ordered ? ` start="${parseInt(list[2], 10)}"` : ''}>`;
        while (i < source.length) {
          const item = source[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
          if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
          const body = [item[3]];
          i++;
          while (i < source.length && source[i].trim() && source[i].match(/^\s*/)[0].length > indent)
            body.push(source[i++].slice(indent + 2));
          let checkbox = '';
          const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            checkbox = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? 'Complete' : 'Incomplete'}"> `;
            body[0] = task[2];
          }
          html += `<li>${checkbox}${blocks(body, depth + 1)}</li>`;
        }
        html += `</${tag}>`;
        continue;
      }
      if (
        i + 1 < source.length &&
        line.includes('|') &&
        /^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)*\s*$/.test(source[i + 1])
      ) {
        const cells = row =>
          row
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map(s => s.trim());
        const header = cells(line);
        html += `<div class="docs-table"><table><thead><tr>${header.map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
        i += 2;
        while (i < source.length && source[i].includes('|') && source[i].trim()) {
          html += `<tr>${cells(source[i++])
            .map(c => `<td>${inline(c)}</td>`)
            .join('')}</tr>`;
        }
        html += '</tbody></table></div>';
        continue;
      }
      const paragraph = [line];
      i++;
      while (
        i < source.length &&
        !starts(source[i]) &&
        !(i + 1 < source.length && /^(?:={3,}|-{3,})\s*$/.test(source[i + 1]))
      )
        paragraph.push(source[i++]);
      html += `<p>${inline(paragraph.join('\n')).replace(/ {2}\n/g, '<br>')}</p>`;
    }
    return html;
  }
  return { html: blocks(lines), headings };
}

// `html` is the complete reader markup. `parts` splits it for readers that place the title
// in their own header: the leading Markdown title moves there with its anchor id intact.
export function renderDocument(doc) {
  const rendered = renderMarkdown(doc.markdown);
  const first = rendered.headings[0];
  const sameTitle = rendered.html.startsWith('<h1 ') && first?.level === 1 && first.text.trim() === doc.title.trim();
  const body = sameTitle ? rendered.html.replace(/^<h1 /, '<h1 class="docs-page-title" ') : rendered.html;
  const title = sameTitle ? '' : `<h2 class="docs-page-title" tabindex="-1">${escape(doc.title)}</h2>`;
  const breadcrumb = `<div class="docs-breadcrumb">${escape(doc.id)}</div>`;
  const leading = sameTitle ? body.match(/^<h1 [^>]*>[\s\S]*?<\/h1>/)[0] : '';
  return {
    ...rendered,
    html: `${breadcrumb}${title}<article class="docs-prose">${body}</article>`,
    parts: {
      breadcrumb,
      // The view heading is the page's h1, so the document title is its h2.
      title: leading
        ? leading.replace(/<a class="docs-heading-anchor"[^>]*>#<\/a><\/h1>$/, '</h2>').replace(/^<h1 /, '<h2 ')
        : title,
      titleHeading: sameTitle ? first.id : null,
      article: `<article class="docs-prose">${body.slice(leading.length)}</article>`,
    },
  };
}
