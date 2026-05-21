/** Thin HTTP client to the relay. Throws on non-2xx. */
export function createRelayClient(relayUrl) {
  const base = relayUrl.replace(/\/+$/, "");

  async function request(path, init = {}) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`relay ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  return {
    registerAgent(name) {
      return request("/api/agents/register", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
    postMessage({ channel, from, content }) {
      return request(`/api/channels/${encodeURIComponent(channel)}/messages`, {
        method: "POST",
        body: JSON.stringify({ from, content }),
      });
    },
    readMessages({ channel, since = 0 }) {
      const qs = new URLSearchParams({ since: String(since) });
      return request(`/api/channels/${encodeURIComponent(channel)}/messages?${qs}`);
    },
    listChannels() {
      return request("/api/channels");
    },
    health() {
      return request("/api/health");
    },
  };
}
