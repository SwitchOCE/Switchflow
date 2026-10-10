import { renderMarkdown, resolveDocumentLink } from './documents.js';
import { createRefreshControl } from './refresh-control.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const references = skill => (Array.isArray(skill?.references) ? skill.references : []);
const allDocuments = skills => skills.flatMap(item => [item, ...references(item)]);

export function mountSkills(container, { request, onNavigate = () => {} }) {
  container.classList.add('skills-view');
  container.innerHTML = `<header class="page-header"><div><h1 class="skills-title">Skills <span class="chip">Read only</span></h1><p>Instructions agents follow in this project.</p></div>
    <div class="page-actions"><div class="refresh-control"></div></div></header>
    <div class="skills-layout">
      <aside class="panel skills-list" aria-label="Skill list">
        <div class="skills-search"><input type="search" placeholder="Filter skills" aria-label="Find a skill" data-skill-search></div>
        <p class="skills-status" role="status" aria-live="polite"></p>
        <nav class="skills-nav" aria-label="Switchflow skills"></nav>
      </aside>
      <article class="panel skills-reader" aria-label="Skill instructions">
        <div class="skills-document"><div class="empty"><strong>Choose a skill</strong><span>Its instructions open here.</span></div></div>
        <aside class="skills-toc" aria-label="On this page"></aside>
      </article>
    </div>`;
  const find = selector => container.querySelector(selector);
  const search = find('[data-skill-search]'),
    nav = find('.skills-nav'),
    content = find('.skills-document'),
    toc = find('.skills-toc'),
    status = find('.skills-status');
  // A manual refresh also reloads the open skill.
  const refreshControl = createRefreshControl(async () => {
    await refresh();
    if (current) await open(current, '', false);
  });
  refreshControl.mount(find('.refresh-control'));
  let skills = [],
    warnings = [],
    current = null,
    destroyed = false,
    generation = 0,
    listing = 0,
    requested = false;
  const report = (text, error = false) => {
    status.textContent = text;
    status.setAttribute('role', error ? 'alert' : 'status');
    status.classList.toggle('is-error', error);
  };
  function tree() {
    const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.skill : null;
    const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = skills.filter(skill =>
      terms.every(term => `${skill.name} ${skill.title} ${skill.description || ''}`.toLocaleLowerCase().includes(term)),
    );
    nav.replaceChildren();
    const list = node('ul', 'skills-items');
    for (const skill of matches) {
      const item = node('li', 'skills-item');
      const button = node('button', 'skills-item-button', skill.title || skill.name);
      button.type = 'button';
      button.dataset.skill = skill.id;
      if (current?.split('/')[0] === skill.name) {
        button.setAttribute('aria-current', 'page');
        item.classList.add('is-current');
      }
      item.append(button);
      if (skill.description) item.append(node('p', 'skills-item-description', skill.description));
      const count = references(skill).length;
      if (count) item.append(node('span', 'skills-item-meta', count === 1 ? '1 reference' : `${count} references`));
      list.append(item);
      if (focused === skill.id) queueMicrotask(() => button.focus({ preventScroll: true }));
    }
    if (matches.length) nav.append(list);
    else {
      const empty = node('div', 'empty skills-empty');
      empty.append(
        node(
          'span',
          '',
          skills.length ? 'No skills match.' : 'No skills are installed. Restore the skill files, then refresh.',
        ),
      );
      if (skills.length) {
        const clear = node('button', 'button quiet button-small', 'Clear filter');
        clear.type = 'button';
        clear.dataset.clearSearch = '';
        empty.append(clear);
      }
      nav.append(empty);
    }
    const summary =
      matches.length === skills.length ? `${skills.length} skills` : `${matches.length} of ${skills.length} skills`;
    report(`${summary}${warnings.length ? '. ' + warnings.join(' ') : ''}`);
  }
  function anchor(id) {
    let decoded;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      decoded = id;
    }
    const heading = [...content.querySelectorAll('[id]')].find(item => item.id === `doc-heading-${decoded}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }
  async function open(id, fragment = '', navigate = true) {
    const ticket = ++generation;
    report('Loading skill…');
    content.setAttribute('aria-busy', 'true');
    try {
      const skill = await request(`/skills/content?id=${encodeURIComponent(id)}`);
      if (destroyed || ticket !== generation) return;
      current = id;
      tree();
      const heading = node('h2', 'skills-doc-title', skill.title);
      heading.tabIndex = -1;
      const prose = node('div', 'docs-prose skills-prose'),
        rendered = renderMarkdown(skill.markdown || '');
      prose.innerHTML = rendered.html;
      if (prose.firstElementChild?.tagName === 'H1' && rendered.headings[0]?.text === skill.title) {
        heading.id = prose.firstElementChild.id;
        prose.firstElementChild.remove();
      }
      // References are constrained to the indexed skill files. Other local paths are text.
      const docs = allDocuments(skills);
      for (const link of prose.querySelectorAll('[data-doc-link]')) {
        const destination = resolveDocumentLink(link.dataset.docLink, id, docs);
        if (destination?.external) {
          link.href = destination.external;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.removeAttribute('data-doc-link');
        } else if (!destination) {
          link.removeAttribute('href');
          link.classList.add('docs-unavailable-link');
          link.title = 'This file is outside the skill folder.';
        }
      }
      const owner = skills.find(item => item.name === (skill.name || id.split('/')[0]));
      const header = node('header', 'skills-doc-header');
      if (skill.path) header.append(node('p', 'skills-doc-path', skill.path));
      header.append(heading);
      const description = skill.description || owner?.description;
      if (description) header.append(node('p', 'skills-doc-description', description));
      const files = owner ? [owner, ...references(owner)] : [];
      if (files.length > 1) {
        const related = node('nav', 'skill-references');
        related.setAttribute('aria-label', 'Files in this skill');
        for (const item of files) {
          const link = node(
            'button',
            'skills-file',
            item.id === owner.id ? 'Instructions' : item.title || item.id.split('/').pop(),
          );
          link.type = 'button';
          link.dataset.skill = item.id;
          if (item.id === id) link.setAttribute('aria-current', 'page');
          related.append(link);
        }
        header.append(related);
      }
      const children = [header, prose];
      if (skill.raw) {
        const source = node('details', 'skill-source');
        source.append(node('summary', '', 'Original Markdown'), node('pre', '', skill.raw));
        children.push(source);
      }
      content.replaceChildren(...children);
      toc.replaceChildren();
      if (rendered.headings.length > 1) {
        toc.append(node('strong', '', 'On this page'));
        for (const item of rendered.headings) {
          if (item.id === heading.id) continue;
          const link = node('a', `docs-toc-level-${item.level}`, item.text);
          link.href = `#${item.id}`;
          link.dataset.docAnchor = item.id;
          toc.append(link);
        }
      }
      toc.hidden = !toc.childElementCount;
      if (navigate) onNavigate({ view: 'skills', record: id });
      if (fragment) anchor(fragment);
      else if (navigate) {
        if (matchMedia('(max-width: 900px)').matches) heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!destroyed && ticket === generation) {
        current = null;
        const message = node('div', 'empty');
        message.append(node('strong', '', 'This skill could not be loaded'), node('span', '', 'Nothing was changed.'));
        const retry = node('button', 'button quiet', 'Try again');
        retry.type = 'button';
        retry.dataset.retrySkill = id;
        message.append(retry);
        content.replaceChildren(message);
        toc.replaceChildren();
        toc.hidden = true;
        report(`${error.message} Check the project connection, then try again.`, true);
      }
    } finally {
      if (!destroyed && ticket === generation) content.removeAttribute('aria-busy');
    }
  }
  async function refresh() {
    const ticket = ++listing;
    nav.setAttribute('aria-busy', 'true');
    if (!skills.length) report('Loading skills…');
    try {
      const result = await request('/skills');
      if (destroyed || ticket !== listing) return;
      skills = Array.isArray(result.skills) ? result.skills : [];
      warnings = Array.isArray(result.warnings) ? result.warnings : [];
      tree();
      refreshControl.loaded();
      // Show the first skill rather than an empty reader, unless a specific record was asked for.
      if (!current && !requested && skills.length) void open(skills[0].id, '', false);
    } catch (error) {
      if (!destroyed && ticket === listing) {
        report(
          `${error.message} ${skills.length ? 'The current list is still shown.' : 'No skills were loaded.'} Check the project connection and refresh.`,
          true,
        );
        refreshControl.failed(error);
      }
    } finally {
      if (!destroyed && ticket === listing) {
        nav.removeAttribute('aria-busy');
      }
    }
  }
  const click = async event => {
    const target = event.target.closest('button,a');
    if (!target || !container.contains(target)) return;
    if (target.hasAttribute('data-clear-search')) {
      search.value = '';
      tree();
      search.focus();
    } else if (target.dataset.retrySkill) await open(target.dataset.retrySkill);
    else if (target.dataset.skill) await open(target.dataset.skill);
    else if (target.hasAttribute('data-doc-anchor')) {
      event.preventDefault();
      anchor(target.dataset.docAnchor);
    } else if (target.hasAttribute('data-doc-link')) {
      event.preventDefault();
      const destination = resolveDocumentLink(target.dataset.docLink, current, allDocuments(skills));
      if (destination?.id) {
        if (destination.id === current) anchor(destination.anchor);
        else await open(destination.id, destination.anchor);
      }
    } else if (target.hasAttribute('data-copy-code')) {
      try {
        await navigator.clipboard.writeText(target.closest('.docs-code').querySelector('code').textContent);
        report('Code copied.');
      } catch {
        report('Select the code text to copy it manually.', true);
      }
    }
  };
  container.addEventListener('click', click);
  search.addEventListener('input', tree);
  const ready = refresh();
  return {
    refresh,
    async open(id, fragment) {
      requested = true;
      await ready;
      if (!destroyed) await open(id, fragment, false);
    },
    destroy() {
      destroyed = true;
      refreshControl.destroy();
      generation++;
      listing++;
      container.removeEventListener('click', click);
      search.removeEventListener('input', tree);
      container.classList.remove('skills-view');
      container.replaceChildren();
    },
  };
}
