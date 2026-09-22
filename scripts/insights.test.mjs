import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildStatisticsModel, completionPage, mergeSettingsConfig, validateSettingsDraft } from '../template/.switchflow/scripts/control/public/insights.js';
import { formatProjectDate, normalizeDateFormat } from '../template/.switchflow/scripts/control/public/ui-date.js';

test('statistics use native totals and reconcile task-backed milestone and completion rows', () => {
  const statistics = { totalTasks: 4, completedTasks: 2, completionPercentage: 50, draftCount: 1, statusCounts: { Ready: 1, Doing: 1, Done: 2 }, priorityCounts: { High: 2, Low: 1 }, noPriorityCount: 1 };
  const tasks = [
    { id: 'SF-1', title: 'First', status: 'Done', priority: 'High', milestone: 'Launch', updatedDate: '2026-09-18' },
    { id: 'SF-2', title: 'Second', status: 'Ready', milestone: 'Launch' },
    { id: 'SF-3', title: 'Third', status: 'Done', updatedDate: '2026-09-19' },
    { id: 'SF-4', title: 'Fourth', status: 'Doing', milestone: 'Polish' },
  ];
  const model = buildStatisticsModel(statistics, tasks, [{ id: 'Launch', title: 'Launch outcome' }, { id: 'Polish', title: 'Polish outcome' }]);
  assert.equal(model.totalTasks, 4); assert.equal(model.completedTasks, 2); assert.equal(model.corpusMatches, true);
  assert.deepEqual(model.milestones, [{ label: 'Launch outcome', count: 2 }, { label: 'No milestone', count: 1 }, { label: 'Polish outcome', count: 1 }]);
  assert.deepEqual(model.completionHistory.map(task => task.id), ['SF-3', 'SF-1']);
  assert.deepEqual(model.completionHistory.map(task => task.milestoneTitle), ['No milestone', 'Launch outcome']);
  assert.deepEqual(model.priority.at(-1), { label: 'No priority', count: 1 });
});

test('statistics withhold task-derived breakdowns when corpus counts do not match', () => {
  const model = buildStatisticsModel({ totalTasks: 3, statusCounts: { Ready: 3 } }, [{ id: 'SF-1', status: 'Ready', milestone: 'Partial' }]);
  assert.equal(model.corpusMatches, false); assert.deepEqual(model.milestones, []); assert.deepEqual(model.completionHistory, []);
});

test('completion history pages clamp ranges and project dates use the configured format', () => {
  const page = completionPage(Array.from({ length: 45 }, (_, index) => index + 1), 9);
  assert.equal(page.page, 2); assert.deepEqual(page.items, [41, 42, 43, 44, 45]); assert.equal(page.start, 41); assert.equal(page.end, 45);
  assert.equal(formatProjectDate('2026-09-22T23:10:00Z', 'dd/mm/yyyy'), '22/09/2026');
  assert.equal(formatProjectDate('2026-09-22', 'mm/dd/yyyy'), '09/22/2026');
  assert.equal(normalizeDateFormat('unexpected'), 'yyyy-mm-dd');
});

test('settings save merges only edited fields into the latest full native config', () => {
  const latest = { projectName: 'Fresh server name', statuses: ['Ready', 'Done'], labels: ['keep'], customFutureField: { nested: true }, autoCommit: false, defaultPort: 6420 };
  const values = { projectName: 'Draft name', autoCommit: true, definitionOfDone: [' Verify ', '', 'Ship'], defaultPort: '' };
  const merged = mergeSettingsConfig(latest, values, new Set(['projectName', 'definitionOfDone']));
  assert.equal(merged.projectName, 'Draft name'); assert.equal(merged.autoCommit, false); assert.equal(merged.defaultPort, 6420);
  assert.deepEqual(merged.definitionOfDone, ['Verify', 'Ship']); assert.deepEqual(merged.customFutureField, { nested: true }); assert.deepEqual(merged.statuses, ['Ready', 'Done']);
  const cleared = mergeSettingsConfig(merged, { definitionOfDone: [] }, new Set(['definitionOfDone']));
  assert.equal('definitionOfDone' in cleared, false);
});

test('settings validation reports native range, required and enum constraints', () => {
  const errors = validateSettingsDraft({ projectName: ' ', dateFormat: 'other', defaultStatus: 'Missing', defaultPort: 70000, maxColumnWidth: 19.5, zeroPaddedIds: -1, taskResolutionStrategy: 'fastest' }, ['Ready', 'Done']);
  assert.deepEqual(Object.keys(errors).sort(), ['dateFormat', 'defaultPort', 'defaultStatus', 'maxColumnWidth', 'projectName', 'taskResolutionStrategy', 'zeroPaddedIds'].sort());
  assert.deepEqual(validateSettingsDraft({ projectName: 'Project', dateFormat: 'dd/mm/yyyy', defaultStatus: 'Ready', defaultPort: 6420, maxColumnWidth: 80, zeroPaddedIds: 3, taskResolutionStrategy: 'most_recent' }, ['Ready', 'Done']), {});
});

test('insights assets avoid inline styles and raw JSON product controls', async () => {
  const [source, css] = await Promise.all([
    fs.readFile(new URL('../template/.switchflow/scripts/control/public/insights.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../template/.switchflow/scripts/control/public/insights.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(source, /\.style\.|style\s*=/); assert.match(source, /node\('progress'\)/);
  assert.match(css, /html\[data-theme=dark\]/); assert.doesNotMatch(css, /(?:^|})\s*(?:body|:root|html)\s*\{/);
});
