#!/usr/bin/env node
/*
 * AI Process Manager — MCP server (stdio, zero npm dependencies).
 * Proxies the local HTTP API (default http://localhost:9147) as MCP tools.
 *
 * Claude Desktop / Cursor config:
 *   { "mcpServers": { "ai-process-manager": {
 *       "command": "node",
 *       "args": ["C:\\path\\to\\mcp\\server.js"] } } }
 *
 * Override API URL: set AIPM_API=http://127.0.0.1:9147
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const VERSION = require('./version.js');
const easyToolsModule = require('./easy-tools.js');

let clientName = 'mcp';
// Nome do AGENTE (quem pensa), distinto do CLIENTE (onde ele roda). Vem do ambiente
// para que vários agentes usando o mesmo cliente MCP apareçam separados em /activity.
// Regra fechada, igual à do servidor: minúsculas, [a-z0-9._-], máx. 40 chars.
const agentName = (String(process.env.AIPM_AGENT_NAME || 'mcp')
  .toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40)) || 'mcp';

const SERVER_INSTRUCTIONS = [
  'AI Process Manager (AIPM) exposes structured Windows state — processes, windows,',
  'console text, UI trees — without screenshots. Prefer these tools over screen capture;',
  'typical perception queries cost ~15–150 tokens vs ~2,765 for a 1080p screenshot.',
  '',
  'Prerequisites: AIProcessManager.exe must be running (system tray). If a tool returns',
  'connection_refused, ask the user to start the app or run install.cmd.',
  '',
  'Recommended workflow:',
  '1. health_check — verify the backend is up, and read executor + forgepilot + warnings',
  '   from it: they tell you which action family to use and whether the real-input arm is',
  '   even available. Do not skip straight to acting.',
  '1b. aipm_ja_faz(intent) — BEFORE writing code or reaching for the shell, ask whether a route already does it. Measured: the answer used to cost ~1047 KB of docs, so agents re-derived instead.',
  '2. get_app_knowledge(app) — load learned UI recipes before acting.',
  '3. check_process / list_windows — locate the target.',
  '4. read_window or get_ui_tree / ui_find — read state (no screenshot).',
  '5. wait_for — block until render/build/download completes (re-call if timeout).',
  '6. ACT — ONE route decides for you, and TWO families you can drive by hand. Picking the',
  '   wrong one is the most common failure on this machine. Read all three before acting.',
  '',
  '   (a) BY INTENT — ui_act. Try this FIRST for click / type / pick. It attempts UI',
  '       Automation and drops to real input BY ITSELF only when UIA reports the pattern is',
  '       missing, then reports which one ran (mecanismo: uia | fisico). It also REFUSES an',
  '       ambiguous target with HTTP 409 and hands back the candidates with their rect,',
  '       instead of silently taking the first name match like (b) does — measured 03/09/2026,',
  '       127 of 208 targets across 4 real windows had a colliding name. Reach for it above',
  '       all when the target name may not be unique (in a chat window, a name substring',
  '       matches the conversation history), or when ui_set_value returned valor_nao_aplicado.',
  '       It does NOT press keys and does NOT drag: those are (c).',
  '',
  '   (b) BY ELEMENT — UIA only, when you already hold a fresh element_index.',
  '       ui_invoke / ui_set_value / ui_select_option.',
  '       These drive the app through its UI Automation provider, NOT through the input',
  '       queue, so they DO NOT need the window focused, on top, or even visible: they work',
  '       with the target window BEHIND other windows while the user keeps typing somewhere',
  '       else. This is the whole point of the product — do not spend actions emulating a',
  '       human. Do NOT call focus_window "just in case" before them: it steals the user\'s',
  '       foreground and buys you nothing. Same UIA attempt ui_act makes first — the',
  '       difference is that these STOP at a mechanism error instead of falling through, and',
  '       that they pick the first name match without telling you.',
  '',
  '   (c) BY SYNTHETIC INPUT — last resort. ui_send_keys / ui_drag.',
  '       These emit real keyboard/mouse events, which Windows delivers to whatever is in',
  '       the FOREGROUND — not to the hwnd you passed. So they REQUIRE focus_window first',
  '       and refuse with janela_nao_esta_em_primeiro_plano otherwise. Use them only after',
  '       (a) or (b) has actually failed for this element, or for what only they can do:',
  '         • ui_send_keys — the only way to press a KEY (enter, tab, ctrl+enter); ui_act cannot.',
  '           For TYPING it is the manual version of what ui_act already does for you: the',
  '           sequence focus_window, ui_invoke the field, then ui_send_keys is three calls',
  '           where ui_act(intent=escrever) is one. Drive it by hand only to control each step.',
  '         • ui_drag — for what only moves by dragging (timeline, kanban, reorder,',
  '           drag-to-upload). There is no UIA pattern for dragging, so neither (a) nor (b)',
  '           covers it; it is still the only dragging path inside the gate and ledger.',
  '       If focus_window itself fails with foco_nao_aplicado, do NOT retry family (c) in a',
  '       loop — it cannot succeed without the foreground. The supported path from there is',
  '       the ForgePilot arm (real input executor): see executor/forgepilot in health_check.',
  '',
  '   Every action in all three requires the action tier enabled by the user AND the app on',
  '   the allowlist; otherwise you get action_denied. ui_act is no exception: its real-input',
  '   fallback runs inside the SAME gate and ledger, never around them.',
  '7. report_action_outcome + report_task_outcome — feed local learning and economy metrics.',
  '',
  'Safety: read-only by default. POST actions require the user to enable "Agent actions"',
  'in the tray and allow each app individually. Never dump /processes unfiltered — use',
  'check_process with name_contains/title_contains filters.',
].join('\n');

function resolveApiBase() {
  if (process.env.AIPM_API) return String(process.env.AIPM_API).replace(/\/$/, '');
  const endpointFile = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'AIProcessManager',
    'endpoint.txt'
  );
  try {
    const line = fs.readFileSync(endpointFile, 'utf8').trim();
    if (line) return line.replace(/\/$/, '');
  } catch (_) { /* default */ }
  return 'http://127.0.0.1:9147';
}

let API = resolveApiBase();

// Optional compact surface. Legacy remains the default and unchanged.
// AIPM_MCP_PROFILE=easy exposes only observe/act/wait/explain; "all" exposes both.
const MCP_PROFILE = String(process.env.AIPM_MCP_PROFILE || 'legacy').toLowerCase();
const EASY_INSTRUCTIONS = 'AIPM compact profile: call aipm_observe, then aipm_act (click, fill, or select only; key, drag, scroll are not separate actions) with a fresh target_ref. aipm_act sends only target_ref; the Core derives hwnd from the reference inside the gate. aipm_wait(operation_id) reads the receipt (query only); pass timeout_ms to poll, and read waited/waited_ms — never assume a wait happened. aipm_explain accepts Portuguese, English, and canonical tool names. Never retry an unknown action without reconciliation.';

function logErr(msg) {
  process.stderr.write('[ai-process-manager-mcp] ' + msg + '\n');
}

function apiRequest(method, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = API + path;
    const opts = {
      method: method || 'GET',
      timeout: timeoutMs || 5000,
      // Identidade do agente (docs/agent-identity.md): AIPM-Agent/<nome> (<cliente>).
      // O nome vem de AIPM_AGENT_NAME, default "mcp". Serve para OBSERVABILIDADE e
      // COORDENAÇÃO (/activity, /notes), NUNCA para autorização — qualquer processo
      // pode escrever qualquer nome aqui. O sufixo "mcp:<cliente>" continua no mesmo
      // cabeçalho porque o painel conta clientes MCP por ele.
      headers: { 'User-Agent': 'AIPM-Agent/' + agentName + ' (' + clientName + ') mcp:' + clientName },
    };
    if (method === 'POST') opts.headers['Content-Length'] = 0;

    const req = http.request(url, opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = { raw: body };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

function apiGet(path, timeoutMs) {
  return apiRequest('GET', path, timeoutMs);
}

function apiPost(path, timeoutMs) {
  return apiRequest('POST', path, timeoutMs || 15000);
}

// Estado do braço de entrada real (ForgePilot). Nunca derruba o health_check: se a rota
// falhar, devolve null e o chamador reporta "unknown" em vez de mentir "ausente".
// Existe porque instalado-e-parado era invisível pelo caminho MCP (mural seq 1386).
async function forgepilotStatus() {
  try {
    const r = await apiGet('/forgepilot/status', 3000);
    const j = r && r.json;
    if (r.status >= 400 || !j || typeof j.installed === 'undefined') return null;
    return {
      installed: j.installed === true,
      running: j.running === true,
      port_responding: j.port_responding === true,
      url: j.url || null,
    };
  } catch (e) {
    return null;
  }
}

function enrichApiError(status, json) {
  const out = Object.assign({ ok: false }, json);
  if (status === 503 && json && json.error === 'paused') {
    out.code = 'api_paused';
    out.next_action =
      'Ask the user to resume the API from the AI Process Manager tray menu (Resume API).';
  } else if (status === 403 && json && json.error === 'action_denied') {
    out.code = 'action_denied';
    out.next_action =
      'Ask the user to enable Agent actions in the tray and allow this app in the allowlist.';
  } else if (status >= 400) {
    out.code = out.code || 'api_error';
    out.http_status = status;
  }
  return out;
}

// Os CINCO erros de MECANISMO — a mesma lista de PodeCairParaFisico (src/UiAct.cs).
// Só nestes o /ui/act cai sozinha para entrada física. Apontar ui_act em qualquer outro
// erro (elemento sumiu, timeout, campo somente leitura) mandaria o agente repetir a mesma
// falha por outro fio, que é o conselho errado — e conselho errado gasta a chamada
// seguinte dele. A lista fica junto do apontador, não espalhada.
const ERROS_DE_MECANISMO = [
  'elemento_nao_suporta_invoke',
  'elemento_nao_suporta_set_value',
  'elemento_nao_suporta_selecao',
  'valor_nao_aplicado',
  'selecao_nao_aplicada',
];

// O achado que esta função existe para atacar: adoção é problema de DESENHO, não de
// disciplina. Quem bateu num erro de mecanismo é EXATAMENTE quem precisa do ui_act, e é
// quem está prestes a sair pelo shell. Descobrir a rota certa não pode depender de ter
// lido a descrição antes — o ponteiro chega no instante da falha.
// Só no caminho de ERRO: nada disto é pago no caminho feliz.
function apontaUiAct(out) {
  const e = out && (out.error || out.code);
  if (!e || ERROS_DE_MECANISMO.indexOf(e) < 0) return out;
  // next_action é da API e continua valendo — este é um campo IRMÃO, nunca um
  // substituto. Sobrescrever o conselho do motor seria trocar medição por palpite.
  out.try_instead =
    'ui_act with the same aim: "' + e + '" is one of the five mechanism errors it is built for. ' +
    'It re-tries this exact element through real input inside the same gate and ledger, and answers ' +
    'mecanismo: uia | fisico so you know which one ran. That is one call instead of ' +
    'focus_window + ui_invoke + ui_send_keys, and it refuses instead of guessing if the window is not ' +
    'in the foreground or the target is covered.';
  return out;
}

// O pacote é público no registro MCP, então gente de macOS e Linux vai instalá-lo.
// Dizer a verdade na primeira chamada é melhor do que mandar um usuário de Mac
// procurar um .exe na bandeja do Windows.
var IS_WINDOWS = process.platform === 'win32';

function mapThrownError(e) {
  if (e.code === 'ECONNREFUSED') {
    if (!IS_WINDOWS) {
      return {
        ok: false,
        error: 'unsupported_platform',
        code: 'unsupported_platform',
        message:
          'AI Process Manager reads Windows UI Automation, so the engine only runs on Windows. ' +
          'Detected platform: ' + process.platform + '.',
        next_action:
          'Nothing to fix here — macOS and Linux engines are not built yet. This bridge will work ' +
          'unchanged once they are; follow github.com/aipm-engine/AIPM to be notified.',
      };
    }
    return {
      ok: false,
      error: 'connection_refused',
      code: 'connection_refused',
      message: 'AI Process Manager is not running or not listening on ' + API + '.',
      next_action:
        'Ask the user to start AIProcessManager.exe (green tray icon) or reinstall with install.cmd.',
    };
  }
  if (e.code === 'ETIMEDOUT') {
    return {
      ok: false,
      error: 'timeout',
      code: 'ETIMEDOUT',
      message: 'Request timed out.',
      next_action: 'Retry with a smaller scope (filters, lower depth/max_nodes) or check if the target app is hung.',
    };
  }
  return {
    ok: false,
    error: 'request_failed',
    code: e.code || 'UNKNOWN',
    message: e.message,
    next_action: 'Retry once; if it persists, check %LOCALAPPDATA%\\AIProcessManager\\log.txt.',
  };
}

function requireArg(args, name) {
  if (args[name] == null || args[name] === '') {
    const err = new Error(name + ' is required');
    err.code = 'invalid_params';
    throw err;
  }
}

const CMDLINE_MAX = 120;

function slimProcess(p, fullCmd) {
  const out = {};
  for (const k in p) {
    const v = p[k];
    if (v == null) continue;
    if (k === 'status' && v === 'running') continue;
    if (k === 'parent' && v === p.name) continue;
    out[k] = v;
  }
  if (!fullCmd && typeof out.command_line === 'string' && out.command_line.length > CMDLINE_MAX)
    out.command_line = out.command_line.slice(0, CMDLINE_MAX) + '\u2026';
  return out;
}

function winQuery(args) {
  const q = new URLSearchParams();
  if (args.hwnd != null) q.set('hwnd', String(args.hwnd));
  else if (args.title_contains) q.set('title_contains', args.title_contains);
  return q;
}

const READ_TOOLS = [
  {
    name: 'aipm_ja_faz',
    description:
      'ASK THIS BEFORE WRITING CODE, BEFORE REACHING FOR THE SHELL, AND BEFORE ASSUMING THE AIPM CANNOT DO SOMETHING. Describe what you want in plain words (Portuguese or English, verbs are fine) and it returns the routes that already do it, with their parameters and their known traps. Why it exists, measured 27/08/2026: answering "does the AIPM already do this?" used to mean reading ~1047 KB of docs, so re-deriving was cheaper than looking up — and agents re-derived. Two real cases the same week, both with the capability ALREADY PRESENT: one agent dropped to the shell to drag by coordinates; another was about to write a heuristic that /analytics/shapes had been serving for weeks. Matching is by 5-char prefix without accents, so "arrastar" finds "arrasta". If nothing matches, try another form of the verb or the noun before concluding it does not exist. For per-app recipes and failures already recorded, follow up with get_app_knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What you want to do, in words (e.g. "arrastar item", "esperar arquivo terminar", "texto dentro da janela")' },
      },
      required: ['intent'],
    },
    annotations: {
      title: 'Does the AIPM already do this?',
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'health_check',
    annotations: { title: 'Check AI Process Manager status' },
    description:
      'Ping the AI Process Manager backend. Call this FIRST in a new session. Returns version, API URL, whether the local service is reachable, and two things that decide your first action: executor (which tools act through UI Automation and need NO foreground, versus which emit real input and REQUIRE it) and forgepilot (whether the real-input arm is installed and running), plus warnings[] with a next_action when the arm is installed but stopped. The route catalogue is deliberately omitted — ask aipm_ja_faz(intent) for that.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_process',
    annotations: { title: 'Check if a process is running' },
    description:
      'Check if a process is running on the user\'s Windows machine — no screenshot. Filter by executable name fragment (e.g. "python", "ffmpeg") and/or window title (e.g. "RENDER VIDEO 02"). Returns PID, CPU%, RAM, title, command line, start time. Command lines are truncated to 120 chars unless full_command_line=true. Results are capped at 10 matches, windowed processes first.',
    inputSchema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string', description: 'Executable name fragment (case-insensitive)' },
        title_contains: { type: 'string', description: 'Window title fragment (case-insensitive)' },
        full_command_line: {
          type: 'boolean',
          description: 'true for full command line (default: truncated to 120 chars)',
        },
      },
    },
  },
  {
    name: 'list_processes',
    annotations: { title: 'List running processes' },
    description:
      'List running processes sorted by CPU. Use "top" to limit (default 25, max 200). Prefer check_process when searching for one process. Command lines truncated unless full_command_line=true.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'How many processes to return (default 25)' },
        full_command_line: { type: 'boolean', description: 'true for full command lines' },
      },
    },
  },
  {
    name: 'list_windows',
    annotations: { title: 'List open windows' },
    description:
      'CATALOGUE of the desktop windows: one entry per window with title, process, minimized/maximized state, position, Z-order and which has focus. Answers "what windows are open", "which is in the foreground", "is X minimized". It does NOT give the text inside a window (use read_window) and does NOT give the UI element structure (use get_ui_tree). If the user asks to READ something or CLICK something, this is not the tool.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_system_status',
    annotations: { title: 'Get system status (CPU, RAM, GPU, disk)' },
    description:
      'Machine snapshot: CPU%, RAM used/total, GPU name and usage, disk free space per drive, network, uptime, active displays.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_taskbar',
    annotations: { title: 'Show taskbar apps' },
    description:
      'Human view of the taskbar: pinned apps and running apps grouped with window titles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_window',
    annotations: { title: 'Read text from a window' },
    description:
      'Read the raw TEXT that is INSIDE a window via UI Automation — no screenshot. Answers "what does the window say": console output, render progress ("frame 4812/5000"), editor content, chat messages. Works with consoles (cmd, PowerShell, Windows Terminal), editors and most native apps. You MUST identify the window first: pass title_contains (or hwnd from list_windows). It does NOT list windows (use list_windows) and does NOT return the UI element tree (use get_ui_tree).',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment (case-insensitive)' },
        hwnd: { type: 'number', description: 'Exact window handle from list_windows' },
        max_chars: { type: 'number', description: 'Max characters. Default 20000, but the engine accepts up to 200000 (Api.cs clamps to [200, 200000]) — the 20000 is a DEFAULT, not a ceiling. Say so because the omission misleads: an agent that asks for 20000, gets exactly 20000 back and concludes "this window is truncated at 20k" is reading its own cap, not a product limit. In a long chat window the tail sits past 20000 and a bigger max_chars reaches it. The reply does NOT flag that it cut, so compare chars against what you asked: equal means you probably hit your own cap and should ask for more.' },
      },
    },
  },
  {
    name: 'get_ui_tree',
    annotations: { title: "Get a window's UI element tree" },
    description:
      'The UI AUTOMATION TREE of a window: the accessibility snapshot with roles, names and states of the elements (buttons, fields, menus, panes) and how they are NESTED. Answers "what is the structure of this window", "how are the elements organised". It does NOT list windows (use list_windows) and does NOT give the plain text inside (use read_window). For finding a clickable element prefer ui_find instead of this tree. ' +
      'depth: default 4, max 30. max_nodes: default 200, max 1000 — max_nodes is the cost brake, NOT depth. ' +
      'Win32 apps expose content within 4-6 levels. Chromium/Electron apps (VS Code, Slack, Discord, Claude Desktop, Teams) ' +
      'bury real content under ~10 levels of Pane/Group wrappers: at low depth you get only empty Panes and conclude, wrongly, ' +
      'that the window is empty. Measured on Claude Desktop: depth=8 -> 15 useless nodes; depth=17 -> 115 nodes, 87 of them named (~8 KB) — ' +
      'the tree saturates at 17. So for Chromium/Electron ask for depth=15-20 and cap cost with max_nodes. ' +
      'The response reports depth, max_nodes, nodes, depth_reached and truncated; when truncated=true the tree was cut ' +
      '(read next_action) and you should repeat with a higher depth and/or max_nodes before concluding anything about the window.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        depth: {
          type: 'number',
          description:
            'Max tree depth (default 4, max 30). 4-6 for native Win32; 15-20 for Chromium/Electron apps, whose content sits under ~10 wrapper levels.',
        },
        max_nodes: {
          type: 'number',
          description:
            'Max nodes returned (default 200, max 1000). This is the token-cost brake — raise depth freely and cap cost here.',
        },
      },
    },
  },
  {
    name: 'wait_for',
    annotations: { title: 'Wait until a condition is met' },
    description:
      'Long-poll until a condition is met (or timeout). Replaces polling loops. Conditions: process_ended, process_started, file_stable (render/download done), file_exists, window_title_contains, note_after_seq (a new note on the agent mural). Max 50s per call; if satisfied=false, call again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        process_ended: { type: 'string', description: 'Process name fragment that must exit' },
        process_started: { type: 'string', description: 'Process name fragment that must start' },
        file_stable: { type: 'string', description: 'File path that must stop growing' },
        file_exists: { type: 'string', description: 'File path that must appear' },
        window_title_contains: { type: 'string', description: 'Window title fragment that must appear' },
        note_after_seq: { type: ['number', 'string'], description: 'Mural bell: blocks until a note with seq > this is posted. Pass the string "now" to get the current max_seq WITHOUT waiting, then call again with that number. Use this instead of polling read_notes in a loop — the mural records but does not push, and a note has sat unread for 11 minutes because of it.' },
        stable_for: { type: 'number', description: 'For file_stable: seconds unchanged (default 10)' },
        timeout: { type: 'number', description: 'Max wait seconds (default 50, max 50)' },
      },
    },
  },
  {
    name: 'get_recent_events',
    annotations: { title: 'List recent PC events' },
    description:
      'Last 24h of PC events: process_started, process_ended (with duration), window_focused, file_changed. Useful for "what happened while I was away" (e.g. when did the render finish?).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type (process_ended, file_changed, ...)' },
        limit: { type: 'number', description: 'Max events (default 50, max 1000)' },
      },
    },
  },
  {
    name: 'check_file',
    annotations: { title: 'Check a file or folder' },
    description:
      'File or folder status: exists, size, last modified, locked?, locking process. Ideal for checking if a render/export finished without opening Explorer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. D:/videos/output.mp4' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_app_knowledge',
    annotations: { title: 'Get learned recipes for an app' },
    description:
      'Query what AIPM learned locally about an app: successful (role, name) -> action recipes, plus common_failures (targets that keep failing — do not retry them). ' +
      'Call BEFORE acting in an app. Even with known=false you may get ui_shape: the shape of the app\'s UI tree (counts, roles, depth) learned passively from earlier reads — useful cold-start map. ' +
      'Pass the process name as shown in task manager (e.g. "notepad.exe", "chrome.exe").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App/process name (e.g. notepad.exe)' },
        top: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum recipes and failures returned (default 8).' },
        role: { type: 'string', description: 'Filter recipes by UI role; null roles remain applicable.' },
        action: { type: 'string', description: 'Filter recipes by canonical action; null actions remain applicable.' },
        include_shape: { type: 'boolean', description: 'Include the learned UI shape cold-start map.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_economy_stats',
    annotations: { title: 'Get token economy statistics' },
    description:
      'Local economy metrics: tokens and time saved by structured state vs screenshots, queries served, task/action success rates, top apps, 24h/7d trends. ' +
      'Two independent views of savings — economy_measured_by_api (measured here) and economy_reported_by_agents (self-reported): never add them together. ' +
      'The store block states which local database the totals came from.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_audit_log',
    annotations: { title: 'View API audit log' },
    description:
      'Recent API audit log: which agents called which endpoints and when. Works even when the API is paused. For compliance and debugging agent behavior. Secrets and typed text (api_key=, value=) are masked before being recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 50, max 1000)' },
      },
    },
  },
  {
    name: 'read_notes',
    annotations: { title: 'Read the agent noticeboard' },
    description:
      'THE NOTICEBOARD other agents left for you on this machine — findings, decisions, blockers and done reports. ' +
      'Call this FIRST in a session, before measuring anything: what looks like a fresh discovery is usually already answered here, ' +
      'and a note may say the thing you are about to investigate was fixed hours ago. Notes never leave this machine (never telemetry, never network). ' +
      'Start with no filter to get the `subjects` map (rooms + note counts) and pick the room where the work actually happens — ' +
      'the biggest room is rarely the one you assume. Then re-call with subject=. ' +
      'Use para=<your-name> as the cheap "any messages for me?" check — it returns only notes mentioning @<name>. ' +
      'COST WARNING: notes are long free text. limit=100 costs roughly 13k tokens — several times a screenshot, which is what this product exists to avoid. ' +
      'Default 20 is deliberate; raise it only after subjects/para narrowed the target. The reply carries matched/truncated/limit_max so a cut is never silent.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Room to read (e.g. "sala/dev"). Omit to get the subjects map first.' },
        para: { type: 'string', description: 'Only notes mentioning @<name> — the "any messages for me?" check' },
        agent: { type: 'string', description: 'Only notes written by this agent' },
        since: { type: 'string', description: 'Only notes newer than this (e.g. "2h", "1d")' },
        limit: { type: 'number', description: 'Max notes (default 20, server cap 500). Each note is long text — keep this small.' },
        after_seq: { type: 'number', description: 'Only notes with seq greater than this — for polling what arrived since your last read' },
      },
    },
  },
];

// Todas as tools de leitura carregam os mesmos hints. Object.assign ESCREVE POR CIMA
// do objeto existente, preservando o `title` que cada tool já declarou (o title é
// exigido pela revisão de extensão e é o que o cliente mostra ao usuário).
READ_TOOLS.forEach((t) => {
  t.annotations = Object.assign(t.annotations || {}, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
});

const ACTION_TOOLS = [
  {
    name: 'ui_find',
    description:
      'List interactive UI elements in a window (buttons, fields, menus first; grid cells last). Each item has an element_index plus can_invoke/can_set_value flags. Read-only, no action tier required, and it does NOT need the window focused or in the foreground. Pass element_index to ui_act (preferred: it is the aim that is never refused for ambiguity) or to ui_invoke/ui_set_value/ui_select_option. TWO TRAPS, both measured: (1) element_index is valid for THIS SNAPSHOT ONLY — it is an identity within one walk of the tree, not a durable handle, and it ages on every re-render (a re-render has been seen shifting indices by -1). Re-read with ui_find after anything that changes the screen, and never reuse an index from an earlier turn. (2) Paginated (total/offset/limit/has_more) — limit caps at 200 no matter what you ask, silently. If has_more is true you have NOT seen the window: page with offset until has_more is false. Big windows (600+ elements) routinely hide the field you want on page 2.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Filter elements by name' },
        role: { type: 'string', description: 'Filter by role (Button, Edit, MenuItem, ...)' },
        limit: { type: 'number', description: 'Page size (default 30, max 200)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
    },
    annotations: {
      title: 'Find interactive UI elements',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_find_at',
    description:
      'Find the UI element under an ABSOLUTE screen pixel (x, y) in a window. Returns the SAME global element_index as ui_find (so you can probe coordinates then act), plus element_role/element_name when available. For UIA-empty windows (canvas games, Java, GDI) it returns element_index -1 with a hint — no accessibility tree; use real clicks at those coordinates instead. NEVER clicks anything, but like the action endpoints it is opt-in (action tier + allowlist).',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        x: { type: 'number', description: 'Absolute screen X' },
        y: { type: 'number', description: 'Absolute screen Y' },
      },
      required: ['x', 'y'],
    },
    annotations: {
      title: 'Find UI element under a screen pixel',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  // A rota de INTENCAO vem antes das rotas de mecanismo de proposito: o agente le a
  // lista de cima para baixo e para na primeira que serve. Enquanto ui_invoke aparecia
  // primeiro, o caminho que decide sozinho era o que so se achava depois de errar.
  {
    name: 'ui_act',
    description:
      'ACT BY INTENT - the first thing to try for click / type / pick. One call replaces choosing between ' +
      'ui_invoke / ui_set_value / ui_select_option AND doing the fallback dance by hand: it tries UI Automation ' +
      'first, drops to real input BY ITSELF only when UIA reports the pattern is missing, and tells you which one ' +
      'ran (mecanismo: uia | fisico). Two measured reasons to prefer it over ui_invoke. ' +
      '(1) AMBIGUITY. name_contains is a SUBSTRING match and every other action tool silently takes the FIRST hit ' +
      '- in a chat window that regularly means a word out of the conversation history, not the control you meant. ' +
      'Measured 03/09/2026 across 4 real windows: 127 of 208 targets had a colliding name (61.1%). In Google Flow ' +
      'two different buttons are both named "Criar" (one attaches a file, one sends); four agents, one of them for ' +
      'seven hours, clicked attach and waited for a generation that was never fired. ui_act REFUSES an ambiguous ' +
      'target with alvo_ambiguo (HTTP 409) and hands back the candidates WITH their rect, so you disambiguate by ' +
      'position (on a toolbar the send control is usually the right-most) and re-call with element_index. It never ' +
      'picks for you, and element_index is never refused for ambiguity. ' +
      '(2) CONTENTEDITABLE. In a React/Vue/Electron composer ui_set_value writes into UI Automation and the ' +
      'framework re-renders over it (valor_nao_aplicado). ui_act falls to real input inside the SAME gate and ' +
      'ledger, so you do not run focus_window + ui_invoke + ui_send_keys yourself. ' +
      'The fall is deliberately narrow - exactly five mechanism errors (elemento_nao_suporta_invoke / ' +
      '_set_value / _selecao, valor_nao_aplicado, selecao_nao_aplicada). Any other error (element gone, timeout, ' +
      'read-only field) is NOT retried blindly, because repeating a non-mechanism failure through another wire is ' +
      'just hammering harder. ' +
      'WHAT IT COSTS: while mecanismo is uia nothing is stolen - it works with the window in the background, like ' +
      'ui_invoke. The fisico branch needs the window in the FOREGROUND, moves the user cursor, and refuses rather ' +
      'than guessing if the window is minimised, not foreground, or the target is occluded. ' +
      'NOT covered: pressing a key (ui_send_keys key=) and dragging (ui_drag). REQUIRES action tier + allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        intent: {
          type: 'string',
          // O vocabulario e FECHADO no motor (UiAct.cs) e os valores sao em portugues.
          // O enum esta aqui para o cliente validar ANTES da chamada: vocabulario fechado
          // sem lista visivel nao disciplina o agente, so apaga o que ele quis dizer.
          enum: ['clicar', 'escrever', 'escolher'],
          description:
            'What you want to do. Closed vocabulary, exactly these three Portuguese values: clicar (click), ' +
            'escrever (type text, needs text=), escolher (pick an option in a list, needs option=).',
        },
        text: { type: 'string', description: 'Text to write. Required when intent=escrever.' },
        option: { type: 'string', description: 'Visible text of the option. Required when intent=escolher.' },
        element_index: {
          type: 'number',
          description:
            'Index from a FRESH ui_find. The deterministic aim, and the answer to a 409: it is never refused ' +
            'for ambiguity. Indices age on every re-render - never reuse one from an earlier turn.',
        },
        name_contains: { type: 'string', description: 'Aim by name instead. SUBSTRING: may be refused with 409 plus the candidates.' },
        role: { type: 'string', description: 'Narrow the aim by role (Button, Edit, ComboBox, ...)' },
      },
      required: ['intent'],
    },
    annotations: {
      title: 'Act by intent (decides UIA vs real input)',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_invoke',
    description:
      'Semantically CLICK a UI element via UI Automation (button, menu item, checkbox). Target by name_contains or element_index from ui_find. USE ui_act INSTEAD WHEN THE NAME MAY NOT BE UNIQUE: name_contains is a SUBSTRING and this tool takes the FIRST hit SILENTLY (in a chat window it routinely matches the conversation history, not the control); ui_act refuses that with 409 plus the candidates. Prefer ui_act too when this returns elemento_nao_suporta_invoke - it falls to real input by itself instead of dead-ending. This tool stays right when you already hold a fresh element_index and want UIA only. WORKS WITH THE WINDOW IN THE BACKGROUND: this drives the app\'s accessibility provider, not the input queue, so the target does NOT need to be focused, on top, or visible — it can sit behind other windows while the user keeps working. Do NOT call focus_window first "just in case"; that steals the user\'s foreground and gains nothing (only ui_send_keys and ui_drag need it). Prefer this over ui_send_keys for anything clickable. REQUIRES user-enabled action tier + app allowlist; otherwise returns action_denied. Confirm with the user before acting.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Element name to click (e.g. "Save")' },
        element_index: { type: 'number', description: 'Stable index from ui_find' },
      },
    },
    annotations: {
      title: 'Click a UI element',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_set_value',
    description:
      'PREFERRED WAY TO TYPE. Set text in an editable field via UI Automation (no key simulation). WORKS WITH THE WINDOW IN THE BACKGROUND: it writes through the accessibility provider, not the keyboard queue, so the window does NOT need to be focused or in the foreground — unlike ui_send_keys, it can fill a form while the user types in another app. Do NOT call focus_window first "just in case". The write is VERIFIED: the value is read back and compared, so ok:true means it actually landed; a control that silently ignores the write returns valor_nao_aplicado — and the shortest way out of that is ui_act (intent=escrever), which retries this same element through real input by itself, in one call instead of the focus_window + ui_invoke + ui_send_keys sequence, and reports mecanismo so you know which one landed. Drive that sequence by hand only when you need to control each step. For dropdowns/<select> use ui_select_option instead. REQUIRES action tier + allowlist. Check can_set_value in ui_find; modern apps (e.g. Win11 Notepad) may not expose fields. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Field name' },
        element_index: { type: 'number', description: 'Stable index from ui_find' },
        value: { type: 'string', description: 'Text to set' },
      },
      required: ['value'],
    },
    annotations: {
      title: 'Set the value of a UI field',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_send_keys',
    description:
      'LAST RESORT for typing, and there is now a shorter road: ui_act (intent=escrever) makes the ui_set_value attempt AND this fallback in a single call, deciding between them itself and reporting mecanismo: uia | fisico. Reach for ui_send_keys directly when you need a KEY PRESS (Enter, Tab, ctrl+enter - ui_act does not press keys), or when you want to drive each step by hand. Check the key parameter before planning: the vocabulary is closed and has no letters, no F-keys and no arrows, so ctrl+a / ctrl+s / ctrl+v are NOT available. Otherwise: use ui_set_value FIRST, and only reach for this when it returns valor_nao_aplicado. That error means the field is a contenteditable inside a controlled framework (React/Vue) — the write lands and the framework immediately re-renders over it. Synthetic keystrokes go through the browser as real input events, which those frameworks DO honour (measured 13/08/2026: same field, ui_set_value failed and the text never appeared; send_keys succeeded and it did). IMPORTANT DIFFERENCES from ui_set_value: (1) this types into whatever currently has keyboard FOCUS, not into an element_index — click the field with ui_invoke first; (2) it REQUIRES the target window to be in the foreground and refuses with janela_nao_esta_em_primeiro_plano otherwise, so it cannot run in the background while the user works, unlike ui_set_value; (3) text is sent LITERALLY — writing "{ENTER}" in text types those 7 characters. To press a key, use the separate key parameter. That split is deliberate: text often carries user content, and parsing sequences out of it would turn any data containing "{ENTER}" into a keystroke. The write is verified by re-reading the window text in a loop; if it cannot be confirmed you get escrita_nao_verificavel, never a false ok. The key is sent only AFTER the text is confirmed — submitting a form that was not filled is worse than doing nothing. Note key_effect_verified is always false: whether Enter navigated or submitted is on the app side and is not something this route can confirm. REQUIRES action tier + allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        text: { type: 'string', description: 'Literal text to type (max 4000 chars). Sequences are NOT parsed.' },
        key: { type: 'string', description: 'Optional key pressed after the text. CLOSED vocabulary, and it is SHORT — exactly these base keys exist: enter, tab, escape (or esc), backspace, delete (or del), home, end. There are NO letter keys, NO function keys (F1-F12) and NO arrow keys. Measured 10/09/2026 against the installed engine: key="ctrl+a" returns HTTP 400 key= desconhecida, and so do ctrl+shift+v and alt+f4 — the three examples this description used to advertise. Modifiers ctrl (or control), shift and alt combine with "+" ON THOSE BASE KEYS ONLY: ctrl+enter, shift+tab, ctrl+shift+home. There is no Win modifier, and anything outside the list is REFUSED rather than guessed; the refusal hands back the accepted list, so read it instead of retrying. PLAN AROUND THIS BEFORE YOU START: select-all (ctrl+a), copy/paste (ctrl+c / ctrl+v) and save (ctrl+s) are NOT reachable by key — drive the command through its menu item with ui_act instead, which is how Notepad Save As was completed here. The missing F-keys are also why some apps cannot be driven by keyboard at all (Roblox Studio needs F7 and there is no way to send it).' },
      },
    },
    annotations: {
      title: 'Type text with synthetic keystrokes (last resort)',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_drag',
    description:
      'Drag from one element to another (or between two absolute screen pixels). Use this for anything that only moves by dragging: video-editor timelines, kanban cards, calendar events, reordering lists, drag-to-upload. There is no UIA pattern for dragging, so this emits REAL mouse input with intermediate movement steps — measured: a teleport fires dragstart but never drop; the steps are what makes the drop land. Prefer from_index/to_index (the ledger then records the element ROLE, so the action is auditable); the pixel form exists for canvas/GDI surfaces with no UIA tree. REQUIRES the target window to be in the FOREGROUND and refuses otherwise, because synthetic input goes to whatever sits under the cursor, not to the hwnd you passed — call focus_window first. Both endpoints are resolved BEFORE any movement, so a bad index fails naming which end was wrong. ok:true means the input sequence was emitted and the cursor was released on target; it does NOT mean the app accepted the drop — confirm with ui_find (the target usually changes name or role). REQUIRES action tier + allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        from_index: { type: 'number', description: 'element_index to drag FROM (from ui_find). Preferred: auditable.' },
        to_index: { type: 'number', description: 'element_index to drop ON (from ui_find)' },
        from_x: { type: 'number', description: 'Absolute screen X to drag from (canvas/GDI only)' },
        from_y: { type: 'number', description: 'Absolute screen Y to drag from' },
        to_x: { type: 'number', description: 'Absolute screen X to drop on' },
        to_y: { type: 'number', description: 'Absolute screen Y to drop on' },
        steps: { type: 'number', description: 'Intermediate movements (default 45, min 4, max 200). Fewer than ~12 starts failing in Chromium.' },
        hold_ms: { type: 'number', description: 'Pause after mouse-down before moving (default 120, max 2000). Frameworks use this gap to tell a drag from a click.' },
      },
    },
    annotations: {
      title: 'Drag an element onto another',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_select_option',
    description:
      'Pick an option in a dropdown / <select> / combo box by its visible text. Use this instead of ui_invoke or ui_set_value for lists: a Chromium <select> supports neither invoke nor toggle, and set_value silently does nothing. WORKS WITH THE WINDOW IN THE BACKGROUND: it goes through UI Automation, not synthetic input, so the window does NOT need focus or foreground — do not call focus_window first "just in case" (only ui_send_keys and ui_drag require it). Expands the list, re-walks the tree (options do not exist while it is closed), selects by text, verifies the displayed value changed, then collapses. Matching is by SUBSTRING, so a short option text can match a longer neighbour — prefer element_index from a fresh ui_find. When the LIST name itself may collide, ui_act (intent=escolher) refuses with 409 and returns the candidates instead of picking one for you; it also falls to real input if this returns elemento_nao_suporta_selecao or selecao_nao_aplicada. REQUIRES action tier + allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'List name' },
        element_index: { type: 'number', description: 'Stable index from ui_find (role ComboBox)' },
        option: { type: 'string', description: 'Visible text of the option to select' },
      },
      required: ['option'],
    },
    annotations: {
      title: 'Select an option in a dropdown',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'focus_window',
    description:
      'Bring a window to the foreground. REQUIRES action tier + app allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
      },
    },
    // Trazer janela para frente não destrói nada e repetir dá o mesmo resultado.
    annotations: {
      title: 'Bring a window to the foreground',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const TELEMETRY_TOOLS = [
  {
    name: 'report_task_outcome',
    description:
      'Report task outcome to local telemetry (metadata only — never screen content). Call at END of a computer-use task. Feeds get_app_knowledge and get_economy_stats.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Short task description (metadata)' },
        app: { type: 'string', description: 'Primary app (e.g. chrome.exe)' },
        success: { type: 'boolean', description: 'Task succeeded?' },
        steps: { type: 'number', description: 'Number of steps/actions' },
        tokens_estimated: { type: 'number', description: 'Estimated tokens consumed' },
        duration_s: { type: 'number', description: 'Duration in seconds' },
        screenshots_avoided: { type: 'number', description: 'Screenshots avoided via structured state' },
        notes: { type: 'string', description: 'Short notes (metadata)' },
      },
      required: ['app'],
    },
    annotations: {
      title: 'Report task outcome (telemetry)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'report_action_outcome',
    description:
      'Report one UI action outcome (invoke/set_value/focus). Feeds per-app recipes in get_app_knowledge. Metadata only — never screen content or typed text. ' +
      'Report FAILURES too (ok=false plus reason): they become common_failures and stop the next agent from repeating the same dead end.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App where action occurred' },
        element_role: { type: 'string', description: 'Element role (Button, Edit, ...)' },
        element_name: { type: 'string', description: 'Element name (e.g. "Save")' },
        action: { type: 'string', description: 'Action performed (invoke, set_value, focus)' },
        ok: { type: 'boolean', description: 'Action succeeded?' },
        ms: { type: 'number', description: 'Action duration in ms' },
        reason: {
          type: 'string',
          description:
            'Only when ok=false. CLOSED vocabulary — a term outside it is silently stored as "outro" and your observation is lost. Do NOT rely on this description for the list: it went stale before (it named 9 terms while the engine had 26, and the three that mattered most were among the missing). The AUTHORITATIVE list comes from the engine itself: call get_app_knowledge and read the vocabulary in its hint, or send any term and read reason_normalized + vocabulario in this call\u2019s own reply when it coerces. Free text never reaches disk.',
        },
      },
      required: ['app', 'action'],
    },
    annotations: {
      title: 'Report UI action outcome (telemetry)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

// Coordenação entre agentes. Não é telemetria (não vira métrica nem receita) e não é
// ação de UI (não passa pelo ActionGate): é recado de agente para agente, e fica só
// nesta máquina. Escreve, então NÃO entra em READ_TOOLS — declara os hints aqui.
const COORD_TOOLS = [
  {
    name: 'post_note',
    description:
      'Leave a note on the local noticeboard for the next agent (or for the human reading later). ' +
      'Notes stay on this machine: never telemetry, never network. ' +
      'Worth writing when you measured something that contradicts a document, hit a trap that cost you time, ' +
      'made a decision the next agent would otherwise re-litigate, or finished something they might redo. ' +
      'Say what you MEASURED and with which command — a note asserting state without the command that produced it is a memory, not a finding. ' +
      'Max 500 chars, so write the conclusion, not the story. Mention @<name> to address a specific agent (they find it via read_notes para=<name>). ' +
      'Reuse an existing subject from read_notes: a new room nobody reads is worse than no note. The reply flags assunto_novo when the room did not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note. Max 500 chars. Conclusion + how it was measured.' },
        subject: { type: 'string', description: 'Room, reusing one from read_notes subjects (e.g. "sala/dev")' },
        kind: {
          type: 'string',
          description: 'finding (measured something) | decision (chose a path) | blocker (stuck, needs input) | done (finished something)',
        },
      },
      required: ['text'],
    },
    annotations: {
      title: 'Post a note to the agent noticeboard',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

const LEGACY_TOOLS = READ_TOOLS.concat(ACTION_TOOLS, TELEMETRY_TOOLS, COORD_TOOLS);
const easyTools = easyToolsModule.create({ apiGet, apiPost, enrichApiError });
const TOOLS = MCP_PROFILE === 'easy' ? easyTools.tools :
  MCP_PROFILE === 'all' ? easyTools.tools.concat(LEGACY_TOOLS) : LEGACY_TOOLS;

// ---------------------------------------------------------------------------
// SERVIÇOS COMPANHEIROS — o que existe NESTA MÁQUINA e não é rota do motor.
//
// POR QUE ISTO VIVE AQUI e não no catálogo do motor, decidido em 14/09/2026:
// o adaptador semântico (9148) e o braço do Pilot (8000) NÃO são rotas do
// AIPM — são processos separados. Enfiá-los no array de endpoints do motor
// inflaria `total_rotas` com uma afirmação falsa. Mas o agente que pergunta
// "isso já existe?" quer saber o que EXISTE, não onde fica a fronteira de
// processo. E a camada que fala com o agente é esta.
//
// O BURACO QUE ISTO FECHA, medido: perguntei aipm_ja_faz("criar objeto 3D no
// Blender") e a resposta foi /app/restart e /ui/capture. Ou seja, o produto
// sugeria TIRAR PRINT numa janela onde ui_find devolve 6 elementos (os 6 são
// moldura do Windows) e o adaptador devolve 17 objetos e 102 propriedades —
// sugeria justamente o caminho que o adaptador existe para tornar dispensável.
//
// ⚠️ `disponivel` é sondado NA HORA, e só quando a intenção casa. Anunciar um
// serviço sem dizer se ele está no ar seria trocar um buraco por outro: o
// agente tentaria e levaria ECONNREFUSED sem saber por quê.
// ---------------------------------------------------------------------------
const SERVICOS_COMPANHEIROS = [
  {
    nome: 'aipm.semantic.v1 — adaptador semântico (porta 9148)',
    sonda: 'http://127.0.0.1:9148/saude',
    // Medido em servidor.py: /saude devolve {"contrato":"aipm.semantic.v1"}.
    marca: 'aipm.semantic.v1',
    o_que_e:
      'Lê e altera o ESTADO INTERNO do aplicativo, não a tela. Devolve objetos, ' +
      'propriedades com caminho real (transform.location) e o TIPO vindo da engine.',
    quando_usar:
      'Quando a árvore UIA não alcança. Medido no Blender: ui_find devolve 6 elementos ' +
      'e os 6 são moldura do Windows; get_ui_tree depth=25 devolve 7 nós. O adaptador, ' +
      'no mesmo arquivo: 17 objetos, 102 propriedades, 85 esquemas do RNA.',
    como:
      'POST http://127.0.0.1:9148/<metodo> com JSON. Métodos: context, capabilities, ' +
      'capability, property_schema, properties, read, apply. Exige o app aberto com o ' +
      'servidor do adaptador carregado.',
    armadilha:
      'Caminho de propriedade é namespaced: transform.location, NAO location. ' +
      'Câmera, render e salvar continuam FORA do vocabulário (400).',
    palavras: ['blender', '3d', 'objeto', 'cena', 'propriedade', 'semantico',
               'adaptador', 'bpy', 'malha', 'modelar', 'modelagem', 'vertice',
               'transform', 'sem arvore', 'arvore vazia', 'interno'],
  },
  {
    nome: 'braço do Pilot — POST /braco/ver e /braco/agir (porta 8000)',
    sonda: 'http://127.0.0.1:8000/status',
    // Medido no /status ao vivo: {"app":"ForgePilot",...}.
    marca: 'ForgePilot',
    o_que_e:
      'Usa o ForgePilot como INSTRUMENTO: quem chama continua sendo o cérebro. ' +
      '/braco/ver devolve o snapshot e as referências; /braco/agir executa UMA ação.',
    quando_usar:
      'Quando você quer os olhos e as mãos do Pilot SEM entregar a decisão ao modelo ' +
      'local dele. Até 14/09/2026 a única porta era o verbo `task` do WebSocket — ' +
      'ou seja, delegar a tarefa INTEIRA era a única opção que existia.',
    como:
      'POST /braco/ver {"pin":"..."} depois POST /braco/agir ' +
      '{"pin":"...","acao":"click","args":{"ref":"e5"}}. Mesmo PIN do PWA.',
    armadilha:
      'Toda ação que muda a tela devolve snapshot_venceu:true e invalida as refs — ' +
      'chame /braco/ver de novo. Recusa com 409 se o laço local estiver ocupado.',
    palavras: ['braco', 'pilot', 'forgepilot', 'delegar', 'agente local',
               'modelo local', 'computer use', 'instrumento', 'maos', 'olhos'],
  },
];

// Mesma régua que o motor anuncia: prefixo de 5 sem acento. Escrita aqui em
// vez de importada porque o motor é C# — duas implementações da mesma regra é
// dívida conhecida, e fica declarada em vez de escondida.
function _semAcento(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function _casa(intencao, palavras) {
  const alvo = _semAcento(intencao);
  const termos = alvo.split(/[^a-z0-9]+/).filter(Boolean);
  for (const p of palavras) {
    const chave = _semAcento(p);
    if (chave.includes(' ')) {
      if (alvo.includes(chave)) return true;
      continue;
    }
    for (const termo of termos) {
      if (termo === chave) return true;
      const n = Math.min(5, chave.length, termo.length);
      if (n >= 3 && chave.slice(0, n) === termo.slice(0, n)) return true;
    }
  }
  return false;
}

function _sonda(url, timeoutMs, marca) {
  // 🔴 REPROVADO pelo revisor em 14/09, e o defeito era esta linha:
  // `resolve(res.statusCode > 0)` -- QUALQUER resposta virava "disponivel".
  // Servico quebrado devolvendo 500 contava como no ar; e pior, OUTRO
  // programa ocupando a mesma porta e devolvendo 404 tambem contava. O campo
  // `disponivel` prometia prontidao e entregava "tem alguem no socket".
  // Agora exige 2xx E a marca do contrato no corpo: quem responde tem que
  // dizer o proprio nome.
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs || 1200 }, (res) => {
        const ok2xx = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok2xx) { res.resume(); resolve(false); return; }
        if (!marca) { res.resume(); resolve(true); return; }
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (corpo.length < 4096) corpo += c; });
        res.on('end', () => resolve(corpo.indexOf(marca) !== -1));
        res.on('error', () => resolve(false));
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch (e) {
      resolve(false);
    }
  });
}

async function companheirosPara(intencao) {
  const achados = [];
  for (const s of SERVICOS_COMPANHEIROS) {
    if (!_casa(intencao, s.palavras)) continue;
    const vivo = await _sonda(s.sonda, 1200, s.marca);
    achados.push({
      nome: s.nome,
      disponivel: vivo,
      o_que_e: s.o_que_e,
      quando_usar: s.quando_usar,
      como: s.como,
      armadilha: s.armadilha,
      nota: vivo
        ? 'no ar agora'
        : 'NAO esta respondendo agora — o servico existe, mas precisa ser iniciado',
    });
  }
  return achados;
}

async function callTool(name, args) {
  if (easyTools.names.has(name)) return easyTools.call(name, args || {});
  args = args || {};

  switch (name) {
    case 'aipm_ja_faz': {
      requireArg(args, 'intent');
      const r = await apiGet('/?q=' + encodeURIComponent(args.intent));
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      const out = r.json || {};
      // Rotas do motor primeiro; companheiros DEPOIS e rotulados. A ordem não é
      // estética: quando o motor cobre o caso, ele é o caminho preferido (passa
      // pelo portão e pelo ledger). O companheiro entra para o que o motor não
      // alcança — e é justamente esse caso que antes devolvia silêncio.
      const comp = await companheirosPara(args.intent);
      if (comp.length) {
        out.companheiros = comp;
        const vivos = comp.filter((c) => c.disponivel).length;
        const nenhumaRota = !(out.encontrados && out.encontrados.length);
        out.next_action =
          (nenhumaRota
            ? 'NENHUMA rota do motor casou, MAS existe serviço companheiro nesta máquina que atende: veja `companheiros`. '
            : 'Veja também `companheiros`: serviço desta máquina que não é rota do motor e pode atender melhor. ') +
          (vivos === comp.length
            ? ''
            : 'ATENÇÃO: nem todos estão no ar — leia `disponivel` antes de chamar. ') +
          (out.next_action || '');
      }
      return out;
    }
    case 'health_check': {
      try {
        const r = await apiGet('/', 3000);
        if (r.status >= 400) return enrichApiError(r.status, r.json);
        const b = (r && r.json) || {};

        // O catálogo de rotas de GET / (51 endpoints, 7.371 bytes medidos em 29/08) NÃO
        // entra aqui. health_check é o passo 1 obrigatório, então tudo que ele despeja é
        // pago por TODA sessão, sempre — e quem responde "o AIPM já faz isso?" é o
        // aipm_ja_faz, por intenção, sem o despejo. Curadoria é o produto.
        const u = b.update || {};
        const update = {
          enabled: u.enabled === true,
          current: u.current || b.version || null,
          latest: u.latest || null,
          update_available: !!(u.latest && u.current && u.latest !== u.current),
        };

        const fp = await forgepilotStatus();
        const warnings = [];

        // O aviso que faltava: braço instalado e PARADO não avisava nada, e o agente só
        // descobria depois de bater em foco_nao_aplicado (mural seq 1386/1387).
        if (fp && fp.installed && !fp.running) {
          warnings.push({
            code: 'forgepilot_instalado_parado',
            message:
              'The ForgePilot arm is INSTALLED but NOT RUNNING' +
              (fp.port_responding ? '' : ' (its local port is not responding)') +
              '. It is the real-input executor: the supported path when focus_window fails ' +
              'with foco_nao_aplicado, or when a surface only answers to a real mouse. ' +
              'Right now that path is unavailable.',
            next_action:
              'Most tasks do NOT need it: prefer ui_invoke / ui_set_value / ui_select_option, ' +
              'which act through UI Automation and work with the window in the background. ' +
              'Only if you genuinely need real input, ask the user to start the arm ' +
              '(POST /forgepilot/start on the local API — there is no MCP tool for it), then ' +
              'poll GET /forgepilot/status until port_responding is true.',
          });
        }
        if (fp && !fp.installed) {
          warnings.push({
            code: 'forgepilot_nao_instalado',
            message:
              'The ForgePilot arm (real-input executor) is not installed, so there is no ' +
              'fallback for surfaces that refuse UI Automation.',
            next_action:
              'Stay on ui_invoke / ui_set_value / ui_select_option — they need no arm and no ' +
              'foreground. If a target answers to neither, report it with ' +
              'report_action_outcome instead of looping on ui_send_keys.',
          });
        }
        if (!fp) {
          warnings.push({
            code: 'forgepilot_status_desconhecido',
            message: 'Could not read the ForgePilot arm state from the local API.',
            next_action:
              'Proceed with ui_invoke / ui_set_value / ui_select_option (they do not depend ' +
              'on the arm). Do not assume the arm is available.',
          });
        }

        return {
          ok: true,
          api_url: API,
          mcp_version: VERSION,
          backend: {
            name: b.name || null,
            version: b.version || null,
            status: b.status || null,
            update,
          },
          // A distinção que decide a primeira ação de toda sessão.
          executor: {
            uia: 'aipm',
            real_input: 'forgepilot',
            // Primeiro campo depois dos dois nomes, de proposito: este bloco e lido no
            // passo 1 de toda sessao, e ate 05/09 ele descrevia DUAS familias sem dizer
            // que existe uma rota que escolhe entre elas. Quem so lia isto nunca achava.
            by_intent:
              'ui_act — the route that DECIDES, and the one to try first for click / type / pick. ' +
              'It attempts UI Automation, drops to real input by itself ONLY when UIA reports the pattern is ' +
              'missing, and answers mecanismo: uia | fisico so you know whether you paid the foreground price. ' +
              'It also REFUSES an ambiguous target (HTTP 409) and returns the candidates with their rect, instead ' +
              'of silently taking the first name match the way the by_element tools do. Prefer it whenever the ' +
              'target name may not be unique, or ui_set_value already returned valor_nao_aplicado.',
            by_element:
              'ui_invoke / ui_set_value / ui_select_option — UI Automation. NO foreground, ' +
              'NO focus needed: they work with the target window BEHIND others while the ' +
              'user keeps working. This is the default; do not call focus_window "just in ' +
              'case" before them.',
            by_synthetic_input:
              'ui_send_keys / ui_drag — real keyboard/mouse. Windows delivers these to the ' +
              'FOREGROUND window, not to the hwnd you pass, so they REQUIRE focus_window ' +
              'and refuse with janela_nao_esta_em_primeiro_plano. Last resort only, after ' +
              'the by-element route actually failed on that element.',
          },
          forgepilot: fp || { status: 'unknown' },
          warnings,
          endpoints:
            'omitted on purpose (7.4 KB of route catalogue). Ask aipm_ja_faz("what you want ' +
            'to do") — it owns the catalogue and answers by intent.',
        };
      } catch (e) {
        return mapThrownError(e);
      }
    }
    case 'check_process': {
      const q = new URLSearchParams();
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.title_contains) q.set('title_contains', args.title_contains);
      const r = await apiGet('/processes?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      let procs = (r.json.processes || []).map((p) => slimProcess(p, args.full_command_line === true));
      procs.sort(
        (a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || (b.cpu_percent - a.cpu_percent)
      );
      const out = {
        running: procs.length > 0,
        matches: procs.length,
        processes: procs.slice(0, 10),
      };
      if (procs.length > 10)
        out.note = 'showing 10 of ' + procs.length + ' (windowed processes first)';
      return out;
    }
    case 'list_processes': {
      const r = await apiGet('/processes');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      const top = Math.max(1, Math.min(200, args.top || 25));
      const procs = (r.json.processes || [])
        .slice(0, top)
        .map((p) => slimProcess(p, args.full_command_line === true));
      return { count: r.json.count, processes: procs };
    }
    case 'list_windows': {
      const r = await apiGet('/windows');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_system_status': {
      const r = await apiGet('/system');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_taskbar': {
      const r = await apiGet('/taskbar');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_recent_events': {
      const q = new URLSearchParams();
      if (args.type) q.set('type', args.type);
      q.set('limit', String(Math.max(1, Math.min(1000, args.limit || 50))));
      const r = await apiGet('/events/history?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'read_window': {
      const q = new URLSearchParams();
      if (args.title_contains) q.set('title_contains', args.title_contains);
      if (args.hwnd) q.set('hwnd', String(args.hwnd));
      if (args.max_chars) q.set('max_chars', String(args.max_chars));
      const r = await apiGet('/window/text?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_ui_tree': {
      const q = new URLSearchParams();
      if (args.title_contains) q.set('title_contains', args.title_contains);
      if (args.hwnd) q.set('hwnd', String(args.hwnd));
      if (args.depth) q.set('depth', String(args.depth));
      if (args.max_nodes) q.set('max_nodes', String(args.max_nodes));
      const r = await apiGet('/ui/tree?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'wait_for': {
      const q = new URLSearchParams();
      const conds = [
        'process_ended',
        'process_started',
        'file_stable',
        'file_exists',
        'window_title_contains',
      ];
      for (const c of conds) if (args[c]) q.set(c, args[c]);
      // O SINO DO MURAL. Aceita 0 e a palavra 'now', entao nao da para usar
      // truthiness: 0 e um ponto de partida VALIDO ("me avise a partir da primeira")
      // e cairia fora do laco acima em silencio.
      if (args.note_after_seq != null && args.note_after_seq !== '')
        q.set('note_after_seq', String(args.note_after_seq));
      if (args.stable_for) q.set('for', String(args.stable_for));
      const timeout = Math.max(1, Math.min(50, args.timeout || 50));
      q.set('timeout', String(timeout));
      const r = await apiGet('/wait?' + q.toString(), (timeout + 10) * 1000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_find': {
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.role) q.set('role', args.role);
      if (args.limit != null) q.set('limit', String(args.limit));
      if (args.offset != null) q.set('offset', String(args.offset));
      const r = await apiGet('/ui/find?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_find_at': {
      const q = winQuery(args);
      q.set('x', String(args.x));
      q.set('y', String(args.y));
      const r = await apiPost('/ui/find_at?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_act': {
      requireArg(args, 'intent');
      const intencao = String(args.intent).trim().toLowerCase();
      // Recusa local antes do round-trip. O motor recusaria igual (intencao_invalida /
      // falta_texto / falta_opcao), mas em portugues e depois de uma ida a rede — e o
      // vocabulario fechado so ensina se a lista aparecer JUNTO da recusa.
      if (['clicar', 'escrever', 'escolher'].indexOf(intencao) < 0) {
        throw new Error(
          'ui_act: intent accepts exactly three values, and they are Portuguese: clicar (click), ' +
            'escrever (type, with text=), escolher (pick from a list, with option=). Received: "' +
            args.intent + '".'
        );
      }
      if (intencao === 'escrever') requireArg(args, 'text');
      if (intencao === 'escolher') requireArg(args, 'option');

      const q = winQuery(args);
      q.set('intencao', intencao);
      if (args.text != null) q.set('texto', String(args.text));
      if (args.option != null) q.set('opcao', String(args.option));
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.role) q.set('role', args.role);
      // Teto proprio: a tentativa UIA sozinha ja tem 10 s de timeout no motor, e a queda
      // para fisico ainda clica, espera o foco assentar e digita relendo para confirmar.
      // O default do cliente abortaria a chamada antes de a API responder.
      const r = await apiPost('/ui/act?' + q.toString(), 25000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_invoke': {
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      const r = await apiPost('/ui/invoke?' + q.toString());
      if (r.status >= 400) return apontaUiAct(enrichApiError(r.status, r.json));
      return r.json;
    }
    case 'ui_set_value': {
      requireArg(args, 'value');
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      q.set('value', String(args.value));
      const r = await apiPost('/ui/set_value?' + q.toString());
      if (r.status >= 400) return apontaUiAct(enrichApiError(r.status, r.json));
      return r.json;
    }
    case 'ui_send_keys': {
      if (args.text == null && args.key == null) {
        throw new Error('ui_send_keys: informe text e/ou key (enter|tab|escape|backspace|delete|home|end)');
      }
      const q = winQuery(args);
      if (args.text != null) q.set('text', String(args.text));
      if (args.key != null) q.set('key', String(args.key));
      // Teto proprio: a rota espera ate 2,5 s relendo a janela para confirmar que o
      // texto chegou (SendInput e assincrono), e ainda ha o custo da leitura da
      // arvore. O default do cliente abortaria antes de a API responder.
      const r = await apiPost('/ui/send_keys?' + q.toString(), 20000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_drag': {
      const q = winQuery(args);
      const porIndice = args.from_index != null && args.to_index != null;
      const porPixel =
        args.from_x != null && args.from_y != null && args.to_x != null && args.to_y != null;
      if (!porIndice && !porPixel) {
        throw new Error(
          'ui_drag needs either from_index + to_index (preferred: the ledger records the ' +
            'element role) or all four of from_x, from_y, to_x, to_y (absolute screen pixels, ' +
            'for canvas/GDI surfaces with no UIA tree).'
        );
      }
      if (porIndice) {
        q.set('from_index', String(args.from_index));
        q.set('to_index', String(args.to_index));
      } else {
        for (const k of ['from_x', 'from_y', 'to_x', 'to_y']) q.set(k, String(args[k]));
      }
      if (args.steps != null) q.set('steps', String(args.steps));
      if (args.hold_ms != null) q.set('hold_ms', String(args.hold_ms));
      const r = await apiPost('/ui/drag?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_select_option': {
      requireArg(args, 'option');
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      q.set('option', String(args.option));
      // Expand + re-travessia da árvore em Chromium é lento: teto próprio, maior
      // que o default, para não abortar no cliente antes de a API responder.
      const r = await apiPost('/ui/select_option?' + q.toString(), 20000);
      if (r.status >= 400) return apontaUiAct(enrichApiError(r.status, r.json));
      return r.json;
    }
    case 'focus_window': {
      const q = winQuery(args);
      const r = await apiPost('/ui/focus?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'check_file': {
      requireArg(args, 'path');
      const r = await apiGet('/filesystem/watch?path=' + encodeURIComponent(args.path));
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_app_knowledge': {
      requireArg(args, 'name');
      const r = await apiGet('/knowledge/app?name=' + encodeURIComponent(args.name));
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      const k = r.json;
      if (!k || typeof k !== 'object' || Array.isArray(k)) return k;

      // O endpoint devolve a app INTEIRA: em chrome.exe são 17.631 B (~4.4k tokens,
      // medido 21/08/2026) — mais caro que o screenshot que este produto existe para
      // evitar. Filtramos aqui no cliente porque a economia que importa é a do
      // CONTEXTO do agente, e assim o motor não precisa de rebuild.
      //
      // TODO corte é declarado em *_omitted + next_action. Teto silencioso é o defeito
      // que mais custou medição errada neste projeto (limit= do /ui/find parava em 200
      // e o de /analytics/actions em 500, ambos sem avisar), e não vamos repeti-lo aqui.
      const top = args.top == null ? 8 : Math.max(1, Math.min(500, args.top));
      const wantRole = args.role == null ? null : String(args.role).toLowerCase();
      const wantAction = args.action == null ? null : String(args.action).toLowerCase();
      const hasFilter = wantRole != null || wantAction != null;

      // role/action null no registro = "qualquer" — não deve ser excluído por um filtro.
      const matches = (x) => {
        if (wantRole != null) {
          const role = x.element_role == null ? null : String(x.element_role).toLowerCase();
          if (role != null && role !== wantRole) return false;
        }
        if (wantAction != null) {
          const act = x.action == null ? null : String(x.action).toLowerCase();
          if (act != null && act !== wantAction) return false;
        }
        return true;
      };

      const out = Object.assign({}, k);
      const cortes = [];

      if (Array.isArray(k.recipes)) {
        const hits = k.recipes.filter(matches);
        out.recipes = hits.slice(0, top);
        out.recipes_total = k.recipes.length;
        out.recipes_matched = hits.length;
        if (hits.length > out.recipes.length) {
          out.recipes_omitted = hits.length - out.recipes.length;
          cortes.push('recipes');
        }
      }

      // common_failures nunca é filtrado por role/action: um alvo que NUNCA funcionou
      // é justamente o que você precisa ver antes de tentar, mesmo procurando outro.
      if (Array.isArray(k.common_failures)) {
        out.common_failures = k.common_failures.slice(0, top);
        if (k.common_failures.length > out.common_failures.length) {
          out.common_failures_omitted = k.common_failures.length - out.common_failures.length;
          cortes.push('common_failures');
        }
      }

      // ui_shape é mapa de partida a frio: útil ANTES do primeiro ui_find, inútil depois.
      if (!args.include_shape && out.ui_shape) {
        delete out.ui_shape;
        out.ui_shape_omitted = true;
        cortes.push('ui_shape');
      }

      if (cortes.length) {
        out.next_action =
          'Resposta FILTRADA para poupar contexto (cortado: ' + cortes.join(', ') + '). ' +
          'Para ver mais: top=<n>' + (hasFilter ? ', ou remova role=/action=' : '') +
          ', include_shape=true. Nada foi perdido no servidor — só não foi devolvido aqui.';
      }
      return out;
    }
    case 'read_notes': {
      const q = new URLSearchParams();
      if (args.subject != null) q.set('subject', String(args.subject));
      if (args.para != null) q.set('para', String(args.para));
      if (args.agent != null) q.set('agent', String(args.agent));
      if (args.since != null) q.set('since', String(args.since));
      if (args.after_seq != null) q.set('after_seq', String(args.after_seq));
      // Default baixo de propósito: limit=100 custa ~13k tokens (medido 21/08/2026).
      q.set('limit', String(Math.max(1, Math.min(500, args.limit == null ? 20 : args.limit))));
      const r = await apiGet('/notes?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'post_note': {
      requireArg(args, 'text');
      const q = new URLSearchParams();
      q.set('agent', clientName);
      q.set('text', String(args.text));
      if (args.subject != null) q.set('subject', String(args.subject));
      if (args.kind != null) q.set('kind', String(args.kind));
      const r = await apiPost('/notes?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_economy_stats': {
      const r = await apiGet('/analytics/summary');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_audit_log': {
      const limit = Math.max(1, Math.min(1000, args.limit || 50));
      const r = await apiGet('/audit?limit=' + limit);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'report_task_outcome': {
      requireArg(args, 'app');
      const q = new URLSearchParams();
      q.set('agent', clientName);
      if (args.task != null) q.set('task', String(args.task));
      q.set('app', String(args.app));
      if (args.success != null) q.set('success', args.success ? 'true' : 'false');
      if (args.steps != null) q.set('steps', String(args.steps));
      if (args.tokens_estimated != null) q.set('tokens_estimated', String(args.tokens_estimated));
      if (args.duration_s != null) q.set('duration_s', String(args.duration_s));
      if (args.screenshots_avoided != null)
        q.set('screenshots_avoided', String(args.screenshots_avoided));
      if (args.notes != null) q.set('notes', String(args.notes));
      const r = await apiPost('/telemetry/task?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'report_action_outcome': {
      requireArg(args, 'app');
      requireArg(args, 'action');
      const q = new URLSearchParams();
      q.set('agent', clientName);
      q.set('app', String(args.app));
      if (args.element_role != null) q.set('element_role', String(args.element_role));
      if (args.element_name != null) q.set('element_name', String(args.element_name));
      q.set('action', String(args.action));
      if (args.ok != null) q.set('ok', args.ok ? 'true' : 'false');
      if (args.ms != null) q.set('ms', String(args.ms));
      // reason= só faz sentido com ok=false; o backend normaliza para o vocabulário
      // fechado (texto livre vira "outro"), então repassar é seguro.
      if (args.reason != null) q.set('reason', String(args.reason));
      const r = await apiPost('/telemetry/action?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

function toolResultText(obj) {
  return JSON.stringify(obj, null, 2);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }

  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      if (params && params.clientInfo && params.clientInfo.name)
        clientName = String(params.clientInfo.name).slice(0, 40);
      API = resolveApiBase();
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-process-manager', version: VERSION },
        instructions: MCP_PROFILE === 'easy' ? EASY_INSTRUCTIONS : SERVER_INSTRUCTIONS,
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification — no reply
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments);
        // Um erro que nao se apresenta como erro tem efeito indistinguivel de nao ter
        // havido erro nenhum. Medido pelo revisor em dbctions.jsonl, com denominador
        // exato: depois de send_keys dar certo, 172/828 = 20,8% dos agentes focaram a
        // janela; depois de uma falha que NAO nomeia o remedio, 17/80 = 21,2% (igual a
        // nao ter erro); depois de uma RECUSA que NOMEIA o remedio, 29/65 = 44,6%.
        // O `api_error` do enrichApiError chegava com isError:false, entao todo 400 com
        // `receita_melhor` — o conserto que existe para corrigir o agente NO MOMENTO da
        // falha — chegava marcado como se nada tivesse falhado (achado do codex, mural
        // seq 1415: sonda stdio na mesma sessao deu connection_refused isError:true e
        // /ui/find em janela ausente HTTP 404 isError:false).
        //
        // Por que da para acender TODO 4xx/5xx sem falso positivo: a API responde
        // "nao achei / vazio / ainda nao" com HTTP 200, nunca com 4xx. Verificado nos
        // tres casos que pareciam risco — check_file em caminho inexistente devolve 200
        // {exists:false} (Api.cs:1229), get_app_knowledge de app desconhecido devolve
        // sempre JsonOk (Api.cs:4650), e wait_for estourando o prazo devolve 200
        // {satisfied:false} (Api.cs:4232). Os 4xx que sobram sao todos falha de verdade:
        // 400 argumento invalido, 403 action_denied, 404 janela_nao_encontrada, 405
        // metodo errado. Leitura vazia legitima NAO passa por aqui.
        //
        // A chave e `http_status` e nao a lista de codigos: o enrichApiError so escreve
        // esse campo no ramo `status >= 400`, entao ele e estrutural. A lista de codigos
        // fica para o que nasce no proprio bridge (connection_refused, ETIMEDOUT), que
        // nunca tem http_status. Nao vale depender de `code === 'api_error'`: ele vem de
        // `out.code || 'api_error'`, ou seja, some no dia em que a API mandar um `code`
        // proprio no corpo (hoje ela nao manda — 0 ocorrencias de `"code"` em Api.cs e
        // Server.cs, contra 26 de `"error"`).
        const isError =
          result &&
          typeof result === 'object' &&
          result.ok === false &&
          (easyTools.names.has(params.name) ||
            typeof result.http_status === 'number' && result.http_status >= 400 ||
            result.code === 'connection_refused' ||
            result.code === 'ETIMEDOUT' ||
            result.code === 'api_paused' ||
            result.code === 'action_denied' ||
            result.code === 'api_error' ||
            result.error === 'connection_refused');
        const structured = result && typeof result === 'object' ? result : { result };
        reply(id, {
          content: [{ type: 'text', text: toolResultText(result) }],
          isError: !!isError,
          structuredContent: structured,
        });
      } catch (e) {
        const payload =
          e.code === 'invalid_params'
            ? {
                ok: false,
                error: 'invalid_params',
                message: e.message,
                next_action: 'Fix the tool arguments and retry.',
              }
            : mapThrownError(e);
        reply(id, {
          content: [{ type: 'text', text: toolResultText(payload) }],
          isError: true,
        });
      }
    } else if (id !== undefined) {
      replyError(id, -32601, 'method not supported: ' + method);
    }
  } catch (e) {
    logErr(method + ': ' + e.message);
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});
