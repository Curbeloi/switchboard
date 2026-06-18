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
    joinChannel(channel) {
      return request(`/api/channels/${encodeURIComponent(channel)}/join`, { method: "POST" });
    },
    leaveChannel(channel) {
      return request(`/api/channels/${encodeURIComponent(channel)}/leave`, { method: "POST" });
    },
    readChannelState(channel) {
      return request(`/api/channels/${encodeURIComponent(channel)}/state`);
    },
    writeChannelState(channel, content) {
      return request(`/api/channels/${encodeURIComponent(channel)}/state`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
    },
    postMessage({ channel, content, to, data, schema, contract }) {
      const body = { content };
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
    readMessages({ channel, since = 0 }) {
      const qs = new URLSearchParams({ since: String(since) });
      return request(`/api/channels/${encodeURIComponent(channel)}/messages?${qs}`);
    },
    listChannels() {
      return request("/api/channels");
    },
    listAgents() {
      return request("/api/agents");
    },
    inbox() {
      return request("/api/inbox");
    },
    wait({ channel = null, timeoutMs = 25000 } = {}) {
      const qs = new URLSearchParams({ timeout_ms: String(timeoutMs) });
      if (channel) qs.set("channel", channel);
      return request(`/api/wait?${qs}`);
    },
  };
}
