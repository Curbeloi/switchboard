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

    /* channels */
    joinChannel(channel) {
      return request(`/api/channels/${encodeURIComponent(channel)}/join`, { method: "POST" });
    },
    leaveChannel(channel) {
      return request(`/api/channels/${encodeURIComponent(channel)}/leave`, { method: "POST" });
    },
    listChannels() {
      return request("/api/channels");
    },

    /* conversations (threads inside a channel) */
    createConversation(channel, { title, purpose, successCriteria, contractName } = {}) {
      const body = { title };
      if (purpose != null) body.purpose = purpose;
      if (successCriteria != null) body.successCriteria = successCriteria;
      if (contractName != null) body.contract_name = contractName;
      return request(`/api/channels/${encodeURIComponent(channel)}/conversations`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    listConversations(channel, status = null) {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request(`/api/channels/${encodeURIComponent(channel)}/conversations${qs}`);
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

    /* messages */
    postMessage({ channel, conversation, content, to, data, schema, contract }) {
      const body = { content };
      if (conversation) body.conversation = conversation;
      if (to && to.length) body.to = to;
      if (data != null) body.data = data;
      if (schema != null) body.schema = schema;
      if (contract != null) body.contract = contract;
      return request(`/api/channels/${encodeURIComponent(channel)}/messages`, {
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
    listAgents() {
      return request("/api/agents");
    },
    inbox() {
      return request("/api/inbox");
    },
    wait({ channel = null, conversation = null, timeoutMs = 25000 } = {}) {
      const qs = new URLSearchParams({ timeout_ms: String(timeoutMs) });
      if (conversation) qs.set("conversation", conversation);
      if (channel) qs.set("channel", channel);
      return request(`/api/wait?${qs}`);
    },
  };
}
