import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewer, REVIEWER_PROVIDERS } from "../src/relay/reviewer.js";

const MSG = { from: "a", channel: "team", content: "status update", to: [] };

/** Run a body with global.fetch stubbed, always restoring the original. */
async function withFetch(stub, body) {
  const orig = global.fetch;
  global.fetch = stub;
  try {
    return await body();
  } finally {
    global.fetch = orig;
  }
}

test("provider selection: openai with a key is available", () => {
  const r = createReviewer({ provider: "openai", keys: { openai: "sk-test" } });
  assert.equal(r.available, true);
  assert.equal(r.backend, "openai");
  assert.equal(r.model, REVIEWER_PROVIDERS.openai.defaultModel);
});

test("openai/gemini are unavailable without a key", () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert.equal(createReviewer({ provider: "openai" }).available, false);
  assert.equal(createReviewer({ provider: "gemini" }).available, false);
});

test("ollama is available without any key (local)", () => {
  const r = createReviewer({ provider: "ollama" });
  assert.equal(r.available, true);
  assert.equal(r.backend, "ollama");
  assert.equal(r.model, REVIEWER_PROVIDERS.ollama.defaultModel);
});

test("auto with no key and no CLI is unavailable (legacy behavior preserved)", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = createReviewer({ allowCli: false });
  assert.equal(r.available, false);
});

test("fail-safe: a thrown provider error escalates (never approves)", async () => {
  await withFetch(async () => { throw new Error("network down"); }, async () => {
    const r = createReviewer({ provider: "openai", keys: { openai: "x" } });
    const d = await r.review(MSG);
    assert.equal(d.decision, "escalate");
  });
});

test("fail-safe: a non-ok HTTP response escalates", async () => {
  await withFetch(async () => ({ ok: false, status: 500 }), async () => {
    const r = createReviewer({ provider: "gemini", keys: { gemini: "x" } });
    const d = await r.review(MSG);
    assert.equal(d.decision, "escalate");
  });
});

test("fail-safe: unparseable model output escalates", async () => {
  await withFetch(async () => ({ ok: true, json: async () => ({ message: { content: "not json" } }) }), async () => {
    const r = createReviewer({ provider: "ollama" });
    const d = await r.review(MSG);
    assert.equal(d.decision, "escalate");
  });
});

test("parses a valid OpenAI decision", async () => {
  const content = '{"decision":"approve","reason":"routine status"}';
  await withFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }), async () => {
    const r = createReviewer({ provider: "openai", keys: { openai: "x" } });
    const d = await r.review(MSG);
    assert.equal(d.decision, "approve");
    assert.equal(d.reason, "routine status");
  });
});

test("a bogus decision value is normalized to escalate", async () => {
  const content = '{"decision":"yolo","reason":"?"}';
  await withFetch(async () => ({ ok: true, json: async () => ({ message: { content } }) }), async () => {
    const r = createReviewer({ provider: "ollama" });
    const d = await r.review(MSG);
    assert.equal(d.decision, "escalate");
  });
});

test("reconfigure switches the active provider at runtime", () => {
  const r = createReviewer({ provider: "ollama" });
  assert.equal(r.backend, "ollama");
  r.reconfigure({ provider: "openai", keys: { openai: "x" } });
  assert.equal(r.backend, "openai");
  r.reconfigure({ provider: "gemini" }); // no key → unavailable
  assert.equal(r.available, false);
});

test("an unconfigured reviewer escalates rather than throwing", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = createReviewer({ allowCli: false });
  const d = await r.review(MSG);
  assert.equal(d.decision, "escalate");
});
