import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readCompletedTasks } from "./check-milestone-progress.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const defaultCliPath = path.join(
  projectRoot,
  ".switchflow",
  "node_modules",
  "backlog.md",
  "cli.js",
);

export function findReadyDependencyViolations(
  tasks,
  taskViews,
  completedTasks = [],
) {
  const statusById = new Map(
    completedTasks.map((task) => [task.id, "Done"]),
  );
  for (const task of tasks) statusById.set(task.id, task.status);
  const violations = [];

  for (const task of tasks) {
    if (task.status !== "Ready") continue;

    const dependencies = taskViews.get(task.id)?.dependencies ?? [];
    for (const dependencyId of dependencies) {
      const dependencyStatus = statusById.get(dependencyId);
      if (dependencyStatus !== "Done") {
        violations.push({
          taskId: task.id,
          dependencyId,
          dependencyStatus: dependencyStatus ?? "missing",
        });
      }
    }
  }

  return violations;
}

function runBacklog(args, cliPath = defaultCliPath, root = projectRoot) {
  const output = execFileSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output);
}

export function checkReadyDependencies(
  cliPath = defaultCliPath,
  root = projectRoot,
) {
  const list = runBacklog(["task", "list", "--json"], cliPath, root);
  const readyTasks = list.tasks.filter((task) => task.status === "Ready");
  const taskViews = new Map(
    readyTasks.map((task) => {
      const view = runBacklog(
        ["task", "view", task.id, "--json"],
        cliPath,
        root,
      );
      return [task.id, view.task];
    }),
  );
  const completedTasks = readCompletedTasks(
    path.join(root, "backlog", "completed"),
  );

  return findReadyDependencyViolations(list.tasks, taskViews, completedTasks);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const [cliPath, root] = process.argv.slice(2);
  const violations = checkReadyDependencies(
    cliPath ?? defaultCliPath,
    root ?? projectRoot,
  );
  if (violations.length > 0) {
    console.error("Ready dependency check failed:");
    for (const violation of violations) {
      console.error(
        `- ${violation.taskId} is Ready but ${violation.dependencyId} is ${violation.dependencyStatus}.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("Ready dependency check passed.");
  }
}
