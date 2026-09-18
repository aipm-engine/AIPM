'use strict';

// Small, deterministic recipe catalog.  This module is deliberately local and
// read-only: execution telemetry must not silently turn into a recipe.
const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, 'recipes');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.keys(value).forEach((key) => freeze(value[key]));
    Object.freeze(value);
  }
  return value;
}

function normalize(value) {
  return String(value == null ? '' : value).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function loadRecipes() {
  let names;
  try { names = fs.readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.json')).sort(); }
  catch (_) { return []; }
  const out = [];
  for (const name of names) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, name), 'utf8'));
      if (validateRecipe(value)) out.push(value);
    } catch (_) { /* invalid catalog entries are ignored by the read-only loader */ }
  }
  return out.map((x) => freeze(x));
}

function appMatches(recipe, app) {
  const wanted = normalize(app);
  const aliases = Array.isArray(recipe.app_aliases) ? recipe.app_aliases : [];
  const names = [recipe.app, ...aliases].map(normalize);
  return !wanted || names.includes(wanted);
}

function versionMatches(recipe, version) {
  if (!recipe.compatibility || !Array.isArray(recipe.compatibility.versions)) return false;
  if (!version) return false;
  return recipe.compatibility.versions.map(String).includes(String(version));
}

function layoutMatches(recipe, layout) {
  if (!layout) return false;
  const layouts = recipe.compatibility && recipe.compatibility.layouts;
  return !Array.isArray(layouts) || layouts.length === 0 || layouts.map(normalize).includes(normalize(layout));
}

function objectiveMatches(recipe, objective) {
  if (!objective) return true;
  const q = normalize(objective);
  const aliases = Array.isArray(recipe.objective_aliases) ? recipe.objective_aliases : [];
  return [recipe.objective, ...aliases]
    .some((x) => normalize(x).includes(q) || q.includes(normalize(x)));
}

function preconditionsMatch(recipe, requested) {
  if (!Array.isArray(requested)) return false;
  const have = new Set(requested.map(normalize));
  return (recipe.preconditions || []).every((x) => have.has(normalize(x)));
}

function eligible(recipe) {
  const p = recipe.provenance || {};
  const evidence = Array.isArray(p.evidence) ? p.evidence : [];
  // Only a concrete observation can support verification.  Counters, historical
  // summaries, self reports and negative tests are useful context, never proof.
  const hasObserved = evidence.some((e) => e && e.kind === 'observed' &&
    typeof e.source === 'string' && e.source.length > 0 &&
    typeof e.claim === 'string' && e.claim.length > 0);
  const observedPreconditions = new Set();
  evidence.filter((e) => e && e.kind === 'observed').forEach((e) => {
    if (Array.isArray(e.preconditions)) e.preconditions.forEach((x) => observedPreconditions.add(normalize(x)));
  });
  const allPreconditionsObserved = recipe.preconditions.every((x) => observedPreconditions.has(normalize(x)));
  const hasPostcondition = Array.isArray(recipe.postconditions) && recipe.postconditions.length > 0;
  const noBadFallback = !(recipe.steps || []).some((s) =>
    (s.action === 'select' || s.action === 'escolher') &&
    ((Array.isArray(s.fallback) && s.fallback.some((x) => normalize(x) === 'click' || normalize(x) === 'clicar')) ||
      normalize(s.fallback) === 'click' || normalize(s.fallback) === 'clicar'));
  const hasShape = Array.isArray(recipe.anchors) && recipe.anchors.length > 0;
  const reviewed = recipe.validity && recipe.validity.reviewed_at;
  const expires = recipe.validity && recipe.validity.expires_at;
  const validDate = (x) => {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
    const d = new Date(x + 'T00:00:00.000Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === x;
  };
  const hasValidity = recipe.validity && typeof recipe.validity === 'object' &&
    validDate(reviewed) && (expires === null || (validDate(expires) && Date.parse(expires + 'T23:59:59.999Z') >= Date.now()));
  return typeof recipe.id === 'string' && typeof recipe.app === 'string' &&
    typeof recipe.objective === 'string' && Array.isArray(recipe.preconditions) &&
    recipe.preconditions.length > 0 && Array.isArray(recipe.steps) && recipe.status === 'verified' && hasObserved &&
    hasPostcondition && hasShape && hasValidity && allPreconditionsObserved &&
    p.learning_eligible === true && noBadFallback;
}

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return false;
  if (typeof recipe.id !== 'string' || typeof recipe.app !== 'string' ||
      typeof recipe.objective !== 'string' || !recipe.compatibility ||
      !Array.isArray(recipe.compatibility.versions) ||
      !Array.isArray(recipe.preconditions) || !Array.isArray(recipe.steps) ||
      !Array.isArray(recipe.postconditions) || !recipe.provenance ||
      !Array.isArray(recipe.provenance.evidence)) return false;
  return true;
}

function queryRecipes(query = {}) {
  const all = loadRecipes();
  const appHits = all.filter((r) => appMatches(r, query.app));
  const appNames = new Set(appHits.map((r) => normalize(r.app)));
  if (query.app && appHits.length === 0) return { ok: true, recipes: [], omitted: [], reason: 'app_not_found', catalog_version: '1' };
  if (query.app && appNames.size > 1) {
    return { ok: false, error: 'ambiguous_app', apps: [...appNames].sort() };
  }
  const omitted = [];
  const recipes = appHits.filter((r) => {
    if (!versionMatches(r, query.version)) { omitted.push({ id: r.id, reason: 'incompatible_version' }); return false; }
    if (!layoutMatches(r, query.layout)) { omitted.push({ id: r.id, reason: 'incompatible_layout' }); return false; }
    if (!objectiveMatches(r, query.objective)) return false;
    if (!Array.isArray(query.preconditions)) { omitted.push({ id: r.id, reason: 'preconditions_required' }); return false; }
    if (!preconditionsMatch(r, query.preconditions)) { omitted.push({ id: r.id, reason: 'missing_preconditions' }); return false; }
    if (!eligible(r)) { omitted.push({ id: r.id, reason: 'not_eligible', status: r.status }); return false; }
    return true;
  });
  return freeze({ ok: true, recipes, omitted, catalog_version: '1' });
}

module.exports = { loadRecipes, queryRecipes, eligible, validateRecipe };
