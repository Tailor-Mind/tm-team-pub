import { DEFECTS, INJECTION, MODIFIERS, TEST_LEVELS } from './tuning.mjs';

/**
 * Two paths through the same pipe, in one ordered list so "further along" keeps
 * meaning further along for both. The old names are the hands-on flow; the ones
 * in the middle are the delegated one, which is the game now: you hand work
 * out, you read what comes back, and you never touch the code.
 */
const STAGES = [
  'backlog',
  'requirements', 'design',
  'planning', 'plan_review',
  'code', 'building',
  'verify', 'review',
  'output_review', 'testing',
  'build', 'shipping',
  'deploy', 'announce', 'done',
];

function makeItem(spec, index) {
  return {
    id: spec.id || `W-${String(index + 1).padStart(2, '0')}`,
    title: spec.title,
    kind: spec.kind || 'feature',
    impact: spec.impact ?? 3,
    complexity: spec.complexity ?? 3,
    ambiguity: spec.ambiguity ?? 0,
    /** Words in the brief that are not defined anywhere. Asking about them is the
     *  whole point; see scoring/signals.md (private). */
    undefinedTerms: spec.undefinedTerms || [],
    modules: spec.modules || [],
    /** Hard sequencing: this card cannot be built until these have been verified. */
    dependsOn: spec.dependsOn || [],
    brief: spec.brief || '',
    answers: spec.answers || {},
    stage: 'backlog',
    defects: [],
    clarified: false,
    assumptionsNoted: 0,
    specWritten: false,
    codeMode: null,
    testLevel: 'none',
    testsBite: 0,
    reviewedBy: [],
    manualQa: false,
    reworkCount: 0,
    /** What the agent says it will take. It believes this. */
    estimate: (spec.complexity ?? 3) * 55,
    /** What it actually takes. Nobody knows this until it is over. */
    effortFactor: 1,
    pulledAt: null,
    doneAt: null,
    deployStrategy: null,
    announceAudience: null,
    valueRealised: 0,
    history: [],
  };
}

let defectSeq = 0;
function resetDefectSeq() { defectSeq = 0; }

/**
 * Plant defects for a stage transition. Returns the new defects (already pushed
 * onto the item) so the caller can log them; the player never sees this list.
 */
function injectDefects(item, stage, rng, ctx = {}) {
  const table = INJECTION[stage];
  if (!table) return [];
  const born = [];
  for (const [kind, base] of Object.entries(table)) {
    let lambda = base * MODIFIERS.complexity(item.complexity);
    if (kind === 'requirement' && !item.clarified) {
      lambda *= 1 + item.ambiguity * MODIFIERS.ambiguityToRequirementDefects;
    }
    if (stage === 'code') {
      if (item.specWritten) lambda *= MODIFIERS.specPresent;
      if (item.codeMode === 'hand') lambda *= (MODIFIERS.handCoded[kind] ?? 1);
      if (item.codeMode === 'agent' && !item.specWritten) lambda *= MODIFIERS.unreviewedAgent;
    }
    if (item.reworkCount > 0) lambda *= MODIFIERS.rework;
    // A stronger model writes fewer of them; a cheaper one writes more. This is
    // the other half of the token trade-off, and it applies where the work is
    // actually produced.
    if (ctx.modelDefects) lambda *= ctx.modelDefects;
    // Building from a plan nobody read.
    if (stage === 'code' && ctx.planUnread) lambda *= MODIFIERS.planUnread;
    if (kind === 'integration' && ctx.parallelCoupled) {
      lambda *= 1 + MODIFIERS.parallelCoupling * ctx.parallelCoupled;
    }
    // A fix touches a fraction of the surface a first write does. Without this
    // the model turns into a treadmill where every fix pays for the next one.
    if (ctx.scale) lambda *= ctx.scale;
    // Poisson-ish: draw an integer count from the rate.
    let n = Math.floor(lambda);
    if (rng.chance(lambda - n)) n += 1;
    for (let k = 0; k < n; k++) {
      const d = {
        id: `D${++defectSeq}`,
        kind,
        origin: stage,
        itemId: item.id,
        found: null,
        escaped: false,
        severity: 1 + (rng.chance(0.25) ? 1 : 0),
      };
      item.defects.push(d);
      born.push(d);
    }
  }
  return born;
}

/** How well this item's tests actually bite. `none` is 0 and stays 0. */
function biteFor(level) {
  const t = TEST_LEVELS[level] || TEST_LEVELS.none;
  return t.bite || 0;
}

/**
 * Run one detection gate over an item's open defects.
 * @param gate one of: tests | mutation | review_agent | review_human | manual_qa | canary
 */
function detect(item, gate, rng) {
  const caught = [];
  for (const d of item.defects) {
    if (d.found) continue;
    let p = DEFECTS[d.kind].detect[gate] ?? 0;
    if (gate === 'tests') p *= item.testsBite;         // a green suite that asserts nothing catches nothing
    if (gate === 'mutation') p *= Math.max(item.testsBite, 0.2);
    if (rng.chance(p)) { d.found = gate; d.foundAt = 'pre-release'; caught.push(d); }
  }
  return caught;
}

function openDefects(item) { return item.defects.filter((d) => !d.found); }

function escapeWeight(defect, item) {
  return DEFECTS[defect.kind].escapeCost * defect.severity * (0.6 + 0.15 * item.impact);
}

export { STAGES, makeItem, resetDefectSeq, injectDefects, biteFor, detect, openDefects, escapeWeight };

