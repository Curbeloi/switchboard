import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "../src/relay/agents/orchestrator.js";

// A fake `complete` that keys behavior off the subagent role embedded in `system`
// ("Your role: <role>"), records call order, and returns a JSON decision.
function makeComplete({ throwFor = new Set(), decisions = {} } = {}) {
  const calls = [];
  const fn = async (_provider, { system, user }) => {
    const who = (system.match(/Your role: (\S+)/) || [])[1] || "?";
    calls.push({ who, user });
    if (throwFor.has(who)) throw new Error("boom-" + who);
    return JSON.stringify({ decision: decisions[who] || "approve", reason: who + " ok" });
  };
  fn.calls = calls;
  return fn;
}

const SUBS = [
  { id: "1", name: "a", role: "a", dependsOn: [] },
  { id: "2", name: "b", role: "b", dependsOn: [] },
  { id: "3", name: "c", role: "c", dependsOn: ["1", "2"] }, // c waits for a + b
];

test("runs independent nodes first, dependents after, and passes upstream verdicts", async () => {
  const complete = makeComplete();
  const { verdicts } = await runReview({ subagents: SUBS, input: "work", complete, defaults: { provider: "test" } });

  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every((v) => v.decision === "approve"));

  const order = complete.calls.map((c) => c.who);
  assert.ok(order.indexOf("c") > order.indexOf("a"), "c runs after a");
  assert.ok(order.indexOf("c") > order.indexOf("b"), "c runs after b");

  const cCall = complete.calls.find((c) => c.who === "c");
  assert.match(cCall.user, /Upstream reviewers/);
  assert.match(cCall.user, /"a":/); // upstream verdicts keyed by subagent name
  assert.match(cCall.user, /"b":/);
});

test("a thrown node becomes an escalate verdict (fail-safe), others unaffected", async () => {
  const complete = makeComplete({ throwFor: new Set(["b"]) });
  const { verdicts } = await runReview({ subagents: SUBS, input: "work", complete, defaults: { provider: "test" } });

  const vb = verdicts.find((v) => v.subagent === "b");
  assert.equal(vb.decision, "escalate");
  assert.match(vb.reason, /errored/);
  assert.equal(verdicts.find((v) => v.subagent === "a").decision, "approve");
});

test("a subagent with no provider escalates (never silently passes)", async () => {
  const complete = makeComplete();
  const { verdicts } = await runReview({
    subagents: [{ id: "1", name: "np", role: "np", dependsOn: [] }],
    input: "x",
    complete,
    defaults: {}, // no default provider, subagent has none
  });
  assert.equal(verdicts[0].decision, "escalate");
  assert.match(verdicts[0].reason, /no provider/);
  assert.equal(complete.calls.length, 0, "complete is never called without a provider");
});

test("no subagents → empty verdicts", async () => {
  const { verdicts } = await runReview({ subagents: [], input: "x", complete: makeComplete() });
  assert.deepEqual(verdicts, []);
});
