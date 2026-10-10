// Switchflow in the Desktop Code tab: a status entry, an approval band above the prompt,
// a board pane and toasts, all drawn from the machine-wide control service.
// Approvals happen here, by the owner's press, and never through a tool the model can call.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import {
  connect,
  events as feedPage,
  initiativeAction,
  interrupt,
  loadSnapshot,
  setLocalPause,
  steer,
  testEnvironment,
} from './client';
import type { Connection, Host } from './client';
import {
  emptySnapshot,
  feedMarkdown,
  stageTrack,
  statusLabel,
  statusText,
  transitions,
  workersByEnvironment,
} from './model';
import type { SwitchflowAction, SwitchflowFeed, SwitchflowSnapshot, SwitchflowWorker } from './types';

const PANE = 'switchflow';
const POLL_MS = 3000;
// The registry (and its CSRF token) is read again this often while connected.
const RECONNECT_MS = 30000;
const FEED_LIMIT = 200;

const snapshot = atom({ plugin: 'switchflow', key: 'snapshot' } as const, null);
const selected = atom({ plugin: 'switchflow', key: 'selected' } as const, null);
const feed = atom({ plugin: 'switchflow', key: 'feed' } as const, { sessionId: null, after: 0, events: [] });
const tests = atom({ plugin: 'switchflow', key: 'tests' } as const, {});
const form = atom({ plugin: 'switchflow', key: 'form' } as const, null);
const notice = atom({ plugin: 'switchflow', key: 'notice' } as const, null);

const saved: Record<string, string> = {
  'approve-scope': 'Scope approved. Planning is queued.',
  'approve-plan': 'Plan approved. Delivery is queued.',
  'request-changes': 'Sent to the agent. It will revise and bring it back for your review.',
  'request-rework': 'Rework requested. The agent will return with updated checks.',
  'accept-uat': 'Accepted. The initiative is complete.',
  retry: 'Testing the environments again. Delivery starts if they are ready.',
  'resume-workers': 'Resuming the held workers.',
  'recover-run': 'Recovery hold released.',
  'stop-processes': 'Stopping the held processes.',
  confirm: 'Approach confirmed. The worker may now edit.',
};

const working = (worker: SwitchflowWorker) => ['working', 'running', 'starting'].includes(worker.status);

// The module's own; a reload starts them over and the next poll reconnects.
let connection: Connection | null = null;
let connectedAt = 0;
let polling: Promise<void> | null = null;

async function hostOf($: EngineInterface): Promise<Host> {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    read: async path => (await $.fs.read(path)) as string,
    env: {
      SWITCHFLOW_HOME: await $.env.get('SWITCHFLOW_HOME'),
      LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
      HOME: await $.env.get('HOME'),
      USERPROFILE: await $.env.get('USERPROFILE'),
    },
  };
}

async function publish($: EngineInterface, next: SwitchflowSnapshot) {
  const previous = await read($, snapshot);
  for (const text of transitions(previous, next)) $.ui.toast(text);
  await update($, snapshot, () => next);
  $.ui.status(statusText(next));
}

async function loadFeed($: EngineInterface) {
  const id = await read($, selected);
  if (!id || !connection) return;
  const current: SwitchflowFeed = await read($, feed);
  const after = current.sessionId === id ? current.after : 0;
  const page = await feedPage(await hostOf($), connection, id, after).catch(() => null);
  if (!page) return;
  await update($, feed, value =>
    value.sessionId === id
      ? { sessionId: id, after: page.after, events: [...value.events, ...page.events].slice(-FEED_LIMIT) }
      : { sessionId: id, after: page.after, events: page.events.slice(-FEED_LIMIT) },
  );
}

async function poll($: EngineInterface) {
  const now = await $.clock.now();
  if (!connection || now - connectedAt > RECONNECT_MS) {
    const found = await connect(await hostOf($), await $.session.cwd());
    if ('snapshot' in found) {
      connection = null;
      return publish($, found.snapshot);
    }
    connection = found.connection;
    connectedAt = now;
  }
  let next: SwitchflowSnapshot;
  try {
    next = await loadSnapshot(await hostOf($), connection);
  } catch (error) {
    connection = null;
    next = emptySnapshot('down', (error as Error).message);
  }
  await publish($, next);
  await loadFeed($);
}

// One poll at a time; a press that refreshes waits for the poll under way.
function refresh($: EngineInterface) {
  polling ??= poll($)
    .catch(error => $.ui.log(`switchflow: poll failed: ${(error as Error).message}`, { to: 'debug' }))
    .finally(() => {
      polling = null;
    });
  return polling;
}

function say($: EngineInterface, text: string | null) {
  return update($, notice, () => text);
}

async function run($: EngineInterface, action: SwitchflowAction, text?: string) {
  await update($, form, () => null);
  if (!connection) return say($, 'Not connected to the Switchflow service.');
  try {
    if (action.target === 'initiative' && action.initiativeId) {
      const current = await read($, snapshot);
      const revision = current?.initiatives.find(item => item.id === action.initiativeId)?.revision ?? null;
      const payload = { ...action.payload, ...(action.input ? { [action.input.payloadKey]: text ?? '' } : {}) };
      await initiativeAction(await hostOf($), connection, action.initiativeId, action.action, revision, payload);
    } else if (action.target === 'steer' && action.sessionId)
      await steer(await hostOf($), connection, action.sessionId, action.payload ?? {});
    await say($, saved[action.action] ?? 'Saved.');
  } catch (error) {
    await say($, `Not saved: ${(error as Error).message}`);
  }
  await refresh($);
}

async function press($: EngineInterface, action: SwitchflowAction) {
  await say($, null);
  if (action.input || action.confirm)
    return update($, form, () => ({ actionKey: action.key, step: action.input ? 'input' : 'confirm' }));
  return run($, action);
}

async function testAll($: EngineInterface) {
  const current = await read($, snapshot);
  if (!connection || !current) return;
  for (const environment of current.environments) {
    const result = await testEnvironment(await hostOf($), connection, environment.id);
    await update($, tests, value => ({ ...value, [environment.id]: result }));
    if (result.ok === false) $.ui.toast(`Switchflow: ${environment.label} is not ready. ${result.reason ?? ''}`.trim());
  }
}

async function togglePause($: EngineInterface) {
  const capacity = (await read($, snapshot))?.capacity;
  if (!connection || !capacity) return;
  try {
    await setLocalPause(await hostOf($), connection, !capacity.isPaused, capacity.settingsRevision);
    await say($, capacity.isPaused ? 'Local workers resumed. Queued workers start in order.' : 'Local workers paused.');
  } catch (error) {
    await say($, `Not saved: ${(error as Error).message}`);
  }
  await refresh($);
}

async function choose($: EngineInterface, id: string) {
  await update($, selected, () => id);
  await update($, feed, () => ({ sessionId: id, after: 0, events: [] }));
  await update($, form, () => null);
  await loadFeed($);
}

async function sendSteer($: EngineInterface, worker: SwitchflowWorker, text: string) {
  if (!connection || !text.trim()) return;
  try {
    const result = await steer(await hostOf($), connection, worker.id, {
      message: text.trim(),
      ...(working(worker) ? { mode: 'steer' } : {}),
    });
    await say(
      $,
      { followup: 'Sent as a follow-up turn.', queue: 'Queued for when this turn finishes.' }[result.mode as string] ??
        'Sent. The agent reads it at its next step.',
    );
  } catch (error) {
    await say($, `Not sent: ${(error as Error).message}`);
  }
  await loadFeed($);
}

async function stop($: EngineInterface, worker: SwitchflowWorker) {
  await update($, form, () => null);
  if (!connection) return;
  try {
    await interrupt(await hostOf($), connection, worker.id);
    await say($, 'Stop requested.');
  } catch (error) {
    await say($, `Not stopped: ${(error as Error).message}`);
  }
  await refresh($);
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // `/switchflow:board` as planned; the engine documents command names as letters, digits, _ and -,
    // so a build that refuses the colon gets `/switchflow-board` instead.
    await $.command
      .register({ name: 'switchflow:board', description: 'Open the Switchflow board for this project' })
      .catch(() =>
        $.command.register({ name: 'switchflow-board', description: 'Open the Switchflow board for this project' }),
      );
    $.clock.every(POLL_MS, () => void refresh($));
    void refresh($);
    return next(e);
  });

  on('command.run', { command: 'switchflow:board' }, async $ => {
    await refresh($);
    await $.ui.open({ id: PANE, title: 'Switchflow' });
    return { text: 'Switchflow board opened.' };
  });

  on('command.run', { command: 'switchflow-board' }, async $ => {
    await refresh($);
    await $.ui.open({ id: PANE, title: 'Switchflow' });
    return { text: 'Switchflow board opened.' };
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e);
    const current = await read($, snapshot);
    const needs = (current?.needs ?? []).filter(need => need.actions.length);
    if (!needs.length) return next(e);
    const need = needs[0]!;
    const open = await read($, form);
    const message = await read($, notice);
    const pending = open ? need.actions.find(action => action.key === open.actionKey) : undefined;
    const { Box, Button, Input, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>Switchflow</Text>
          <Text wrap="truncate-end">
            {need.title}: {need.context}
          </Text>
          {needs.length > 1 && <Text dimColor>+{needs.length - 1} more</Text>}
        </Box>
        {pending && open?.step === 'input' && pending.input ? (
          <Box flexDirection="row" gap={1}>
            <Input
              key="band-input"
              label={pending.input.label}
              submitLabel="Send"
              autoFocus
              onSubmit={value => (value.trim() ? run($, pending, value.trim()) : undefined)}
            />
            <Button key="band-cancel" label="Cancel" onPress={() => update($, form, () => null)} />
          </Box>
        ) : pending && open?.step === 'confirm' ? (
          <Box flexDirection="row" gap={1}>
            <Text>{pending.confirm}</Text>
            <Button key="band-confirm" label={pending.label} variant="primary" onPress={() => run($, pending)} />
            <Button key="band-cancel" label="Cancel" onPress={() => update($, form, () => null)} />
          </Box>
        ) : (
          <Box flexDirection="row" gap={1}>
            {need.actions.map(action => (
              <Button
                key={action.key}
                label={action.input ? `${action.label}…` : action.label}
                variant={action.primary ? 'primary' : 'secondary'}
                onPress={() => press($, action)}
              />
            ))}
          </Box>
        )}
        {message && <Text dimColor>{message}</Text>}
      </Box>
    );
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e);
    const { Box, Button, Input, Markdown, Text } = $.ui.resolve(e);
    const current = await read($, snapshot);
    const message = await read($, notice);
    if (!current || current.service !== 'up')
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{statusText(current)}</Text>
          {current?.reason && <Text dimColor>{current.reason}</Text>}
          <Button key="retry-connect" label="Try again" onPress={() => refresh($)} />
        </Box>
      );
    const results = await read($, tests);
    const chosen = await read($, selected);
    const worker = current.workers.find(entry => entry.id === chosen);
    const open = await read($, form);
    const events = await read($, feed);
    const capacity = current.capacity;
    const initiatives = current.initiatives.filter(item => item.stage !== 'complete');
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          {current.projectName ?? 'Switchflow'} · {statusText(current).replace(/^SF ▸ /, '')}
        </Text>
        {message && <Text dimColor>{message}</Text>}

        <Box flexDirection="column">
          <Text bold>Initiatives</Text>
          {initiatives.length === 0 && <Text dimColor>No open initiatives.</Text>}
          {initiatives.map(item => (
            <Box key={`initiative:${item.id}`} flexDirection="column">
              <Text>
                {item.title} <Text dimColor>{item.isRunning ? 'running' : item.status}</Text>
              </Text>
              <Text dimColor>{stageTrack(item.stage)}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Capacity</Text>
          {capacity ? (
            <Box flexDirection="row" gap={1}>
              <Text>
                {capacity.running} running
                {capacity.queued ? ` · ${capacity.queued} queued` : ''}
                {capacity.maxWorkers ? ` · at most ${capacity.maxWorkers}` : ''}
                {capacity.freeGB !== null && capacity.totalGB !== null
                  ? ` · ${capacity.freeGB.toFixed(1)} GB free of ${capacity.totalGB.toFixed(1)} GB`
                  : ''}
                {capacity.isPaused ? ' · local workers paused' : ''}
              </Text>
              <Button
                key="pause"
                label={capacity.isPaused ? 'Resume local workers' : 'Pause local workers'}
                onPress={() => togglePause($)}
              />
            </Box>
          ) : (
            <Text dimColor>Capacity is unavailable.</Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>Environments</Text>
            <Button key="test-all" label="Test all" onPress={() => testAll($)} />
          </Box>
          {current.environments.map(environment => {
            const result = results[environment.id];
            const health = environment.holdReason
              ? `not ready: ${environment.holdReason}`
              : result?.ok === true
                ? 'ready'
                : result?.ok === false
                  ? `not ready: ${result.reason ?? 'no reason given'}`
                  : 'not tested';
            return (
              <Text>
                {environment.label} <Text dimColor>{health}</Text>
              </Text>
            );
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Workers</Text>
          {current.workers.length === 0 && <Text dimColor>No workers in this run.</Text>}
          {workersByEnvironment(current.workers).map(([label, list]) => (
            <Box key={`group:${label}`} flexDirection="column">
              <Text dimColor>{label}</Text>
              {list.map(entry => (
                // A Button's label is one plain string; the engine refuses mixed children.
                <Button
                  key={`worker:${entry.id}`}
                  plain
                  label={`${entry.id === chosen ? '▸ ' : '  '}${entry.title} · ${statusLabel(entry)}${entry.isHeld ? ' · held' : ''}`}
                  onPress={() => choose($, entry.id)}
                />
              ))}
            </Box>
          ))}
        </Box>

        {worker && (
          <Box flexDirection="column" gap={1}>
            <Text bold>
              {worker.title} <Text dimColor>{statusLabel(worker)}</Text>
            </Text>
            <Markdown key="feed" text={feedMarkdown(events.sessionId === worker.id ? events.events : [])} />
            {worker.canSteer && (
              <Input
                key="steer"
                placeholder={working(worker) ? 'Steer this agent' : 'Send a follow-up'}
                submitLabel="Send"
                onSubmit={value => sendSteer($, worker, value)}
              />
            )}
            {worker.canInterrupt &&
              (open?.actionKey === `stop:${worker.id}` ? (
                <Box flexDirection="row" gap={1}>
                  <Text>Stop {worker.title}? Its current turn ends; the transcript is kept.</Text>
                  <Button key="stop-confirm" label="Stop" variant="primary" onPress={() => stop($, worker)} />
                  <Button key="stop-cancel" label="Cancel" onPress={() => update($, form, () => null)} />
                </Box>
              ) : (
                <Button
                  key="stop"
                  label="Stop"
                  onPress={() => update($, form, () => ({ actionKey: `stop:${worker.id}`, step: 'confirm' }))}
                />
              ))}
          </Box>
        )}
      </Box>
    );
  });
};
