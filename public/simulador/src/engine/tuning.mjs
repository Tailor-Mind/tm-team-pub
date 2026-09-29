/**
 * Every number the simulation leans on, in one file, so calibration is a diff
 * and not a hunt. `scripts/calibrate.mjs` sweeps policies against these.
 *
 * Public on purpose: a candidate who reads this file and plays better because
 * of it is doing exactly what we want engineers to do. What stays private is
 * the mapping from behaviour to score (`scoring/`), not the physics.
 */

const RESOURCES = {
  cores: 8,          // laptop cores
  ram: 32,           // GB
  agents: 3,         // concurrent agent licences
  tokens: 4_500_000, // whole week, does not refill
};

/**
 * The two calendars. The machine gets the whole week; you get five days of it.
 * Everything interesting in this simulation lives in that gap.
 *
 * The week opens Monday at 09:00 and closes Sunday at 23:59, because Monday
 * morning is when you present what got finished. Anything not delivered by then
 * is not in the presentation, and so it is not delivered.
 */
const CALENDAR = {
  horizonMinutes: 7 * 24 * 60,   // 10 080 — seven days of wall clock
  opensAt: 9 * 60,               // lunes 09:00
  closesAt: 7 * 24 * 60 - 1,     // domingo 23:59
  attentionBudget: 5 * 8 * 60,   // 2 400 — forty hours of you, placed wherever you want
  fatigue: { nightFrom: 22, nightTo: 6, nightFactor: 1.35, edgeFactor: 1.1, edgeSpan: 2 },
  /** Night attention plants more, on top of being slower. */
  nightDefectFactor: 1.4,
};

/**
 * What you actually do with your hours — and this is the whole point of the
 * game, so it is worth reading slowly.
 *
 * You do not write code. The agents write code. What you do is **look at what
 * they produced and say yes or no**, and that is cheap per item and never free.
 * At twelve tasks you can look at everything. At a hundred you cannot, and the
 * only ways through are the ones that reduce how much you have to touch each
 * item: review in batches, sample instead of reading everything, and put the
 * bar upstream so less comes back wrong.
 *
 * `setup` is what it costs to sit down to a kind of work at all; `unit` is what
 * each item costs once you are in it. That gap is why a block of thirty reviews
 * beats thirty interruptions, and it is the arithmetic behind 10x.
 */
const HUMAN_WORK = {
  // `setup` is real and it is big: getting into a pile of plans costs about as
  // much as reading three of them. That is why a morning booked for one thing
  // beats the same minutes scattered through the week, and why half-hour gaps
  // spend most of themselves on getting started.
  plan_review:   { label: 'revisar planes',   setup: 12, unit: 3.5, scales: true },
  output_review: { label: 'revisar entregas', setup: 14, unit: 7,   scales: true },
  manual_test:   { label: 'pruebas manuales', setup: 10, unit: 18,  scales: true },
  /** Delegable work you decided to do with your own hands. Needs `libre` blocks. */
  hands_on:      { label: 'a mano',           setup: 8, unit: 1, scales: false },
  unblock:       { label: 'desbloquear',      setup: 2, unit: 8 },
  decide:        { label: 'decidir',          setup: 2, unit: 6 },
  free:          { label: 'libre',            setup: 3, unit: 4 },
};

/**
 * Reading is not one price. A plan for something gnarly takes longer to read
 * than a plan for something small, and that is exactly why "just review
 * everything" survives twelve tasks and dies at a hundred: the arithmetic of
 * the week stops closing.
 */
const REVIEW_SCALE = (complexity) => 0.5 + 0.25 * (complexity ?? 3);

/** A block of your week is booked for one kind of work. `free` takes anything. */
const BLOCK_KINDS = ['plan_review', 'output_review', 'manual_test', 'free'];

/**
 * The stages of building something, and who does each one.
 *
 * This is the sheet the player fills in, and the whole "delegar" question lives
 * here instead of in a button: writing code and running automated tests is what
 * the agents are for; reading a plan and using the product with your own hands
 * is what you are for. Both can be assigned the other way — and the interesting
 * ones are the assignments that should not be made.
 *
 *   `delegable: false` does not mean the game stops you. It means the model
 *   knows an agent cannot really do it, and the scorer notices you tried.
 */
const STAGE_SPEC = {
  plan_write:   { label: 'escribir el plan',      delegable: true,  aiDefault: 'ia',     human: 26, note: 'análisis y diseño de lo que se va a hacer' },
  plan_review:  { label: 'revisar el plan',       delegable: false, aiDefault: 1,        human: null, note: 'tu criterio sobre si eso es lo que hay que construir' },
  code:         { label: 'escribir el código',    delegable: true,  aiDefault: 'ia',     human: 55, note: 'lo que mejor hacen los agentes' },
  auto_tests:   { label: 'pruebas automáticas',   delegable: true,  aiDefault: 'ia',     human: 40, note: 'escribirlas y correrlas' },
  output_review:{ label: 'revisar la entrega',    delegable: false, aiDefault: 1,        human: null, note: 'leer lo que trajo de vuelta' },
  manual_test:  { label: 'pruebas manuales',      delegable: false, aiDefault: 0.35,     human: null, note: 'usar el producto. Un agente no puede: no tiene manos ni ojos' },
  build_deploy: { label: 'construir y desplegar', delegable: true,  aiDefault: 'ia',     human: 30, note: 'build, canary, nota de versión' },
};

/** Doing a delegable stage by hand: slower, and not always better. */
const BY_HAND = { minutesFactor: 1, defects: 0.75, tokens: 0 };

/**
 * Handing a stage to an agent that cannot really do it. Allowed on purpose —
 * the game never blocks it — and close to useless, which is the point.
 */
const UNDELEGABLE_AI = {
  manual_test: { catch: 0.06, minutes: 6 },
  plan_review: { catch: 0.22, minutes: 4 },
  output_review: { catch: 0.24, minutes: 4 },
};

/**
 * How wrong the estimate is. The agent says four hours and means it; the week
 * disagrees. Round one is how you find out what your own multiplier is.
 */
const ESTIMATES = {
  spread: [0.6, 2.2],
  /** Long tail: a few tasks blow up far past anything anyone guessed. */
  tailChance: 0.08,
  tailFactor: [2.2, 4.5],
};

/**
 * Reviewing without reading. Approving a share of the queue on trust is the
 * lever that makes a hundred tasks possible — and the thing that decides
 * whether that was leverage or recklessness is what you built upstream.
 */
const TRUST = {
  /** Fraction of a batch you actually read, when you sample rather than read all. */
  sampleShares: [1, 0.5, 0.25, 0],
  /** An unread item keeps whatever the agent left in it. */
  unreadDetection: 0,
  /** Reading catches this share of what a plan got wrong. */
  planCatch: 0.65,
  outputCatch: 0.55,
};

/** Delivered sooner is worth more: the same week compressed is the whole idea. */
const DELIVERY = {
  /** Value multiplier at the moment the week opens, decaying to 1.0 at close. */
  earlyBonus: 0.35,
};

/**
 * Which model runs the job. A fixed token budget makes this an economic
 * decision and not a preference: the strong one on everything means fewer
 * cards get finished, the fast one everywhere means more of them come back.
 *
 * Deliberately generic tiers — the point is the trade-off, not a vendor.
 */
const MODELS = {
  rapido:      { tokens: 0.40, minutes: 0.70, defects: 1.70, failure: 1.80, label: 'rápido' },
  equilibrado: { tokens: 1.00, minutes: 1.00, defects: 1.00, failure: 1.00, label: 'equilibrado' },
  // The spread has to be wide enough that "put the expensive one where being
  // wrong is expensive" is a strategy and not a preference — at scale it is the
  // only thing standing between you and the plans you did not read.
  fuerte:      { tokens: 1.90, minutes: 1.15, defects: 0.42, failure: 0.35, label: 'fuerte' },
};
const DEFAULT_MODEL = 'equilibrado';

/**
 * Not everything an agent runs comes back right, and the three ways it goes
 * wrong cost completely different things.
 *
 *   soft      — it finishes and looks fine. It is not. Extra defects, no warning.
 *   attention — it stops and waits for a person. Ten minutes of yours, whenever
 *               you next sit down. On a Friday night that is Monday.
 *   hardstop  — it stops, the work is lost, and it needs you to do something
 *               about it explicitly. Rare, and it ruins a night.
 */
const FAILURE = {
  soft:      { p: 0.16, extraDefects: 1.6 },
  attention: { p: 0.09, unblockMinutes: 10 },
  hardstop:  { p: 0.02, unblockMinutes: 25 },
  /** An unspecified card is a worse thing to hand an agent. */
  noSpecFactor: 1.5,
  /** Complexity makes every tier likelier. */
  complexity: (c) => 0.7 + 0.15 * c,
};

/** Automated work. Anything with `agents` needs a licence slot; `human: true` blocks the dev. */
const JOBS = {
  spec_gen:      { minutes: 6,  cores: 1, ram: 1,  agents: 1, tokens: (i) => 16_000 + 8_000 * i.complexity },
  /** The agent works out what it is going to do, and hands it to you to read. */
  plan_gen:      { minutes: 5,  cores: 1, ram: 1,  agents: 1, tokens: (i) => 14_000 + 7_000 * i.complexity },
  code_gen:      { minutes: 8,  cores: 2, ram: 3,  agents: 1, tokens: (i) => 30_000 + 18_000 * i.complexity },
  test_gen:      { minutes: 6,  cores: 1, ram: 2,  agents: 1, tokens: (i) => 14_000 + 9_000 * i.complexity },
  unit_tests:    { minutes: 9,  cores: 3, ram: 4,  agents: 0, tokens: () => 0 },
  mutation_run:  { minutes: 32, cores: 5, ram: 6,  agents: 0, tokens: () => 0 },
  review_agent:  { minutes: 4,  cores: 1, ram: 1,  agents: 1, tokens: (i) => 12_000 + 5_000 * i.complexity },
  build_android: { minutes: 24, cores: 5, ram: 14, agents: 0, tokens: () => 0 },
  deploy:        { minutes: 4,  cores: 1, ram: 2,  agents: 0, tokens: () => 0 },
};

/** Work the developer does personally. Capacity 1 — this is where WIP hurts. */
const HUMAN_MINUTES = {
  clarify: 18,
  spec_hand: 30,
  code_hand: 45,
  review_human: 22,
  manual_qa: 25,
  investigate: 28,
  escalate: 12,
  announce: 10,
  note: 3,
  reprioritise: 5,
  triage_build_failure: 15,
};

/**
 * Defect kinds, and who can actually see them.
 *
 *   requirement — built the wrong thing. Tests cannot see it: they assert the
 *                 same misunderstanding. Only asking, or a human looking at the
 *                 result, catches it. Escapes cost the most.
 *   logic       — wrong behaviour in code. Tests see it *if the tests bite*.
 *   integration — works alone, breaks wired together.
 *   visual      — layout/copy/state. Automation is blind here; this is the ~20%
 *                 the C-01 interview called out as needing a human.
 *   resource    — OOM, slow build, memory leak. Only shows up when it really runs.
 */
const DEFECTS = {
  requirement: { escapeCost: 3.0, detect: { tests: 0.02, mutation: 0.02, review_agent: 0.10, review_human: 0.25, manual_qa: 0.45, canary: 0.35, plan_review: 0.60, output_review: 0.15 } },
  logic:       { escapeCost: 1.6, detect: { tests: 0.40, mutation: 0.85, review_agent: 0.25, review_human: 0.40, manual_qa: 0.35, canary: 0.55, plan_review: 0.10, output_review: 0.45 } },
  integration: { escapeCost: 2.0, detect: { tests: 0.20, mutation: 0.35, review_agent: 0.15, review_human: 0.40, manual_qa: 0.60, canary: 0.65, plan_review: 0.28, output_review: 0.42 } },
  visual:      { escapeCost: 1.0, detect: { tests: 0.02, mutation: 0.02, review_agent: 0.10, review_human: 0.20, manual_qa: 0.80, canary: 0.30, plan_review: 0.04, output_review: 0.22 } },
  resource:    { escapeCost: 2.2, detect: { tests: 0.10, mutation: 0.15, review_agent: 0.05, review_human: 0.20, manual_qa: 0.30, canary: 0.70, plan_review: 0.12, output_review: 0.20 } },
};

/**
 * Injection: how many defects a stage plants, before modifiers.
 * `code` is where most of it happens, and how you got there decides how much.
 */
const INJECTION = {
  requirements: { requirement: 0.30 },
  design:       { integration: 0.20, requirement: 0.08 },
  code:         { logic: 0.52, integration: 0.17, visual: 0.19, resource: 0.11 },
  integrate:    { integration: 0.14 },
};

const MODIFIERS = {
  /** Unresolved ambiguity is the single most expensive thing in the model. */
  ambiguityToRequirementDefects: 2.6,
  /** A written spec before generation. Cheap, and it is the C-01 workflow. */
  specPresent: 0.6,
  /** Hand-written code: slower, fewer logic defects, no free lunch on the rest. */
  handCoded: { logic: 0.65, integration: 1.0, visual: 0.9, resource: 1.0 },
  /** Agent code with no spec and no read-through. */
  unreviewedAgent: 1.45,
  /** Complexity scales injection roughly linearly. */
  complexity: (c) => 0.6 + 0.35 * c,
  /** Coupled modules touched in parallel plant integration defects in each other. */
  parallelCoupling: 0.5,
  /** Rework is more defect-prone than fresh work: the code is already load-bearing. */
  rework: 1.25,
  /** How much of a fresh write's defect surface a fix re-exposes. */
  fixScale: 0.25,
  /** Cost of the developer picking up a different item than the last one.
   *  This is what a WIP limit is actually buying. */
  contextSwitchMinutes: 7,
  /**
   * Building on a plan nobody read. Reading is not only a detector — a plan
   * that got looked at is a better plan to build from, and this is the number
   * that makes "put the bar upstream" pay instead of just costing minutes.
   */
  planUnread: 1.45,
};

const TEST_LEVELS = {
  none:     { jobs: [], detectKey: null },
  happy:    { jobs: ['test_gen', 'unit_tests'], detectKey: 'tests', bite: 0.35 },
  edge:     { jobs: ['test_gen', 'unit_tests'], detectKey: 'tests', bite: 0.75, extraTokens: 1.4, extraMinutes: 1.3 },
  mutation: { jobs: ['test_gen', 'unit_tests', 'mutation_run'], detectKey: 'mutation', bite: 1.0 },
};

const DEPLOY = {
  full:   { extraMinutes: 0,  catch: 0,    incidentMultiplier: 1.0 },
  canary: { extraMinutes: 22, catch: 0.55, incidentMultiplier: 0.35 },
  /**
   * Releasing is itself a test, and the fastest one you have: real users on real
   * devices find in an hour what a suite never will. Part of whatever you did
   * not catch surfaces right after the deploy instead of days later — sooner is
   * better, and it is still a fire either way.
   */
  discoveryWindow: [30, 110],
  discoveryShare: 0.5,
};

/** Nothing reaches Monday's presentation after the week closes. */
const DEADLINE = { lateFactor: 0 };

/** Value only counts once someone knows it shipped. */
const ANNOUNCE = {
  none:   { realised: 0.55, minutes: 0 },
  team:   { realised: 0.80, minutes: HUMAN_MINUTES.announce },
  client: { realised: 1.00, minutes: HUMAN_MINUTES.announce + 8 },
};

/** Batching builds. Cheap per item, expensive when the batch goes red. */
const BUILD = {
  fixedMinutes: 24,
  perItemMinutes: 5,
  bisectMinutesPerItem: 6,
};

/** A card cannot start before what it depends on has been through verification. */
const DEPENDENCIES = { blockUntilStage: 'verify' };

const INCIDENT = {
  /** Delay between shipping an escaped defect and it biting, in sim minutes. */
  latency: [40, 220],
  humanMinutes: 22,
  /** Reputation damage per escaped defect, scaled by kind and item impact. */
  reputationPerPoint: 1.0,

  /**
   * How long production waits before the damage stops being recoverable.
   * A P1 that sits over the weekend is not the same bug on Monday: it is a bug
   * plus four days of people working around it.
   */
  sla: { p1: 240, p2: 720 },
  slaBreachMultiplier: 2.2,

  /** Fixing it now, properly. Interrupts whatever you were doing. */
  hotfix: { humanMinutes: 30, jobMinutes: 12, extraDefectScale: 0.5 },
  /** Pulling it back. The bleeding stops and so does the value. */
  rollback: { humanMinutes: 15, valueKept: 0.15 },
};

/**
 * The week has seven closes, not one. Each is a small digest of what was
 * decided, what ran, what shipped and what is still on fire — the shape a
 * stand-up would take if anyone were holding one.
 */
const EPOCH = { minutes: 24 * 60, label: 'día' };

/**
 * Work that does not fit in the week. Unresolved incidents and defects still
 * sitting in production are hours somebody owes, and they land outside whatever
 * was agreed. Counted and reported, never silently dropped.
 */
const SPILLOVER = {
  perOpenIncident: 45,
  perEscapedDefect: 25,
  perUnfinishedCard: 30,
};

export { RESOURCES, CALENDAR, HUMAN_WORK, REVIEW_SCALE, BLOCK_KINDS, STAGE_SPEC, BY_HAND, UNDELEGABLE_AI, ESTIMATES, TRUST, DELIVERY, MODELS, DEFAULT_MODEL, FAILURE, JOBS, HUMAN_MINUTES, DEFECTS, INJECTION, MODIFIERS, TEST_LEVELS, DEPLOY, DEADLINE, ANNOUNCE, BUILD, DEPENDENCIES, INCIDENT, EPOCH, SPILLOVER };

