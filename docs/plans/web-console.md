# Plan: Consola por agente en la web + vincular agente ↔ proyecto

> Rama: `feat/web-console`. Estado: **plan / análisis** (sin código todavía).
> Objetivo de producto: que switchboard sea **una sola vista** donde defines un
> proyecto, le asignas/levantas un agente (CLI `claude`/`opencode`) y **ves su
> consola y lo que hace** mientras lo orquestas — sin saltar entre el IDE/terminal
> y switchboard.
>
> **Alcance fijado:** terminal **interactivo real** (`xterm.js` + node-pty),
> **todo en la web** por ahora (el shell desktop queda para una fase futura), y
> **solo Claude Code** como motor por ahora (opencode más adelante).

## Contexto

Hoy switchboard supervisa **mensajes** entre agentes que corren fuera (en sus
propias terminales/IDEs). El relay ya es un **servidor web local** (Express +
`ws`) que sirve la UI en `127.0.0.1:8765`. Falta lo que ocurre "donde pasan los
hechos": ver al agente trabajar y poder lanzarlo desde la misma ventana.

Este plan agrega **dos pilares**, ambos en el open source (gancho de adopción):

1. **Consola por agente en la web** — traer la salida (y opcionalmente la
   terminal interactiva) de cada agente a un panel de la UI actual.
2. **Vincular agente ↔ proyecto** — "mover" un agente a un proyecto: dar la ruta
   de un repo existente **o** crear un proyecto nuevo, y levantar ahí el CLI.

No construimos un IDE: reusamos los CLIs como motor; switchboard hospeda, observa
y orquesta.

## Pilar 1 — Consola por agente en la web

### El pipeline (patrón resuelto, igual que VS Code/Gitpod)

```
CLI (claude/opencode) ⇄ PTY/pipe (Node) ⇄ WebSocket ⇄ panel en la UI (browser)
```

- **Servidor:** un *process manager* lanza el CLI y captura su salida.
- **Transporte:** WebSocket (switchboard ya tiene `ws` en el mismo `http.Server`).
- **Cliente:** un panel en la SPA actual, junto a canales/conversaciones/master.

### Modo elegido: terminal real (B), todo web

**Decisión fijada:** terminal **interactivo real** + **todo en la web** por ahora
(sin shell desktop).

- **`xterm.js`** en el navegador (el mismo emulador de VS Code) dentro de un panel
  de la SPA actual.
- **node-pty** en el servidor: lanza el CLI en un **pseudo-terminal** → TUIs,
  colores e **input interactivo** (puedes escribir/responder prompts del CLI desde
  la web).
- **WebSocket** bidireccional: salida del PTY → `xterm` y teclas → PTY.
- node-pty es **módulo nativo**: se incluye vía **prebuilds**
  (`@homebridge/node-pty-prebuilt-multiarch`) para no exigir compilación al
  instalar. (En el futuro shell desktop/Electron node-pty es estándar.)
- El **`git diff` en vivo** del directorio se mantiene como **panel complementario
  opcional** ("ver el código que crea"), no como sustituto del terminal.

## Pilar 2 — Vincular agente ↔ proyecto ("mover un agente a un proyecto")

Un **proyecto** = `{ id, name, dir, engine, agentName, createdAt }`.
`engine ∈ { claude, opencode, ... }` (vía un adaptador, ver abajo).

Dos formas de crear un proyecto:

1. **Repo existente:** el usuario da la **ruta absoluta**. Validar que el
   directorio existe (y, si aplica, que es repo git). Se registra el proyecto
   apuntando a ese dir.
2. **Proyecto nuevo:** el usuario da **carpeta padre + nombre** (o ruta completa).
   switchboard **crea el directorio**, corre `git init`, y opcionalmente escribe
   un `README.md` semilla. Queda listo como proyecto.

Levantar el agente de un proyecto:

1. Asegurar el cableado de identidad en ese dir reusando `src/install.js`
   (`installMcp` + `ensureSkill`) → el CLI se conecta al relay como agente
   `agentName` (token persistido) y trae las herramientas MCP + skill.
2. **Spawnear** el CLI en `dir` con el process manager (Modo A o B).
3. El proceso queda gestionado: estado `running|stopped|exited`, con
   arrancar/parar/reiniciar desde la UI.

> Frontera honesta: hospedar el CLI **no** le da a switchboard control automático
> sobre cada escritura local — eso lo gobierna el modelo de permisos del propio
> CLI. switchboard sigue gobernando la **comunicación** (aprobación de mensajes,
> contratos DSP, master, code-review). Esto no cambia con este plan.

## Arquitectura y costuras (respetando CLAUDE.md)

- **Process manager (nuevo):** `src/relay/agents/manager.js` — `spawnAgent`,
  `stopAgent`, `listManaged`, eventos `agentproc.started|output|exited`. Estado de
  procesos **en memoria** (transitorio por naturaleza, como los waiters de
  `agent_wait`). Lanza CLIs vía `child_process` (Modo A) o node-pty (Modo B).
- **Motor (solo Claude Code por ahora):** Fase 0 implementa el motor `claude`
  directo (spawn de `claude` + el `install` actual para el cableado). Se deja una
  **costura mínima** (`engine` en el proyecto + un punto único donde se arma el
  spawn/install) para que **opencode** entre después como segundo driver
  (`AgentDriver { id, isAvailable(), spawnArgs, install }`) sin reescribir.
- **Definiciones de proyecto (persisten):** en el config store durable
  (`src/relay/config.js`) como `projects.json` (mismo patrón que
  contracts/policy/mode). Sobreviven reinicios; el estado de proceso no.
- **Rutas REST (nuevas):** en `src/relay/routes/index.js`
  - `GET/POST /api/projects` (listar / crear: existente o nuevo).
  - `DELETE /api/projects/:id`.
  - `POST /api/projects/:id/agent/start` · `POST .../agent/stop`.
- **Puente WS de consola (nuevo):** una ruta WS (p.ej. `/console`) multiplexada
  por agente; Modo A transmite salida (una vía) + diff; Modo B además recibe
  input del navegador hacia el PTY. Reusa el `http.Server` ya compartido.
- **Broadcasts:** eventos nuevos (`agentproc.*`, `project.*`) emitidos por el
  manager/rutas y manejados en el `switch` de `handle()` en `src/ui/static/app.js`.
- **UI (misma vista):** panel central "Agente activo": selector de proyecto/agente
  (izquierda ya existe), consola (log Modo A / `xterm.js` Modo B) + diff en vivo,
  y a la derecha la supervisión que ya existe. Todo en la SPA actual.
- **CLI:** subcomando opcional `switchboard project add|new|start|stop` que use el
  mismo manager (paridad con la UI), siguiendo el patrón de `bin/switchboard.js`.

## Modelo de datos

```jsonc
// ~/.switchboard/projects.json  (config store, persiste)
[
  { "id": "uuid", "name": "back", "dir": "/abs/path", "engine": "claude",
    "agentName": "back", "createdAt": 0 }
]
```
Estado de proceso (en memoria, no persiste): `{ projectId, pid, status, startedAt }`.

## Fases

- **Fase 0 — Proof, vista única (terminal real):** manager mínimo + crear proyecto
  (existente/nuevo) + arrancar `claude`/`opencode` en **PTY** (node-pty prebuilt) +
  panel **`xterm.js`** con I/O interactivo por WebSocket + el agente conectado al
  relay para recibir un mensaje del **master**. *Si este lazo convence, el producto
  existe.*
- **Fase 1 — Robustez del terminal:** resize/fit (addon), reconexión del WS,
  scrollback, búsqueda, **multi-terminal** (varios agentes a la vez) y el panel de
  `git diff` complementario.
- **Fase 2 — Pulido de ciclo de vida:** multi-proyecto, reinicio, logs
  persistidos, manejo de crashes, paridad con el CLI `switchboard project …`.
- **Fase 3 (futuro, fuera de esta rama):** shell desktop (Electron) reusando la
  misma UI + manager; licencia/suscripción.

## Decisiones

**Fijadas:**
1. **Terminal real (Modo B)** desde v1 — `xterm.js` + node-pty.
2. **Todo web por ahora** — sin shell desktop (Electron queda para Fase 3).
3. **node-pty vía prebuilds** (`@homebridge/node-pty-prebuilt-multiarch`).
4. **Solo Claude Code** como motor por ahora (opencode después).
5. **Proyectos en `config.json`** (junto a mode/policy/contracts; no en el store).
6. **`switchboard install` automático al arrancar** el agente (no como paso
   aparte). El `<nombre>` = identidad única en el relay; por defecto el nombre de
   la carpeta, editable; token persistido por proyecto.

**Abiertas:**
7. **Permisos del CLI**: con terminal real puedes **responder los prompts en el
   propio terminal**; surfacearlos como aprobación estructurada queda fuera del
   alcance inicial.

## Riesgos

- **Dependencia nativa (node-pty)** vs filosofía "sin build" → mitigado por Modo A
  inicial + prebuilds.
- **Gestión de procesos** (N CLIs, recursos, crashes, cross-platform).
- **Acoplamiento a un CLI** → mitigado por el adaptador `AgentDriver`.
- **Scope creep** → fases pequeñas; Fase 0 decide.

## Verificación

- Crear proyecto desde **repo existente** (ruta válida) y desde **nuevo** (crea
  dir + `git init`).
- Arrancar el agente → aparece como agente del relay, su consola se ve en el panel
  y el `git diff` se actualiza al editar.
- Mandarle un mensaje por **master** → llega al agente (lazo orquestación).
- Parar/reiniciar el agente desde la UI.
- Errores claros: ruta inexistente, no es repo (si se exige), motor no instalado.
- Tests Node nativos para el manager (mock de spawn), creación de proyectos y las
  rutas nuevas.

## Fuera de alcance (por ahora)

- **opencode y otros motores** (se añaden luego como segundo driver).
- Editor de código humano (no es el negocio; reusamos CLIs).
- Interceptar cada acción local del agente (lo gobierna el CLI).
- Shell desktop y licencia/suscripción (Fase 3, otra rama).
