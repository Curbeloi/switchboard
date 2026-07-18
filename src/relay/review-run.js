import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runReview } from "./agents/orchestrator.js";

const execFileAsync = promisify(execFile);

/**
 * Shared review-run helpers: the one place that builds a subagent-review input
 * (git diff + optional conversation transcript) and executes an environment's
 * review graph. Used by the manual route (POST /environments/:id/review, POST
 * /conversations/:id/review-subagents) and by the automation listener (review
 * on task-done), so both paths behave identically.
 */

/* Read-only git inspection. Runs in `dir` with execFile (no shell → no
 * injection). Returns the uncommitted diff vs HEAD plus a short status (so
 * new/untracked files show up too). Throws if not a repo. */
const REVIEW_DIFF_CAP = 100_000; // chars fed to the LLM (truncate huge diffs)
export async function gitReview(dir) {
  const run = (args) =>
    execFileAsync("git", ["-C", dir, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  await run(["rev-parse", "--is-inside-work-tree"]); // throws if dir isn't a git repo
  let diff = "";
  try {
    diff = (await run(["diff", "HEAD"])).stdout; // staged + unstaged vs last commit
  } catch {
    diff = (await run(["diff"])).stdout; // empty repo / no HEAD → unstaged only
  }
  const status = (await run(["status", "--short"])).stdout;
  let truncated = false;
  if (diff.length > REVIEW_DIFF_CAP) {
    diff = diff.slice(0, REVIEW_DIFF_CAP);
    truncated = true;
  }
  return { diff, status, truncated };
}

/** Does this delivered message declare a finished task? Explicit signals only
 *  (no natural-language heuristics): the `[task-done]` marker in the content,
 *  or structured `data.task_status === "done"`. */
export function isTaskDone(m) {
  if (!m) return false;
  if (m.data && m.data.task_status === "done") return true;
  return /\[task-done\]/i.test(String(m.content || ""));
}

const TRANSCRIPT_TAIL = 30;

/** Run one environment's subagent review graph over its git diff plus (when
 *  `conversationId` is given) the conversation's recent transcript. Returns
 *  `{ verdicts, truncated }`. Callers decide what to do with the verdicts
 *  (route response, post into the conversation, …). */
export async function runEnvironmentReview({
  env,
  conversationId = null,
  dir = null,
  store,
  config,
  reviewer = null,
  resolveKey,
  complete = undefined, // injectable for tests (forwarded to the orchestrator)
} = {}) {
  const subagents = config.subagentsOfEnvironment(env.id);
  if (!subagents.length) throw new Error("this environment has no subagents to run");

  const reviewDir = (typeof dir === "string" && dir.trim()) || env.dir;
  let input = "";
  let truncated = false;
  try {
    const r = await gitReview(reviewDir);
    truncated = r.truncated;
    input += `Directory: ${reviewDir}\n\ngit status --short:\n${r.status || "(clean)"}\n\n` +
      `git diff HEAD${r.truncated ? " (TRUNCATED)" : ""}:\n${r.diff || "(no uncommitted changes)"}`;
  } catch (err) {
    input += `Directory: ${reviewDir}\n(could not read a git diff: ${err.message})`;
  }
  if (conversationId) {
    const conv = store.getConversation(conversationId);
    if (conv) {
      const msgs = store.readMessages({ conversationId: conv.id, since: 0 }).slice(-TRANSCRIPT_TAIL);
      input += `\n\nConversation "${conv.title}" (recent):\n` +
        msgs.map((m) => `${m.from}: ${m.content}`).join("\n");
    }
  }

  const rc = config.readReviewerConfig?.() ?? {};
  const { verdicts } = await runReview({
    subagents,
    input,
    complete,
    resolveKey,
    defaults: {
      provider: reviewer?.provider ?? null,
      model: reviewer?.model ?? rc.model ?? null,
      baseUrl: rc.baseUrl ?? null,
    },
  });
  return { verdicts, truncated };
}
