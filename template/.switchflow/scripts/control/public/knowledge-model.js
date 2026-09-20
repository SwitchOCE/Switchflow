export const decisionSeed = '## Context\n\nDescribe the problem and constraints.\n\n## Decision\n\nDescribe the chosen approach and why.\n\n## Consequences\n\nDescribe benefits, costs and risks.\n\n## Alternatives\n\nDescribe alternatives considered.\n';
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function folderOf(record) { return (record.path || '').replaceAll('\\', '/').split('/').slice(0, -1).join('/'); }
export function draftFrom(record, kind) {
  return { id: record?.id || '', title: record?.title || '', content: record?.rawContent ?? (kind === 'decisions' ? decisionSeed : ''), type: record?.type || 'other', tags: (record?.tags || []).join(', '), folder: record ? folderOf(record) : '' };
}
export function knowledgePayload(draft, kind) {
  if (!draft.title.trim()) throw new Error('A title is required.');
  if (kind === 'decisions') {
    const headings = new Set(); let section = ''; let fence = '';
    for (const line of draft.content.replace(/\r\n/g, '\n').split('\n')) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) { if (!fence) fence = marker[0]; else if (fence === marker[0]) fence = ''; }
      const heading = !fence && /^##[ \t]+(.+?)[ \t]*$/.exec(line);
      if (heading) {
        section = heading[1].toLowerCase();
        if (!['context','decision','consequences','alternatives'].includes(section) || headings.has(section)) throw new Error('Use each decision section once. Put additional headings inside a section using ###.');
        headings.add(section);
      } else if (!section && line.trim()) throw new Error('Place all text under a decision section heading so it can be saved without loss.');
    }
    if (['context','decision','consequences'].some(h => !headings.has(h))) throw new Error('Keep the Context, Decision and Consequences headings. Alternatives is optional.');
    return {title: draft.title.trim(), content: draft.content};
  }
  const folder = draft.folder.trim().replaceAll('\\', '/');
  if (folder.startsWith('/') || /[:\u0000-\u001f]/.test(folder) || folder.split('/').some(p => p === '..' || p === '.')) throw new Error('Use a project-relative folder without dot segments.');
  return {title: draft.title.trim(), content: draft.content, type: draft.type, tags: [...new Set(draft.tags.split(',').map(t => t.trim()).filter(Boolean))], path: folder || (draft.id ? null : '')};
}
export function recordFingerprint(record) {
  return JSON.stringify([record.id, record.title, record.rawContent, record.type, record.tags || [], record.path, record.status, record.date]);
}
