/**
 * Scenarios ship bilingual: any string can be written as {es, en}. The engine
 * only ever sees plain strings, so resolution happens once, on load.
 */
const LANGS = ['es', 'en'];

function isLangMap(v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length > 0 && Object.keys(v).every((k) => LANGS.includes(k));
}

function resolveI18n(value, lang = 'es') {
  if (Array.isArray(value)) return value.map((v) => resolveI18n(v, lang));
  if (isLangMap(value)) return value[lang] ?? value.es ?? value.en;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveI18n(v, lang);
    return out;
  }
  return value;
}

/** Structural check. A broken scenario should fail on load, not mid-run. */
function validateScenario(s) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['scenario is not an object'];
  if (!s.id) errs.push('missing id');
  if (!Array.isArray(s.backlog) || !s.backlog.length) errs.push('backlog is empty');
  const ids = new Set();
  for (const it of s.backlog || []) {
    if (!it.id) errs.push('backlog item without id');
    if (ids.has(it.id)) errs.push(`duplicate item id ${it.id}`);
    ids.add(it.id);
    if (it.ambiguity != null && (it.ambiguity < 0 || it.ambiguity > 1)) errs.push(`${it.id}: ambiguity out of range`);
  }
  for (const ev of s.events || []) {
    if (typeof ev.at !== 'number') errs.push('event without numeric `at`');
    if (!ev.type) errs.push('event without type');
    if (ev.type === 'rush' && !ev.item) errs.push('rush event without item');
  }
  return errs;
}

function loadScenario(raw, lang = 'es') {
  const errs = validateScenario(raw);
  if (errs.length) throw new Error(`invalid scenario: ${errs.join('; ')}`);
  return resolveI18n(raw, lang);
}

export { resolveI18n, validateScenario, loadScenario };

