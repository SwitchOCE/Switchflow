import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  parseCompletedTask,
  readCompletedTasks,
  mergeMilestoneProgress,
} from "../template/.switchflow/scripts/check-milestone-progress.mjs";
import { findReadyDependencyViolations } from "../template/.switchflow/scripts/check-ready-dependencies.mjs";

test("body examples cannot satisfy a Ready dependency", () => {
  const sources = [
    "---\nid: SF-1\ntitle: Example\n---\n```yaml\nstatus: Done\n```",
    "---\nid: SF-1\nstatus:\nDone\n---\n",
    "id: SF-1\nstatus: Done\n",
    "---\nid: SF-1\nstatus: Done\n",
  ];
  for (const source of sources) {
    const completed = [parseCompletedTask(source)].filter(Boolean);
    assert.deepEqual(completed, []);
    assert.equal(findReadyDependencyViolations(
      [{ id: "SF-2", status: "Ready" }],
      new Map([["SF-2", { dependencies: ["SF-1"] }]]),
      completed,
    ).length, 1);
  }
});

test("completed frontmatter supports quoted fields and CRLF without reading body milestones", () => {
  const task = parseCompletedTask("---\r\nid: 'SF-1'\r\nstatus: \"Done\"\r\nmilestone: m-1\r\n---\r\n");
  assert.deepEqual(task, { id: "SF-1", milestone: "m-1" });
  assert.equal(mergeMilestoneProgress("  m-1: Delivery (0/1 done)", [task]), "  m-1: Delivery (1/2 done)");
  assert.deepEqual(parseCompletedTask("---\nid: SF-1\nstatus: Done\n---\nmilestone: m-2"), { id: "SF-1", milestone: null });
});

test("an absent completed directory is empty; other filesystem errors remain visible", () => {
  const root = mkdtempSync(join(tmpdir(), "switchflow-completed-"));
  try {
    assert.deepEqual(readCompletedTasks(join(root, "missing")), []);
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    assert.throws(() => readCompletedTasks(file));
    writeFileSync(join(root, "sf-1.md"), "---\nid: SF-1\nstatus: Done\n---\n");
    assert.deepEqual(readCompletedTasks(root), [{ id: "SF-1", milestone: null }]);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
