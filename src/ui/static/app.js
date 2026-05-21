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
  const overlay = document.getElementById("overlay");
  const settingsBtn = document.getElementById("settings-btn");

  let reviewerAvailable = false;
  let defaultPolicy = "";
  let overlayMode = null; // "wizard" | "settings" | null

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
    const contractName = m.contract
      ? `<div class="contract-name">contract: ${escapeHtml(m.contract)}</div>`
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
      ${contractName}
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
      case "setup.updated":
        if (e.needed === false && overlayMode === "wizard") closeOverlay();
        break;
      case "contracts.updated":
      case "policy.updated":
        if (overlayMode === "settings") refreshSettings();
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

  async function changeMode(mode) {
    const res = await fetch("/api/approval/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "could not change mode");
      const approval = await fetch("/api/approval").then((r) => r.json());
      modeSelect.value = approval.mode;
      return false;
    }
    modeSelect.value = mode;
    return true;
  }

  modeSelect.addEventListener("change", () => changeMode(modeSelect.value));

  /* ---------- overlay (setup wizard + settings) ---------- */

  const MODE_INFO = {
    manual: "Every message waits for your approval. No LLM, zero tokens.",
    auto: "Deliver everything immediately, no supervision. No LLM, zero tokens.",
    llm: "An LLM reviewer approves routine messages, blocks bad ones, and escalates risky ones to you.",
  };
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

  /** Parse + sanity-check a JSON Schema typed into a textarea. */
  function parseSchema(text) {
    const t = (text || "").trim();
    if (!t) return { error: "schema is empty" };
    let v;
    try { v = JSON.parse(t); } catch (e) { return { error: "invalid JSON: " + e.message }; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: "schema must be a JSON object" };
    }
    return { schema: v };
  }

  function modeOptionsHtml(selected) {
    return ["manual", "auto", "llm"].map((m) => {
      const disabled = m === "llm" && !reviewerAvailable;
      const cls = "mode-option" + (m === selected ? " selected" : "") + (disabled ? " disabled" : "");
      const note = disabled ? " (no reviewer — set ANTHROPIC_API_KEY or install the claude CLI)" : "";
      return `<label class="${cls}" data-mode="${m}">
        <input type="radio" name="wiz-mode" value="${m}" ${m === selected ? "checked" : ""} ${disabled ? "disabled" : ""}/>
        <div>
          <div class="mo-name">${m}${note ? `<span class="mo-desc">${note}</span>` : ""}</div>
          <div class="mo-desc">${MODE_INFO[m]}</div>
        </div>
      </label>`;
    }).join("");
  }

  /* ----- first-run wizard ----- */

  function openWizard(initial) {
    const wiz = {
      step: 1,
      total: 3,
      mode: initial.mode || "manual",
      policy: initial.policy || initial.defaultPolicy || "",
      contracts: (initial.contracts || []).map((c) => ({
        name: c.name,
        schema: c.schema,
      })),
    };
    renderWizard(wiz);
  }

  function renderWizard(wiz) {
    const dots = [1, 2, 3].map((n) =>
      `<div class="step ${n === wiz.step ? "active" : n < wiz.step ? "done" : ""}"></div>`
    ).join("");

    let body = "";
    if (wiz.step === 1) {
      body = `<p class="step-title">1 · Supervision mode</p>
        <div class="mode-options">${modeOptionsHtml(wiz.mode)}</div>`;
    } else if (wiz.step === 2) {
      body = `<p class="step-title">2 · Reviewer policy</p>
        <div class="field">
          <label>Policy / rubric (used only in <code>llm</code> mode)</label>
          <textarea id="wiz-policy" rows="12">${escapeHtml(wiz.policy)}</textarea>
          <div class="hint">The LLM reviewer judges each message against this. Leave the default if unsure.</div>
        </div>`;
    } else {
      body = `<p class="step-title">3 · Contracts <span class="mo-desc">(optional)</span></p>
        ${renderContractListHtml(wiz.contracts, "wiz")}
        <div class="field">
          <label>Add a contract</label>
          <input type="text" id="wiz-cname" placeholder="name, e.g. revenue.v1" />
          <textarea id="wiz-cschema" rows="8" placeholder='{"type":"object","properties":{...},"required":[...]}'></textarea>
          <div class="field-error" id="wiz-cerr"></div>
          <button class="btn" id="wiz-cadd" type="button">+ Add contract</button>
        </div>`;
    }

    const back = wiz.step > 1
      ? `<button class="btn" id="wiz-back" type="button">Back</button>`
      : `<span></span>`;
    const next = wiz.step < wiz.total
      ? `<button class="btn btn-primary" id="wiz-next" type="button">Next</button>`
      : `<button class="btn btn-primary" id="wiz-finish" type="button">Finish setup</button>`;

    showOverlay(`<div class="panel">
      <h2>Welcome to switchboard</h2>
      <p class="sub">Let's set up supervision, the reviewer policy, and any shared contracts. These are saved to disk and reused on every restart.</p>
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
      if (!NAME_RE.test(name)) { errEl.textContent = "invalid name (A-Z a-z 0-9 . _ -, max 64)"; return; }
      if (wiz.contracts.some((c) => c.name === name)) { errEl.textContent = `"${name}" already added`; return; }
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
        alert(body.error || "setup failed");
        finish.disabled = false;
        return;
      }
      modeSelect.value = wiz.mode;
      closeOverlay();
    };
  }

  function renderContractListHtml(contracts, scope) {
    if (!contracts.length) return `<p class="empty-note">No contracts yet — agents can still send inline schemas.</p>`;
    return `<ul class="contract-list">${contracts.map((c) => `
      <li><span>${escapeHtml(c.name)}</span>
        <span class="c-actions">
          ${scope === "settings" ? `<button class="btn" data-edit="${escapeHtml(c.name)}" type="button">edit</button>` : ""}
          <button class="btn btn-danger" data-del="${escapeHtml(c.name)}" type="button">remove</button>
        </span></li>`).join("")}</ul>`;
  }

  /* ----- settings (edit) ----- */

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
        <h2>Settings</h2>
        <button class="btn" id="set-close" type="button">Close</button>
      </div>
      <p class="sub">Saved to ${escapeHtml(data.configDir || "~/.switchboard")} and applied live.</p>

      <div class="settings-section">
        <h3>Supervision mode</h3>
        <div class="field"><select id="set-mode">${modeSel}</select></div>
      </div>

      <div class="settings-section">
        <h3>Reviewer policy</h3>
        <div class="field">
          <textarea id="set-policy" rows="10">${escapeHtml(policy)}</textarea>
          <div class="field-ok" id="set-policy-msg"></div>
        </div>
        <button class="btn btn-primary" id="set-policy-save" type="button">Save policy</button>
      </div>

      <div class="settings-section">
        <h3>Contracts</h3>
        ${renderContractListHtml(contracts, "settings")}
        <div class="field">
          <label>Add / update a contract</label>
          <input type="text" id="set-cname" placeholder="name, e.g. revenue.v1" />
          <textarea id="set-cschema" rows="8" placeholder='{"type":"object", ...}'></textarea>
          <div class="field-error" id="set-cerr"></div>
          <button class="btn btn-primary" id="set-csave" type="button">Save contract</button>
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
      msg.textContent = res.ok ? "saved ✓" : "save failed";
    };

    overlay.querySelector("#set-csave").onclick = async () => {
      const name = overlay.querySelector("#set-cname").value.trim();
      const errEl = overlay.querySelector("#set-cerr");
      if (!NAME_RE.test(name)) { errEl.textContent = "invalid name (A-Z a-z 0-9 . _ -, max 64)"; return; }
      const parsed = parseSchema(overlay.querySelector("#set-cschema").value);
      if (parsed.error) { errEl.textContent = parsed.error; return; }
      const res = await fetch(`/api/contracts/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: parsed.schema }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        errEl.textContent = body.error || "save failed";
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
        if (!confirm(`Delete contract "${b.dataset.del}"?`)) return;
        await fetch(`/api/contracts/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
        refreshSettings();
      };
    });
  }

  settingsBtn.addEventListener("click", refreshSettings);

  /* ---------- init ---------- */

  async function init() {
    setStatus("connecting", "connecting…");
    try {
      const setup = await fetch("/api/setup").then((r) => r.json());
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
