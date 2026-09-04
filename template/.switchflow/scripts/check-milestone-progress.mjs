import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function frontmatterValue(source, field) {
  const match = source.match(
    new RegExp(
      "^" + field + ":[\\t ]*['\\\"]?([^\\r\\n'\\\"]+)['\\\"]?[\\t ]*\\r?$",
      "m",
    ),
  );
  return match?.[1]?.trim() ?? null;
}

export function parseCompletedTask(source) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  if (frontmatter === undefined) return null;
  const id = frontmatterValue(frontmatter, "id");
  const milestone = frontmatterValue(frontmatter, "milestone");
  const status = frontmatterValue(frontmatter, "status");
  if (id === null || status !== "Done") return null;
  return { id, milestone };
}

export function mergeMilestoneProgress(output, completedTasks) {
  const completedIdsByMilestone = new Map();
  for (const task of completedTasks) {
    const ids = completedIdsByMilestone.get(task.milestone) ?? new Set();
    ids.add(task.id);
    completedIdsByMilestone.set(task.milestone, ids);
  }

  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s+)([^:]+): (.+) \((\d+)\/(\d+) done\)$/);
      if (match === null) return line;
      const [, indent, milestoneId, title, activeDone, activeTotal] = match;
      const completedCount =
        completedIdsByMilestone.get(milestoneId)?.size ?? 0;
      return (
        indent +
        milestoneId +
        ": " +
        title +
        " (" +
        (Number(activeDone) + completedCount) +
        "/" +
        (Number(activeTotal) + completedCount) +
        " done)"
      );
    })
    .join("\n");
}

export function readCompletedTasks(completedRoot) {
  let entries;
  try {
    entries = readdirSync(completedRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) =>
      parseCompletedTask(readFileSync(join(completedRoot, entry.name), "utf8")),
    )
    .filter((task) => task !== null);
}

function run() {
  const [cliPath, projectRoot, ...backlogArgs] = process.argv.slice(2);
  if (cliPath === undefined || projectRoot === undefined) {
    console.error(
      "Usage: check-milestone-progress.mjs <cli-path> <project-root> <backlog args...>",
    );
    process.exitCode = 2;
    return;
  }

  const result = spawnSync(process.execPath, [cliPath, ...backlogArgs], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
    return;
  }

  const completedTasks = readCompletedTasks(
    join(projectRoot, "backlog", "completed"),
  );
  process.stdout.write(
    mergeMilestoneProgress(result.stdout ?? "", completedTasks),
  );
  process.stderr.write(result.stderr ?? "");
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) run();
