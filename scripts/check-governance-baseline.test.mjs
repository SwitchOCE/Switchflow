import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(repository, "template");
const baseline = { schemaVersion: 1, templateVersion: "0.2.1", taskPrefix: "VAL" };
const revision = "a".repeat(40);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function powershell(script, args = []) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]);
}

function success(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "switchflow-baseline-"));
  try { fn(root); }
  finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

function preflightFixture(root) {
  const dispatch = join(root, "dispatch");
  const worktree = join(root, "worktree");
  cpSync(join(template, ".switchflow", "scripts"), join(dispatch, ".switchflow", "scripts"), { recursive: true });
  mkdirSync(worktree);
  const configPath = join(worktree, ".switchflow", "project.json");
  const dispatchConfigPath = join(dispatch, ".switchflow", "project.json");
  json(dispatchConfigPath, baseline);
  // A controlled CLI proves successful admission reaches task readability checks
  // without installing dependencies or relying on a user's board.
  const packageRoot = join(worktree, ".switchflow", "node_modules", "backlog.md");
  json(join(worktree, ".switchflow", "package.json"), { devDependencies: { "backlog.md": "1.50.1" } });
  json(join(packageRoot, "package.json"), { version: "1.50.1" });
  writeFileSync(join(packageRoot, "cli.js"), "process.exit(process.argv.includes('--version') || process.argv.includes('VAL-1') ? 0 : 1);");
  const check = (args = []) => powershell(join(dispatch, ".switchflow", "scripts", "check-worktree-tools.ps1"), ["-Worktree", worktree, "-TaskId", "VAL-1", ...args]);
  return { configPath, dispatchConfigPath, check };
}

test("preflight rejects missing, invalid and mismatched governance before tools", () => fixture((root) => {
  const { configPath, dispatchConfigPath, check } = preflightFixture(root);
  assert.match(check().stderr, /has no Switchflow project metadata/);
  for (const value of [null, [], [baseline], "text", true, 1, {}, { ...baseline, taskPrefix: "val" }, { ...baseline, templateVersion: "" }, { ...baseline, schemaVersion: 2 }]) {
    json(configPath, value);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid Switchflow project metadata/, JSON.stringify(value));
  }
  writeFileSync(configPath, '{invalid');
  assert.match(check().stderr, /Invalid Switchflow project metadata/);
  for (const value of [{ ...baseline, templateVersion: "0.0.0" }, { ...baseline, taskPrefix: "OLD" }]) {
    json(configPath, value);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Switchflow governance mismatch/);
  }
  json(configPath, baseline);
  success(check());
  json(dispatchConfigPath, {});
  assert.match(check().stderr, /Invalid Switchflow project metadata/);
}));

test("preflight compares available provenance while retaining legacy imports", () => fixture((root) => {
  const { configPath, dispatchConfigPath, check } = preflightFixture(root);
  const recorded = { ...baseline, templateRevision: revision, templateDirty: false };
  json(dispatchConfigPath, recorded);
  for (const value of [baseline, { ...recorded, templateRevision: "b".repeat(40) }, { ...recorded, templateDirty: true }]) {
    json(configPath, value);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Switchflow governance mismatch/);
  }
  for (const value of [{ ...recorded, templateRevision: "invalid" }, { ...recorded, templateDirty: "false" }]) {
    json(configPath, value);
    assert.match(check().stderr, /Invalid Switchflow source provenance/);
  }
  json(configPath, recorded);
  success(check());
  assert.match(check(["-RequireNode"]).stderr, /has no package.json/);
  json(dispatchConfigPath, baseline);
  json(configPath, baseline);
  success(check());
  json(dispatchConfigPath, { ...baseline, templateRevision: null, templateDirty: null });
  success(check());
}));

test("imports identify clean and dirty sources and keep archives unknown", () => fixture((root) => {
  const source = join(root, "source");
  cpSync(template, join(source, "template"), { recursive: true, filter: (path) => !path.split(/[\\/]/).includes("node_modules") });
  mkdirSync(join(source, "scripts"));
  cpSync(join(repository, "scripts", "import-switchflow.ps1"), join(source, "scripts", "import-switchflow.ps1"));
  cpSync(join(repository, "scripts", "install-rendered-template.ps1"), join(source, "scripts", "install-rendered-template.ps1"));
  cpSync(join(repository, "VERSION"), join(source, "VERSION"));
  const importTo = (name, extra = []) => {
    const target = join(root, name);
    const result = powershell(join(source, "scripts", "import-switchflow.ps1"), ["-TargetPath", target, "-ProjectName", "Validation", "-TaskPrefix", "VAL", ...extra]);
    return { target, result };
  };
  const readConfig = (target) => JSON.parse(readFileSync(join(target, ".switchflow", "project.json"), "utf8"));
  // A parent repository must not be mistaken for the archive's source.
  success(run("git", ["init", "-b", "main", root]));
  success(run("git", ["-C", root, "-c", "user.name=Validation", "-c", "user.email=validation@localhost", "commit", "--allow-empty", "-m", "Parent"]));
  const archive = importTo("archive");
  success(archive.result);
  assert.equal(readConfig(archive.target).templateRevision, null);
  assert.equal(readConfig(archive.target).templateDirty, null);
  success(run("git", ["init", "-b", "main", source]));
  const unborn = importTo("unborn");
  success(unborn.result);
  assert.equal(readConfig(unborn.target).templateRevision, null);
  assert.equal(readConfig(unborn.target).templateDirty, null);
  success(run("git", ["-C", source, "add", "."]));
  success(run("git", ["-C", source, "-c", "user.name=Validation", "-c", "user.email=validation@localhost", "commit", "-m", "Source"]));
  const sha = run("git", ["-C", source, "rev-parse", "HEAD"]).stdout.trim();
  const clean = importTo("clean");
  success(clean.result);
  assert.equal(readConfig(clean.target).templateRevision, sha);
  assert.equal(readConfig(clean.target).templateDirty, false);
  assert.equal(readConfig(clean.target).templateVersion, readFileSync(join(repository, "VERSION"), "utf8").trim());
  const instructions = join(source, "template", "AGENTS.md");
  const originalInstructions = readFileSync(instructions, "utf8");
  writeFileSync(instructions, originalInstructions + "\nLocal change\n");
  const modified = importTo("modified");
  success(modified.result);
  assert.equal(readConfig(modified.target).templateRevision, sha);
  assert.equal(readConfig(modified.target).templateDirty, true);
  writeFileSync(instructions, originalInstructions);
  writeFileSync(join(source, "template", "local-addition.txt"), "Uncommitted template content");
  const dirty = importTo("dirty");
  success(dirty.result);
  assert.equal(readConfig(dirty.target).templateRevision, sha);
  assert.equal(readConfig(dirty.target).templateDirty, true);
  const preview = importTo("preview", ["-WhatIf"]);
  success(preview.result);
  assert.equal(existsSync(preview.target), false);
  const originalConfig = readFileSync(join(clean.target, ".switchflow", "project.json"), "utf8");
  const collision = importTo("clean");
  assert.notEqual(collision.result.status, 0);
  assert.match(collision.result.stderr, /overwrite existing governance files/);
  assert.equal(readFileSync(join(clean.target, ".switchflow", "project.json"), "utf8"), originalConfig);
}));
