import * as readline from "node:readline";

const HELP = `commands:
  approve <id>     deliver a pending message (id can be a prefix; 'all' approves every pending)
  reject  <id>     drop a pending message
  list             show pending messages
  channels         list channels with members and message counts
  members <chan>   show the members of a channel
  addto <agent> <chan> [chan...]      add an agent to one or more channels
  removefrom <agent> <chan> [chan...] remove an agent from one or more channels
  manual           supervision mode: every message waits for your approval (default)
  auto             supervision mode: deliver everything, no supervision
  llm              supervision mode: an LLM reviewer approves/rejects/escalates (needs a reviewer)
  status           show current mode, reviewer, and pending count
  help             show this help
  quit             stop the relay
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
export function startConsoleSupervisor({ store, broadcast, reviewer = null }) {
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
        `[PENDING ${m.id.slice(0, 8)}] ${m.from} → ${m.channel}\n  ${preview(m.content, 200).replace(/\n/g, "\n  ")}`
      );
      return;
    }
    if (event.type === "message.escalated") {
      const m = event.message;
      notify(
        `[ESCALATED ${m.id.slice(0, 8)}] ${m.from} → ${m.channel} — reviewer: ${m.review?.reason ?? "needs a human"}\n  approve/reject it`
      );
      return;
    }
    if (event.type === "approval.mode") {
      notify(`mode → ${event.mode}`);
      return;
    }
  }

  function findByPrefix(prefix) {
    return store.listPending().filter((m) => m.id.startsWith(prefix));
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
            `  ${m.id.slice(0, 8)}  ${m.from} → ${m.channel}: ${preview(m.content, 80)}\n`
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
            process.stdout.write(`  ${m.id.slice(0, 8)}  ${m.from} → ${m.channel}\n`);
          }
          return;
        }
        const msg = approveOne(matches[0].id);
        process.stdout.write(`approved ${msg.id.slice(0, 8)} (${msg.from} → ${msg.channel})\n`);
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
        process.stdout.write(`rejected ${msg.id.slice(0, 8)} (${msg.from} → ${msg.channel})\n`);
        return;
      }

      case "channels":
      case "ch": {
        const list = store.listChannels();
        if (list.length === 0) {
          process.stdout.write("no channels yet\n");
          return;
        }
        for (const c of list) {
          process.stdout.write(
            `  ${c.name} — ${c.messageCount} msgs, members: ${c.members.join(", ") || "(none)"}\n`
          );
        }
        return;
      }

      case "members": {
        const name = args[0];
        if (!name) {
          process.stdout.write("usage: members <channel>\n");
          return;
        }
        const members = store.channelMembers(name);
        process.stdout.write(
          members.length ? `${name}: ${members.join(", ")}\n` : `${name}: no members (or no such channel)\n`
        );
        return;
      }

      case "addto": {
        const [agentName, ...chans] = args;
        if (!agentName || chans.length === 0) {
          process.stdout.write("usage: addto <agent> <channel> [channel...]\n");
          return;
        }
        if (!store.hasAgent(agentName)) {
          process.stdout.write(`unknown agent "${agentName}" (not registered)\n`);
          return;
        }
        for (const c of chans) {
          const result = store.joinChannel(c, agentName);
          broadcast({ type: "channel.updated", channel: result });
        }
        process.stdout.write(`added "${agentName}" to: ${chans.join(", ")}\n`);
        return;
      }

      case "removefrom": {
        const [agentName, ...chans] = args;
        if (!agentName || chans.length === 0) {
          process.stdout.write("usage: removefrom <agent> <channel> [channel...]\n");
          return;
        }
        for (const c of chans) {
          const result = store.leaveChannel(c, agentName);
          if (result) broadcast({ type: "channel.updated", channel: result });
        }
        process.stdout.write(`removed "${agentName}" from: ${chans.join(", ")}\n`);
        return;
      }

      case "auto":
      case "manual": {
        const m = store.setMode(cmd);
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
