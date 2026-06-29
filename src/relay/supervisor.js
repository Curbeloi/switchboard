import * as readline from "node:readline";

const HELP = `commands:
  approve <id>        deliver a pending message (id can be a prefix; 'all' approves every pending)
  reject  <id>        drop a pending message
  list                show pending messages
  agents              list connected agents
  conversations [open|closed|all]   list conversations with members (default: open)
  members <id-prefix>               show the members of a conversation
  addto <agent> <id-prefix> [id...]      add an agent to one or more conversations
  removefrom <agent> <id-prefix> [id...] remove an agent from one or more conversations
  openconv <title...>               open a new conversation
  closeconv <id-prefix> [outcome words...]  close a conversation by id prefix
  delconv <id-prefix>               delete a conversation (and its messages)
  manual              supervision mode: every message waits for your approval (default)
  auto                supervision mode: deliver everything, no supervision
  llm                 supervision mode: an LLM reviewer approves/rejects/escalates (needs a reviewer)
  status              show current mode, reviewer, and pending count
  help                show this help
  quit                stop the relay
`;

function preview(text, n) {
  if (text.length <= n) return text;
  return text.slice(0, n) + "…";
}

/**
 * Console supervisor: a small REPL on the relay's stdin/stdout for approving
 * or rejecting queued messages without opening the web UI. Skips itself if
 * stdin is not a TTY (e.g. when the relay is run under systemd / nohup).
 */
export function startConsoleSupervisor({ store, broadcast, reviewer = null, config = null }) {
  if (!process.stdin.isTTY) return null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "switchboard> ",
  });

  function notify(text) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
    rl.prompt(true);
    if (rl.line) process.stdout.write(rl.line);
  }

  function onEvent(event) {
    if (event.type === "message.pending") {
      const m = event.message;
      notify(
        `[PENDING ${m.id.slice(0, 8)}] ${m.from} → conv ${m.conversationId.slice(0, 8)}\n  ${preview(m.content, 200).replace(/\n/g, "\n  ")}`
      );
      return;
    }
    if (event.type === "message.escalated") {
      const m = event.message;
      notify(
        `[ESCALATED ${m.id.slice(0, 8)}] ${m.from} → conv ${m.conversationId.slice(0, 8)} — reviewer: ${m.review?.reason ?? "needs a human"}\n  approve/reject it`
      );
      return;
    }
    if (event.type === "approval.mode") {
      notify(`mode → ${event.mode}`);
      return;
    }
    if (event.type === "conversation.created") {
      const c = event.conversation;
      notify(`conversation opened: "${c.title}" (${c.id.slice(0, 8)})`);
      return;
    }
    if (event.type === "conversation.closed") {
      const c = event.conversation;
      notify(
        `conversation closed: "${c.title}" (${c.id.slice(0, 8)})${c.closedOutcome ? ` — ${c.closedOutcome}` : ""}`
      );
      return;
    }
  }

  function findByPrefix(prefix) {
    return store.listPending().filter((m) => m.id.startsWith(prefix));
  }
  function findConvByPrefix(prefix) {
    return store.listConversations().filter((c) => c.id.startsWith(prefix));
  }

  function approveOne(id) {
    const msg = store.approvePending(id);
    if (msg) broadcast({ type: "message.delivered", message: msg });
    return msg;
  }
  function rejectOne(id) {
    const msg = store.rejectPending(id);
    if (msg) broadcast({ type: "message.rejected", message: msg });
    return msg;
  }

  /** Resolve a single conversation by id-prefix, printing a friendly message and
   *  returning null on no/ambiguous match. */
  function resolveConv(prefix) {
    const matches = findConvByPrefix(prefix);
    if (matches.length === 0) {
      process.stdout.write(`no conversation with id starting "${prefix}"\n`);
      return null;
    }
    if (matches.length > 1) {
      process.stdout.write(`ambiguous prefix "${prefix}" — ${matches.length} matches\n`);
      return null;
    }
    return matches[0];
  }

  function handle(line) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd) return;

    switch (cmd) {
      case "help":
      case "?":
        process.stdout.write(HELP);
        return;

      case "list":
      case "ls":
      case "l": {
        const pending = store.listPending();
        if (pending.length === 0) {
          process.stdout.write("no pending messages\n");
          return;
        }
        for (const m of pending) {
          process.stdout.write(
            `  ${m.id.slice(0, 8)}  ${m.from} → conv ${m.conversationId.slice(0, 8)}: ${preview(m.content, 80)}\n`
          );
        }
        return;
      }

      case "approve":
      case "a": {
        if (args[0] === "all") {
          const pending = store.listPending();
          for (const m of pending) approveOne(m.id);
          process.stdout.write(`approved ${pending.length} pending message(s)\n`);
          return;
        }
        const prefix = args[0];
        if (!prefix) {
          process.stdout.write("usage: approve <id-prefix> | approve all\n");
          return;
        }
        const matches = findByPrefix(prefix);
        if (matches.length === 0) {
          process.stdout.write(`no pending message with id starting "${prefix}"\n`);
          return;
        }
        if (matches.length > 1) {
          process.stdout.write(`ambiguous prefix "${prefix}" — ${matches.length} matches:\n`);
          for (const m of matches) {
            process.stdout.write(`  ${m.id.slice(0, 8)}  ${m.from} → conv ${m.conversationId.slice(0, 8)}\n`);
          }
          return;
        }
        const msg = approveOne(matches[0].id);
        process.stdout.write(`approved ${msg.id.slice(0, 8)} (${msg.from} → conv ${msg.conversationId.slice(0, 8)})\n`);
        return;
      }

      case "reject":
      case "r": {
        const prefix = args[0];
        if (!prefix) {
          process.stdout.write("usage: reject <id-prefix>\n");
          return;
        }
        const matches = findByPrefix(prefix);
        if (matches.length === 0) {
          process.stdout.write(`no pending message with id starting "${prefix}"\n`);
          return;
        }
        if (matches.length > 1) {
          process.stdout.write(`ambiguous prefix "${prefix}" — ${matches.length} matches\n`);
          return;
        }
        const msg = rejectOne(matches[0].id);
        process.stdout.write(`rejected ${msg.id.slice(0, 8)} (${msg.from} → conv ${msg.conversationId.slice(0, 8)})\n`);
        return;
      }

      case "agents":
      case "who": {
        const list = store.listAgents();
        if (list.length === 0) {
          process.stdout.write("no agents connected\n");
          return;
        }
        for (const a of list) {
          process.stdout.write(
            `  ${a.name}  (registered ${new Date(a.registeredAt).toLocaleTimeString()})\n`
          );
        }
        return;
      }

      case "conversations":
      case "convs": {
        const statusArg = args[0];
        const status = statusArg && statusArg !== "all" ? statusArg : null;
        const list = store.listConversations(status);
        if (list.length === 0) {
          process.stdout.write(`no ${statusArg ?? "open"} conversations\n`);
          return;
        }
        for (const c of list) {
          const closed = c.status === "closed" && c.closedOutcome ? ` → ${c.closedOutcome}` : "";
          const dm = c.isDm ? " (dm)" : "";
          process.stdout.write(
            `  ${c.id.slice(0, 8)}  [${c.status}]${dm}  ${c.title}${closed}  members: ${(c.members || []).join(", ") || "(none)"}\n`
          );
        }
        return;
      }

      case "members": {
        const prefix = args[0];
        if (!prefix) {
          process.stdout.write("usage: members <conversation-id-prefix>\n");
          return;
        }
        const conv = resolveConv(prefix);
        if (!conv) return;
        const members = store.conversationMembers(conv.id);
        process.stdout.write(
          `${conv.title} (${conv.id.slice(0, 8)}): ${members.join(", ") || "(no members)"}\n`
        );
        return;
      }

      case "addto": {
        const [agentName, ...prefixes] = args;
        if (!agentName || prefixes.length === 0) {
          process.stdout.write("usage: addto <agent> <conversation-id-prefix> [id-prefix...]\n");
          return;
        }
        if (!store.hasAgent(agentName)) {
          process.stdout.write(`unknown agent "${agentName}" (not registered)\n`);
          return;
        }
        const done = [];
        for (const p of prefixes) {
          const conv = resolveConv(p);
          if (!conv) continue;
          const result = store.joinConversation(conv.id, agentName);
          if (result) { broadcast({ type: "conversation.updated", conversation: result }); done.push(conv.id.slice(0, 8)); }
        }
        if (done.length) process.stdout.write(`added "${agentName}" to: ${done.join(", ")}\n`);
        return;
      }

      case "removefrom": {
        const [agentName, ...prefixes] = args;
        if (!agentName || prefixes.length === 0) {
          process.stdout.write("usage: removefrom <agent> <conversation-id-prefix> [id-prefix...]\n");
          return;
        }
        const done = [];
        for (const p of prefixes) {
          const conv = resolveConv(p);
          if (!conv) continue;
          const result = store.leaveConversation(conv.id, agentName);
          if (result) { broadcast({ type: "conversation.updated", conversation: result }); done.push(conv.id.slice(0, 8)); }
        }
        if (done.length) process.stdout.write(`removed "${agentName}" from: ${done.join(", ")}\n`);
        return;
      }

      case "openconv": {
        const title = args.join(" ");
        if (!title) {
          process.stdout.write("usage: openconv <title...>\n");
          return;
        }
        const conv = store.createConversation({ title, createdBy: "supervisor" });
        broadcast({ type: "conversation.created", conversation: conv });
        process.stdout.write(`opened "${title}" (${conv.id.slice(0, 8)})\n`);
        return;
      }

      case "closeconv": {
        const prefix = args[0];
        const outcome = args.slice(1).join(" ") || null;
        if (!prefix) {
          process.stdout.write("usage: closeconv <id-prefix> [outcome...]\n");
          return;
        }
        const conv = resolveConv(prefix);
        if (!conv) return;
        if (conv.status !== "open") {
          process.stdout.write(`conversation already closed\n`);
          return;
        }
        const closed = store.closeConversation(conv.id, { closedBy: "supervisor", outcome });
        broadcast({ type: "conversation.closed", conversation: closed });
        process.stdout.write(`closed "${closed.title}" (${closed.id.slice(0, 8)})${outcome ? ` — ${outcome}` : ""}\n`);
        return;
      }

      case "delconv": {
        const prefix = args[0];
        if (!prefix) {
          process.stdout.write("usage: delconv <id-prefix>\n");
          return;
        }
        const conv = resolveConv(prefix);
        if (!conv) return;
        store.deleteConversation(conv.id);
        broadcast({ type: "conversation.deleted", id: conv.id });
        process.stdout.write(`deleted "${conv.title}" (${conv.id.slice(0, 8)})\n`);
        return;
      }

      case "auto":
      case "manual": {
        const m = store.setMode(cmd);
        config?.saveConfig({ mode: m });
        broadcast({ type: "approval.mode", mode: m });
        return;
      }

      case "llm": {
        if (!reviewer?.available) {
          process.stdout.write(
            "llm mode unavailable: no reviewer (set ANTHROPIC_API_KEY or install the claude CLI, then restart)\n"
          );
          return;
        }
        const m = store.setMode("llm");
        config?.saveConfig({ mode: m });
        broadcast({ type: "approval.mode", mode: m });
        return;
      }

      case "status": {
        const pending = store.listPending().length;
        const rev = reviewer?.available ? `reviewer: ${reviewer.backend}` : "reviewer: none";
        process.stdout.write(`mode: ${store.getMode()}, ${rev}, pending: ${pending}\n`);
        return;
      }

      case "quit":
      case "exit":
      case "q":
        process.stdout.write("bye\n");
        process.exit(0);
        return;

      default:
        process.stdout.write(`unknown command: ${cmd}. Type 'help' for commands.\n`);
    }
  }

  rl.on("line", (line) => {
    try {
      handle(line);
    } catch (err) {
      process.stdout.write(`error: ${err.message}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));

  const rev = reviewer?.available ? ` reviewer: ${reviewer.backend}.` : "";
  process.stdout.write(
    `supervisor active (mode: ${store.getMode()}).${rev} Type 'help' for commands.\n`
  );
  rl.prompt();

  return { onEvent };
}
