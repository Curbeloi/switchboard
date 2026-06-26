/* i18n for the switchboard supervision UI — plain global (no modules), loaded
 * before app.js. Exposes window.SBI18n. Preference persists in localStorage. */
(() => {
  const LS_KEY = "sb.lang";

  const dict = {
    en: {
      // header
      "app.title": "switchboard",
      "mode.label": "Mode",
      "settings": "⚙ Settings",
      "settings.title": "Settings",
      "theme.label": "Theme",
      "theme.light": "light",
      "theme.dark": "dark",
      "theme.auto": "auto",
      "lang.label": "Language",
      // connection status
      "status.connecting": "connecting…",
      "status.connected": "connected",
      "status.disconnected": "disconnected — retrying in 2s",
      "status.error": "error",
      // col 1: channels + agents
      "channels": "Channels",
      "agents": "Agents",
      "noChannels": "no channels yet",
      "noAgents": "no agents yet",
      "newChannel": "new channel…",
      "createChannel": "create channel",
      "deleteChannel": "delete channel",
      // col 2: conversations
      "selectChannel": "select a channel",
      "members": "members: {list}",
      "membersNone": "(none)",
      "membersInline": "members:",
      "addToChannel": "add agent to channel",
      "removeFromChannel": "remove from channel",
      "addAgentOption": "add agent…",
      "noConversations": "no conversations yet — open one above",
      "open": "Open",
      "closed": "Closed",
      "newConvTitle": "new conversation title…",
      "newConvPurpose": "purpose (optional)",
      "noContract": "no contract",
      "openConversation": "+ Open conversation",
      // col 3: messages + state doc
      "selectConversation": "Select a conversation",
      "pendingApproval": "Pending approval",
      "stateDoc": "state doc",
      "hideStateDoc": "hide state doc",
      "stateDocTitle": "State doc (PROGRESS.md)",
      "closeConv": "close conv",
      "approve": "approve",
      "reject": "reject",
      "emptyHint": "Pick a channel on the left, then a conversation in the middle.",
      "noMessages": "no messages in this conversation yet",
      "convStatusOpen": "open",
      "convStatusClosed": "closed",
      "save": "Save",
      "saving": "saving…",
      "saved": "saved ✓",
      "saveFailed": "save failed",
      "stateEmpty": "empty",
      "stateLoadFailed": "(failed to load)",
      "stateUpdated": "last updated {time} by {by}",
      "reviewer": "reviewer: {decision} — {reason}",
      "contractLabel": "contract: {name}",
      // prompts / alerts / confirm
      "outcomePrompt": "Outcome (optional):",
      "deleteChannelConfirm": "Delete channel \"{name}\"? Its conversations, messages, and state docs are lost.",
      "deleteContractConfirm": "Delete contract \"{name}\"?",
      "couldNotClose": "could not close",
      "couldNotCreateConv": "could not create conversation",
      "couldNotCreateChannel": "could not create channel",
      "couldNotDeleteChannel": "could not delete channel",
      "couldNotChangeMode": "could not change mode",
      "setupFailed": "setup failed",
      // wizard + settings
      "wizWelcome": "Welcome to switchboard",
      "wizIntro": "Let's set up supervision, the reviewer policy, and any shared contracts. These are saved to disk and reused on every restart.",
      "wizStep1": "1 · Supervision mode",
      "wizStep2": "2 · Reviewer policy",
      "wizStep3": "3 · Contracts",
      "wizOptional": "(optional)",
      "wizPolicyLabel": "Policy / rubric (used only in llm mode)",
      "wizPolicyHint": "The LLM reviewer judges each message against this. Leave the default if unsure.",
      "wizAddContract": "Add a contract",
      "wizContractName": "name, e.g. revenue.v1",
      "wizAddContractBtn": "+ Add contract",
      "back": "Back",
      "next": "Next",
      "finishSetup": "Finish setup",
      "close": "Close",
      "settingsSavedTo": "Saved to {dir} and applied live.",
      "supervisionMode": "Supervision mode",
      "reviewerPolicy": "Reviewer policy",
      "savePolicy": "Save policy",
      "contracts": "Contracts",
      "addUpdateContract": "Add / update a contract",
      "saveContract": "Save contract",
      "edit": "edit",
      "remove": "remove",
      "noContractsYet": "No contracts yet — agents can still send inline schemas.",
      "noContractsInline": "No contracts yet — agents can still send inline schemas.",
      "contractAlreadyAdded": "\"{name}\" already added",
      "invalidName": "invalid name (A-Z a-z 0-9 . _ -, max 64)",
      "schemaEmpty": "schema is empty",
      "noReviewerNote": " (no reviewer — pick a provider below, or set ANTHROPIC_API_KEY / install the claude CLI)",
      "llmProvider": "LLM provider",
      "llmProviderDesc": "Which LLM reviews messages in llm mode. Applied live — no restart.",
      "provider": "Provider",
      "providerAuto": "auto (Anthropic key or Claude CLI)",
      "model": "Model",
      "modelDefault": "default: {model}",
      "modelsPick": "— pick a model —",
      "modelsNone": "no models found",
      "modelsError": "couldn't list models: {err}",
      "modelsNeedKey": "save the API key first to list models",
      "loadingModels": "loading models…",
      "refreshModels": "list available models",
      "cliInstalled": "CLI installed ✓",
      "cliMissing": "CLI not installed",
      "baseUrl": "Base URL",
      "apiKey": "API key",
      "apiKeyKeep": "blank = keep current key",
      "apiKeySet": "key set ✓",
      "apiKeyNotSet": "no key yet",
      "saveProvider": "Save provider",
      "reviewerActive": "Active: {backend}{model}",
      "reviewerInactive": "No reviewer active — pick a provider that has a key (or the Claude CLI / Ollama).",
      "masterAll": "All",
      "masterVerbatim": "verbatim",
      "masterPlaceholder": "instruction for master… (e.g. tell back to wait for front's API, or: analyze whether this conversation is effective)",
      "masterCompose": "Compose…",
      "masterAnalyze": "Analyze",
      "masterPreview": "Preview — edit before sending",
      "masterSend": "Confirm & send",
      "masterCancel": "Cancel",
      "masterEmpty": "type an instruction first",
      "masterThinking": "master is thinking…",
      "masterSending": "sending…",
      "mode.manual": "Every message waits for your approval. No LLM, zero tokens.",
      "mode.auto": "Deliver everything immediately, no supervision. No LLM, zero tokens.",
      "mode.llm": "An LLM reviewer approves routine messages, blocks bad ones, and escalates risky ones to you.",
    },
    es: {
      // header
      "app.title": "switchboard",
      "mode.label": "Modo",
      "settings": "⚙ Ajustes",
      "settings.title": "Ajustes",
      "theme.label": "Tema",
      "theme.light": "claro",
      "theme.dark": "oscuro",
      "theme.auto": "auto",
      "lang.label": "Idioma",
      // connection status
      "status.connecting": "conectando…",
      "status.connected": "conectado",
      "status.disconnected": "desconectado — reintentando en 2s",
      "status.error": "error",
      // col 1: channels + agents
      "channels": "Canales",
      "agents": "Agentes",
      "noChannels": "aún no hay canales",
      "noAgents": "aún no hay agentes",
      "newChannel": "nuevo canal…",
      "createChannel": "crear canal",
      "deleteChannel": "eliminar canal",
      // col 2: conversations
      "selectChannel": "elige un canal",
      "members": "miembros: {list}",
      "membersNone": "(ninguno)",
      "membersInline": "miembros:",
      "addToChannel": "agregar agente al canal",
      "removeFromChannel": "quitar del canal",
      "addAgentOption": "agregar agente…",
      "noConversations": "aún no hay conversaciones — abre una arriba",
      "open": "Abiertas",
      "closed": "Cerradas",
      "newConvTitle": "título de la conversación…",
      "newConvPurpose": "propósito (opcional)",
      "noContract": "sin contrato",
      "openConversation": "+ Abrir conversación",
      // col 3: messages + state doc
      "selectConversation": "Elige una conversación",
      "pendingApproval": "Pendientes de aprobación",
      "stateDoc": "doc de estado",
      "hideStateDoc": "ocultar doc de estado",
      "stateDocTitle": "Doc de estado (PROGRESS.md)",
      "closeConv": "cerrar conv",
      "approve": "aprobar",
      "reject": "rechazar",
      "emptyHint": "Elige un canal a la izquierda, luego una conversación en el medio.",
      "noMessages": "aún no hay mensajes en esta conversación",
      "convStatusOpen": "abierta",
      "convStatusClosed": "cerrada",
      "save": "Guardar",
      "saving": "guardando…",
      "saved": "guardado ✓",
      "saveFailed": "falló al guardar",
      "stateEmpty": "vacío",
      "stateLoadFailed": "(falló la carga)",
      "stateUpdated": "última actualización {time} por {by}",
      "reviewer": "revisor: {decision} — {reason}",
      "contractLabel": "contrato: {name}",
      // prompts / alerts / confirm
      "outcomePrompt": "Resultado (opcional):",
      "deleteChannelConfirm": "¿Eliminar el canal \"{name}\"? Se pierden sus conversaciones, mensajes y docs de estado.",
      "deleteContractConfirm": "¿Eliminar el contrato \"{name}\"?",
      "couldNotClose": "no se pudo cerrar",
      "couldNotCreateConv": "no se pudo crear la conversación",
      "couldNotCreateChannel": "no se pudo crear el canal",
      "couldNotDeleteChannel": "no se pudo eliminar el canal",
      "couldNotChangeMode": "no se pudo cambiar el modo",
      "setupFailed": "falló la configuración",
      // wizard + settings
      "wizWelcome": "Bienvenido a switchboard",
      "wizIntro": "Configuremos la supervisión, la política del revisor y los contratos compartidos. Se guardan en disco y se reutilizan en cada reinicio.",
      "wizStep1": "1 · Modo de supervisión",
      "wizStep2": "2 · Política del revisor",
      "wizStep3": "3 · Contratos",
      "wizOptional": "(opcional)",
      "wizPolicyLabel": "Política / rúbrica (solo se usa en modo llm)",
      "wizPolicyHint": "El revisor LLM juzga cada mensaje contra esto. Deja el valor por defecto si no estás seguro.",
      "wizAddContract": "Agregar un contrato",
      "wizContractName": "nombre, ej. revenue.v1",
      "wizAddContractBtn": "+ Agregar contrato",
      "back": "Atrás",
      "next": "Siguiente",
      "finishSetup": "Finalizar configuración",
      "close": "Cerrar",
      "settingsSavedTo": "Guardado en {dir} y aplicado en vivo.",
      "supervisionMode": "Modo de supervisión",
      "reviewerPolicy": "Política del revisor",
      "savePolicy": "Guardar política",
      "contracts": "Contratos",
      "addUpdateContract": "Agregar / actualizar un contrato",
      "saveContract": "Guardar contrato",
      "edit": "editar",
      "remove": "quitar",
      "noContractsYet": "Aún no hay contratos — los agentes pueden enviar esquemas en línea.",
      "noContractsInline": "Aún no hay contratos — los agentes pueden enviar esquemas en línea.",
      "contractAlreadyAdded": "\"{name}\" ya fue agregado",
      "invalidName": "nombre inválido (A-Z a-z 0-9 . _ -, máx 64)",
      "schemaEmpty": "el esquema está vacío",
      "noReviewerNote": " (sin revisor — elige un proveedor abajo, o define ANTHROPIC_API_KEY / instala el CLI claude)",
      "llmProvider": "Proveedor LLM",
      "llmProviderDesc": "Qué LLM revisa los mensajes en modo llm. Se aplica en vivo — sin reinicio.",
      "provider": "Proveedor",
      "providerAuto": "auto (clave Anthropic o CLI de Claude)",
      "model": "Modelo",
      "modelDefault": "por defecto: {model}",
      "modelsPick": "— elige un modelo —",
      "modelsNone": "no se encontraron modelos",
      "modelsError": "no se pudieron listar: {err}",
      "modelsNeedKey": "guarda la API key primero para listar modelos",
      "loadingModels": "cargando modelos…",
      "refreshModels": "listar modelos disponibles",
      "cliInstalled": "CLI instalado ✓",
      "cliMissing": "CLI no instalado",
      "baseUrl": "URL base",
      "apiKey": "Clave API",
      "apiKeyKeep": "vacío = mantener la clave actual",
      "apiKeySet": "clave configurada ✓",
      "apiKeyNotSet": "sin clave aún",
      "saveProvider": "Guardar proveedor",
      "reviewerActive": "Activo: {backend}{model}",
      "reviewerInactive": "Sin revisor activo — elige un proveedor con clave (o el CLI de Claude / Ollama).",
      "masterAll": "Todos",
      "masterVerbatim": "literal",
      "masterPlaceholder": "instrucción para master… (ej. dile a back que espere la API de front, o: analiza si esta conversación es efectiva)",
      "masterCompose": "Redactar…",
      "masterAnalyze": "Analizar",
      "masterPreview": "Vista previa — edita antes de enviar",
      "masterSend": "Confirmar y enviar",
      "masterCancel": "Cancelar",
      "masterEmpty": "escribe una instrucción primero",
      "masterThinking": "master está pensando…",
      "masterSending": "enviando…",
      "mode.manual": "Cada mensaje espera tu aprobación. Sin LLM, cero tokens.",
      "mode.auto": "Entrega todo de inmediato, sin supervisión. Sin LLM, cero tokens.",
      "mode.llm": "Un revisor LLM aprueba los mensajes de rutina, bloquea los malos y te escala los riesgosos.",
    },
  };

  function detectLang() {
    const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.startsWith("es") ? "es" : "en";
  }

  let current = (() => {
    const saved = localStorage.getItem(LS_KEY);
    return saved && dict[saved] ? saved : detectLang();
  })();

  function getLang() {
    return current;
  }
  function setLang(lang) {
    if (!dict[lang]) return;
    current = lang;
    localStorage.setItem(LS_KEY, lang);
    document.documentElement.lang = lang;
  }
  function t(key, vars) {
    let s = (dict[current] && dict[current][key]) ?? dict.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replaceAll("{" + k + "}", String(v));
      }
    }
    return s;
  }
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
  }

  document.documentElement.lang = current;
  window.SBI18n = { getLang, setLang, t, apply, langs: Object.keys(dict) };
})();
