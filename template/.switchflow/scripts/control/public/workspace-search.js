const nativeLimit = 40;
const types = [
  ['initiative', 'Initiatives'],
  ['milestone', 'Milestones'],
  ['task', 'Tasks'],
  ['document', 'Documents'],
  ['decision', 'Decisions'],
];

const text = value => (value === null || value === undefined ? '' : String(value));

function compact(value) {
  return text(value)
    .replace(/[#>*_`\[\](){}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchedSnippet(item, query, maximum = 180) {
  const source =
    [
      item.request,
      item.description,
      item.content,
      item.rawContent,
      item.body,
      item.context,
      item.outcome,
      item.summary,
      item.finalSummary,
      item.implementationNotes,
    ]
      .map(compact)
      .find(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ||
    [item.description, item.request, item.content, item.rawContent, item.body, item.summary]
      .map(compact)
      .find(Boolean) ||
    '';
  if (!source || source.length <= maximum) return source;
  const at = Math.max(0, source.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()));
  const start = Math.max(0, Math.min(at - 45, source.length - maximum));
  return `${start ? '…' : ''}${source.slice(start, start + maximum).trim()}${start + maximum < source.length ? '…' : ''}`;
}

export function buildSearchMatches(response, localInitiatives, query, milestones = []) {
  const needle = query.toLocaleLowerCase();
  const matches = (localInitiatives || [])
    .filter(item => `${text(item.title)} ${text(item.request)}`.toLocaleLowerCase().includes(needle))
    .map(item => ({ type: 'initiative', item, view: 'overview', id: item.id }));
  // The native search covers tasks and documents only; milestones match on title and ID here.
  for (const item of Array.isArray(milestones) ? milestones : [])
    if (item?.id && `${text(item.id)} ${text(item.title)}`.toLocaleLowerCase().includes(needle))
      matches.push({ type: 'milestone', item, view: 'milestones', record: item.id });
  for (const result of Array.isArray(response) ? response : []) {
    const item = result.task || result.document || result.decision;
    if (!item || !['task', 'document', 'decision'].includes(result.type)) continue;
    const view = result.type === 'task' ? 'tasks' : result.type === 'document' ? 'documents' : 'decisions';
    matches.push({
      type: result.type,
      item,
      view,
      ...(result.type === 'task' ? { task: item.id } : { record: item.id }),
    });
  }
  return matches;
}

function resultContext(match) {
  return [match.type, match.item.id, match.item.status, match.item.milestone, match.item.path]
    .map(text)
    .map(value => value.trim())
    .filter(Boolean)
    .join(' · ');
}

export function mountSearch({ dialog, trigger, project, api, initiatives, navigate, commands = () => [] }) {
  const input = dialog.querySelector('#search-query'),
    results = dialog.querySelector('#search-results'),
    status = dialog.querySelector('#search-status');
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'workspace-search-scopes';
  const legend = document.createElement('legend');
  legend.className = 'sr-only';
  legend.textContent = 'Record types';
  fieldset.append(legend);
  for (const [value, labelText] of types) {
    const label = document.createElement('label'),
      checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    checkbox.checked = true;
    checkbox.dataset.searchScope = value;
    label.append(checkbox, document.createTextNode(labelText));
    fieldset.append(label);
  }
  const help = document.createElement('p');
  help.className = 'workspace-search-help';
  help.textContent = `Shows up to ${nativeLimit} matching records. Add words to narrow the results.`;
  input.closest('label')?.after(fieldset, help);

  let generation = 0,
    timer,
    loaded = [],
    query = '',
    nativeCount = 0,
    commandMatches = [],
    milestoneCache = null,
    selected = -1;
  // One milestone list per project for a short while, so typing does not refetch it per keystroke.
  const loadMilestones = async projectId => {
    if (milestoneCache?.project === projectId && Date.now() - milestoneCache.at < 15000) return milestoneCache.value;
    const value = await api('/milestones');
    const list = Array.isArray(value) ? value : value?.milestones || [];
    milestoneCache = { project: projectId, at: Date.now(), value: list };
    return list;
  };
  const matchCommands = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return commands().filter(command => words.every(word => command.label.toLowerCase().includes(word)));
  };
  const renderCommands = () => {
    for (const command of commandMatches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-search-result is-command';
      const title = document.createElement('strong');
      title.textContent = command.label;
      button.append(title);
      if (command.hint) {
        const meta = document.createElement('span');
        meta.textContent = command.hint;
        button.append(meta);
      }
      button.addEventListener('click', () => {
        dialog.close();
        command.run();
      });
      results.append(button);
    }
  };
  const selectedTypes = () =>
    new Set([...fieldset.querySelectorAll('[data-search-scope]:checked')].map(item => item.value));
  const buttons = () => [...results.querySelectorAll('.workspace-search-result')];
  const select = (index, focus = false) => {
    const choices = buttons();
    selected = choices.length ? (index + choices.length) % choices.length : -1;
    choices.forEach((button, itemIndex) => {
      const current = itemIndex === selected;
      button.classList.toggle('is-selected', current);
    });
    if (focus && selected >= 0) choices[selected].focus({ preventScroll: true });
  };
  const activate = async match => {
    dialog.close();
    try {
      await navigate(match);
    } catch (error) {
      status.textContent = `${error.message} Your search is still available.`;
      dialog.showModal();
      input.focus();
    }
  };
  const render = () => {
    const scopes = selectedTypes(),
      shown = loaded.filter(match => scopes.has(match.type));
    results.replaceChildren();
    selected = -1;
    renderCommands();
    for (const match of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-search-result';
      const title = document.createElement('strong');
      title.textContent = match.item.title || match.item.name || match.item.id || 'Untitled record';
      const meta = document.createElement('span');
      meta.textContent = resultContext(match);
      const excerpt = matchedSnippet(match.item, query);
      button.append(title, meta);
      if (excerpt) {
        const snippet = document.createElement('span');
        snippet.className = 'workspace-search-snippet';
        snippet.textContent = excerpt;
        button.append(snippet);
      }
      button.addEventListener('click', () => activate(match));
      results.append(button);
    }
    const nativeCapped = nativeCount >= nativeLimit;
    if (!shown.length)
      status.textContent = scopes.size
        ? `No matching records${nativeCapped ? ` in the first ${nativeLimit} results` : ''}. Try other words or record types.`
        : 'Choose at least one record type.';
    else
      status.textContent = `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}.${nativeCapped ? ` Showing the first ${nativeLimit}; add words to narrow.` : ''}`;
  };
  function open() {
    if (!project()) return;
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
    void search();
  }
  async function search() {
    const ticket = ++generation,
      projectId = project();
    query = input.value.trim();
    results.replaceChildren();
    loaded = [];
    nativeCount = 0;
    commandMatches = matchCommands();
    if (query.length < 2) {
      renderCommands();
      status.textContent = 'Type to search tasks, milestones, documents, decisions and initiatives.';
      return;
    }
    status.textContent = 'Searching this project…';
    dialog.setAttribute('aria-busy', 'true');
    try {
      const scopes = selectedTypes();
      const [response, milestones] = await Promise.all([
        [...scopes].some(type => !['initiative', 'milestone'].includes(type))
          ? api(`/search?query=${encodeURIComponent(query)}&limit=${nativeLimit}`)
          : [],
        // Older Backlog runtimes without a milestone route still search everything else.
        scopes.has('milestone') ? loadMilestones(projectId).catch(() => []) : [],
      ]);
      if (ticket !== generation || projectId !== project() || !dialog.open) return;
      nativeCount = Array.isArray(response) ? response.length : 0;
      loaded = buildSearchMatches(response, scopes.has('initiative') ? initiatives() : [], query, milestones);
      render();
    } catch (error) {
      if (ticket === generation && dialog.open)
        status.textContent = `${error.message} Check the project connection, then refine the search or try again.`;
    } finally {
      if (ticket === generation) dialog.removeAttribute('aria-busy');
    }
  }
  trigger.addEventListener('click', open);
  dialog.querySelector('#search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    clearTimeout(timer);
    dialog.removeAttribute('aria-busy');
    trigger.focus();
  });
  input.addEventListener('input', () => {
    generation++;
    clearTimeout(timer);
    timer = setTimeout(search, 200);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && buttons().length) {
      event.preventDefault();
      select(0, true);
    } else if (event.key === 'Enter' && buttons().length) {
      event.preventDefault();
      buttons()[0].click();
    }
  });
  results.addEventListener('keydown', event => {
    const choices = buttons(),
      at = choices.indexOf(document.activeElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      select(at + 1, true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (at === 0) {
        selected = -1;
        input.focus();
      } else select(at - 1, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(0, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(choices.length - 1, true);
    }
  });
  fieldset.addEventListener('change', () => {
    if (input.value.trim().length >= 2) void search();
    else render();
  });
  document.addEventListener('keydown', event => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'k' &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      open();
    }
  });
}
