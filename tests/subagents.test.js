import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "../src/relay/config.js";

// A fresh config store in a throwaway dir, pre-seeded with a project + environment.
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "sb-subagents-"));
  const cfg = createConfigStore(dir);
  const project = cfg.addProject({ name: "proj" });
  const env = cfg.addEnvironment({ name: "env", dir: join(dir, "work"), agentName: "coder", projectId: project.id });
  return { cfg, dir, project, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("subagent add / list / get / update / remove round-trips", () => {
  const { cfg, env, cleanup } = fresh();
  const a = cfg.addSubagent({ environmentId: env.id, name: "security", role: "check security" });
  assert.equal(a.environmentId, env.id);
  assert.equal(a.name, "security");
  assert.deepEqual(a.dependsOn, []);
  assert.equal(cfg.getSubagent(a.id).role, "check security");
  assert.equal(cfg.subagentsOfEnvironment(env.id).length, 1);

  const up = cfg.updateSubagent(a.id, { role: "deep security", provider: "openai", model: "gpt-5-codex" });
  assert.equal(up.role, "deep security");
  assert.equal(up.provider, "openai");
  assert.equal(up.model, "gpt-5-codex");

  assert.equal(cfg.removeSubagent(a.id), true);
  assert.equal(cfg.getSubagent(a.id), null);
  assert.equal(cfg.subagentsOfEnvironment(env.id).length, 0);
  cleanup();
});

test("dependsOn: siblings only, no self, no unknown, no cycle", () => {
  const { cfg, env, cleanup } = fresh();
  const a = cfg.addSubagent({ environmentId: env.id, name: "a" });
  const b = cfg.addSubagent({ environmentId: env.id, name: "b", dependsOn: [a.id] });
  assert.deepEqual(b.dependsOn, [a.id]);

  assert.throws(() => cfg.updateSubagent(a.id, { dependsOn: [a.id] }), /itself/);
  assert.throws(() => cfg.addSubagent({ environmentId: env.id, name: "c", dependsOn: ["nope"] }), /unknown dependency/);
  // a → b would close the loop (b already → a)
  assert.throws(() => cfg.updateSubagent(a.id, { dependsOn: [b.id] }), /cycle/);
  cleanup();
});

test("removeEnvironment and removeProject cascade subagents", () => {
  const { cfg, project, env, dir, cleanup } = fresh();
  cfg.addSubagent({ environmentId: env.id, name: "x" });
  cfg.addSubagent({ environmentId: env.id, name: "y" });
  assert.equal(cfg.subagentsOfEnvironment(env.id).length, 2);

  cfg.removeEnvironment(env.id);
  assert.equal(cfg.subagentsOfEnvironment(env.id).length, 0);

  const env2 = cfg.addEnvironment({ name: "env2", dir: join(dir, "w2"), agentName: "c2", projectId: project.id });
  cfg.addSubagent({ environmentId: env2.id, name: "z" });
  cfg.removeProject(project.id);
  assert.equal(cfg.readSubagents().length, 0);
  cleanup();
});

test("removeSubagent drops it from siblings' dependsOn (no dangling edges)", () => {
  const { cfg, env, cleanup } = fresh();
  const a = cfg.addSubagent({ environmentId: env.id, name: "a" });
  const b = cfg.addSubagent({ environmentId: env.id, name: "b", dependsOn: [a.id] });
  cfg.removeSubagent(a.id);
  assert.deepEqual(cfg.getSubagent(b.id).dependsOn, []);
  cleanup();
});
