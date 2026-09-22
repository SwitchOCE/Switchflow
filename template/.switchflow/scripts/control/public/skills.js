import { renderMarkdown, resolveDocumentLink } from './documents.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
export function mountSkills(container, { request, onNavigate = () => {} }) {
  container.innerHTML = `<div class="section-heading"><div><h1>Skills</h1><p class="muted">Inspect the Switchflow instructions installed in this project.</p></div><span class="badge">Read only</span></div>
    <div class="docs-reader skills-reader"><div class="docs-toolbar"><label>Find a skill<input type="search" placeholder="Search names and descriptions…" aria-label="Find a skill"></label><button type="button" data-refresh>Refresh skills</button></div>
    <p class="docs-status" role="status" aria-live="polite"></p><div class="docs-layout"><nav class="docs-nav" aria-label="Switchflow skills"></nav><article class="docs-content"><p class="muted">Choose a skill to inspect its instructions.</p></article><aside class="docs-toc" aria-label="On this page"></aside></div></div>`;
  const find = selector => container.querySelector(selector);
  const search = find('input'), nav = find('nav'), content = find('article'), toc = find('aside'), status = find('.docs-status'), refreshButton = find('[data-refresh]');
  let skills = [], warnings = [], current = null, destroyed = false, generation = 0, listing = 0;
  const report = (text, error = false) => { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); };
  function tree() {
    const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.skill : null;
    const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = skills.filter(skill => terms.every(term => `${skill.name} ${skill.title} ${skill.description}`.toLocaleLowerCase().includes(term)));
    nav.replaceChildren();
    for (const skill of matches) {
      const button = node('button', '', skill.title); button.type = 'button'; button.dataset.skill = skill.id;
      if (current?.split('/')[0] === skill.name) button.setAttribute('aria-current', 'page');
      nav.append(button, node('p', 'docs-excerpt', skill.description));
      if (focused === skill.id) button.focus({ preventScroll: true });
    }
    if (!matches.length) {
      nav.append(node('p', 'muted', skills.length ? 'No skills match this filter. Clear the search to see the installed skills.' : 'No Switchflow skills are installed in this project. Refresh after restoring the project skill files.'));
      if (skills.length) { const clear = node('button', 'button quiet', 'Clear search'); clear.type = 'button'; clear.dataset.clearSearch = ''; nav.append(clear); }
    }
    report(`${matches.length} of ${skills.length} skills${warnings.length ? '. ' + warnings.join(' ') : '.'}`);
  }
  function anchor(id) {
    let decoded; try { decoded = decodeURIComponent(id); } catch { decoded = id; }
    const heading = [...content.querySelectorAll('[id]')].find(item => item.id === `doc-heading-${decoded}`);
    heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true });
  }
  async function open(id, fragment = '', navigate = true) {
    const ticket = ++generation; report('Loading skill…'); content.setAttribute('aria-busy', 'true');
    try {
      const skill = await request(`/skills/content?id=${encodeURIComponent(id)}`);
      if (destroyed || ticket !== generation) return;
      current = id; tree();
      const heading = node('h2', 'docs-page-title', skill.title); heading.tabIndex = -1;
      const prose = node('div', 'docs-prose'), rendered = renderMarkdown(skill.markdown);
      prose.innerHTML = rendered.html;
      if (prose.firstElementChild?.tagName === 'H1' && rendered.headings[0]?.text === skill.title) {
        heading.id = prose.firstElementChild.id; prose.firstElementChild.remove();
      }
      // References are constrained to the indexed skill files. Other local paths are text.
      const docs = skills.flatMap(item => [item, ...item.references]);
      for (const link of prose.querySelectorAll('[data-doc-link]')) {
        const destination = resolveDocumentLink(link.dataset.docLink, id, docs);
        if (destination?.external) { link.href = destination.external; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.removeAttribute('data-doc-link'); }
        else if (!destination) { link.removeAttribute('href'); link.classList.add('docs-unavailable-link'); link.title = 'This file is outside the skill inspector.'; }
      }
      const source = node('details', 'skill-source'); source.append(node('summary', '', 'Original Markdown'));
      source.append(node('pre', '', skill.raw));
      const related = node('div', 'skill-references');
      const owner = skills.find(item => item.name === skill.name);
      for (const item of owner ? [owner, ...owner.references].filter(item => item.id !== id) : []) {
        const link = node('button', 'button quiet', item.id === owner.id ? '← Skill instructions' : `Reference: ${item.title}`); link.type = 'button'; link.dataset.skill = item.id; related.append(link);
      }
      content.replaceChildren(node('p', 'docs-breadcrumb', skill.path), heading, node('p', 'muted', skill.description), related, prose, source);
      toc.replaceChildren(node('strong', '', 'On this page'));
      for (const item of rendered.headings) { const link = node('a', `docs-toc-level-${item.level}`, item.text); link.href = `#${item.id}`; link.dataset.docAnchor = item.id; toc.append(link); }
      if (navigate) onNavigate({ view: 'skills', record: id });
      if (fragment) anchor(fragment); else if (navigate) heading.focus({ preventScroll: true });
    } catch (error) {
      if (!destroyed && ticket === generation) {
        current = null; const message = node('p', 'muted', 'This skill could not be loaded. Your project files were not changed.');
        const retry = node('button', 'button quiet', 'Try this skill again'); retry.type = 'button'; retry.dataset.retrySkill = id;
        content.replaceChildren(message, retry); toc.replaceChildren(); report(`${error.message} Check the project connection, then retry.`, true);
      }
    } finally { if (!destroyed && ticket === generation) content.removeAttribute('aria-busy'); }
  }
  async function refresh() {
    const ticket = ++listing; nav.setAttribute('aria-busy', 'true'); refreshButton.disabled = true; report(skills.length ? 'Refreshing installed skills…' : 'Loading installed skills…');
    try {
      const result = await request('/skills'); if (destroyed || ticket !== listing) return;
      skills = Array.isArray(result.skills) ? result.skills : []; warnings = Array.isArray(result.warnings) ? result.warnings : []; tree();
    } catch (error) { if (!destroyed && ticket === listing) report(`${error.message} ${skills.length ? 'Existing instructions remain available' : 'No skill list was loaded'}; check the project connection and use Refresh skills.`, true); }
    finally { if (!destroyed && ticket === listing) { nav.removeAttribute('aria-busy'); refreshButton.disabled = false; } }
  }
  const click = async event => {
    const target = event.target.closest('button,a'); if (!target || !container.contains(target)) return;
    if (target.hasAttribute('data-refresh')) { await refresh(); if (current) await open(current, '', false); }
    else if (target.hasAttribute('data-clear-search')) { search.value = ''; tree(); search.focus(); }
    else if (target.dataset.retrySkill) await open(target.dataset.retrySkill);
    else if (target.dataset.skill) await open(target.dataset.skill);
    else if (target.hasAttribute('data-doc-anchor')) { event.preventDefault(); anchor(target.dataset.docAnchor); }
    else if (target.hasAttribute('data-doc-link')) {
      event.preventDefault(); const destination = resolveDocumentLink(target.dataset.docLink, current, skills.flatMap(item => [item, ...item.references]));
      if (destination?.id) { if (destination.id === current) anchor(destination.anchor); else await open(destination.id, destination.anchor); }
    } else if (target.hasAttribute('data-copy-code')) {
      try { await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent); report('Code copied.'); } catch { report('Select the code text to copy it manually.', true); }
    }
  };
  container.addEventListener('click', click); search.addEventListener('input', tree);
  const ready = refresh();
  return { refresh, async open(id, fragment) { await ready; if (!destroyed) await open(id, fragment, false); }, destroy() { destroyed = true; generation++; listing++; container.removeEventListener('click', click); search.removeEventListener('input', tree); container.replaceChildren(); } };
}
