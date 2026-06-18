import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";

/**
 * On-disk configuration store under a fixed directory (default ~/.switchboard).
 * This is the durable source of truth for the wizard-driven setup: the in-memory
 * relay store is ephemeral, but these files survive restarts. On boot the relay
 * reads them; the web UI's first-run wizard writes them.
 *
 * Layout:
 *   <dir>/config.json        { mode, setupComplete }
 *   <dir>/policy.md          the LLM reviewer rubric
 *   <dir>/contracts/<name>.json   one JSON Schema per named contract
 */
export const DEFAULT_CONFIG_DIR = join(homedir(), ".switchboard");

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

  function saveConfig(patch) {
    ensureDir();
    const next = { ...readConfig(), ...patch };
    writeFileSync(configPath, JSON.stringify(next, null, 2));
    return next;
  }

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
  };
}
