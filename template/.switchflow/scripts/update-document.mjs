import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Use the pinned Backlog core through MCP: document bodies never enter argv.
const [cliPath, projectRoot, ...args] = process.argv.slice(2);
let child;
let timeout;
let finished = false;
let submitted = false;

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) {
    console.error(error.message);
    if (submitted) console.error('Update outcome may be uncertain; view the document before retrying.');
    process.exitCode = 1;
  }
  child?.stdin.end();
  child?.kill();
}

try {
  if (args.length !== 5 || args[0] !== 'doc' || args[1] !== 'update' ||
      !args[2] || args[3] !== '--content-file' || !args[4]) {
    throw new Error('Usage: backlog.ps1 doc update <id> --content-file <UTF-8 body file> (no other options)');
  }
  const content = readFileSync(resolve(args[4]), 'utf8').replace(/^\uFEFF/, '');
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
          name: 'document_update', arguments: { id: args[2], content },
        } });
      } else if (message.id === 2) {
        if (!message.result || message.result.isError) {
          const detail = message.result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
          throw new Error(`Backlog document update failed: ${(detail || 'invalid result').slice(0, 1000)}`);
        }
        console.log(`Updated ${args[2]} from file (${content.length} characters).`);
        finish();
      }
    } catch (error) { finish(error); }
  });
  timeout = setTimeout(() => finish(new Error('Backlog document update timed out.')), 30000);
  send({ id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'switchflow-document-file', version: '1.0' },
  } });
} catch (error) { finish(error); }
