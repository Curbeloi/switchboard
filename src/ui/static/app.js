(() => {
  /* ---------- DOM refs ---------- */
  const statusEl = document.getElementById("status");
  const modeSelect = document.getElementById("mode-select");
  const modeLlmOption = document.getElementById("mode-llm");
  const agentsList = document.getElementById("agents");
  const channelsList = document.getElementById("channels");
  const newChannelName = document.getElementById("new-channel-name");
  const newChannelBtn = document.getElementById("new-channel-btn");

  const convChannelName = document.getElementById("conv-channel-name");
  const convChannelMeta = document.getElementById("conv-channel-meta");
  const convNewPane = document.getElementById("conv-new");
  const newConvTitle = document.getElementById("new-conv-title");
  const newConvPurpose = document.getElementById("new-conv-purpose");
  const newConvContract = document.getElementById("new-conv-contract");
  const newConvBtn = document.getElementById("new-conv-btn");
  const conversationsList = document.getElementById("conversations");

  const convTitle = document.getElementById("conv-title");
  const convMeta = document.getElementById("conv-meta");
  const stateToggleBtn = document.getElementById("state-toggle");
  const closeConvBtn = document.getElementById("close-conv-btn");
  const statePane = document.getElementById("state-pane");
  const stateTextarea = document.getElementById("state-textarea");
  const stateMeta = document.getElementById("state-meta");
  const stateSaveBtn = document.getElementById("state-save");
  const stateMsg = document.getElementById("state-msg");

  const messagesList = document.getElementById("messages");
  const pendingList = document.getElementById("pending");
  const pendingHeading = document.getElementById("pending-heading");
  const emptyHint = document.getElementById("empty-hint");
  const overlay = document.getElementById("overlay");
  const settingsBtn = document.getElementById("settings-btn");
  const themeSelect = document.getElementById("theme-select");
  const langSelect = document.getElementById("lang-select");

  /* ---------- i18n shortcut ---------- */
  const t = (key, vars) => window.SBI18n.t(key, vars);

  /* ---------- state ---------- */
  let reviewerAvailable = false;
  let defaultPolicy = "";
  let overlayMode = null;

  const agents = new Map();                 // name → agent
  const channels = new Map();               // name → { members, messageCount }
  const conversations = new Map();          // convId → conversation
  const convsByChannel = new Map();         // channel → Set<convId>
  const messagesByConv = new Map();         // convId → msg[]
  const pending = new Map();                // msgId → message (global)
  let contractNames = [];                   // string[] — named contracts (e.g. dsp.v1)

  let selectedChannel = null;
  let selectedConv = null;

  /* ---------- helpers ---------- */
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function setStatus(state, label) {
    statusEl.className =
      "text-xs px-2.5 py-1 rounded-full font-mono " +
      (state === "connected"
        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
        : state === "disconnected"
        ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200");
    statusEl.textContent = label;
  }

  function channelOf(convId) {
    return conversations.get(convId)?.channel ?? null;
  }
  function convsOfChannel(name) {
    return [...(convsByChannel.get(name) ?? [])]
      .map((id) => conversations.get(id))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  function unreadCountInConv(convId) {
    // We don't have read cursors for the supervisor (no token); show pending count instead.
    return [...pending.values()].filter((m) => m.conversationId === convId).length;
  }

  /* ---------- col 1: channels + agents ---------- */

  function renderAgents() {
    if (agents.size === 0) {
      agentsList.innerHTML = `<li class="text-xs text-slate-400 italic px-2">${escapeHtml(t("noAgents"))}</li>`;
      return;
    }
    agentsList.innerHTML = "";
    for (const a of agents.values()) {
      const li = document.createElement("li");
      li.className = "text-xs font-mono text-slate-700 dark:text-slate-300 px-2 py-0.5";
      li.textContent = a.name;
      agentsList.appendChild(li);
    }
  }

  function renderChannels() {
    if (channels.size === 0) {
      channelsList.innerHTML = `<li class="text-xs text-slate-400 italic px-2">${escapeHtml(t("noChannels"))}</li>`;
      return;
    }
    channelsList.innerHTML = "";
    for (const [name, info] of channels.entries()) {
      const li = document.createElement("li");
      const active = name === selectedChannel;
      li.className =
        "group flex items-center justify-between gap-1 px-2 py-1 rounded cursor-pointer " +
        (active ? "bg-blue-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-700");
      const count = info.messageCount ?? 0;
      const badgeCls = active
        ? "bg-white/20 text-white"
        : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300";
      li.innerHTML = `
        <span class="font-mono text-xs truncate">${escapeHtml(name)}</span>
        <span class="text-[10px] ${badgeCls} px-1.5 rounded-full tabular-nums">${count}</span>
      `;
      li.title = t("members", { list: (info.members || []).join(", ") || t("membersNone") });
      li.onclick = () => selectChannel(name);
      const del = document.createElement("button");
      del.className =
        "invisible group-hover:visible text-[11px] px-1 " +
        (active ? "text-white/80 hover:text-white" : "text-slate-400 hover:text-red-500");
      del.textContent = "✕";
      del.title = t("deleteChannel");
      del.onclick = (ev) => { ev.stopPropagation(); deleteChannel(name); };
      li.appendChild(del);
      channelsList.appendChild(li);
    }
  }

  /* ---------- col 2: conversations ---------- */

  function renderConversationsPane() {
    if (!selectedChannel) {
      convChannelName.textContent = "—";
      convChannelMeta.textContent = t("selectChannel");
      convNewPane.classList.add("hidden");
      conversationsList.innerHTML = "";
      return;
    }
    const info = channels.get(selectedChannel) || { members: [] };
    convChannelName.textContent = selectedChannel;
    convChannelMeta.textContent = t("members", { list: (info.members || []).join(", ") || t("membersNone") });
    convNewPane.classList.remove("hidden");

    const list = convsOfChannel(selectedChannel);
    if (list.length === 0) {
      conversationsList.innerHTML =
        `<li class="text-xs text-slate-400 italic px-2 py-2">${escapeHtml(t("noConversations"))}</li>`;
      return;
    }
    conversationsList.innerHTML = "";
    const open = list.filter((c) => c.status === "open");
    const closed = list.filter((c) => c.status === "closed");

    if (open.length) {
      appendConvSectionLabel(t("open"));
      for (const c of open) conversationsList.appendChild(convItem(c));
    }
    if (closed.length) {
      appendConvSectionLabel(t("closed"));
      for (const c of closed) conversationsList.appendChild(convItem(c));
    }
  }
  function appendConvSectionLabel(label) {
    const li = document.createElement("li");
    li.className = "text-[10px] uppercase tracking-wider font-semibold text-slate-400 mt-1 px-2";
    li.textContent = label;
    conversationsList.appendChild(li);
  }
  function convItem(c) {
    const li = document.createElement("li");
    const active = c.id === selectedConv;
    const isClosed = c.status === "closed";
    li.className =
      "px-2 py-1.5 rounded cursor-pointer " +
      (active
        ? "bg-blue-600 text-white"
        : isClosed
        ? "bg-slate-100 hover:bg-slate-200 text-slate-500 dark:bg-slate-700/50 dark:hover:bg-slate-700 dark:text-slate-400"
        : "hover:bg-slate-100 dark:hover:bg-slate-700");
    const unread = unreadCountInConv(c.id);
    const unreadBadge = unread > 0
      ? `<span class="text-[10px] ${active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"} px-1.5 rounded-full ml-1 tabular-nums">${unread}</span>`
      : "";
    const contractBadge = c.contract_name
      ? `<span class="text-[10px] ${active ? "bg-white/20 text-white" : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200"} px-1.5 rounded font-mono ml-1" title="governed by contract">${escapeHtml(c.contract_name)}</span>`
      : "";
    const outcome = c.closedOutcome ? `<div class="text-[10px] italic mt-0.5 ${active ? "text-white/80" : "text-slate-400"}">→ ${escapeHtml(c.closedOutcome)}</div>` : "";
    const purpose = c.purpose ? `<div class="text-[11px] mt-0.5 ${active ? "text-white/80" : "text-slate-500 dark:text-slate-400"} truncate">${escapeHtml(c.purpose)}</div>` : "";
    li.innerHTML = `
      <div class="flex items-center justify-between gap-1">
        <span class="font-mono text-xs truncate">${escapeHtml(c.title)}</span>
        <span class="flex items-center shrink-0">${contractBadge}${unreadBadge}</span>
      </div>
      ${purpose}
      ${outcome}
    `;
    li.onclick = () => selectConversation(c.id);
    return li;
  }

  /* ---------- col 3: messages + state doc ---------- */

  function messageNode(m, withActions) {
    const li = document.createElement("li");
    const base =
      "rounded border bg-white dark:bg-slate-800 text-sm px-3 py-2 leading-snug shadow-sm";
    const variant =
      m.status === "pending"
        ? "border-amber-300 dark:border-amber-700 border-l-4 border-l-amber-500"
        : m.status === "rejected"
        ? "border-slate-200 dark:border-slate-700 opacity-50 line-through"
        : "border-slate-200 dark:border-slate-700";
    li.className = `${base} ${variant}`;
    const to = Array.isArray(m.to) && m.to.length
      ? `<span class="text-green-700 dark:text-green-400 text-[11px] font-mono">→ @${m.to.map(escapeHtml).join(" @")}</span>`
      : "";
    const contractName = m.contract
      ? `<div class="text-[11px] text-green-700 dark:text-green-400 font-mono mt-1">${escapeHtml(t("contractLabel", { name: m.contract }))}</div>`
      : "";
    const data = m.data != null
      ? `<pre class="mt-1 text-[11px] bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 overflow-x-auto">${escapeHtml(JSON.stringify(m.data, null, 2))}</pre>`
      : "";
    const review = m.review
      ? `<div class="mt-1 text-[11px] text-amber-700 dark:text-amber-400 font-mono">${escapeHtml(t("reviewer", { decision: m.review.decision, reason: m.review.reason || "" }))}</div>`
      : "";
    li.innerHTML = `
      <div class="flex items-baseline justify-between gap-2 mb-0.5">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="font-mono text-blue-700 dark:text-blue-400 font-semibold">${escapeHtml(m.from)}</span>
          ${to}
        </div>
        <span class="text-[11px] text-slate-400 font-mono tabular-nums shrink-0">${fmtTime(m.createdAt)}</span>
      </div>
      <div class="whitespace-pre-wrap break-words">${escapeHtml(m.content)}</div>
      ${contractName}
      ${data}
      ${review}
    `;
    if (withActions && m.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "mt-2 flex gap-2";
      const approve = document.createElement("button");
      approve.className = "rounded bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 font-semibold";
      approve.textContent = t("approve");
      approve.onclick = () => act(`/api/approval/${m.id}/approve`);
      const reject = document.createElement("button");
      reject.className = "rounded bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 font-semibold";
      reject.textContent = t("reject");
      reject.onclick = () => act(`/api/approval/${m.id}/reject`);
      actions.appendChild(approve);
      actions.appendChild(reject);
      li.appendChild(actions);
    }
    return li;
  }

  function renderMessages() {
    if (!selectedConv) {
      convTitle.textContent = t("selectConversation");
      convMeta.textContent = "";
      stateToggleBtn.classList.add("hidden");
      closeConvBtn.classList.add("hidden");
      statePane.classList.add("hidden");
      pendingHeading.hidden = true;
      pendingList.innerHTML = "";
      messagesList.innerHTML = "";
      emptyHint.hidden = false;
      return;
    }
    const c = conversations.get(selectedConv);
    if (!c) return;
    emptyHint.hidden = true;
    convTitle.textContent = c.title;
    const status = c.status === "open"
      ? t("convStatusOpen")
      : `${t("convStatusClosed")}${c.closedOutcome ? ` — ${c.closedOutcome}` : ""}`;
    convMeta.textContent = `${c.channel}/${c.id.slice(0, 8)} · ${status}${c.purpose ? ` · ${c.purpose}` : ""}`;
    stateToggleBtn.classList.remove("hidden");
    closeConvBtn.classList.toggle("hidden", c.status !== "open");

    const convPending = [...pending.values()].filter((m) => m.conversationId === selectedConv);
    pendingHeading.hidden = convPending.length === 0;
    pendingList.innerHTML = "";
    for (const m of convPending) pendingList.appendChild(messageNode(m, true));

    const msgs = messagesByConv.get(selectedConv) || [];
    messagesList.innerHTML = "";
    if (msgs.length === 0 && convPending.length === 0) {
      const li = document.createElement("li");
      li.className = "text-sm text-slate-400 italic";
      li.textContent = t("noMessages");
      messagesList.appendChild(li);
    } else {
      for (const m of msgs) messagesList.appendChild(messageNode(m, false));
    }
    scrollMessagesToBottom();
  }
  function scrollMessagesToBottom() {
    const s = document.getElementById("msg-scroll");
    s.scrollTop = s.scrollHeight;
  }

  /* ---------- selection ---------- */
  async function selectChannel(name) {
    selectedChannel = name;
    selectedConv = null;
    renderChannels();
    renderConversationsPane();
    renderMessages();
    // Lazy-load conversations for the channel if we haven't yet.
    try {
      const list = await fetch(`/api/channels/${encodeURIComponent(name)}/conversations?status=all`)
        .then((r) => r.json());
      mergeConversations(list);
      renderConversationsPane();
    } catch {
      /* keep what we have */
    }
  }

  async function selectConversation(id) {
    selectedConv = id;
    renderConversationsPane();
    renderMessages();
    statePane.classList.add("hidden"); // collapse state doc on switch
    try {
      const msgs = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages?since=0`)
        .then((r) => r.json());
      messagesByConv.set(id, msgs);
      renderMessages();
    } catch {
      /* keep what we have */
    }
  }

  function mergeConversations(list) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      conversations.set(c.id, c);
      if (!convsByChannel.has(c.channel)) convsByChannel.set(c.channel, new Set());
      convsByChannel.get(c.channel).add(c.id);
    }
  }

  /* ---------- state doc ---------- */
  async function toggleStateDoc() {
    if (!selectedConv) return;
    const hidden = statePane.classList.contains("hidden");
    if (hidden) {
      statePane.classList.remove("hidden");
      stateToggleBtn.textContent = t("hideStateDoc");
      try {
        const s = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/state`)
          .then((r) => r.json());
        stateTextarea.value = s.content || "";
        stateMeta.textContent = s.updatedAt
          ? t("stateUpdated", { time: fmtTime(s.updatedAt), by: s.updatedBy })
          : t("stateEmpty");
        stateMsg.textContent = "";
      } catch {
        stateMeta.textContent = t("stateLoadFailed");
      }
    } else {
      statePane.classList.add("hidden");
      stateToggleBtn.textContent = t("stateDoc");
    }
  }
  async function saveStateDoc() {
    if (!selectedConv) return;
    stateMsg.textContent = t("saving");
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: stateTextarea.value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      stateMsg.textContent = body.error || t("saveFailed");
      return;
    }
    const data = await res.json();
    stateMeta.textContent = t("stateUpdated", { time: fmtTime(data.updatedAt), by: data.updatedBy });
    stateMsg.textContent = t("saved");
  }
  stateToggleBtn.addEventListener("click", toggleStateDoc);
  stateSaveBtn.addEventListener("click", saveStateDoc);

  /* ---------- close conversation ---------- */
  closeConvBtn.addEventListener("click", async () => {
    if (!selectedConv) return;
    const outcome = prompt(t("outcomePrompt")) || null;
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(outcome ? { outcome } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || t("couldNotClose"));
    }
  });

  /* ---------- create conversation ---------- */
  async function createConversation() {
    if (!selectedChannel) return;
    const title = newConvTitle.value.trim();
    if (!title) return;
    const body = { title };
    const purpose = newConvPurpose.value.trim();
    if (purpose) body.purpose = purpose;
    const contract = newConvContract?.value || "";
    if (contract) body.contract_name = contract;
    const res = await fetch(`/api/channels/${encodeURIComponent(selectedChannel)}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || t("couldNotCreateConv"));
      return;
    }
    newConvTitle.value = "";
    newConvPurpose.value = "";
    if (newConvContract) newConvContract.value = "";
    // conversation.created broadcast will refresh; also auto-select the new one.
    const conv = await res.json();
    mergeConversations([conv]);
    selectConversation(conv.id);
  }

  function renderContractsSelect() {
    if (!newConvContract) return;
    const current = newConvContract.value;
    newConvContract.innerHTML =
      `<option value="">${escapeHtml(t("noContract"))}</option>` +
      contractNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    if (current && contractNames.includes(current)) newConvContract.value = current;
  }
  newConvBtn.addEventListener("click", createConversation);
  newConvTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") createConversation(); });

  /* ---------- channel create / delete ---------- */
  async function createChannel(name) {
    const n = (name || "").trim();
    if (!n) return;
    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: n }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || t("couldNotCreateChannel"));
    }
  }
  async function deleteChannel(name) {
    if (!confirm(t("deleteChannelConfirm", { name }))) return;
    const res = await fetch(`/api/channels/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || t("couldNotDeleteChannel"));
    }
  }
  newChannelBtn.addEventListener("click", async () => {
    await createChannel(newChannelName.value);
    newChannelName.value = "";
  });
  newChannelName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (async () => { await createChannel(newChannelName.value); newChannelName.value = ""; })();
  });

  /* ---------- websocket + bootstrap ---------- */
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/subscribe`);
    ws.onopen = () => setStatus("connected", t("status.connected"));
    ws.onclose = () => {
      setStatus("disconnected", t("status.disconnected"));
      setTimeout(connect, 2000);
    };
    ws.onerror = () => setStatus("disconnected", t("status.error"));
    ws.onmessage = (event) => handle(JSON.parse(event.data));
  }

  function setReviewerAvailable(available) {
    reviewerAvailable = Boolean(available);
    if (modeLlmOption) modeLlmOption.disabled = !reviewerAvailable;
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
        const c = e.channel;
        if (!channels.has(c.name)) channels.set(c.name, { members: [], messageCount: 0 });
        const info = channels.get(c.name);
        info.members = c.members || [];
        if (typeof c.messageCount === "number") info.messageCount = c.messageCount;
        renderChannels();
        if (c.name === selectedChannel) renderConversationsPane();
        break;
      }
      case "channel.deleted": {
        channels.delete(e.name);
        const ids = convsByChannel.get(e.name);
        if (ids) for (const id of ids) { conversations.delete(id); messagesByConv.delete(id); }
        convsByChannel.delete(e.name);
        if (selectedChannel === e.name) { selectedChannel = null; selectedConv = null; }
        for (const [id, m] of pending) if (m.channel === e.name) pending.delete(id);
        renderChannels();
        renderConversationsPane();
        renderMessages();
        break;
      }
      case "conversation.created":
        mergeConversations([e.conversation]);
        if (e.conversation.channel === selectedChannel) renderConversationsPane();
        break;
      case "conversation.closed":
      case "conversation.updated": {
        const existing = conversations.get(e.conversation.id);
        if (existing) Object.assign(existing, e.conversation);
        else mergeConversations([e.conversation]);
        if (e.conversation.channel === selectedChannel) renderConversationsPane();
        if (e.conversation.id === selectedConv) renderMessages();
        break;
      }
      case "conversation.state.updated":
        if (e.conversationId === selectedConv && !statePane.classList.contains("hidden")) {
          // Refresh the textarea silently if it's open.
          fetch(`/api/conversations/${encodeURIComponent(e.conversationId)}/state`)
            .then((r) => r.json())
            .then((s) => {
              stateTextarea.value = s.content || "";
              stateMeta.textContent = s.updatedAt ? t("stateUpdated", { time: fmtTime(s.updatedAt), by: s.updatedBy }) : t("stateEmpty");
            });
        }
        break;
      case "message.delivered": {
        if (pending.has(e.message.id)) pending.delete(e.message.id);
        addMessageToConv(e.message);
        const info = channels.get(e.message.channel);
        if (info) info.messageCount = (info.messageCount ?? 0) + 1;
        renderChannels();
        if (e.message.conversationId === selectedConv) renderMessages();
        else if (e.message.channel === selectedChannel) renderConversationsPane();
        break;
      }
      case "message.pending":
        pending.set(e.message.id, e.message);
        if (!conversations.has(e.message.conversationId)) {
          // Conversation we haven't fetched yet — lazy-merge a minimal stub.
        }
        if (e.message.conversationId === selectedConv) renderMessages();
        else if (e.message.channel === selectedChannel) renderConversationsPane();
        break;
      case "message.escalated":
        pending.set(e.message.id, e.message);
        if (e.message.conversationId === selectedConv) renderMessages();
        break;
      case "message.rejected":
        pending.delete(e.message.id);
        if (e.message.conversationId === selectedConv) renderMessages();
        else if (e.message.channel === selectedChannel) renderConversationsPane();
        break;
      case "message.read":
        // no-op for the supervisor UI for now
        break;
      case "approval.mode":
        if (e.mode) modeSelect.value = e.mode;
        break;
      case "setup.updated":
        if (e.needed === false && overlayMode === "wizard") closeOverlay();
        break;
      case "contracts.updated":
        refreshContracts();
        if (overlayMode === "settings") refreshSettings();
        break;
      case "policy.updated":
        if (overlayMode === "settings") refreshSettings();
        break;
    }
  }

  function addMessageToConv(m) {
    if (!messagesByConv.has(m.conversationId)) messagesByConv.set(m.conversationId, []);
    const arr = messagesByConv.get(m.conversationId);
    if (!arr.some((x) => x.id === m.id)) arr.push(m);
  }

  async function refreshContracts() {
    try {
      const list = await fetch("/api/contracts").then((r) => r.json());
      contractNames = list.map((c) => c.name);
      renderContractsSelect();
    } catch {
      /* best-effort */
    }
  }

  async function bootstrap() {
    const [agentsRes, channelsRes, approvalRes] = await Promise.all([
      fetch("/api/agents").then((r) => r.json()),
      fetch("/api/channels").then((r) => r.json()),
      fetch("/api/approval").then((r) => r.json()),
      refreshContracts(),
    ]);
    for (const a of agentsRes) agents.set(a.name, a);
    for (const c of channelsRes) channels.set(c.name, { members: c.members || [], messageCount: c.messageCount });
    for (const m of approvalRes.pending) pending.set(m.id, m);
    if (approvalRes.mode) modeSelect.value = approvalRes.mode;
    setReviewerAvailable(Boolean(approvalRes.reviewer?.available));
    // Fetch conversations for every channel up-front (small lists).
    await Promise.all(
      [...channels.keys()].map((name) =>
        fetch(`/api/channels/${encodeURIComponent(name)}/conversations?status=all`)
          .then((r) => r.json())
          .then(mergeConversations)
          .catch(() => null)
      )
    );
    renderAgents();
    renderChannels();
    renderConversationsPane();
    renderMessages();
  }

  async function act(path) {
    await fetch(path, { method: "POST" });
  }

  async function changeMode(mode) {
    const res = await fetch("/api/approval/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || t("couldNotChangeMode"));
      const approval = await fetch("/api/approval").then((r) => r.json());
      modeSelect.value = approval.mode;
      return false;
    }
    modeSelect.value = mode;
    return true;
  }
  modeSelect.addEventListener("change", () => changeMode(modeSelect.value));

  /* ---------- overlay: setup wizard + settings (uses style.css classes) ---------- */
  const modeInfo = (m) => t("mode." + m);
  const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

  function showOverlay(html, mode) {
    overlay.innerHTML = html;
    overlay.hidden = false;
    overlayMode = mode;
  }
  function closeOverlay() {
    overlay.hidden = true;
    overlay.innerHTML = "";
    overlayMode = null;
  }

  function parseSchema(text) {
    const s = (text || "").trim();
    if (!s) return { error: t("schemaEmpty") };
    let v;
    try { v = JSON.parse(s); } catch (e) { return { error: "invalid JSON: " + e.message }; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: "schema must be a JSON object" };
    }
    return { schema: v };
  }

  function modeOptionsHtml(selectedMode) {
    return ["manual", "auto", "llm"].map((m) => {
      const disabled = m === "llm" && !reviewerAvailable;
      const cls = "mode-option" + (m === selectedMode ? " selected" : "") + (disabled ? " disabled" : "");
      const note = disabled ? t("noReviewerNote") : "";
      return `<label class="${cls}" data-mode="${m}">
        <input type="radio" name="wiz-mode" value="${m}" ${m === selectedMode ? "checked" : ""} ${disabled ? "disabled" : ""}/>
        <div>
          <div class="mo-name">${m}${note ? `<span class="mo-desc">${escapeHtml(note)}</span>` : ""}</div>
          <div class="mo-desc">${escapeHtml(modeInfo(m))}</div>
        </div>
      </label>`;
    }).join("");
  }

  function openWizard(initial) {
    const wiz = {
      step: 1,
      total: 3,
      mode: initial.mode || "manual",
      policy: initial.policy || initial.defaultPolicy || "",
      contracts: (initial.contracts || []).map((c) => ({ name: c.name, schema: c.schema })),
    };
    renderWizard(wiz);
  }

  function renderWizard(wiz) {
    const dots = [1, 2, 3].map((n) =>
      `<div class="step ${n === wiz.step ? "active" : n < wiz.step ? "done" : ""}"></div>`
    ).join("");
    let body = "";
    if (wiz.step === 1) {
      body = `<p class="step-title">${escapeHtml(t("wizStep1"))}</p>
        <div class="mode-options">${modeOptionsHtml(wiz.mode)}</div>`;
    } else if (wiz.step === 2) {
      body = `<p class="step-title">${escapeHtml(t("wizStep2"))}</p>
        <div class="field">
          <label>${escapeHtml(t("wizPolicyLabel"))}</label>
          <textarea id="wiz-policy" rows="12">${escapeHtml(wiz.policy)}</textarea>
          <div class="hint">${escapeHtml(t("wizPolicyHint"))}</div>
        </div>`;
    } else {
      body = `<p class="step-title">${escapeHtml(t("wizStep3"))} <span class="mo-desc">${escapeHtml(t("wizOptional"))}</span></p>
        ${renderContractListHtml(wiz.contracts, "wiz")}
        <div class="field">
          <label>${escapeHtml(t("wizAddContract"))}</label>
          <input type="text" id="wiz-cname" placeholder="${escapeHtml(t("wizContractName"))}" />
          <textarea id="wiz-cschema" rows="8" placeholder='{"type":"object","properties":{...},"required":[...]}'></textarea>
          <div class="field-error" id="wiz-cerr"></div>
          <button class="btn" id="wiz-cadd" type="button">${escapeHtml(t("wizAddContractBtn"))}</button>
        </div>`;
    }
    const back = wiz.step > 1
      ? `<button class="btn" id="wiz-back" type="button">${escapeHtml(t("back"))}</button>`
      : `<span></span>`;
    const next = wiz.step < wiz.total
      ? `<button class="btn btn-primary" id="wiz-next" type="button">${escapeHtml(t("next"))}</button>`
      : `<button class="btn btn-primary" id="wiz-finish" type="button">${escapeHtml(t("finishSetup"))}</button>`;
    showOverlay(`<div class="panel">
      <h2>${escapeHtml(t("wizWelcome"))}</h2>
      <p class="sub">${escapeHtml(t("wizIntro"))}</p>
      <div class="steps">${dots}</div>
      ${body}
      <div class="panel-footer">${back}<div class="right">${next}</div></div>
    </div>`, "wizard");
    wireWizard(wiz);
  }
  function captureWizardStep(wiz) {
    if (wiz.step === 1) {
      const sel = overlay.querySelector('input[name="wiz-mode"]:checked');
      if (sel) wiz.mode = sel.value;
    } else if (wiz.step === 2) {
      const ta = overlay.querySelector("#wiz-policy");
      if (ta) wiz.policy = ta.value;
    }
  }
  function wireWizard(wiz) {
    overlay.querySelectorAll(".mode-option").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.classList.contains("disabled")) return;
        wiz.mode = el.dataset.mode;
        overlay.querySelectorAll(".mode-option").forEach((o) => o.classList.remove("selected"));
        el.classList.add("selected");
        const radio = el.querySelector("input");
        if (radio) radio.checked = true;
      });
    });
    const back = overlay.querySelector("#wiz-back");
    if (back) back.onclick = () => { captureWizardStep(wiz); wiz.step--; renderWizard(wiz); };
    const next = overlay.querySelector("#wiz-next");
    if (next) next.onclick = () => { captureWizardStep(wiz); wiz.step++; renderWizard(wiz); };
    const add = overlay.querySelector("#wiz-cadd");
    if (add) add.onclick = () => {
      const name = overlay.querySelector("#wiz-cname").value.trim();
      const errEl = overlay.querySelector("#wiz-cerr");
      if (!NAME_RE.test(name)) { errEl.textContent = t("invalidName"); return; }
      if (wiz.contracts.some((c) => c.name === name)) { errEl.textContent = t("contractAlreadyAdded", { name }); return; }
      const parsed = parseSchema(overlay.querySelector("#wiz-cschema").value);
      if (parsed.error) { errEl.textContent = parsed.error; return; }
      wiz.contracts.push({ name, schema: parsed.schema });
      renderWizard(wiz);
    };
    overlay.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () => {
        wiz.contracts = wiz.contracts.filter((c) => c.name !== b.dataset.del);
        renderWizard(wiz);
      };
    });
    const finish = overlay.querySelector("#wiz-finish");
    if (finish) finish.onclick = async () => {
      captureWizardStep(wiz);
      finish.disabled = true;
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: wiz.mode, policy: wiz.policy, contracts: wiz.contracts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || t("setupFailed"));
        finish.disabled = false;
        return;
      }
      modeSelect.value = wiz.mode;
      closeOverlay();
    };
  }
  function renderContractListHtml(contracts, scope) {
    if (!contracts.length) return `<p class="empty-note">${escapeHtml(t("noContractsInline"))}</p>`;
    return `<ul class="contract-list">${contracts.map((c) => `
      <li><span>${escapeHtml(c.name)}</span>
        <span class="c-actions">
          ${scope === "settings" ? `<button class="btn" data-edit="${escapeHtml(c.name)}" type="button">${escapeHtml(t("edit"))}</button>` : ""}
          <button class="btn btn-danger" data-del="${escapeHtml(c.name)}" type="button">${escapeHtml(t("remove"))}</button>
        </span></li>`).join("")}</ul>`;
  }

  async function refreshSettings() {
    const data = await fetch("/api/setup").then((r) => r.json());
    renderSettings(data);
  }
  function renderSettings(data) {
    const contracts = data.contracts || [];
    const policy = data.policy || "";
    const mode = data.mode || "manual";
    const modeSel = ["manual", "auto", "llm"].map((m) =>
      `<option value="${m}" ${m === mode ? "selected" : ""} ${m === "llm" && !reviewerAvailable ? "disabled" : ""}>${m}</option>`
    ).join("");
    showOverlay(`<div class="panel">
      <div class="row-between">
        <h2>${escapeHtml(t("settings.title"))}</h2>
        <button class="btn" id="set-close" type="button">${escapeHtml(t("close"))}</button>
      </div>
      <p class="sub">${escapeHtml(t("settingsSavedTo", { dir: data.configDir || "~/.switchboard" }))}</p>
      <div class="settings-section">
        <h3>${escapeHtml(t("supervisionMode"))}</h3>
        <div class="field"><select id="set-mode">${modeSel}</select></div>
      </div>
      <div class="settings-section">
        <h3>${escapeHtml(t("reviewerPolicy"))}</h3>
        <div class="field">
          <textarea id="set-policy" rows="10">${escapeHtml(policy)}</textarea>
          <div class="field-ok" id="set-policy-msg"></div>
        </div>
        <button class="btn btn-primary" id="set-policy-save" type="button">${escapeHtml(t("savePolicy"))}</button>
      </div>
      <div class="settings-section">
        <h3>${escapeHtml(t("contracts"))}</h3>
        ${renderContractListHtml(contracts, "settings")}
        <div class="field">
          <label>${escapeHtml(t("addUpdateContract"))}</label>
          <input type="text" id="set-cname" placeholder="${escapeHtml(t("wizContractName"))}" />
          <textarea id="set-cschema" rows="8" placeholder='{"type":"object", ...}'></textarea>
          <div class="field-error" id="set-cerr"></div>
          <button class="btn btn-primary" id="set-csave" type="button">${escapeHtml(t("saveContract"))}</button>
        </div>
      </div>
    </div>`, "settings");
    overlay.querySelector("#set-close").onclick = closeOverlay;
    overlay.querySelector("#set-mode").onchange = (e) => changeMode(e.target.value);
    overlay.querySelector("#set-policy-save").onclick = async () => {
      const text = overlay.querySelector("#set-policy").value;
      const res = await fetch("/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: text }),
      });
      const msg = overlay.querySelector("#set-policy-msg");
      msg.textContent = res.ok ? t("saved") : t("saveFailed");
    };
    overlay.querySelector("#set-csave").onclick = async () => {
      const name = overlay.querySelector("#set-cname").value.trim();
      const errEl = overlay.querySelector("#set-cerr");
      if (!NAME_RE.test(name)) { errEl.textContent = t("invalidName"); return; }
      const parsed = parseSchema(overlay.querySelector("#set-cschema").value);
      if (parsed.error) { errEl.textContent = parsed.error; return; }
      const res = await fetch(`/api/contracts/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: parsed.schema }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        errEl.textContent = body.error || t("saveFailed");
        return;
      }
      refreshSettings();
    };
    overlay.querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = () => {
        const c = contracts.find((x) => x.name === b.dataset.edit);
        if (!c) return;
        overlay.querySelector("#set-cname").value = c.name;
        overlay.querySelector("#set-cschema").value = JSON.stringify(c.schema, null, 2);
        overlay.querySelector("#set-cschema").scrollIntoView({ behavior: "smooth", block: "center" });
      };
    });
    overlay.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm(t("deleteContractConfirm", { name: b.dataset.del }))) return;
        await fetch(`/api/contracts/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
        refreshSettings();
      };
    });
  }
  settingsBtn.addEventListener("click", refreshSettings);

  /* ---------- theme (light / dark / auto) ---------- */
  const THEME_KEY = "sb.theme";
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  function getThemePref() {
    const p = localStorage.getItem(THEME_KEY);
    return p === "light" || p === "dark" || p === "auto" ? p : "auto";
  }
  function applyTheme(pref) {
    const dark = pref === "dark" || (pref === "auto" && mql.matches);
    document.documentElement.classList.toggle("dark", dark);
  }
  // React to OS theme changes while in "auto".
  mql.addEventListener("change", () => {
    if (getThemePref() === "auto") applyTheme("auto");
  });
  if (themeSelect) {
    themeSelect.value = getThemePref();
    themeSelect.addEventListener("change", () => {
      localStorage.setItem(THEME_KEY, themeSelect.value);
      applyTheme(themeSelect.value);
    });
  }

  /* ---------- language ---------- */
  function rerenderAll() {
    window.SBI18n.apply();          // static HTML ([data-i18n*])
    renderAgents();
    renderChannels();
    renderConversationsPane();
    renderMessages();
    renderContractsSelect();
    // Re-render the open overlay so its dynamic text follows the language.
    if (overlayMode === "settings") refreshSettings();
    else if (overlayMode === "wizard") openWizard(lastSetup || {});
  }
  let lastSetup = null;
  if (langSelect) {
    langSelect.value = window.SBI18n.getLang();
    langSelect.addEventListener("change", () => {
      window.SBI18n.setLang(langSelect.value);
      rerenderAll();
    });
  }

  /* ---------- init ---------- */
  async function init() {
    applyTheme(getThemePref());
    window.SBI18n.apply();
    setStatus("connecting", t("status.connecting"));
    try {
      const setup = await fetch("/api/setup").then((r) => r.json());
      lastSetup = setup;
      defaultPolicy = setup.defaultPolicy || "";
      setReviewerAvailable(Boolean(setup.reviewer?.available));
      if (setup.needed) openWizard(setup);
    } catch {
      /* relay not reachable yet; WS reconnect will catch up */
    }
    connect();
  }
  init();
})();
