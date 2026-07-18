/** Thin HTTP client to the relay. Throws on non-2xx (with `.status` set). */
export function createRelayClient(relayUrl, token = null) {
  const base = relayUrl.replace(/\/+$/, "");
  let authToken = token;

  async function request(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    };
    if (authToken) headers["authorization"] = `Bearer ${authToken}`;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`relay ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    setToken(t) {
      authToken = t;
    },
    health() {
      return request("/api/health");
    },
    registerAgent(name, existingToken = null) {
      return request("/api/agents/register", {
        method: "POST",
        body: JSON.stringify(existingToken ? { name, token: existingToken } : { name }),
      });
    },
    listAgents() {
      return request("/api/agents");
    },

    /* conversations (the room) */
    createConversation({ title, purpose, successCriteria, contractName, members } = {}) {
      const body = { title };
      if (purpose != null) body.purpose = purpose;
      if (successCriteria != null) body.successCriteria = successCriteria;
      if (contractName != null) body.contract_name = contractName;
      if (members && members.length) body.members = members;
      return request("/api/conversations", { method: "POST", body: JSON.stringify(body) });
    },
    listConversations(status = null) {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request(`/api/conversations${qs}`);
    },
    getConversation(id) {
      return request(`/api/conversations/${encodeURIComponent(id)}`);
    },
    closeConversation(id, outcome = null) {
      return request(`/api/conversations/${encodeURIComponent(id)}/close`, {
        method: "POST",
        body: JSON.stringify(outcome != null ? { outcome } : {}),
      });
    },
    setConversationContract(id, contractName) {
      return request(`/api/conversations/${encodeURIComponent(id)}/contract`, {
        method: "PUT",
        body: JSON.stringify({ contract_name: contractName }),
      });
    },
    joinConversation(id) {
      return request(`/api/conversations/${encodeURIComponent(id)}/join`, { method: "POST" });
    },
    leaveConversation(id) {
      return request(`/api/conversations/${encodeURIComponent(id)}/leave`, { method: "POST" });
    },

    /* messages */
    postMessage({ conversation, content, to, data, schema, contract }) {
      const body = { content };
      if (to && to.length) body.to = to;
      if (data != null) body.data = data;
      if (schema != null) body.schema = schema;
      if (contract != null) body.contract = contract;
      return request(`/api/conversations/${encodeURIComponent(conversation)}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    dm({ to, content }) {
      return request("/api/dm", {
        method: "POST",
        body: JSON.stringify({ to, content }),
      });
    },
    readConversationMessages({ conversationId, since = 0 }) {
      const qs = new URLSearchParams({ since: String(since) });
      return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${qs}`);
    },

    /* conversation state doc */
    readConversationState(conversationId) {
      return request(`/api/conversations/${encodeURIComponent(conversationId)}/state`);
    },
    writeConversationState(conversationId, content) {
      return request(`/api/conversations/${encodeURIComponent(conversationId)}/state`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },

    /* inbox + wait */
    inbox() {
      return request("/api/inbox");
    },
    wait({ conversation = null, timeoutMs = 25000 } = {}) {
      const qs = new URLSearchParams({ timeout_ms: String(timeoutMs) });
      if (conversation) qs.set("conversation", conversation);
      return request(`/api/wait?${qs}`);
    },
  };
}
