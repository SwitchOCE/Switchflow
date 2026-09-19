import { pathToFileURL } from 'node:url';
import { resolveProject } from './storage.mjs';
import { recordIssue, listIssues, issueMetrics, resolveIssue } from './issues.mjs';
import { runCheck } from './evidence.mjs';
import { inspectWorktrees, registerWorktree, writeScratch, promoteScratch, planRetention, applyRetention } from './workspaces.mjs';
export * from './storage.mjs';
export * from './issues.mjs';
export * from './evidence.mjs';
export * from './workspaces.mjs';
export async function main(argv = process.argv.slice(2)) {
  const [action = 'context', project = process.cwd(), json = '{}'] = argv;
  const options = JSON.parse(json); const context = await resolveProject(project);
  switch (action) {
    case 'context': return context;
    case 'issue-add': return recordIssue(context, options);
    case 'issues': return { entries: await listIssues(context), metrics: await issueMetrics(context) };
    case 'issue-resolve': return resolveIssue(context, options.id, options.resolution);
    case 'check': return runCheck(context, options);
    case 'worktrees': return inspectWorktrees(context);
    case 'worktree-register': return registerWorktree(context, options);
    case 'scratch-write': return writeScratch(context, options);
    case 'scratch-promote': return promoteScratch(context, options.id, options.name);
    case 'retention': return planRetention(context);
    case 'retention-apply': return applyRetention(context, options.ids);
    default: throw new Error(`Unknown action: ${action}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if ('exitCode' in result && (result.exitCode !== 0 || result.candidateChanged || result.timedOut)) process.exitCode = 1; }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
