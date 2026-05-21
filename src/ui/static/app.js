(() => {
  const statusEl = document.getElementById("status");
  const approvalToggle = document.getElementById("approval-mode");
  const agentsList = document.getElementById("agents");
  const channelsList = document.getElementById("channels");
  const messagesList = document.getElementById("messages");
  const pendingList = document.getElementById("pending");
  const pendingHeading = document.getElementById("pending-heading");

  const channels = new Map(); // name -> messageCount
  const agents = new Map();   // name -> agent
  const pending = new Map();  // id -> message

  function setStatus(state, label) {
    statusEl.className = `status status-${state}`;
    statusEl.textContent = label;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString();
  }

  function renderAgents() {
    if (agents.size === 0) {
      agentsList.innerHTML = '<li class="muted">no agents yet</li>';
      return;
    }
    agentsList.innerHTML = "";
    for (const a of agents.values()) {
      const li = document.createElement("li");
      li.textContent = a.name;
      agentsList.appendChild(li);
    }
  }

  function renderChannels() {
    if (channels.size === 0) {
      channelsList.innerHTML = '<li class="muted">no channels yet</li>';
      return;
    }
    channelsList.innerHTML = "";
    for (const [name, count] of channels.entries()) {
      const li = document.createElement("li");
      li.textContent = `${name} (${count})`;
      channelsList.appendChild(li);
    }
  }

  function renderPending() {
    pendingHeading.hidden = pending.size === 0;
    pendingList.innerHTML = "";
    for (const m of pending.values()) {
      pendingList.appendChild(messageNode(m, true));
    }
  }

  function messageNode(m, withActions) {
    const li = document.createElement("li");
    li.className = `message ${m.status}`;
    li.innerHTML = `
      <span class="from">${escapeHtml(m.from)}</span>
      <span class="channel">→ ${escapeHtml(m.channel)}</span>
      <span class="time">${fmtTime(m.createdAt)}</span>
      <div class="content">${escapeHtml(m.content)}</div>
    `;
    if (withActions && m.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "actions";
      const approve = document.createElement("button");
      approve.textContent = "approve";
      approve.onclick = () => act(`/api/approval/${m.id}/approve`);
      const reject = document.createElement("button");
      reject.textContent = "reject";
      reject.className = "reject";
      reject.onclick = () => act(`/api/approval/${m.id}/reject`);
      actions.appendChild(approve);
      actions.appendChild(reject);
      li.appendChild(actions);
    }
    return li;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function act(path) {
    await fetch(path, { method: "POST" });
  }

  /* WebSocket */
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/subscribe`);
    ws.onopen = () => setStatus("connected", "connected");
    ws.onclose = () => {
      setStatus("disconnected", "disconnected — retrying in 2s");
      setTimeout(connect, 2000);
    };
    ws.onerror = () => setStatus("disconnected", "error");
    ws.onmessage = (event) => {
      const e = JSON.parse(event.data);
      handle(e);
    };
  }

  function handle(e) {
    switch (e.type) {
      case "hello":
        approvalToggle.checked = Boolean(e.approvalMode);
        bootstrap();
        break;
      case "agent.registered":
        agents.set(e.agent.name, e.agent);
        renderAgents();
        break;
      case "message.delivered": {
        if (pending.has(e.message.id)) pending.delete(e.message.id);
        renderPending();
        appendMessage(e.message);
        channels.set(e.message.channel, (channels.get(e.message.channel) ?? 0) + 1);
        renderChannels();
        break;
      }
      case "message.pending":
        pending.set(e.message.id, e.message);
        renderPending();
        break;
      case "message.rejected":
        pending.delete(e.message.id);
        renderPending();
        break;
      case "approval.mode":
        approvalToggle.checked = Boolean(e.mode);
        break;
    }
  }

  function appendMessage(m) {
    messagesList.appendChild(messageNode(m, false));
    messagesList.parentElement.scrollTop = messagesList.parentElement.scrollHeight;
  }

  async function bootstrap() {
    const [agentsRes, channelsRes, approvalRes] = await Promise.all([
      fetch("/api/agents").then((r) => r.json()),
      fetch("/api/channels").then((r) => r.json()),
      fetch("/api/approval").then((r) => r.json()),
    ]);
    for (const a of agentsRes) agents.set(a.name, a);
    for (const c of channelsRes) channels.set(c.name, c.messageCount);
    for (const m of approvalRes.pending) pending.set(m.id, m);
    renderAgents();
    renderChannels();
    renderPending();
  }

  approvalToggle.addEventListener("change", async () => {
    await fetch("/api/approval/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: approvalToggle.checked }),
    });
  });

  setStatus("connecting", "connecting…");
  connect();
})();
