export function mountSearch({dialog,trigger,project,api,initiatives,navigate}) {
  const input = dialog.querySelector('#search-query'), results = dialog.querySelector('#search-results'), status = dialog.querySelector('#search-status');
  let generation = 0, timer;
  function open() { if (!project()) return; if (!dialog.open) dialog.showModal(); input.focus(); input.select(); void search(); }
  async function search() {
    const ticket = ++generation, projectId = project(), query = input.value.trim(); results.replaceChildren();
    if (query.length < 2) { status.textContent = 'Type at least two characters. Shortcut: Ctrl K.'; return; }
    status.textContent = 'Searching…';
    try {
      const response = await api(`/search?query=${encodeURIComponent(query)}&limit=40`);
      if (ticket !== generation || projectId !== project() || !dialog.open) return;
      const matches = initiatives().filter(i => `${i.title} ${i.request}`.toLowerCase().includes(query.toLowerCase())).map(i => ({type:'initiative',item:i,view:'board',id:i.id}));
      for (const result of response) {
        const item = result.task || result.document || result.decision;
        if (!item) continue;
        const type = result.type;
        matches.push({type,item,view:type === 'task' ? 'tasks' : type === 'document' ? 'documents' : 'decisions',...(type === 'task' ? {task:item.id} : {record:item.id})});
      }
      status.textContent = matches.length ? `${matches.length} results` : 'No matching records.';
      for (const match of matches) {
        const button = document.createElement('button'); button.className = 'workspace-search-result';
        const title = document.createElement('strong'); title.textContent = match.item.title;
        const meta = document.createElement('span'); meta.textContent = `${match.type} · ${match.item.id}`;
        button.append(title,meta); button.addEventListener('click', () => { dialog.close(); Promise.resolve(navigate(match)).catch(error => { status.textContent = error.message; dialog.showModal(); }); }); results.append(button);
      }
    } catch (error) { if (ticket === generation && dialog.open) status.textContent = error.message; }
  }
  trigger.addEventListener('click',open);
  dialog.querySelector('#search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; clearTimeout(timer); trigger.focus(); });
  input.addEventListener('input', () => { generation++; clearTimeout(timer); timer = setTimeout(search,200); });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); open(); } });
}
