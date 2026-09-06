import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Use the pinned Backlog core through MCP: document/checkpoint bodies never enter argv.
const [cliPath, projectRoot, ...args] = process.argv.slice(2);
let child;
let timeout;
let finished = false;
let submitted = false;
let recordName = 'record';

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) {
    console.error(error.message);
    if (submitted) console.error(`Update outcome may be uncertain; view the ${recordName} before retrying.`);
    process.exitCode = 1;
  }
  child?.stdin.end();
  child?.kill();
}

try {
  const document = args[0] === 'doc' && args[1] === 'update' && args[3] === '--content-file';
  const task = args[0] === 'task' && args[1] === 'edit' && args[3] === '--description-file';
  if (args.length !== 5 || (!document && !task) || !args[2] || !args[4]) {
    throw new Error('Usage: backlog.ps1 doc update <id> --content-file <file> | task edit <id> --description-file <file> (no other options)');
  }
  const content = readFileSync(resolve(args[4]), 'utf8').replace(/^\uFEFF/, '');
  recordName = task ? 'task' : 'document';
  let toolName = 'document_update';
  let argumentsBody = { id: args[2], content };
  if (task) {
    if (!content.trim() || content.length > 10000) throw new Error('Task description must contain 1-10000 characters (pinned Backlog limit). Keep a compact checkpoint with linked detail; never truncate required content.');
    const current = spawnSync(process.execPath, [cliPath, 'task', 'view', args[2], '--json'], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    if (current.error) throw current.error;
    if (current.status !== 0) throw new Error(`Cannot read task before description update: ${(current.stderr || current.stdout).slice(0, 1000)}`);
    const status = JSON.parse(current.stdout).task?.status;
    if (!status) throw new Error('Task response has no status; refusing description update.');
    // task_edit's schema defaults status to Backlog. Carry the observed status explicitly.
    toolName = 'task_edit';
    argumentsBody = { id: args[2], description: content, status };
  }
  const require = createRequire(resolve(cliPath));
  const { resolveBinaryPath } = require(join(dirname(resolve(cliPath)), 'resolveBinary.cjs'));
  child = spawn(resolveBinaryPath(), ['mcp', 'start'], {
    cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.on('error', finish);
  child.stdin.on('error', finish);
  child.on('exit', (code) => {
    if (!finished) finish(new Error(`Backlog exited before confirming the update (exit ${code}).`));
  });
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (finished) return;
    try {
      const message = JSON.parse(line);
      if (message.error) throw new Error(`Backlog MCP: ${message.error.message}`);
      if (message.id === 1) {
        if (!message.result?.protocolVersion) throw new Error('Invalid Backlog initialization response.');
        send({ method: 'notifications/initialized' });
        submitted = true;
        send({ id: 2, method: 'tools/call', params: {
          name: toolName, arguments: argumentsBody,
        } });
      } else if (message.id === 2) {
        if (!message.result || message.result.isError) {
          const detail = message.result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
          throw new Error(`Backlog ${recordName} update failed: ${(detail || 'invalid result').slice(0, 1000)}`);
        }
        console.log(`Updated ${args[2]} from file (${content.length} characters).`);
        finish();
      }
    } catch (error) { finish(error); }
  });
  timeout = setTimeout(() => finish(new Error(`Backlog ${recordName} update timed out.`)), 30000);
  send({ id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'switchflow-document-file', version: '1.0' },
  } });
} catch (error) { finish(error); }
