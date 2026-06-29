import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "node:fs";

/**
 * On-disk configuration store under a fixed directory (default ~/.switchboard).
 * This is the durable source of truth for the wizard-driven setup: the in-memory
 * relay store is ephemeral, but these files survive restarts. On boot the relay
 * reads them; the web UI's first-run wizard writes them.
 *
 * Layout:
 *   <dir>/config.json        { mode, engine, setupComplete }
 *   <dir>/policy.md          the LLM reviewer rubric
 *   <dir>/contracts/<name>.json   one JSON Schema per named contract
 */
export const DEFAULT_CONFIG_DIR = join(homedir(), ".switchboard");

/** Engine = which agent CLI an environment launches. Chosen during setup
 *  (wizard + Settings) and used as the default for new environments. */
export const VALID_ENGINES = new Set(["claude", "opencode"]);
export const DEFAULT_ENGINE = "claude";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Built-in named contracts that are seeded on first boot if absent. The user
 *  can edit them via the Settings UI — we never overwrite an existing file. */
const BUILTIN_CONTRACTS = {
  "dsp.v1": {
    type: "object",
    properties: {
      decision_type: {
        type: "string",
        enum: ["ROUTINE", "BOUNDARY", "AMBIGUOUS", "IRREVERSIBLE"],
        description:
          "Class of decision. IRREVERSIBLE always escalates regardless of supervision mode.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Agent's calibrated confidence in this response (0–1).",
      },
      escalation_flag: {
        type: "boolean",
        description:
          "Agent's request that a human (or the orchestrator) reviews this before it is acted on.",
      },
      trace: {
        type: "string",
        description: "Short, human-readable reasoning summary.",
      },
      verifier_summary: {
        type: "string",
        description:
          "Summary of an independent checker sub-agent's verdict (writer/checker pattern).",
      },
    },
    required: ["decision_type", "confidence", "escalation_flag"],
    additionalProperties: false,
  },
};

export function createConfigStore(dir = DEFAULT_CONFIG_DIR) {
  const contractsDir = join(dir, "contracts");
  const configPath = join(dir, "config.json");
  const policyPath = join(dir, "policy.md");
  const projectsPath = join(dir, "projects.json");        // top-level projects [{id,name,createdAt}]
  const environmentsPath = join(dir, "environments.json"); // [{id,name,dir,engine,agentName,projectId,createdAt}]

  function ensureDir() {
    mkdirSync(contractsDir, { recursive: true });
  }

  /** Seed any built-in contract whose file is missing. Idempotent: never
   *  overwrites a contract the user has already edited locally. */
  function seedBuiltinContracts() {
    ensureDir();
    for (const [name, schema] of Object.entries(BUILTIN_CONTRACTS)) {
      const p = join(contractsDir, `${name}.json`);
      if (!existsSync(p)) {
        writeFileSync(p, JSON.stringify(schema, null, 2));
      }
    }
  }
  seedBuiltinContracts();

  function validName(name) {
    return typeof name === "string" && NAME_RE.test(name);
  }

  function readConfig() {
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return {};
    }
  }

  function readPolicy() {
    if (!existsSync(policyPath)) return null;
    try {
      return readFileSync(policyPath, "utf8");
    } catch {
      return null;
    }
  }

  function getContract(name) {
    if (!validName(name)) return null;
    const p = join(contractsDir, `${name}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  function listContracts() {
    if (!existsSync(contractsDir)) return [];
    const out = [];
    for (const f of readdirSync(contractsDir)) {
      if (!f.endsWith(".json")) continue;
      const name = f.slice(0, -5);
      const schema = getContract(name);
      if (schema != null) out.push({ name, schema });
    }
    return out;
  }

  function saveContract(name, schema) {
    if (!validName(name)) throw new Error(`invalid contract name: ${name}`);
    ensureDir();
    writeFileSync(join(contractsDir, `${name}.json`), JSON.stringify(schema, null, 2));
  }

  function deleteContract(name) {
    if (!validName(name)) return false;
    const p = join(contractsDir, `${name}.json`);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }

  function savePolicy(text) {
    ensureDir();
    writeFileSync(policyPath, typeof text === "string" ? text : "");
  }

  function writeConfig(next) {
    ensureDir();
    writeFileSync(configPath, JSON.stringify(next, null, 2));
    // config.json may hold reviewer API keys — keep it owner-only.
    try { chmodSync(configPath, 0o600); } catch { /* best effort (e.g. Windows) */ }
    return next;
  }

  function saveConfig(patch) {
    return writeConfig({ ...readConfig(), ...patch });
  }

  /** The reviewer (LLM supervision) provider config: provider, model, baseUrl,
   *  and per-provider API keys. Never exposed raw over the API — routes return
   *  only which keys are SET. */
  function readReviewerConfig() {
    return readConfig().reviewer ?? {};
  }

  /** Merge a patch into the persisted reviewer config. `keys` is merged per
   *  provider (so switching providers preserves each key). Switching provider
   *  without naming a model clears the stale model so the new provider's default
   *  applies. */
  function saveReviewerConfig(patch = {}) {
    const cur = readConfig();
    const prev = cur.reviewer ?? {};
    const reviewer = { ...prev, ...patch };
    if (patch.keys) reviewer.keys = { ...(prev.keys ?? {}), ...patch.keys };
    if (patch.provider && patch.provider !== prev.provider && !("model" in patch)) {
      delete reviewer.model;
    }
    writeConfig({ ...cur, reviewer });
    return reviewer;
  }

  /* Hierarchy: a PROJECT (top level) groups one or more ENVIRONMENTS. An
   *  environment is a directory + engine + agent identity switchboard can launch
   *  (each environment = one agent; the running process state lives in the agent
   *  manager). Conversations are tied to a project. Both are persisted here. */
  /** The default engine for new environments, chosen during setup. Falls back
   *  to DEFAULT_ENGINE when unset (pre-setup or older configs). */
  function getEngine() {
    const e = readConfig().engine;
    return VALID_ENGINES.has(e) ? e : DEFAULT_ENGINE;
  }
  function readJsonArray(path) {
    if (!existsSync(path)) return [];
    try {
      const arr = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /* --- top-level projects --- */
  function readProjects() {
    return readJsonArray(projectsPath);
  }
  function getProject(id) {
    return readProjects().find((p) => p.id === id) ?? null;
  }
  function writeProjects(list) {
    ensureDir();
    writeFileSync(projectsPath, JSON.stringify(list, null, 2));
    return list;
  }
  function addProject({ name }) {
    if (!validName(name)) throw new Error(`invalid project name: ${name}`);
    const list = readProjects();
    if (list.some((p) => p.name === name)) throw new Error(`a project named "${name}" already exists`);
    const project = { id: randomUUID(), name, createdAt: Date.now() };
    writeProjects([...list, project]);
    return project;
  }
  /** Remove a project and cascade-delete its environments (the caller is
   *  responsible for stopping any running agents first). */
  function removeProject(id) {
    const list = readProjects();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    writeProjects(next);
    const envs = readEnvironments();
    const keep = envs.filter((e) => e.projectId !== id);
    if (keep.length !== envs.length) writeEnvironments(keep);
    return true;
  }

  /* --- environments (one per agent; belong to a project) --- */
  function readEnvironments() {
    return readJsonArray(environmentsPath);
  }
  function getEnvironment(id) {
    return readEnvironments().find((e) => e.id === id) ?? null;
  }
  function writeEnvironments(list) {
    ensureDir();
    writeFileSync(environmentsPath, JSON.stringify(list, null, 2));
    return list;
  }
  function environmentsOfProject(projectId) {
    return readEnvironments().filter((e) => e.projectId === projectId);
  }
  function addEnvironment({ name, dir: envDir, engine = getEngine(), agentName, projectId }) {
    if (!validName(name)) throw new Error(`invalid environment name: ${name}`);
    if (typeof envDir !== "string" || !envDir.trim()) throw new Error("dir is required");
    if (!VALID_ENGINES.has(engine)) throw new Error(`unsupported engine: ${engine}`);
    if (!validName(agentName)) throw new Error(`invalid agent name: ${agentName}`);
    if (!projectId || !getProject(projectId)) throw new Error("a valid projectId is required");
    const list = readEnvironments();
    if (list.some((e) => e.dir === envDir.trim())) {
      throw new Error(`an environment already points to ${envDir.trim()}`);
    }
    const env = {
      id: randomUUID(),
      name,
      dir: envDir.trim(),
      engine,
      agentName,
      projectId,
      createdAt: Date.now(),
    };
    writeEnvironments([...list, env]);
    return env;
  }
  function removeEnvironment(id) {
    const list = readEnvironments();
    const next = list.filter((e) => e.id !== id);
    if (next.length === list.length) return false;
    writeEnvironments(next);
    return true;
  }

  /** Migrate a pre-hierarchy projects.json (each entry was a dir+agent, i.e. an
   *  environment) into the new model: one project per old entry (1:1, names
   *  preserved) + an environment under it. Idempotent: skips once
   *  environments.json exists or projects.json already holds new-shape projects. */
  function migrateProjectsToEnvironments() {
    if (existsSync(environmentsPath)) return;
    const raw = readJsonArray(projectsPath);
    if (!raw.length) return;
    if (!raw.some((p) => p && typeof p.dir === "string")) return; // already new-shape
    const projects = [];
    const envs = [];
    for (const old of raw) {
      const projId = randomUUID();
      const ts = old.createdAt ?? Date.now();
      projects.push({ id: projId, name: old.name, createdAt: ts });
      envs.push({
        id: old.id ?? randomUUID(),
        name: old.name,
        dir: old.dir,
        engine: old.engine ?? "claude",
        agentName: old.agentName,
        projectId: projId,
        createdAt: ts,
      });
    }
    writeEnvironments(envs);
    writeProjects(projects);
  }
  migrateProjectsToEnvironments();

  return {
    dir,
    contractsDir,
    configPath,
    policyPath,
    validName,
    isSetupComplete: () => existsSync(configPath),
    readConfig,
    readPolicy,
    getContract,
    listContracts,
    saveContract,
    deleteContract,
    savePolicy,
    saveConfig,
    readReviewerConfig,
    saveReviewerConfig,
    getEngine,
    readProjects,
    getProject,
    addProject,
    removeProject,
    readEnvironments,
    getEnvironment,
    environmentsOfProject,
    addEnvironment,
    removeEnvironment,
  };
}
