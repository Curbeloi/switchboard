(() => {
  /* ---------- DOM refs ---------- */
  const statusEl = document.getElementById("status");
  // Supervision mode no longer has a header control — it lives in the Settings
  // view. We track the current value and mirror it into the open Settings select.
  let currentMode = "manual";
  function setCurrentMode(m) {
    if (!m) return;
    currentMode = m;
    const sel = overlay.querySelector("#set-mode");
    if (sel) sel.value = m;
  }
  const agentsList = document.getElementById("agents");
  const channelsList = document.getElementById("channels");
  const newChannelName = document.getElementById("new-channel-name");
  const newChannelBtn = document.getElementById("new-channel-btn");

  const convChannelName = document.getElementById("conv-channel-name");
  const convChannelMeta = document.getElementById("conv-channel-meta");
  const convMembers = document.getElementById("conv-members");
  const secNew = document.getElementById("sec-new");
  const secMembers = document.getElementById("sec-members");
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
  const masterBar = document.getElementById("master-bar");
  const masterTarget = document.getElementById("master-target");
  const masterInput = document.getElementById("master-input");
  const masterMsg = document.getElementById("master-msg");
  const masterPreview = document.getElementById("master-preview");
  const masterDraft = document.getElementById("master-draft");
  const masterAnalysis = document.getElementById("master-analysis");
  const masterDir = document.getElementById("master-dir");
  const emptyHint = document.getElementById("empty-hint");
  const overlay = document.getElementById("overlay");
  const settingsBtn = document.getElementById("settings-btn");

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
      // Oldest first → the most recent conversation sits at the bottom of the list.
      .sort((a, b) => a.createdAt - b.createdAt);
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
      convMembers.innerHTML = "";
      secNew.classList.add("hidden");
      secMembers.classList.add("hidden");
      conversationsList.innerHTML = "";
      return;
    }
    const info = channels.get(selectedChannel) || { members: [] };
    convChannelName.textContent = selectedChannel;
    convChannelMeta.textContent = "";
    renderChannelMembers(info.members || []);
    secNew.classList.remove("hidden");
    secMembers.classList.remove("hidden");

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
  /* Channel membership chips + an "add agent" control (supervisor surface). The
   * channel.updated broadcast re-renders this pane, so mutations need no manual refresh. */
  function renderChannelMembers(members) {
    convMembers.innerHTML = "";
    // Chips (wrap with breathing room), each removable.
    const chips = document.createElement("div");
    chips.className = "flex flex-wrap gap-1.5";
    if (!members.length) {
      const none = document.createElement("span");
      none.className = "text-[11px] text-slate-400 italic";
      none.textContent = t("membersNone");
      chips.appendChild(none);
    }
    for (const name of members) {
      const chip = document.createElement("span");
      chip.className =
        "inline-flex items-center gap-1.5 text-[11px] font-mono bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded px-2 py-0.5";
      const n = document.createElement("span");
      n.textContent = name;
      chip.appendChild(n);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "text-slate-400 hover:text-red-500 leading-none text-sm";
      x.textContent = "×";
      x.title = t("removeFromChannel");
      x.onclick = () => removeMember(selectedChannel, name);
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    convMembers.appendChild(chips);

    // Add-agent row on its own line (select fills the width + a clear button).
    const candidates = [...agents.keys()].filter((a) => !members.includes(a));
    if (candidates.length) {
      const row = document.createElement("div");
      row.className = "flex gap-1";
      const sel = document.createElement("select");
      sel.className =
        "flex-1 min-w-0 text-[11px] rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 dark:text-slate-200 px-1.5 py-1 font-mono";
      const def = document.createElement("option");
      def.value = "";
      def.textContent = t("addAgentOption");
      sel.appendChild(def);
      for (const a of candidates) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a;
        sel.appendChild(o);
      }
      const add = document.createElement("button");
      add.type = "button";
      add.className =
        "px-2.5 rounded bg-slate-200 dark:bg-slate-700 dark:text-slate-200 hover:bg-blue-500 hover:text-white text-sm leading-none";
      add.textContent = "+";
      add.title = t("addToChannel");
      add.onclick = () => { if (sel.value) addMember(selectedChannel, sel.value); };
      row.appendChild(sel);
      row.appendChild(add);
      convMembers.appendChild(row);
    }
  }
  async function addMember(channel, agent) {
    const res = await fetch(`/api/channels/${encodeURIComponent(channel)}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || t("saveFailed"));
    }
  }
  async function removeMember(channel, agent) {
    const res = await fetch(
      `/api/channels/${encodeURIComponent(channel)}/members/${encodeURIComponent(agent)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || t("saveFailed"));
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
      masterBar.classList.add("hidden");
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
    renderMasterBar(c);
    scrollMessagesToBottom();
  }
  function scrollMessagesToBottom() {
    const s = document.getElementById("msg-scroll");
    s.scrollTop = s.scrollHeight;
  }

  /* ---------- master: LLM-mediated supervisor presence ---------- */
  let masterConvId = null;
  function renderMasterBar(c) {
    if (!c || c.status !== "open") { masterBar.classList.add("hidden"); return; }
    masterBar.classList.remove("hidden");
    // Rebuild the target dropdown (All + each agent member), preserving selection.
    const prev = masterTarget.value;
    const members = (channels.get(c.channel)?.members || []).filter((m) => m !== "master");
    masterTarget.innerHTML =
      `<option value="">${escapeHtml(t("masterAll"))}</option>` +
      members.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    if ([...masterTarget.options].some((o) => o.value === prev)) masterTarget.value = prev;
    // Reset the transient UI only when the conversation actually changed.
    if (masterConvId !== c.id) {
      masterConvId = c.id;
      masterInput.value = "";
      masterMsg.textContent = "";
      masterPreview.classList.add("hidden");
      masterAnalysis.classList.add("hidden");
    }
  }
  async function masterAct(mode) {
    if (!selectedConv) return;
    const instruction = masterInput.value.trim();
    if (!instruction) { masterMsg.textContent = t("masterEmpty"); return; }
    masterMsg.textContent = t("masterThinking");
    masterPreview.classList.add("hidden");
    masterAnalysis.classList.add("hidden");
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/master`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          instruction,
          verbatim: document.getElementById("master-verbatim").checked,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { masterMsg.textContent = b.error || t("saveFailed"); return; }
      masterMsg.textContent = "";
      if (mode === "compose") {
        masterDraft.value = b.text || "";
        masterPreview.classList.remove("hidden");
      } else {
        masterAnalysis.textContent = b.text || "";
        masterAnalysis.classList.remove("hidden");
      }
    } catch (e) {
      masterMsg.textContent = e.message;
    }
  }
  document.getElementById("master-compose").onclick = () => masterAct("compose");
  document.getElementById("master-analyze").onclick = () => masterAct("analyze");
  // Code review via git diff (relay-side): only on explicit request. Shows the
  // LLM's review for the supervisor in the analysis pane.
  document.getElementById("master-review").onclick = async () => {
    if (!selectedConv) return;
    const dir = masterDir.value.trim();
    if (!dir) { masterMsg.textContent = t("masterDirEmpty"); return; }
    masterMsg.textContent = t("masterReviewing");
    masterPreview.classList.add("hidden");
    masterAnalysis.classList.add("hidden");
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/master/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { masterMsg.textContent = b.error || t("saveFailed"); return; }
      masterMsg.textContent = b.truncated ? t("masterReviewTruncated") : "";
      masterAnalysis.textContent = b.review || "";
      masterAnalysis.classList.remove("hidden");
    } catch (e) { masterMsg.textContent = e.message; }
  };
  // Delegate the review to the agent itself (e.g. back): ask it to check its own
  // code quality + security (using its supervision subagent if it has one). Builds
  // the instruction and runs compose → preview → you confirm & send.
  document.getElementById("master-delegate").onclick = () => {
    const target = masterTarget.value;
    masterInput.value = target ? t("masterDelegateOne", { target }) : t("masterDelegateAll");
    masterAct("compose");
  };
  document.getElementById("master-cancel").onclick = () => masterPreview.classList.add("hidden");
  document.getElementById("master-send").onclick = async () => {
    if (!selectedConv) return;
    const content = masterDraft.value.trim();
    if (!content) return;
    masterMsg.textContent = t("masterSending");
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConv)}/master/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, to: masterTarget.value || null }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { masterMsg.textContent = b.error || t("saveFailed"); return; }
    masterMsg.textContent = "";
    masterInput.value = "";
    masterDraft.value = "";
    masterPreview.classList.add("hidden");
    // the message.delivered broadcast renders the master message in the feed
  };

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
    // The llm option lives in the Settings view now; refresh it if it's open.
    if (overlayMode === "settings") refreshSettings();
  }

  function handle(e) {
    switch (e.type) {
      case "hello":
        if (e.mode) setCurrentMode(e.mode);
        setReviewerAvailable(Boolean(e.reviewer?.available));
        bootstrap();
        break;
      case "agent.registered":
        agents.set(e.agent.name, e.agent);
        renderAgents();
        if (selectedChannel) renderConversationsPane(); // refresh the add-agent candidates
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
        if (e.mode) setCurrentMode(e.mode);
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
      case "reviewer.updated":
        setReviewerAvailable(Boolean(e.reviewer?.available));
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
    if (approvalRes.mode) setCurrentMode(approvalRes.mode);
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
      setCurrentMode(approval.mode);
      return false;
    }
    setCurrentMode(mode);
    return true;
  }

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
      setCurrentMode(wiz.mode);
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

  /* Settings → LLM provider section. `cfg` is the /api/reviewer payload
   *  (providers map, current selection, which keys are set, live availability). */
  function reviewerProviderSectionHtml(cfg) {
    if (!cfg) return "";
    const providers = cfg.providers || {};
    const sel = cfg.selected || { provider: "auto", model: "", baseUrl: "" };
    const opts = [`<option value="auto" ${sel.provider === "auto" ? "selected" : ""}>${escapeHtml(t("providerAuto"))}</option>`]
      .concat(Object.entries(providers).map(([id, meta]) =>
        `<option value="${escapeHtml(id)}" ${sel.provider === id ? "selected" : ""}>${escapeHtml(meta.label || id)}</option>`
      )).join("");
    const status = cfg.available
      ? t("reviewerActive", { backend: cfg.backend || cfg.provider || "", model: cfg.model ? ` · ${cfg.model}` : "" })
      : t("reviewerInactive");
    return `<div class="settings-section">
        <h3>${escapeHtml(t("llmProvider"))}</h3>
        <p class="sub">${escapeHtml(t("llmProviderDesc"))}</p>
        <div class="field">
          <label>${escapeHtml(t("provider"))}</label>
          <select id="set-rv-provider">${opts}</select>
        </div>
        <div class="field" id="set-rv-baseurl-wrap">
          <label>${escapeHtml(t("baseUrl"))}</label>
          <input type="text" id="set-rv-baseurl" value="${escapeHtml(sel.baseUrl || "")}" placeholder="http://127.0.0.1:11434" />
        </div>
        <div class="field" id="set-rv-key-wrap">
          <label>${escapeHtml(t("apiKey"))}</label>
          <div class="input-row">
            <input type="password" id="set-rv-key" autocomplete="off" placeholder="${escapeHtml(t("apiKeyPlaceholder"))}" />
            <button id="set-rv-connect" type="button" class="btn btn-primary">${escapeHtml(t("connect"))}</button>
          </div>
          <div class="field-error" id="set-rv-key-msg"></div>
        </div>
        <div class="field-ok" id="set-rv-connected-wrap">
          <span id="set-rv-connected-text"></span>
          <button id="set-rv-changekey" type="button" class="underline text-xs text-slate-500 dark:text-slate-400 ml-1">${escapeHtml(t("changeKey"))}</button>
        </div>
        <div class="field">
          <label>${escapeHtml(t("model"))}</label>
          <div class="input-row">
            <select id="set-rv-model-list">
              <option value="">${escapeHtml(t("modelsPick"))}</option>
            </select>
            <button id="set-rv-model-fetch" type="button" class="btn btn-icon" title="${escapeHtml(t("refreshModels"))}">↻</button>
          </div>
          <input type="text" id="set-rv-model" style="margin-top:8px" value="${escapeHtml(sel.model || "")}" placeholder="${escapeHtml(t("modelsPick"))}" />
          <div class="field-ok" id="set-rv-model-msg"></div>
        </div>
        <div class="field-ok" id="set-rv-status">${escapeHtml(status)}</div>
        <button class="btn btn-primary" id="set-rv-save" type="button">${escapeHtml(t("saveProvider"))}</button>
        <div class="field-ok" id="set-rv-msg"></div>
      </div>`;
  }

  function wireReviewerProviderSection(cfg) {
    const providerSel = overlay.querySelector("#set-rv-provider");
    if (!providerSel || !cfg) return;
    const providers = cfg.providers || {};
    const keysSet = cfg.keysSet || {};
    const cliAvailable = cfg.cliAvailable || {};
    const modelInput = overlay.querySelector("#set-rv-model");
    const modelList = overlay.querySelector("#set-rv-model-list");
    const modelMsg = overlay.querySelector("#set-rv-model-msg");
    const baseUrlWrap = overlay.querySelector("#set-rv-baseurl-wrap");
    const keyWrap = overlay.querySelector("#set-rv-key-wrap");
    const keyInput = overlay.querySelector("#set-rv-key");
    const keyMsg = overlay.querySelector("#set-rv-key-msg");
    const connectedWrap = overlay.querySelector("#set-rv-connected-wrap");
    const connectedText = overlay.querySelector("#set-rv-connected-text");
    let forceKey = false; // user clicked "change key" → re-reveal the input

    // For "auto", the server resolved a concrete backend (cfg.provider).
    const resolvedProvider = (p) => (p === "auto" ? cfg.provider || null : p);
    function isConnected(p) {
      const meta = providers[p];
      if (p === "auto") return Boolean(cfg.available);
      if (meta?.needsKey) return Boolean(keysSet[p]);
      if (p === "claude-cli" || p === "opencode") return Boolean(cliAvailable[p]);
      if (p === "ollama") return true; // assume reachable; the fetch reveals the truth
      return Boolean(cfg.available);
    }

    async function fetchModels(p) {
      if (!p) { modelMsg.textContent = ""; return; }
      modelMsg.textContent = t("loadingModels");
      try {
        const r = await fetch(`/api/reviewer/models?provider=${encodeURIComponent(p)}`);
        const b = await r.json().catch(() => ({}));
        modelList.innerHTML = `<option value="">${escapeHtml(t("modelsPick"))}</option>`;
        if (!r.ok || !Array.isArray(b.models) || !b.models.length) {
          modelMsg.textContent = b.error ? t("modelsError", { err: b.error }) : t("modelsNone");
          return;
        }
        for (const m of b.models) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          if (m === modelInput.value) o.selected = true;
          modelList.appendChild(o);
        }
        modelMsg.textContent = "";
      } catch (e) {
        modelMsg.textContent = t("modelsError", { err: e.message });
      }
    }

    function syncFields() {
      const p = providerSel.value;
      const meta = providers[p];
      const needsKey = Boolean(meta?.needsKey);
      const connected = isConnected(p);
      const def = meta?.defaultModel;
      modelInput.placeholder = def ? t("modelDefault", { model: def }) : "";
      baseUrlWrap.style.display = p === "ollama" ? "" : "none";

      // Key input (when a key is needed and we're not connected yet, or the user
      // chose to change it) vs the "Connected ✓" indicator.
      const showKey = needsKey && (!connected || forceKey);
      keyWrap.style.display = showKey ? "" : "none";
      connectedWrap.style.display = needsKey && connected && !forceKey ? "" : "none";
      if (needsKey && connected) connectedText.textContent = t("connected");
      keyMsg.textContent = "";
      keyInput.value = "";

      // Model list: load once connected. CLI backends (claude-cli/opencode) list
      // when installed; keyed providers list once their key is saved.
      modelList.innerHTML = `<option value="">${escapeHtml(t("modelsPick"))}</option>`;
      modelList.disabled = needsKey && !connected;
      const rp = resolvedProvider(p);
      if (needsKey && !connected) {
        modelMsg.textContent = t("modelsNeedConnect");
      } else if ((rp === "claude-cli" || rp === "opencode") && cliAvailable[rp] === false) {
        modelMsg.textContent = t("cliMissing");
      } else if (!rp) {
        modelMsg.textContent = "";
      } else {
        fetchModels(rp); // claude-cli / opencode / ollama / connected keyed / auto→resolved
      }
    }
    syncFields();
    providerSel.onchange = () => { forceKey = false; syncFields(); };

    overlay.querySelector("#set-rv-model-fetch").onclick = () => {
      const rp = resolvedProvider(providerSel.value);
      if (rp) fetchModels(rp);
    };
    modelList.onchange = () => { if (modelList.value) modelInput.value = modelList.value; };
    overlay.querySelector("#set-rv-changekey").onclick = () => {
      forceKey = true;
      syncFields();
      keyInput.focus();
    };

    // Connect: save the key, then re-render — keysSet flips on, the key hides,
    // and the model list auto-loads (the server now resolves the saved key).
    overlay.querySelector("#set-rv-connect").onclick = async () => {
      const p = providerSel.value;
      const key = keyInput.value.trim();
      if (!key) { keyMsg.textContent = t("apiKeyEmpty"); return; }
      keyMsg.textContent = t("connecting");
      const res = await fetch("/api/reviewer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: p, keys: { [p]: key } }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        keyMsg.textContent = e.error || t("saveFailed");
        return;
      }
      const updated = await res.json();
      setReviewerAvailable(Boolean(updated.available));
      forceKey = false;
      refreshSettings();
    };

    overlay.querySelector("#set-rv-save").onclick = async () => {
      const provider = providerSel.value;
      const meta = providers[provider];
      const body = {
        provider,
        model: modelInput.value.trim(),
        baseUrl: overlay.querySelector("#set-rv-baseurl").value.trim(),
      };
      if (meta?.needsKey && keyInput.value.trim()) body.keys = { [provider]: keyInput.value.trim() };
      const msg = overlay.querySelector("#set-rv-msg");
      msg.textContent = t("saving");
      const res = await fetch("/api/reviewer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        msg.textContent = e.error || t("saveFailed");
        return;
      }
      const updated = await res.json();
      setReviewerAvailable(Boolean(updated.available));
      msg.textContent = t("saved");
      refreshSettings();
    };
  }

  let settingsSection = "language"; // remembered across re-renders
  async function refreshSettings() {
    const [data, reviewerCfg] = await Promise.all([
      fetch("/api/setup").then((r) => r.json()),
      fetch("/api/reviewer").then((r) => r.json()).catch(() => null),
    ]);
    renderSettings(data, reviewerCfg);
  }
  function renderSettings(data, reviewerCfg) {
    const contracts = data.contracts || [];
    const policy = data.policy || "";
    currentMode = data.mode || "manual";

    const SECTIONS = [
      ["language", t("lang.label")],
      ["theme", t("theme.label")],
      ["supervision", t("supervisionMode")],
      ["provider", t("llmProvider")],
      ["policy", t("reviewerPolicy")],
      ["contracts", t("contracts")],
    ];
    if (!SECTIONS.some(([id]) => id === settingsSection)) settingsSection = "language";
    const navHtml = SECTIONS.map(([id, label]) =>
      `<button type="button" data-section="${id}">${escapeHtml(label)}</button>`
    ).join("");

    showOverlay(`<div class="panel settings-panel">
      <div class="row-between">
        <h2>${escapeHtml(t("settings.title"))}</h2>
        <button class="btn" id="set-close" type="button">${escapeHtml(t("close"))}</button>
      </div>
      <p class="sub">${escapeHtml(t("settingsSavedTo", { dir: data.configDir || "~/.switchboard" }))}</p>
      <div class="settings-layout">
        <nav id="set-nav" class="settings-nav">${navHtml}</nav>
        <div id="set-content" class="settings-content"></div>
      </div>
    </div>`, "settings");

    overlay.querySelector("#set-close").onclick = closeOverlay;
    overlay.querySelectorAll("[data-section]").forEach((b) => {
      b.onclick = () => { settingsSection = b.dataset.section; renderSection(); };
    });
    renderSection();

    function renderSection() {
      overlay.querySelectorAll("[data-section]").forEach((b) =>
        b.classList.toggle("active", b.dataset.section === settingsSection));
      overlay.querySelector("#set-content").innerHTML = sectionHtml(settingsSection);
      wireSection(settingsSection);
    }

    function sectionHtml(id) {
      if (id === "language") {
        const lang = window.SBI18n.getLang();
        return `<div class="settings-section"><h3>${escapeHtml(t("lang.label"))}</h3>
          <div class="field"><select id="set-lang">
            <option value="es" ${lang === "es" ? "selected" : ""}>Español</option>
            <option value="en" ${lang === "en" ? "selected" : ""}>English</option>
          </select></div></div>`;
      }
      if (id === "theme") {
        const th = getThemePref();
        return `<div class="settings-section"><h3>${escapeHtml(t("theme.label"))}</h3>
          <div class="field"><select id="set-theme">
            <option value="light" ${th === "light" ? "selected" : ""}>${escapeHtml(t("theme.light"))}</option>
            <option value="dark" ${th === "dark" ? "selected" : ""}>${escapeHtml(t("theme.dark"))}</option>
            <option value="auto" ${th === "auto" ? "selected" : ""}>${escapeHtml(t("theme.auto"))}</option>
          </select></div></div>`;
      }
      if (id === "supervision") {
        const modeSel = ["manual", "auto", "llm"].map((m) =>
          `<option value="${m}" ${m === currentMode ? "selected" : ""} ${m === "llm" && !reviewerAvailable ? "disabled" : ""}>${m}</option>`
        ).join("");
        return `<div class="settings-section"><h3>${escapeHtml(t("supervisionMode"))}</h3>
          <div class="field"><select id="set-mode">${modeSel}</select>
          <div class="hint">${escapeHtml(t("mode." + currentMode))}</div></div></div>`;
      }
      if (id === "provider") return reviewerProviderSectionHtml(reviewerCfg);
      if (id === "policy") {
        return `<div class="settings-section"><h3>${escapeHtml(t("reviewerPolicy"))}</h3>
          <div class="field">
            <textarea id="set-policy" rows="14">${escapeHtml(policy)}</textarea>
            <div class="field-ok" id="set-policy-msg"></div>
          </div>
          <button class="btn btn-primary" id="set-policy-save" type="button">${escapeHtml(t("savePolicy"))}</button></div>`;
      }
      if (id === "contracts") {
        return `<div class="settings-section"><h3>${escapeHtml(t("contracts"))}</h3>
          ${renderContractListHtml(contracts, "settings")}
          <div class="field">
            <label>${escapeHtml(t("addUpdateContract"))}</label>
            <input type="text" id="set-cname" placeholder="${escapeHtml(t("wizContractName"))}" />
            <textarea id="set-cschema" rows="8" placeholder='{"type":"object", ...}'></textarea>
            <div class="field-error" id="set-cerr"></div>
            <button class="btn btn-primary" id="set-csave" type="button">${escapeHtml(t("saveContract"))}</button>
          </div></div>`;
      }
      return "";
    }

    function wireSection(id) {
      if (id === "language") {
        overlay.querySelector("#set-lang").onchange = (e) => setLanguage(e.target.value);
      } else if (id === "theme") {
        overlay.querySelector("#set-theme").onchange = (e) => setTheme(e.target.value);
      } else if (id === "supervision") {
        overlay.querySelector("#set-mode").onchange = (e) => changeMode(e.target.value);
      } else if (id === "provider") {
        wireReviewerProviderSection(reviewerCfg);
      } else if (id === "policy") {
        overlay.querySelector("#set-policy-save").onclick = async () => {
          const text = overlay.querySelector("#set-policy").value;
          const res = await fetch("/api/policy", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ policy: text }),
          });
          overlay.querySelector("#set-policy-msg").textContent = res.ok ? t("saved") : t("saveFailed");
        };
      } else if (id === "contracts") {
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
    }
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
  function setTheme(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
  }

  /* ---------- collapsible side panels (persist in localStorage) ---------- */
  function wirePanelToggle(btnId, colId, key) {
    const btn = document.getElementById(btnId);
    const col = document.getElementById(colId);
    if (!btn || !col) return;
    const apply = () => {
      const hidden = localStorage.getItem(key) === "hidden";
      col.classList.toggle("hidden", hidden);
      btn.classList.toggle("text-blue-600", !hidden);
      btn.classList.toggle("border-blue-500", !hidden);
    };
    btn.addEventListener("click", () => {
      const next = localStorage.getItem(key) === "hidden" ? "shown" : "hidden";
      localStorage.setItem(key, next);
      apply();
    });
    apply();
  }
  wirePanelToggle("toggle-conv", "col-conversations", "sb.panel.conv");
  wirePanelToggle("toggle-channels", "col-channels", "sb.panel.channels");

  /* Collapsible sections (header button with data-collapse → body id). Collapsed
   *  by default; the caret rotates when open. State persists per section. */
  function wireCollapsibles() {
    document.querySelectorAll("[data-collapse]").forEach((btn) => {
      const body = document.getElementById(btn.dataset.collapse);
      if (!body) return;
      const caret = btn.querySelector(".collapse-caret");
      const key = "sb.collapse." + btn.dataset.collapse;
      const setOpen = (open) => {
        body.classList.toggle("hidden", !open);
        if (caret) caret.textContent = open ? "▴" : "▾";
      };
      setOpen(localStorage.getItem(key) === "open"); // default collapsed
      btn.addEventListener("click", () => {
        const open = body.classList.contains("hidden"); // about to open
        localStorage.setItem(key, open ? "open" : "closed");
        setOpen(open);
      });
    });
  }
  wireCollapsibles();

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
  function setLanguage(lang) {
    window.SBI18n.setLang(lang);
    persistLocale(lang);
    rerenderAll();
  }
  // Mirror the UI language to the relay so the LLM reviewer writes its reasons in
  // the same language ("el idioma configurado en el sistema"). Best-effort.
  function persistLocale(lang) {
    fetch("/api/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: lang }),
    }).catch(() => {});
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
      // Sync the relay's reviewer language with the UI's current language if it drifted.
      if ((setup.locale ?? null) !== window.SBI18n.getLang()) persistLocale(window.SBI18n.getLang());
      if (setup.needed) openWizard(setup);
    } catch {
      /* relay not reachable yet; WS reconnect will catch up */
    }
    connect();
  }
  init();
})();
