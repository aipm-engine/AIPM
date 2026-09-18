# AI Process Manager — MCP Server

**Structured Windows state for AI agents — no screenshots.**

This MCP server exposes the [AI Process Manager](https://github.com/aipm-engine/AIPM) local HTTP API as tools for Claude Desktop, Cursor, and any MCP client. Instead of capturing pixels (~2,765 tokens per 1080p screenshot), agents read **JSON and text** (~15–150 tokens per query) from processes, windows, consoles, and UI Automation trees.

> **Requires:** AIProcessManager.exe running on Windows (system tray). Node.js ≥ 14. Zero npm dependencies.

<!-- mcp-name: io.github.agorapassadoagora-debug/AIPM -->

## Why this exists

Computer-use agents often "look" at the desktop via screenshots. That is slow (3–5 s), expensive in tokens, and sends pixel data through the model. AIPM answers structured questions on loopback:

| Question | Screenshot | AIPM tool |
|----------|------------|-----------|
| Is the render still running? | ~2,765 tokens | `check_process` → ~15 tokens |
| What's the console output? | screenshot + OCR | `read_window` → ~30 tokens |
| Did the export finish? | poll + screenshots | `wait_for(file_stable=...)` → one call |

**~94–98% fewer perception tokens per action** vs screenshots (2,765 → ~60 tokens per query; the two inputs are the `assumptions` block of `GET /analytics/summary`, not a benchmark).

## Quick start

### 1. Start the backend
Ensure `AIProcessManager.exe` is running in your system tray.

### 2. Configure your MCP client

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-process-manager": {
      "command": "node",
      "args": ["C:\\path\\to\\ai-process-manager\\mcp\\server.js"]
    }
  }
}
```

Cursor and other stdio MCP clients take the same `command` / `args` pair. Optional env var
`AIPM_API` overrides the API base URL (default: read from
`%LOCALAPPDATA%\AIProcessManager\endpoint.txt`, else `http://127.0.0.1:9147`).

Optional env var `AIPM_AGENT_NAME` names **this agent** in the API's activity log (default `mcp`).
Every request is sent with `User-Agent: AIPM-Agent/<name> (<client>) mcp:<client>`, and the API
extracts `<name>` into the `agent` field of `/audit`, `/activity` and `/notes`. Use it when several
agents share one MCP client, so `GET /activity` can tell them apart:

```json
"env": { "AIPM_AGENT_NAME": "revisor" }
```

The name is normalized to `[a-z0-9._-]`, max 40 chars. **It is an identity the caller declares about
itself — observability and coordination only, never authorization.** Anyone can write any name here;
nothing in the product grants or denies permission based on it. The only barrier remains the
deny-by-default action allowlist, which is per **app**.

### 3. Restart the MCP client
Tools appear as `ai-process-manager`. Call `health_check` first.

## Tools (28)

The 15 perception tools and the two UI probes are annotated `readOnlyHint: true` — clients may
auto-approve them. The seven UI actions are `readOnlyHint: false` and refuse to run unless the user
opts in (see [Privacy](#privacy)).

| Tool | Title | Endpoint |
|---|---|---|
| `aipm_ja_faz` | Does the AIPM already do this? Ask before writing code or reaching for the shell | `GET /?q=` |
| `health_check` | Status + which action family to use + real-input arm state | `GET /` + `GET /forgepilot/status` |
| `check_process` | Check if a process is running | `GET /processes` |
| `list_processes` | List running processes | `GET /processes` |
| `list_windows` | List open windows | `GET /windows` |
| `get_system_status` | Get system status (CPU, RAM, GPU, disk) | `GET /system` |
| `get_taskbar` | Show taskbar apps | `GET /taskbar` |
| `read_window` | Read text from a window | `GET /window/text` |
| `get_ui_tree` | Get a window's UI element tree | `GET /ui/tree` |
| `wait_for` | Wait until a condition is met | `GET /wait` |
| `get_recent_events` | List recent PC events | `GET /events/history` |
| `check_file` | Check a file or folder | `GET /filesystem/watch` |
| `get_app_knowledge` | Get learned recipes for an app | `GET /knowledge/app` |
| `get_economy_stats` | Get token economy statistics | `GET /analytics/summary` |
| `get_audit_log` | View API audit log | `GET /audit` |
| `read_notes` | Read the local agent noticeboard | `GET /notes` |

**UI tools — state first, then opt-in actions:**

| Tool | Title | Endpoint |
|---|---|---|
| `ui_find` | Find interactive UI elements | `GET /ui/find` |
| `ui_find_at` | Find the UI element under a screen pixel | `POST /ui/find_at` |
| `ui_act` | Act by intent (decides UIA vs real input) | `POST /ui/act` |
| `ui_invoke` | Click a UI element | `POST /ui/invoke` |
| `ui_set_value` | Set the value of a UI field | `POST /ui/set_value` |
| `ui_send_keys` | Type text with synthetic keystrokes (last resort) | `POST /ui/send_keys` |
| `ui_drag` | Drag an element onto another | `POST /ui/drag` |
| `ui_select_option` | Select an option in a dropdown | `POST /ui/select_option` |
| `focus_window` | Bring a window to the foreground | `POST /ui/focus` |

**Local telemetry (writes to the local store, metadata only):**

| Tool | Title | Endpoint |
|---|---|---|
| `report_task_outcome` | Report task outcome (telemetry) | `POST /telemetry/task` |
| `report_action_outcome` | Report UI action outcome (telemetry) | `POST /telemetry/action` |

**Local agent coordination (stored only on this machine):**

| Tool | Title | Endpoint |
|---|---|---|
| `post_note` | Post a note to the agent noticeboard | `POST /notes` |

### Reading deep UI trees (Chromium/Electron)

`get_ui_tree` defaults to `depth=4`, which is enough for native Win32 apps. Chromium/Electron
apps (VS Code, Slack, Discord, Claude Desktop, Teams) bury content under ~10 levels of
`Pane`/`Group` wrappers — at low depth the response is only empty panes. Ask for `depth=15-20`
there (max 30) and cap cost with `max_nodes` (default 200, max 1000): **`max_nodes` is the cost
brake, not `depth`.** When the response has `truncated: true`, the tree was cut — repeat with a
higher `depth`/`max_nodes` before concluding anything about the window.

### Acting: two families, and picking the wrong one is the classic failure

This is the part agents get wrong by default, because every other computer-use tool they have
ever seen needs the window in front. Here, most of them do not:

**`ui_act` picks between the two families below for you — try it first for click / type / pick.**
It attempts UI Automation and drops to real input by itself only when UIA reports the pattern is
missing on that element (never for `intent=escolher`, where a physical click would trigger the
element instead of picking an option inside it), and tells you which one ran in `mecanismo`
(`uia`/`fisico`). It also refuses an ambiguous target with `409 alvo_ambiguo` and hands back the
candidates with their `rect`, instead of silently taking the first name match the way the tools
below do. Read on for what each family means and when to call one of them directly instead.

| Family | Tools | Needs the window in the foreground? |
|---|---|---|
| **By element** (UI Automation) | `ui_invoke`, `ui_set_value`, `ui_select_option` | **No.** Works with the window *behind* others, unfocused, while the user keeps typing elsewhere. |
| **By synthetic input** | `ui_send_keys`, `ui_drag` | **Yes.** Refuses with `janela_nao_esta_em_primeiro_plano` otherwise. |

Why: the first family talks to the app's accessibility provider and ignores z-order; the second
emits real keyboard/mouse events, which Windows delivers to whatever is in the foreground — not
to the `hwnd` you passed.

**Calling the families directly: start with by-element, every time.** Do not call `focus_window`
"just in case" before it: that steals the user's foreground and buys nothing. Reach for `ui_send_keys` only
after `ui_set_value` actually returned `valor_nao_aplicado` on that field (a `contenteditable`
in a controlled framework), and for `ui_drag` only for what genuinely only moves by dragging —
there is no UIA pattern for dragging.

If `focus_window` itself fails with `foco_nao_aplicado`, do not loop on the second family: it
cannot succeed without the foreground. `health_check` reports the real-input arm (ForgePilot)
under `executor`/`forgepilot`, and warns when it is installed but stopped.

## Privacy

**No data about you leaves the machine. There is no remote telemetry, no cloud service, and no
account.** There is exactly one outbound request, it carries nothing about you, and you can turn it
off:

> **Update check.** Once a day the engine asks GitHub's public Releases API whether a newer version
> exists. The request goes to GitHub, not to us: no identifier, no telemetry, nothing about your machine
> or your apps. It can be switched off in the tray menu, and when off no outbound request is made at all.
> Everything else in AIPM remains local.

### Network
- The backend listens on the **loopback interface only** (`127.0.0.1:9147`) — not on `0.0.0.0`,
  so nothing on the LAN can reach it.
- Every request must carry a `Host` header of `localhost` or `127.0.0.1`; anything else is
  rejected with `403 forbidden_host` (anti DNS-rebinding, so a web page you visit cannot drive
  the API).
- This MCP server makes exactly one kind of outbound call: HTTP to that local address. It sends
  a `User-Agent` of `mcp:<your MCP client name>` so the local audit log shows which agent asked.

### Read-only by default
- The 15 perception tools plus `ui_find` are plain reads. `ui_find_at` is also semantically
  read-only, but its pixel probe uses a guarded `POST`; all 17 carry `readOnlyHint: true`.
- The 7 UI action tools (`ui_act`, `ui_invoke`, `ui_set_value`, `ui_send_keys`, `ui_drag`,
  `ui_select_option`, `focus_window`) return `403 action_denied` until the user does **both**:
  enable *Agent actions* in the tray menu and add the target process to a per-app allowlist.
  Neither is on by default, and the setting is per app — allowing Notepad does not allow the browser.

### What the telemetry stores — metadata only
Recorded: app/process name, element role (`Button`, `Edit`…), the element name **the agent
asked for**, the action (`invoke`/`set_value`/`focus`), success or failure, duration in ms, and a
failure reason. Two mechanical invariants make "metadata only" verifiable rather than a promise:

1. **An action record stores what the agent requested, not what the app displayed.** The role and
   name come from the agent's own `role=`/`name_contains=` arguments. The name of the element
   actually resolved on screen is never written, so what the tool *saw* never becomes telemetry.
2. **The failure reason is a closed vocabulary** (`elemento_nao_encontrado`, `ui_timeout`,
   `erro_uia`, `outro`, …). Any other string is stored as `outro`. An exception message — which
   could carry a file path or on-screen text — therefore cannot reach the disk.

**Never stored:** screen contents, window text read by `read_window`, the text typed by
`ui_set_value` (`value=`), file contents, keystrokes, screenshots. The passively learned UI shape
(`ui_shape`) holds only counts, UIA role names, depth and booleans: `exposes_text` says *whether*
text exists, `named_controls` says *how many* elements have a name — never the text itself.

**Masking:** before any request is recorded, `value=` and `api_key=` are replaced with `***`, so
neither `get_audit_log` nor the on-disk query log can reveal typed text or a secret.

**One honest nuance:** the audit/query log stores the request line, so *other* query arguments
stay readable — e.g. `check_file(path=D:/videos/out.mp4)` is logged as that path, and
`check_process(title_contains=...)` keeps that fragment. It is a local log of what the agent
asked for. Only `value=` and `api_key=` are masked.

### Where the data lives, and how to delete it
Everything is under `%LOCALAPPDATA%\AIProcessManager\`:

| Path | Contents |
|---|---|
| `db\*.jsonl`, `db\rollup.json` | telemetry: tasks, actions, queries, UI shapes, counters |
| `ledger.jsonl` | tamper-evident hash-chained log of reported/executed actions (metadata only) |
| `actions.cfg` | whether the action tier is on + the per-app allowlist |
| `update.json` | update-check preference (on/off) and its cache: last check time, latest tag, dismissed tag |
| `log.txt`, `endpoint.txt` | app log and the API address currently in use |

To erase: quit the app from the tray, then delete the folder (or just `db\` to reset learning and
the economy counters; deleting `actions.cfg` turns the action tier back off). Nothing is written
anywhere else, and the `/audit` ring buffer lives in memory only — it disappears when the app
closes. You can inspect everything the store holds with `get_audit_log`, `get_economy_stats`, and
`GET /analytics/actions`.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `connection_refused` | AIProcessManager.exe is not running | Start it from the Start menu (green tray icon) |
| `action_denied` | Action tier off, or app not in the allowlist | Tray menu → *Agent actions*, then allow that app |
| `api_paused` | The user paused the API from the tray | Tray menu → *Resume API* |
| Empty `Pane` tree | `depth` too low for a Chromium/Electron app | Retry `get_ui_tree` with `depth=17` |

Every error payload carries a `next_action` field with the same guidance.
## Coverage (measured, honest)

| Stack | Read state | Semantic actions |
|-------|-----------|------------------|
| Win32 / WinForms / WPF / UWP | ✅ full | ✅ |
| **Delphi VCL** (legacy business apps) | ✅ full | ✅ |
| Console (cmd, PowerShell, Windows Terminal) | ✅ text | — |
| **Chromium / Electron** (Chrome, Cursor, Claude Desktop) | ✅ after waking the a11y tree | ✅ |
| Electron on the legacy MSAA bridge (e.g. Discord) | ⚠️ wakes, but ~120 ms/node — too slow today | ⚠️ |
| Java Swing | ⚠️ needs the Java Access Bridge | roadmap |

We publish what does **not** work yet on purpose — you should know the edges before relying on it.

> **Behaviour note:** the first read of a Chromium/Electron window asks it to activate its accessibility
> tree — the same standard request a screen reader makes. That app then keeps computing accessibility
> data (a CPU cost in *that* app) and does not go back to sleep on its own. Native Win32 apps are
> unaffected.

## Free vs paid

- **Free & open (MIT):** this MCP server.
- **Free (closed):** the `AIProcessManager.exe` backend — the sensor. Yours to run at no cost.
- **Paid:** **AIPM Pilot**, the autonomous computer-use agent that drives apps end-to-end using AIPM's
  structured perception.

## Support the project

If AIPM saves you tokens, consider [sponsoring](https://github.com/sponsors/agorapassadoagora-debug).

## License

[MIT](LICENSE) for the MCP server. The backend and AIPM Pilot are separate products.
