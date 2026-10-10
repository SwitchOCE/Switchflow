// Every call the mod makes to the Switchflow service: finding it, reading a project's
// snapshot and posting the owner's actions. Moving to GET /summary changes this file only.
import type { HttpInit, HttpResponse } from 'claude-code';

import { emptySnapshot, feedEvent, fromState } from './model';
import type { SwitchflowFeedEvent, SwitchflowSnapshot } from './types';

/** What the client needs from the engine, handed over by register.tsx (the engine follows `$` within one file only). */
export type Host = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>;
  read: (path: string) => Promise<string>;
  env: { SWITCHFLOW_HOME?: string; LOCALAPPDATA?: string; HOME?: string; USERPROFILE?: string };
};

export type Connection = { base: string; token: string; projectId: string; project: Record<string, any> };
export type Found = { connection: Connection } | { snapshot: SwitchflowSnapshot };

const isWindowsPath = (value: string) => /^[a-z]:[\\/]/i.test(value) || value.includes('\\');
const join = (base: string, ...parts: string[]) => {
  const separator = isWindowsPath(base) ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(separator);
};

/** The state folder: SWITCHFLOW_HOME, else %LOCALAPPDATA%\Switchflow, else ~/.local/state/switchflow. */
export function stateHome(env: Host['env']): string | null {
  if (env.SWITCHFLOW_HOME) return env.SWITCHFLOW_HOME;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'Switchflow');
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, '.local', 'state', 'switchflow') : null;
}

/** Folder identity as the service compares it: one separator, no trailing one, case-folded on Windows. */
export function samePathKey(value: string): string {
  const flat = value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return isWindowsPath(value) ? flat.toLowerCase() : flat;
}

/** The registered project holding `cwd`: the deepest root equal to it or above it. */
export function matchProject(projects: Record<string, any>[], cwd: string) {
  const here = samePathKey(cwd);
  let best: Record<string, any> | null = null;
  for (const project of projects) {
    if (typeof project.root !== 'string') continue;
    const root = samePathKey(project.root);
    if ((here === root || here.startsWith(`${root}/`)) && (!best || root.length > samePathKey(best.root).length))
      best = project;
  }
  return best;
}

async function getJson(host: Host, url: string) {
  const response = await host.fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const data = response.text ? JSON.parse(response.text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

async function send(host: Host, connection: Connection, route: string, method: string, body: unknown) {
  const response = await host.fetch(
    `${connection.base}/api/projects/${encodeURIComponent(connection.projectId)}${route}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Switchflow-Token': connection.token },
      body: JSON.stringify(body ?? {}),
    },
  );
  let data: Record<string, any> = {};
  try {
    data = response.text ? JSON.parse(response.text) : {};
  } catch {}
  if (!response.ok) {
    const error = data.error;
    const message = typeof error === 'string' ? error : error?.message || `Request failed (${response.status}).`;
    throw new Error(
      response.status === 409 && route.endsWith('/actions')
        ? 'The record changed since the last refresh. Check the latest state and try again.'
        : message,
    );
  }
  return data;
}

/** Finds the running service and this session's project, or says why there is none. */
export async function connect(host: Host, cwd: string): Promise<Found> {
  const home = stateHome(host.env);
  if (!home) return { snapshot: emptySnapshot('down', 'No state folder: set SWITCHFLOW_HOME.') };
  let info: Record<string, any>;
  try {
    info = JSON.parse(await host.read(join(home, 'control-service', 'service-info.json')));
  } catch {
    return { snapshot: emptySnapshot('down', 'The service has not been started on this machine.') };
  }
  if (typeof info.url !== 'string') return { snapshot: emptySnapshot('down', 'service-info.json names no URL.') };
  const base = info.url.replace(/\/+$/, '');
  let registry: Record<string, any>;
  try {
    registry = await getJson(host, `${base}/api/projects`);
  } catch (error) {
    return { snapshot: emptySnapshot('down', `No answer from ${base}: ${(error as Error).message}`) };
  }
  const project = matchProject(Array.isArray(registry.projects) ? registry.projects : [], cwd);
  if (!project) return { snapshot: emptySnapshot('unregistered', `${cwd} is not a registered Switchflow project.`) };
  if (project.available === false)
    return {
      snapshot: {
        ...emptySnapshot('unregistered', project.error || 'The project is unavailable.'),
        projectId: project.id,
      },
    };
  return { connection: { base, token: registry.csrfToken, projectId: project.id, project } };
}

const projectUrl = (connection: Connection, route: string) =>
  `${connection.base}/api/projects/${encodeURIComponent(connection.projectId)}${route}`;

/** One poll. Today: GET /state and GET /agents. With workstream D's summary: GET /summary?since=. */
export async function loadSnapshot(host: Host, connection: Connection): Promise<SwitchflowSnapshot> {
  const [state, agents] = await Promise.all([
    getJson(host, projectUrl(connection, '/state')),
    getJson(host, projectUrl(connection, '/agents')).catch(() => null),
  ]);
  return fromState(connection.project, state, agents);
}

/** An owner action on an initiative, as app.js `act` posts it. */
export const initiativeAction = (
  host: Host,
  connection: Connection,
  initiativeId: string,
  action: string,
  expectedRevision: number | null,
  payload: Record<string, unknown> = {},
) =>
  send(host, connection, `/initiatives/${encodeURIComponent(initiativeId)}/actions`, 'POST', {
    action,
    expectedRevision,
    ...payload,
  });

/** A message to a live session; `confirm: true` approves a delivery worker's approach. */
export const steer = (host: Host, connection: Connection, sessionId: string, body: Record<string, unknown>) =>
  send(host, connection, `/agents/${encodeURIComponent(sessionId)}/steer`, 'POST', body);

export const interrupt = (host: Host, connection: Connection, sessionId: string) =>
  send(host, connection, `/agents/${encodeURIComponent(sessionId)}/interrupt`, 'POST', {});

export const setLocalPause = (host: Host, connection: Connection, paused: boolean, expectedRevision: number | null) =>
  send(host, connection, '/agents/settings', 'PUT', {
    pauseLocalWorkers: paused,
    ...(expectedRevision !== null ? { expectedRevision } : {}),
  });

export async function testEnvironment(host: Host, connection: Connection, id: string) {
  try {
    const result = await send(host, connection, `/agents/environments/${encodeURIComponent(id)}/test`, 'POST', {});
    return { ok: result.ok === true, reason: result.reason ?? null, checkedAt: result.checkedAt ?? null };
  } catch (error) {
    return { ok: false, reason: (error as Error).message, checkedAt: null };
  }
}

export async function events(
  host: Host,
  connection: Connection,
  sessionId: string,
  after: number,
): Promise<{ events: SwitchflowFeedEvent[]; after: number }> {
  const page = await getJson(
    host,
    projectUrl(connection, `/agents/${encodeURIComponent(sessionId)}/events?after=${after}`),
  );
  const incoming = Array.isArray(page.events) ? page.events : [];
  return { events: incoming.map(feedEvent), after: page.nextAfter ?? incoming.at(-1)?.seq ?? after };
}
