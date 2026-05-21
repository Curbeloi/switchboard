(() => {
  const statusEl = document.getElementById("status");
  const modeSelect = document.getElementById("mode-select");
  const modeLlmOption = document.getElementById("mode-llm");
  const agentsList = document.getElementById("agents");
  const channelsList = document.getElementById("channels");
  const messagesList = document.getElementById("messages");
  const pendingList = document.getElementById("pending");
  const pendingHeading = document.getElementById("pending-heading");
  const channelTitle = document.getElementById("channel-title");
  const channelMeta = document.getElementById("channel-meta");
  const emptyHint = document.getElementById("empty-hint");

  const channels = new Map();          // name -> { members: string[], messageCount }
  const agents = new Map();            // name -> agent
  const pending = new Map();           // id -> message (global)
  const messagesByChannel = new Map(); // channel -> Message[]
  const readsByChannel = new Map();    // channel -> Map<agent, at>
  let selected = null;

  function setStatus(state, label) {
    statusEl.className = `status status-${state}`;
    statusEl.textContent = label;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------- sidebar ---------- */

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
    for (const [name, info] of channels.entries()) {
      const li = document.createElement("li");
      li.className = "channel-item" + (name === selected ? " active" : "");
      const count = info.messageCount ?? 0;
      li.innerHTML = `<span class="ch-name">${escapeHtml(name)}</span>
        <span class="ch-badge">${count}</span>`;
      li.title = `members: ${(info.members || []).join(", ") || "(none)"}`;
      li.onclick = () => selectChannel(name);
      channelsList.appendChild(li);
    }
  }

  /* ---------- feed ---------- */

  function messageNode(m, withActions) {
    const li = document.createElement("li");
    li.className = `message ${m.status}`;
    const to = Array.isArray(m.to) && m.to.length
      ? `<span class="to">→ @${m.to.map(escapeHtml).join(" @")}</span>`
      : "";
    const data = m.data != null
      ? `<pre class="contract">${escapeHtml(JSON.stringify(m.data, null, 2))}</pre>`
      : "";
    const review = m.review
      ? `<div class="review">reviewer: ${escapeHtml(m.review.decision)} — ${escapeHtml(m.review.reason || "")}</div>`
      : "";
    li.innerHTML = `
      <span class="from">${escapeHtml(m.from)}</span>
      ${to}
      <span class="time">${fmtTime(m.createdAt)}</span>
      <div class="content">${escapeHtml(m.content)}</div>
      ${data}
      ${review}
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

  function renderChannelMeta() {
    if (!selected) {
      channelMeta.textContent = "";
      return;
    }
    const info = channels.get(selected) || { members: [] };
    const members = (info.members || []).join(", ") || "(none)";
    const reads = readsByChannel.get(selected);
    let readLine = "";
    if (reads && reads.size) {
      readLine = ` · read by ${[...reads.keys()].join(", ")}`;
    }
    channelMeta.textContent = `members: ${members}${readLine}`;
  }

  function renderFeed() {
    if (!selected) {
      channelTitle.textContent = "Select a channel";
      channelMeta.textContent = "";
      pendingHeading.hidden = true;
      pendingList.innerHTML = "";
      messagesList.innerHTML = "";
      emptyHint.hidden = false;
      return;
    }
    emptyHint.hidden = true;
    channelTitle.textContent = selected;
    renderChannelMeta();

    const channelPending = [...pending.values()].filter((m) => m.channel === selected);
    pendingHeading.hidden = channelPending.length === 0;
    pendingList.innerHTML = "";
    for (const m of channelPending) pendingList.appendChild(messageNode(m, true));

    const msgs = messagesByChannel.get(selected) || [];
    messagesList.innerHTML = "";
    if (msgs.length === 0 && channelPending.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "no messages in this channel yet";
      messagesList.appendChild(li);
    } else {
      for (const m of msgs) messagesList.appendChild(messageNode(m, false));
    }
    feedScrollToBottom();
  }

  function feedScrollToBottom() {
    const feed = document.getElementById("feed");
    feed.scrollTop = feed.scrollHeight;
  }

  async function selectChannel(name) {
    selected = name;
    renderChannels();
    try {
      const msgs = await fetch(`/api/channels/${encodeURIComponent(name)}/messages?since=0`)
        .then((r) => r.json());
      messagesByChannel.set(name, msgs);
    } catch {
      /* keep whatever we have */
    }
    renderFeed();
  }

  /* ---------- state mutation ---------- */

  function ensureChannel(name) {
    if (!channels.has(name)) channels.set(name, { members: [], messageCount: 0 });
    return channels.get(name);
  }

  function addMessage(m) {
    if (!messagesByChannel.has(m.channel)) messagesByChannel.set(m.channel, []);
    const arr = messagesByChannel.get(m.channel);
    if (!arr.some((x) => x.id === m.id)) arr.push(m);
  }

  async function act(path) {
    await fetch(path, { method: "POST" });
  }

  /* ---------- websocket ---------- */

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/subscribe`);
    ws.onopen = () => setStatus("connected", "connected");
    ws.onclose = () => {
      setStatus("disconnected", "disconnected — retrying in 2s");
      setTimeout(connect, 2000);
    };
    ws.onerror = () => setStatus("disconnected", "error");
    ws.onmessage = (event) => handle(JSON.parse(event.data));
  }

  function setReviewerAvailable(available) {
    if (modeLlmOption) modeLlmOption.disabled = !available;
  }

  function handle(e) {
    switch (e.type) {
      case "hello":
        if (e.mode) modeSelect.value = e.mode;
        setReviewerAvailable(Boolean(e.reviewer?.available));
        bootstrap();
        break;
      case "agent.registered":
        agents.set(e.agent.name, e.agent);
        renderAgents();
        break;
      case "channel.updated": {
        const info = ensureChannel(e.channel.name);
        info.members = e.channel.members || [];
        if (typeof e.channel.messageCount === "number") info.messageCount = e.channel.messageCount;
        renderChannels();
        if (e.channel.name === selected) renderChannelMeta();
        break;
      }
      case "message.delivered": {
        if (pending.has(e.message.id)) pending.delete(e.message.id);
        addMessage(e.message);
        const info = ensureChannel(e.message.channel);
        info.messageCount = (info.messageCount ?? 0) + 1;
        renderChannels();
        if (e.message.channel === selected) renderFeed();
        break;
      }
      case "message.pending":
        pending.set(e.message.id, e.message);
        ensureChannel(e.message.channel);
        renderChannels();
        if (e.message.channel === selected) renderFeed();
        break;
      case "message.escalated":
        // Reviewer kicked it to a human — keep it pending, annotate with the reason.
        pending.set(e.message.id, e.message);
        if (e.message.channel === selected) renderFeed();
        break;
      case "message.rejected":
        pending.delete(e.message.id);
        if (e.message.channel === selected) renderFeed();
        break;
      case "message.read": {
        if (!readsByChannel.has(e.channel)) readsByChannel.set(e.channel, new Map());
        readsByChannel.get(e.channel).set(e.agent, e.at);
        if (e.channel === selected) renderChannelMeta();
        break;
      }
      case "approval.mode":
        if (e.mode) modeSelect.value = e.mode;
        break;
    }
  }

  async function bootstrap() {
    const [agentsRes, channelsRes, approvalRes] = await Promise.all([
      fetch("/api/agents").then((r) => r.json()),
      fetch("/api/channels").then((r) => r.json()),
      fetch("/api/approval").then((r) => r.json()),
    ]);
    for (const a of agentsRes) agents.set(a.name, a);
    for (const c of channelsRes) channels.set(c.name, { members: c.members || [], messageCount: c.messageCount });
    for (const m of approvalRes.pending) pending.set(m.id, m);
    if (approvalRes.mode) modeSelect.value = approvalRes.mode;
    setReviewerAvailable(Boolean(approvalRes.reviewer?.available));
    renderAgents();
    renderChannels();
    if (selected) renderFeed();
  }

  modeSelect.addEventListener("change", async () => {
    const res = await fetch("/api/approval/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: modeSelect.value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "could not change mode");
      // refresh from server truth
      const approval = await fetch("/api/approval").then((r) => r.json());
      modeSelect.value = approval.mode;
    }
  });

  setStatus("connecting", "connecting…");
  connect();
})();
