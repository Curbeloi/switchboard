import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskDone, runEnvironmentReview } from "../src/relay/review-run.js";
import { createConfigStore } from "../src/relay/config.js";
import { createStore } from "../src/relay/store.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("isTaskDone: explicit signals only", () => {
  // marker in content, case-insensitive, anywhere
  assert.equal(isTaskDone({ content: "terminé la tarea [task-done]" }), true);
  assert.equal(isTaskDone({ content: "[TASK-DONE] listo" }), true);
  // structured data
  assert.equal(isTaskDone({ content: "listo", data: { task_status: "done" } }), true);
  // negatives: no NL heuristics, other statuses, empty
  assert.equal(isTaskDone({ content: "la tarea está terminada y lista" }), false);
  assert.equal(isTaskDone({ content: "task done" }), false);
  assert.equal(isTaskDone({ content: "x", data: { task_status: "in_progress" } }), false);
  assert.equal(isTaskDone({ content: "" }), false);
  assert.equal(isTaskDone(null), false);
});

test("automation guards: master and verdict messages must never trigger", () => {
  // The listener ignores these before isTaskDone even runs; still, the marker in
  // a verdicts message must not read as a task-done if guards were bypassed.
  const verdictMsg = {
    from: "master",
    content: "Revisión de subagentes — `env`",
    data: { kind: "review-verdicts", verdicts: [] },
  };
  // guard conditions used by routes: from === "master" / data.kind
  assert.equal(verdictMsg.from === "master", true);
  assert.equal(verdictMsg.data?.kind === "review-verdicts", true);
  assert.equal(isTaskDone(verdictMsg), false);
});

test("runEnvironmentReview: runs the env's subagents over dir + transcript (mocked LLM)", async () => {
  const cfgDir = tempDir("sb-auto-cfg-");
  const dbDir = tempDir("sb-auto-db-");
  const workDir = tempDir("sb-auto-work-"); // not a git repo → graceful input note
  try {
    const config = createConfigStore(cfgDir);
    const store = createStore({ dbPath: join(dbDir, "test.db") });
    const project = config.addProject({ name: "proj" });
    const env = config.addEnvironment({ name: "env1", dir: workDir, agentName: "coder", projectId: project.id });
    config.addSubagent({ environmentId: env.id, name: "Seguridad", role: "revisa seguridad", provider: "openai", model: "m" });
    config.addSubagent({ environmentId: env.id, name: "Calidad", role: "revisa calidad", provider: "openai", model: "m" });

    store.registerAgent("coder");
    store.setMode("auto"); // deliver immediately so the transcript includes it
    const conv = store.createConversation({ title: "tarea X", createdBy: "coder", members: ["coder"] });
    store.postMessage({ conversationId: conv.id, from: "coder", content: "hice el cambio [task-done]" });

    const seen = [];
    const complete = async (provider, { user }) => {
      seen.push(user);
      return JSON.stringify({ decision: "approve", reason: "ok" });
    };
    const { verdicts } = await runEnvironmentReview({
      env, conversationId: conv.id, store, config, complete, resolveKey: () => "k",
    });
    assert.equal(verdicts.length, 2);
    for (const v of verdicts) {
      assert.equal(v.decision, "approve");
      assert.ok(["Seguridad", "Calidad"].includes(v.subagent));
    }
    // the input carried both the directory note and the conversation transcript
    assert.ok(seen[0].includes(workDir));
    assert.ok(seen[0].includes("[task-done]"), "transcript included");
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("runEnvironmentReview: env without subagents throws (callers 409/skip)", async () => {
  const cfgDir = tempDir("sb-auto-cfg2-");
  try {
    const config = createConfigStore(cfgDir);
    const project = config.addProject({ name: "p" });
    const env = config.addEnvironment({ name: "e", dir: cfgDir, agentName: "a", projectId: project.id });
    await assert.rejects(
      () => runEnvironmentReview({ env, store: null, config, complete: async () => "{}" }),
      /no subagents/
    );
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("sender→environment mapping (agentName) resolves the right env", () => {
  const cfgDir = tempDir("sb-auto-cfg3-");
  try {
    const config = createConfigStore(cfgDir);
    const project = config.addProject({ name: "p" });
    const dirA = tempDir("sb-auto-front-");
    const dirB = tempDir("sb-auto-back-");
    config.addEnvironment({ name: "front", dir: dirA, agentName: "front-agent", projectId: project.id });
    const back = config.addEnvironment({ name: "back", dir: dirB, agentName: "back-agent", projectId: project.id });
    const found = config.readEnvironments().find((e) => e.agentName === "back-agent");
    assert.equal(found.id, back.id);
    assert.equal(config.readEnvironments().find((e) => e.agentName === "nobody"), undefined);
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
