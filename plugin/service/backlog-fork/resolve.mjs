import { resolveBacklogFork } from './runtime.mjs';
resolveBacklogFork().then(runtime => console.log(runtime.cliPath)).catch(error => { console.error(error.message); process.exitCode = 1; });
