import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "../src/relay/config.js";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"));
  return { dir, store: createConfigStore(dir) };
}

test("reviewer config: defaults to empty, then persists provider/model/keys", () => {
  const { dir, store } = freshStore();
  try {
    assert.deepEqual(store.readReviewerConfig(), {});
    store.saveReviewerConfig({ provider: "openai", model: "gpt-4o-mini", keys: { openai: "k1" } });
    const rc = store.readReviewerConfig();
    assert.equal(rc.provider, "openai");
    assert.equal(rc.model, "gpt-4o-mini");
    assert.equal(rc.keys.openai, "k1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer config: keys merge per provider (adding one preserves the other)", () => {
  const { dir, store } = freshStore();
  try {
    store.saveReviewerConfig({ provider: "openai", keys: { openai: "k1" } });
    store.saveReviewerConfig({ keys: { gemini: "k2" } });
    const rc = store.readReviewerConfig();
    assert.equal(rc.keys.openai, "k1");
    assert.equal(rc.keys.gemini, "k2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer config: switching provider without a model clears the stale model", () => {
  const { dir, store } = freshStore();
  try {
    store.saveReviewerConfig({ provider: "openai", model: "gpt-4o-mini" });
    store.saveReviewerConfig({ provider: "gemini" });
    const rc = store.readReviewerConfig();
    assert.equal(rc.provider, "gemini");
    assert.equal(rc.model, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config.json holding keys is written owner-only (0600)", () => {
  const { dir, store } = freshStore();
  try {
    store.saveReviewerConfig({ provider: "openai", keys: { openai: "secret" } });
    const mode = statSync(store.configPath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
