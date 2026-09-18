'use strict';

const { CONTRACT_VERSION, CAPABILITIES, findCapability } = require('./capabilities');
const { queryRecipes } = require('./easy-recipes');

const ACTION_TO_INTENT = Object.freeze({ click: 'clicar', fill: 'escrever', select: 'escolher' });
const EXECUTIONS = new Set(['not_started', 'running', 'completed', 'unknown']);
const EFFECTS = new Set(['confirmed', 'refuted', 'unknown']);
const RETRIES = new Set(['not_needed', 'reconcile', 'forbidden', 'allowed']);

function objectSchema(properties, required) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function outputSchema() {
  return {
    type: 'object',
    required: ['ok', 'contract_version'],
    properties: {
      ok: { type: 'boolean' },
      contract_version: { type: 'string' },
      execution: { type: 'string', enum: [...EXECUTIONS] },
      effect: { type: 'object' },
      retry: { type: 'string', enum: [...RETRIES] },
      operation_id: { type: 'string' },
      error: { type: 'string' },
    },
  };
}

function definitions() {
  const closed = { openWorldHint: false };
  return [
    {
      name: 'aipm_observe', title: 'Observe AIPM state',
      description: 'Observe one scoped process, window, or UI page. UI controls may include fresh target_ref values. Follow has_more with offset.',
      inputSchema: objectSchema({
        kind: { type: 'string', enum: ['process', 'window', 'ui'] },
        hwnd: { type: 'integer', minimum: 1 }, title_contains: { type: 'string', minLength: 1 },
        name_contains: { type: 'string', minLength: 1 }, role: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 },
      }, ['kind']), outputSchema: outputSchema(),
      annotations: Object.assign({}, closed, { readOnlyHint: true, destructiveHint: false }),
    },
    {
      name: 'aipm_act', title: 'Perform one AIPM action',
      description: 'Perform exactly one click, fill, or select against a fresh opaque target_ref. Reconcile unknown outcomes before retrying.',
      inputSchema: objectSchema({
        target_ref: { type: 'string', minLength: 1 }, action: { type: 'string', enum: Object.keys(ACTION_TO_INTENT) },
        text: { type: 'string', maxLength: 4000 }, option: { type: 'string', minLength: 1 },
      }, ['target_ref', 'action']), outputSchema: outputSchema(),
      annotations: Object.assign({}, closed, { readOnlyHint: false, destructiveHint: true }),
    },
    {
      name: 'aipm_wait', title: 'Reconcile an AIPM operation',
      description: 'Read the receipt for one operation_id (query only). Pass timeout_ms to poll until completed or timeout; the reply declares waited true/false with waited_ms, never claiming a wait that did not happen.',
      inputSchema: objectSchema({ operation_id: { type: 'string', minLength: 1 }, timeout_ms: { type: 'integer', minimum: 0, maximum: 50000 } }, ['operation_id']),
      outputSchema: outputSchema(), annotations: Object.assign({}, closed, { readOnlyHint: true, destructiveHint: false }),
    },
    {
      name: 'aipm_explain', title: 'Explain an AIPM capability',
      description: 'Explain a capability. To consult local app recipes, also pass app, its observed version/layout and all observed preconditions. Recipes are advisory and do not execute actions.',
      inputSchema: objectSchema({ intent: { type: 'string', minLength: 1 },
        app: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 },
        layout: { type: 'string', minLength: 1 },
        preconditions: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 30 },
      }, ['intent']),
      outputSchema: outputSchema(), annotations: Object.assign({}, closed, { readOnlyHint: true, destructiveHint: false }),
    },
  ];
}

function create(ctx) {
  let modern;
  const base = (extra) => Object.assign({ ok: true, contract_version: CONTRACT_VERSION }, extra || {});
  const reject = (error, message, retry) => base({ ok: false, error, message, execution: 'not_started', effect: { status: 'unknown', scope: 'none', check: 'none' }, retry: retry || 'forbidden' });
  const bounded = (value, fallback, max) => Math.max(0, Math.min(max, value == null ? fallback : Number(value) || 0));
  const queryWindow = (args) => {
    const q = new URLSearchParams();
    if (args.hwnd != null) q.set('hwnd', String(args.hwnd));
    else if (args.title_contains) q.set('title_contains', String(args.title_contains));
    return q;
  };
  const normalizeReceipt = (body, fallback) => {
    body = body && typeof body === 'object' ? body : {};
    const rawEffect = body.effect;
    const effect = rawEffect && typeof rawEffect === 'object'
      ? Object.assign({ status: 'unknown', scope: 'procedure', check: 'none' }, rawEffect)
      : { status: EFFECTS.has(rawEffect) ? rawEffect : 'unknown', scope: body.effect_scope || 'procedure', check: body.effect_check || 'none' };
    if (!EFFECTS.has(effect.status)) effect.status = 'unknown';
    const execution = EXECUTIONS.has(body.execution) ? body.execution : (fallback || 'unknown');
    const retry = RETRIES.has(body.retry) ? body.retry : (execution === 'completed' && effect.status !== 'unknown' ? 'not_needed' : 'reconcile');
    return base(Object.assign({}, body, { execution, effect, retry }));
  };
  async function hasModernCore() {
    if (modern !== undefined) return modern;
    try {
      const r = await ctx.apiGet('/');
      const text = JSON.stringify((r && r.json) || {});
      modern = r.status < 400 && text.indexOf('/ui/observe') >= 0 && text.indexOf('/ui/operation') >= 0 && text.indexOf('target_ref') >= 0;
    } catch (_) { modern = false; }
    return modern;
  }
  async function observe(args) {
    const limit = Math.max(1, bounded(args.limit, 30, 200));
    const offset = bounded(args.offset, 0, Number.MAX_SAFE_INTEGER);
    if (args.kind === 'ui') {
      if (args.hwnd == null && !args.title_contains) return reject('target_required', 'Provide hwnd or title_contains.');
      const q = queryWindow(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.role) q.set('role', args.role);
      q.set('limit', String(limit)); q.set('offset', String(offset));
      if (await hasModernCore()) {
        const r = await ctx.apiPost('/ui/observe?' + q.toString(), 15000);
        if (r.status >= 400) return normalizeReceipt(ctx.enrichApiError(r.status, r.json), 'not_started');
        const body = r.json || {};
        return base({ observation: body, refs: (body.controls || []).filter(x => x && x.target_ref).map(x => x.target_ref), refs_available: true, offset: body.offset == null ? offset : body.offset, has_more: body.has_more === true });
      }
      const r = await ctx.apiGet('/ui/find?' + q.toString(), 15000);
      if (r.status >= 400) return normalizeReceipt(ctx.enrichApiError(r.status, r.json), 'not_started');
      return base({ observation: r.json, refs: [], refs_available: false, compatibility: 'legacy_read_only', next_action: 'Upgrade the Core for target_ref support, or explicitly use the legacy MCP profile.' });
    }
    const q = new URLSearchParams();
    if (args.name_contains) q.set('name_contains', args.name_contains);
    if (args.title_contains) q.set('title_contains', args.title_contains);
    q.set('limit', String(limit)); q.set('offset', String(offset));
    const route = args.kind === 'process' ? '/processes?' : args.kind === 'window' ? '/windows?' : null;
    if (!route) return reject('invalid_kind', 'kind must be process, window, or ui.');
    const r = await ctx.apiGet(route + q.toString());
    if (r.status >= 400) return normalizeReceipt(ctx.enrichApiError(r.status, r.json), 'not_started');
    // Client-side filter+paginate: legacy endpoints may ignore limit/offset or
    // filters, so enforce them here. Never trust the server slice alone.
    const body = r.json && typeof r.json === 'object' ? r.json : {};
    const listKey = args.kind === 'process' ? 'processes' : 'windows';
    let list = Array.isArray(body[listKey]) ? body[listKey].slice() : (Array.isArray(body) ? body.slice() : null);
    if (list) {
      const wantName = args.name_contains ? String(args.name_contains).toLowerCase() : null;
      const wantTitle = args.title_contains ? String(args.title_contains).toLowerCase() : null;
      if (wantName) list = list.filter((x) => x && String(x.name || x.process || '').toLowerCase().indexOf(wantName) >= 0);
      if (wantTitle) list = list.filter((x) => x && String(x.title || x.window_title || '').toLowerCase().indexOf(wantTitle) >= 0);
      const total = list.length;
      const page = list.slice(offset, offset + limit).map((item) => {
        if (args.kind !== 'process') return item;
        const copy = Object.assign({}, item);
        if (typeof copy.command_line === 'string' && copy.command_line.length > 120) {
          copy.command_line = copy.command_line.slice(0, 120) + '…';
          copy.command_line_truncated = true;
        }
        return copy;
      });
      const obs = Object.assign({}, body);
      obs[listKey] = page; obs.total = total; obs.offset = offset; obs.limit = limit; obs.has_more = (offset + page.length) < total;
      return base({ observation: obs, refs: [], refs_available: false, offset, has_more: obs.has_more });
    }
    return base({ observation: r.json, refs: [], refs_available: false, offset });
  }
  async function act(args) {
    if (typeof args.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_TO_INTENT, args.action))
      return reject('invalid_action', 'action must be click, fill, or select.');
    if (typeof args.target_ref !== 'string' || !args.target_ref.trim())
      return reject('target_required', 'Provide the exact target_ref from a fresh observation.');
    if (args.action === 'fill' && (typeof args.text !== 'string' || args.text.length > 4000))
      return reject('invalid_text', 'fill requires a string of at most 4000 characters.');
    if (args.action === 'select' && (typeof args.option !== 'string' || !args.option.trim()))
      return reject('invalid_option', 'select requires a non-empty option string.');
    if (!(await hasModernCore())) return reject('core_upgrade_required', 'This Core cannot validate target_ref. Upgrade it or explicitly use the legacy MCP profile.');
    if (args.action === 'fill' && args.text == null) return reject('missing_text', 'fill requires text.');
    if (args.action === 'select' && args.option == null) return reject('missing_option', 'select requires option.');
    // REAL integration: send ONLY the opaque target_ref. The Core derives and
    // validates hwnd from the reference server-side, inside ActionGate/allowlist.
    // Never send hwnd/title_contains/element_index alongside: that would let the
    // caller steer the window past the reference binding.
    const q = new URLSearchParams({ target_ref: String(args.target_ref), intencao: ACTION_TO_INTENT[args.action] });
    if (args.action === 'fill') q.set('texto', String(args.text));
    if (args.action === 'select') q.set('opcao', String(args.option));
    let r;
    try { r = await ctx.apiPost('/ui/act?' + q.toString(), 25000); }
    catch (_) {
      return normalizeReceipt({ ok: false, error: 'action_response_lost', execution: 'unknown', retry: 'reconcile',
        next_action: 'Observe the application before retrying; losing the response does not mean the action was not sent.' });
    }
    const receipt = normalizeReceipt(r.json, r.status >= 400 && r.status < 500 ? 'not_started' : 'unknown');
    if (r.status >= 400) return Object.assign({}, ctx.enrichApiError(r.status, r.json), receipt, { ok: false });
    return receipt;
  }
  async function wait(args) {
    if (!(await hasModernCore())) return reject('core_upgrade_required', 'This Core has no operation receipt endpoint.');
    const op = String(args.operation_id);
    const budget = args.timeout_ms == null ? 0 : Math.max(0, Math.min(50000, Number(args.timeout_ms) || 0));
    const fetchReceipt = async () => {
      let r;
      try { r = await ctx.apiGet('/ui/operation?operation_id=' + encodeURIComponent(op)); }
      catch (_) { return normalizeReceipt({ ok: false, error: 'receipt_unavailable', execution: 'unknown', retry: 'reconcile', waited: false, waited_ms: 0 }); }
      const receipt = normalizeReceipt(r.json, 'unknown');
      if (r.status >= 400) return Object.assign({}, ctx.enrichApiError(r.status, r.json), receipt, { ok: false, waited: false, waited_ms: 0 });
      return receipt;
    };
    let receipt = await fetchReceipt();
    if (receipt.ok === false || budget <= 0) {
      if (budget <= 0 && receipt.ok !== false) { receipt.waited = false; receipt.waited_ms = 0; }
      return receipt;
    }
    // Declared wait: poll the receipt until execution leaves unknown/running or
    // the budget expires. waited reports what actually happened.
    const started = Date.now();
    let waited = false;
    while (Date.now() - started < budget) {
      if (receipt.execution !== 'unknown' && receipt.execution !== 'running') break;
      waited = true;
      await new Promise((res) => setTimeout(res, Math.min(1000, budget - (Date.now() - started))));
      if (Date.now() - started >= budget) break;
      receipt = await fetchReceipt();
      if (receipt.ok === false) break;
    }
    receipt.waited = waited; receipt.waited_ms = Date.now() - started;
    receipt.timed_out = waited && (receipt.execution === 'unknown' || receipt.execution === 'running');
    return receipt;
  }
  async function explain(args) {
    if (args.app != null) {
      if (typeof args.app !== 'string' || !args.app.trim()) return reject('invalid_app', 'app must be a non-empty string.');
      if (args.preconditions != null && (!Array.isArray(args.preconditions) || args.preconditions.length > 30 || args.preconditions.some(x => typeof x !== 'string' || !x.trim())))
        return reject('invalid_preconditions', 'Provide at most 30 observed precondition strings.');
      return base(Object.assign({ advisory_only: true }, queryRecipes({ app: args.app,
        objective: args.intent, version: args.version, layout: args.layout, preconditions: args.preconditions })));
    }
    const hit = findCapability(args.intent);
    if (hit) return base({ capability: hit.id, canonical_tool: hit.tool, summary: hit.summary,
      supported_in_profile: hit.profile !== 'legacy',
      next_action: hit.profile === 'legacy' ? 'Use the legacy MCP profile for ' + hit.tool + '.' : hit.tool });
    const r = await ctx.apiGet('/?q=' + encodeURIComponent(args.intent));
    if (r.status >= 400) return Object.assign(base({ ok: false }), ctx.enrichApiError(r.status, r.json));
    return base({ capability: null, lookup: r.json, next_action: 'Try a canonical tool name or a Portuguese/English verb.' });
  }
  return {
    tools: definitions(), names: new Set(definitions().map(x => x.name)),
    call: (name, args) => ({ aipm_observe: observe, aipm_act: act, aipm_wait: wait, aipm_explain: explain }[name] || (() => Promise.reject(new Error('unknown easy tool: ' + name))))(args || {}),
  };
}

module.exports = { create, definitions, ACTION_TO_INTENT };
