import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, dmKeyFor } from "../src/relay/store.js";

function freshStore() {
  const s = createStore({ dbPath: ":memory:" });
  s.setMode("auto"); // deliver immediately so unread/inbox are exercised
  return s;
}

test("schema is at the conversations-only version (5)", () => {
  const s = freshStore();
  assert.equal(s.schemaVersion(), 5);
  s.close();
});

test("createConversation: creator + invited members are joined; no channel field", () => {
  const s = freshStore();
  s.registerAgent("front");
  s.registerAgent("back");
  const c = s.createConversation({ title: "fix login", purpose: "p", createdBy: "front", members: ["back"] });
  assert.equal(c.title, "fix login");
  assert.deepEqual(c.members.sort(), ["back", "front"]);
  assert.equal(c.isDm, false);
  assert.equal("channel" in c, false);
  s.close();
});

test("ensureDmConversation: canonical, idempotent, order-independent", () => {
  const s = freshStore();
  s.registerAgent("front");
  s.registerAgent("back");
  const a = s.ensureDmConversation("front", "back");
  const b = s.ensureDmConversation("back", "front");
  assert.equal(a.id, b.id, "same pair resolves to one conversation");
  assert.equal(a.isDm, true);
  assert.equal(a.dmKey, dmKeyFor("front", "back"));
  assert.deepEqual(a.members.sort(), ["back", "front"]);
  s.close();
});

test("postMessage carries no channel; inbox groups by conversation", () => {
  const s = freshStore();
  s.registerAgent("front");
  s.registerAgent("back");
  const c = s.createConversation({ title: "task", createdBy: "front", members: ["back"] });
  const msg = s.postMessage({ conversationId: c.id, from: "front", content: "hi", to: ["back"] });
  assert.equal(msg.status, "delivered");
  assert.equal("channel" in msg, false);

  const ib = s.inboxFor("back");
  assert.equal(ib.total, 1);
  assert.equal(ib.conversations.length, 1);
  assert.equal(ib.conversations[0].conversationId, c.id);
  assert.equal(ib.conversations[0].mentioned, 1);

  // Reading clears the unread count.
  s.markRead("back", c.id);
  assert.equal(s.inboxFor("back").total, 0);
  s.close();
});

test("join / leave conversation membership", () => {
  const s = freshStore();
  s.registerAgent("front");
  s.registerAgent("back");
  const c = s.createConversation({ title: "t", createdBy: "front" });
  assert.deepEqual(c.members, ["front"]);
  const joined = s.joinConversation(c.id, "back");
  assert.deepEqual(joined.members.sort(), ["back", "front"]);
  const left = s.leaveConversation(c.id, "back");
  assert.deepEqual(left.members, ["front"]);
  s.close();
});

test("project_id round-trips and is returned on list/get", () => {
  const s = freshStore();
  s.registerAgent("back");
  const c = s.createConversation({ title: "task", createdBy: "supervisor", projectId: "proj-1", members: ["back"] });
  assert.equal(c.projectId, "proj-1");
  assert.equal(s.getConversation(c.id).projectId, "proj-1");
  assert.ok(s.listConversations().some((x) => x.id === c.id && x.projectId === "proj-1"));
  s.close();
});

test("listConversations filters by status; close drops from inbox", () => {
  const s = freshStore();
  s.registerAgent("a");
  s.registerAgent("b");
  const c = s.createConversation({ title: "t", createdBy: "a", members: ["b"] });
  s.postMessage({ conversationId: c.id, from: "a", content: "x", to: ["b"] });
  assert.equal(s.inboxFor("b").total, 1);
  s.closeConversation(c.id, { closedBy: "a", outcome: "done" });
  assert.equal(s.listConversations("open").length, 0);
  assert.equal(s.listConversations("closed").length, 1);
  assert.equal(s.inboxFor("b").total, 0, "closed conversations drop out of the inbox");
  s.close();
});

test("master is never a persistent member", () => {
  const s = freshStore();
  s.registerAgent("front");
  const c = s.createConversation({ title: "t", createdBy: "front" });
  s.postMessage({ conversationId: c.id, from: "master", content: "directive", to: ["front"] });
  assert.equal(s.conversationMembers(c.id).includes("master"), false);
  s.close();
});

test("IRREVERSIBLE is force-queued even in auto mode", () => {
  const s = freshStore();
  s.registerAgent("front");
  const c = s.createConversation({ title: "t", createdBy: "front" });
  const msg = s.postMessage({
    conversationId: c.id,
    from: "front",
    content: "deploy",
    data: { decision_type: "IRREVERSIBLE" },
  });
  assert.equal(msg.status, "pending", "auto mode still holds IRREVERSIBLE for a human");
  s.close();
});
