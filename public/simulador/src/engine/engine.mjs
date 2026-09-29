import { Clock } from './clock.mjs';
import { Pool, Budget, Scheduler } from './resources.mjs';
import { makeRng, seedFromString } from './rng.mjs';
import { STAGES, makeItem, injectDefects, detect, openDefects, biteFor, escapeWeight, resetDefectSeq } from './model.mjs';
import { RESOURCES, JOBS, HUMAN_MINUTES, TEST_LEVELS, DEPLOY, ANNOUNCE, BUILD, INCIDENT, DEFECTS, MODIFIERS,
         CALENDAR, MODELS, DEFAULT_MODEL, FAILURE, DEPENDENCIES, DEADLINE, EPOCH, SPILLOVER,
         HUMAN_WORK, BLOCK_KINDS, TRUST, DELIVERY, REVIEW_SCALE,
         STAGE_SPEC, BY_HAND, UNDELEGABLE_AI, ESTIMATES } from './tuning.mjs';
import { Calendar } from './calendar.mjs';

const stageIndex = (s) => STAGES.indexOf(s);

/**
 * What you are allowed to do while the clock is still stopped — which is to
 * say, everything that is a decision about *how the week will run* rather than
 * a move inside it. Booking your hours, setting the bar, choosing what you will
 * read: all of that is planning, and none of it costs sprint time.
 */
const PLAN_ACTIONS = new Set([
  'set_attention', 'schedule', 'set_model', 'set_policy', 'set_trust', 'flag',
  'set_wip', 'reprioritise', 'drop', 'note', 'ask', 'plan_place', 'seal_plan', 'set_stage',
]);

/** One line of plain language per decision, for the report a person reads. */
function summariseParams(action, p) {
  switch (action) {
    case 'code': case 'spec': return [p.mode, p.when === 'night' ? 'de noche' : null].filter(Boolean).join(', ');
    case 'verify': return `${p.level}${p.when === 'night' ? ', de noche' : ''}`;
    case 'review': return p.by === 'human' ? 'yo' : 'agente';
    case 'build': return p.when === 'night' ? 'de noche' : 'ahora';
    case 'deploy': return p.strategy;
    case 'announce': return p.audience;
    case 'set_model': return `${p.model}${p.job ? ` para ${p.job}` : ' por defecto'}`;
    case 'set_wip': return `límite ${p.n || 'ninguno'}`;
    case 'drop': return p.reason || '';
    case 'ask': case 'note': case 'retro': return String(p.text || '').slice(0, 160);
    case 'answer_premise': return p.stance;
    case 'respond_fork': return p.stance;
    case 'incident_action': return p.choice;
    default: return '';
  }
}

function summariseResult(action, r) {
  if (!r) return '';
  if (action === 'ask' && r.resolvedTerm) return `preguntó por «${r.resolvedTerm}»`;
  if (action === 'seal_plan') return `plan ${r.hash}, ${r.placed / 60} h colocadas`;
  if (action === 'deploy' || action === 'build') return r.when === 'night' ? 'encolado para la noche' : 'lanzado';
  if (action === 'announce') return `${r.announced} comunicado(s)`;
  return '';
}

/** Cheap, stable fingerprint of a plan. Not a secret — a seal. */
function hashPlan(plan) {
  const s = JSON.stringify([plan.order, plan.placements, plan.cut, plan.assumptions, plan.notes, plan.attention.blocks, plan.models, plan.wipLimit]);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The simulation. Pure: no DOM, no timers, no network. The UI moves wall time
 * onto it with `advanceTo`, and the headless runners in `scripts/` drive the
 * exact same surface — which is the only reason bot policies and human runs are
 * comparable at all.
 */
class Simulation {
  constructor({ scenario, seed, telemetry = null, now = () => Date.now(), autoIntake = true }) {
    this.scenario = scenario;
    this.seed = typeof seed === 'number' ? seed : seedFromString(String(seed ?? scenario.id));
    this.rng = makeRng(this.seed);
    this.telemetry = telemetry;
    this.wallNow = now;
    resetDefectSeq();

    const res = { ...RESOURCES, ...(scenario.resources || {}) };
    this.clock = new Clock(0);
    this.pools = {
      cores: new Pool('cores', res.cores),
      ram: new Pool('ram', res.ram, ' GB'),
      agents: new Pool('agents', res.agents),
    };
    this.budgets = { tokens: new Budget('tokens', res.tokens) };
    this.scheduler = new Scheduler({
      clock: this.clock, pools: this.pools, budgets: this.budgets,
      onStart: (j) => this.log('job_start', { job: j.kind, id: j.id, item: j.itemId, minutes: j.duration, swapped: j.swapped, waited: j.waitedMinutes }),
      onFinish: (j) => this.log('job_done', { job: j.kind, id: j.id, item: j.itemId }),
    });

    this.horizon = scenario.horizonMinutes ?? CALENDAR.horizonMinutes;
    // The machine gets the whole week. You get the hours you place on it.
    this.calendar = new Calendar({
      blocks: scenario.attentionBlocks || Calendar.officeHours(),
      budgetMinutes: scenario.attentionBudget ?? CALENDAR.attentionBudget,
      fatigue: CALENDAR.fatigue,
    });
    this.deadline = scenario.deadline || null;
    /**
     * A rehearsal. The mechanics are identical — that is the whole point of a
     * rehearsal — but nothing is scored and nothing is sent, and both the app
     * and the scorer say so out loud rather than quietly discounting it.
     */
    this.practice = !!scenario.practice;
    this.items = (scenario.backlog || []).map(makeItem);
    // The estimate is what the agent says; the factor is what the week says.
    // A few of them blow up far past anything anyone guessed, which is the
    // single most reliable fact about software estimates.
    for (const it of this.items) {
      const [lo, hi] = ESTIMATES.spread;
      it.effortFactor = Number(this.rng.float(lo, hi).toFixed(2));
      if (this.rng.chance(ESTIMATES.tailChance)) {
        it.effortFactor = Number((it.effortFactor * this.rng.float(...ESTIMATES.tailFactor)).toFixed(2));
        it.tail = true;
      }
    }
    this.alerts = [];
    this.journal = [];       // player-visible event log
    this.notes = [];         // written assumptions / decisions
    this.questions = [];     // things they asked
    this.incidents = [];
    this.humanBusyUntil = 0;
    /**
     * You do not have a to-do list, you have queues. Each one is a kind of work
     * that only moves when you have booked time for it, and the whole game is
     * how you book that time against how fast the queues fill.
     */
    this.queues = { plan_review: [], output_review: [], manual_test: [], unblock: [], decide: [] };
    this.humanQueue = [];          // kept for the urgent, one-off tasks
    this.humanMinutesUsed = 0;
    this.minutesByKind = {};
    this.sessions = [];
    /**
     * Who does each stage. This is the answer to "what do I delegate": not a
     * number of tasks, but a line per stage of the work.
     */
    this.stages = Object.fromEntries(Object.entries(STAGE_SPEC).map(([k, v]) => [k, v.aiDefault]));
    /** Kept in sync with the review rows, because the rest of the engine reads it. */
    this.trust = { plan: 1, output: 1 };
    /** Assignments a person cannot really hand over, handed over anyway. */
    this.undelegated = [];
    /** Work flows in by itself. Tests that need a quiet world turn it off. */
    this.autoIntake = autoIntake;
    this.flagged = new Set();
    this.policy = { tests: 'edge', deploy: 'canary', announce: 'client' };
    this.wipLimit = null;
    this.reputation = 0;     // negative is bad; incidents subtract
    this.finished = false;
    this.forks = new Map();
    this.ciState = { redSeen: 0, reruns: 0, investigated: false, maskedCause: false };
    this.counters = {
      actions: 0, rejected: 0, rework: 0, builds: 0, buildFailures: 0, contextSwitches: 0,
      softFailures: 0, blocked: 0, hardStops: 0, nightMinutes: 0, strandedMinutes: 0, preempted: 0,
    };
    this.lastHumanItem = null;
    this.started = false;
    /** 'plan' → no clock, you are laying out the week. 'play' → it runs. */
    this.phase = scenario.planPhase === false ? 'play' : 'plan';
    this.plan = null;
    this.modelDefault = scenario.defaultModel || DEFAULT_MODEL;
    this.modelByJob = {};        // per job kind override, e.g. { code_gen: 'fuerte' }
    this.blockedJobs = [];
    this.pumpScheduled = null;
    /** One digest per day. The week has seven closes, not one. */
    this.epochs = [];
    this.epochMark = null;
    /** Everything the player decided, in order, for the final report. */
    this.ledger = [];
  }

  /** Which model runs this kind of job. Per-kind choice beats the default. */
  modelFor(kind) { return MODELS[this.modelByJob[kind]] ? this.modelByJob[kind] : this.modelDefault; }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return this;
    this.started = true;
    for (const ev of this.scenario.events || []) {
      this.clock.at(ev.at, `script:${ev.type}`, () => this.fireScripted(ev));
    }
    // Work flows in on its own. You do not press a button to hand tasks over —
    // you decide how wide the pipe is (the WIP limit) and who does each stage.
    const intake = () => {
      if (this.finished) return;
      if (this.phase === 'play' && this.autoIntake) this.autoDelegate();
      this.clock.after(20, 'intake', intake);
    };
    this.clock.after(1, 'intake', intake);
    for (let at = EPOCH.minutes; at <= this.horizon; at += EPOCH.minutes) {
      this.clock.at(at, 'epoch', () => this.closeEpoch(at));
    }
    this.clock.at(this.horizon, 'horizon', () => this.finish('horizon'));
    this.log('run_start', {
      seed: this.seed, scenario: this.scenario.id, phase: this.phase, practice: this.practice,
      resources: this.resourceSnapshot(), attention: this.calendar.toJSON(),
    });
    return this;
  }

  /**
   * Move sim time forward. The UI calls this on every animation frame tick.
   * During the plan phase the clock does not move at all: you are laying out
   * the week, not living it.
   */
  advanceTo(t) {
    if (this.finished || this.phase === 'plan') return this;
    this.clock.runTo(Math.min(t, this.horizon));
    this.pumpHuman();
    return this;
  }

  finish(reason = 'manual') {
    if (this.finished) return this;
    this.finished = true;
    // Anything still in flight at the horizon is unfinished work, not value.
    this.log('run_end', { reason, score: this.score(), t_sim: this.clock.now, practice: this.practice });
    // The report goes out the moment the week closes, with the sealed plan
    // beside it: the plan is what was promised, the report is what happened,
    // and reading either one alone tells you nothing. Anything the player wants
    // to add afterwards travels later, in its own send.
    const rep = this.report();
    this.log('run_report', { ...rep, ledger: undefined, plan: this.plan || null }, { snapshot: false });
    this.sentAt = this.wallNow();
    if (this.telemetry) this.telemetry.flush('run_end');
    return this;
  }

  // ------------------------------------------------------------ human queue
  //
  // Capacity 1, FIFO. Everything the developer does personally lands here, and
  // this is what makes five things in flight feel like five things in flight.

  /**
   * @param urgent  jump the queue. This is what "urgent" actually means: not
   *   that it is important, but that everything you had planned moves back to
   *   make room for it — and every jump is a context switch you pay for.
   */
  human(kind, minutes, itemId, done, urgent = false) {
    // While you are laying out the week nothing costs you anything: there is no
    // clock yet. Reading the backlog and asking about it is not sprint time.
    if (this.phase === 'plan') { done?.(); return null; }
    const task = { kind, minutes, itemId, done, queuedAt: this.clock.now, urgent };
    if (urgent) {
      this.counters.preempted += this.humanQueue.length ? 1 : 0;
      this.humanQueue.unshift(task);
    } else this.humanQueue.push(task);
    this.pumpHuman();
    return task;
  }

  /**
   * The queues, served in the blocks you booked for them.
   *
   * Nothing here happens because the machine is free. It happens because you
   * sat down at a time you chose, for a kind of work you chose, and worked
   * through what had piled up until the block ran out. Whatever did not fit
   * waits for the next block of its kind — and if you booked none, it waits
   * forever, which is a decision too.
   *
   * The batch is the point: sitting down costs `setup` once and each item costs
   * `unit`. Thirty reviews in one block cost a fraction of thirty interruptions,
   * and that gap is the arithmetic behind doing ten times the work.
   */
  pumpHuman() {
    if (this.phase === 'plan' || this.finished) return;
    if (this.sessionEnds && this.sessionEnds > this.clock.now) return;

    const now = Math.max(this.clock.now, this.humanBusyUntil);
    let best = null;
    for (const [kind, queue] of Object.entries(this.queues)) {
      if (!queue.length) continue;
      // Fires and stuck agents are not booked work: they take whatever block is open.
      const asKind = (kind === 'unblock' || kind === 'decide') ? null : kind;
      const session = this.calendar.nextSession(now, asKind);
      if (!session) { this.noteStranded(kind, queue); continue; }
      const rank = session.at + (kind === 'unblock' || kind === 'decide' ? -1 : 0);
      if (!best || rank < best.rank) best = { kind, queue, session, rank };
    }
    if (!best) return;

    if (best.session.at > this.clock.now) {
      if (this.pumpScheduled !== best.session.at) {
        this.pumpScheduled = best.session.at;
        this.clock.at(best.session.at, 'human:desk_opens', () => { this.pumpScheduled = null; this.pumpHuman(); });
      }
      return;
    }
    this.runSession(best.kind, best.queue, best.session);
  }

  runSession(kind, queue, session) {
    const at = session.at;
    const spec = HUMAN_WORK[kind] || HUMAN_WORK.free;
    const fatigue = this.calendar.fatigueAt(at);
    const setup = spec.setup * fatigue;
    const unit = spec.unit * fatigue;
    const available = Math.max(0, session.block.end - at);

    // Walk the queue paying for each item what that item actually costs to
    // read, and stop when the block runs out. This is the whole economics of
    // the game in six lines.
    const costOf = (task) => {
      if (task.minutes) return task.minutes;      // hands-on work carries its own price
      const it = task.itemId ? this.item(task.itemId) : null;
      return unit * (spec.scales ? REVIEW_SCALE(it?.complexity) : 1);
    };
    let spent = setup;
    let n = 0;
    while (n < queue.length && spent + costOf(queue[n]) <= available) { spent += costOf(queue[n]); n++; }
    if (n < 1) {
      // The block is too short to even sit down. Look past it.
      const after = this.calendar.nextAttention(session.block.end, kind === 'unblock' || kind === 'decide' ? null : kind);
      if (after != null && this.pumpScheduled !== after) {
        this.pumpScheduled = after;
        this.clock.at(after, 'human:desk_opens', () => { this.pumpScheduled = null; this.pumpHuman(); });
      }
      return;
    }
    const batch = queue.splice(0, n);
    const minutes = Math.round(spent);
    const ends = at + minutes;

    this.humanBusyUntil = ends;
    this.sessionEnds = ends;
    this.humanMinutesUsed += minutes;
    this.minutesByKind[kind] = (this.minutesByKind[kind] || 0) + minutes;
    if (fatigue > 1) this.counters.nightMinutes += minutes;

    const record = {
      kind, at, minutes, items: batch.length, label: Calendar.label(at),
      left: queue.length, perItem: Number((minutes / batch.length).toFixed(1)),
    };
    this.sessions.push(record);
    this.log('session_start', record);

    this.clock.at(ends, `session:${kind}`, () => {
      this.sessionEnds = null;
      const outcomes = [];
      for (const task of batch) outcomes.push(task.done?.() ?? null);
      this.afterSession(kind, record, outcomes.filter(Boolean));
      this.pumpHuman();
    });
  }

  /** What the session actually decided, said once instead of item by item. */
  afterSession(kind, record, outcomes) {
    if (!outcomes.length) return;
    const rejected = outcomes.filter((o) => o.decision === 'reject');
    const read = outcomes.filter((o) => o.read).length;
    this.log('session_done', {
      kind, items: record.items, read, rejected: rejected.length,
      rejected_ids: rejected.map((o) => o.itemId).slice(0, 12),
      minutes: record.minutes, per_item: record.perItem, left: record.left,
    }, { snapshot: false });
    const label = HUMAN_WORK[kind]?.label || kind;
    this.pushAlert({
      type: 'session', autoResolve: true,
      text: `${record.label} · ${label}: ${record.items} en ${record.minutes} min` +
            (read < record.items ? `, ${read} leídos de verdad` : '') +
            (rejected.length ? ` · devolviste ${rejected.length}` : '') +
            (record.left ? ` · quedan ${record.left} esperando` : ''),
    });
  }

  noteStranded(kind, queue) {
    const key = `stranded:${kind}`;
    if (this.strandedKinds?.has(key)) return;
    this.strandedKinds = this.strandedKinds || new Set();
    this.strandedKinds.add(key);
    const label = HUMAN_WORK[kind]?.label || kind;
    this.log('queue_stranded', { kind, waiting: queue.length }, { snapshot: false });
    this.pushAlert({
      type: 'stranded',
      text: `${queue.length} esperando por «${label}» y no queda ni un bloque tuyo reservado para eso en toda la semana.`,
    });
  }

  /** Put work in a queue. It moves when you booked time for its kind. */
  enqueue(kind, itemId, done, { urgent = false, minutes = null } = {}) {
    if (this.phase === 'plan') { done?.(); return null; }
    const task = { kind, itemId, done, queuedAt: this.clock.now, minutes };
    const q = this.queues[kind] || (this.queues[kind] = []);
    if (urgent) q.unshift(task); else q.push(task);
    if (urgent) this.counters.preempted += q.length > 1 ? 1 : 0;
    this.strandedKinds?.delete(`stranded:${kind}`);
    this.pumpHuman();
    return task;
  }

  /** The old one-off path, for the handful of things that are not a queue. */
  human(kind, minutes, itemId, done, urgent = false) {
    const bucket = kind === 'unblock' ? 'unblock' : 'decide';
    return this.enqueue(bucket, itemId, () => { done?.(); return null; }, { urgent });
  }

  get humanFreeIn() {
    const next = this.calendar.nextAttention(Math.max(this.clock.now, this.humanBusyUntil));
    return next == null ? Infinity : next - this.clock.now;
  }

  get queueDepth() {
    return Object.fromEntries(Object.entries(this.queues).map(([k, v]) => [k, v.length]));
  }

  // ---------------------------------------------------------------- helpers

  item(id) { return this.items.find((i) => i.id === id); }
  get inFlight() { return this.items.filter((i) => i.stage !== 'backlog' && i.stage !== 'done' && !i.dropped); }

  coupledLoad(item) {
    if (!item.modules.length) return 0;
    return this.inFlight.filter((o) => o.id !== item.id && o.modules.some((m) => item.modules.includes(m))).length;
  }

  /** Which stage a job belongs to, so the assignment sheet can redirect it. */
  stageOf(kind) {
    return { plan_gen: 'plan_write', code_gen: 'code', test_gen: 'auto_tests',
             unit_tests: 'auto_tests', mutation_run: 'auto_tests',
             build_android: 'build_deploy', deploy: 'build_deploy' }[kind] || null;
  }

  /**
   * A stage assigned to you is not a job, it is queue time. It costs the hours
   * the sheet says, produces fewer defects than an agent would, and spends no
   * tokens — and it only moves in blocks you booked as `libre`.
   */
  byHand(kind, item, done) {
    const stage = this.stageOf(kind);
    const said = STAGE_SPEC[stage]?.human || 30;
    const minutes = Math.round(said * (item?.effortFactor ?? 1));
    this.bookEstimate(item, said, minutes);
    this.counters.byHand = (this.counters.byHand || 0) + 1;
    this.enqueue('hands_on', item?.id ?? null, () => {
      done?.();
      return { itemId: item?.id, read: true, decision: 'approve' };
    }, { minutes });
    return { id: `H${this.counters.byHand}`, state: 'by_hand', kind };
  }

  /**
   * What the agent said it would take, next to what it took.
   *
   * Nobody knows how long a task is until it is done, and an agent is no
   * better at guessing than the person who used to write the ticket. Keeping
   * both numbers is what turns one round into evidence for the next: after
   * twelve cards you know your own multiplier, and you can plan the fifty with
   * it instead of with hope.
   */
  bookEstimate(item, said, real) {
    if (!item) return;
    item.estMinutes = (item.estMinutes || 0) + said;
    item.realMinutes = (item.realMinutes || 0) + real;
  }

  /**
   * What the sheet is asking of your week, in hours, against what you booked.
   *
   * This is the number the planning screen was missing: assigning yourself all
   * the plan reviews is a decision about the *calendar*, and until you can see
   * "esto pide 46 h y reservaste 20" the two halves of the screen are unrelated
   * pictures. The estimate is deliberately simple and stated as an estimate —
   * it assumes every card gets there, which is the pessimistic case and the
   * only useful one when you are deciding how much to look at.
   */
  demand() {
    const live = this.items.filter((i) => !i.dropped);
    const avgScale = live.length
      ? live.reduce((a, i) => a + REVIEW_SCALE(i.complexity), 0) / live.length
      : REVIEW_SCALE(3);
    const minutesOf = (kind) => this.calendar.blocks
      .filter((b) => b.kind === kind).reduce((a, b) => a + (b.end - b.start), 0);
    const sessionsOf = (kind) => this.calendar.blocks.filter((b) => b.kind === kind).length;

    const rows = [];
    for (const [stage, spec] of Object.entries(STAGE_SPEC)) {
      const who = this.stages[stage];
      if (who === 'ia') continue;                       // an agent's hours are not yours
      const share = who === 'humano' ? 1 : Number(who) || 0;
      if (share <= 0) continue;
      // A stage you took back needs `libre`; a review needs its own kind of block.
      const kind = spec.delegable ? 'free' : stage;
      const work = HUMAN_WORK[spec.delegable ? 'hands_on' : stage] || HUMAN_WORK.free;
      const cards = Math.round(live.length * share);
      const per = spec.delegable ? (spec.human || 30) : work.unit * avgScale;
      const sessions = Math.max(1, sessionsOf(kind));
      const minutes = Math.round(cards * per + sessions * work.setup);
      rows.push({
        stage, label: spec.label, kind, share, cards, minutes,
        blocks: sessionsOf(kind), booked: minutesOf(kind),
      });
    }
    // Blocks marked `libre` take anything, so they are a shared pool, not a
    // second column: counted once, against everything that has nowhere else.
    const free = minutesOf('free');
    const byKind = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + r.minutes;
    for (const r of rows) {
      const pooled = r.kind === 'free' ? free : r.booked + free;
      r.covered = byKind[r.kind] <= pooled;
      r.pooled = pooled;
    }
    const needed = rows.reduce((a, r) => a + r.minutes, 0);
    return {
      rows, free,
      needed,
      booked: this.calendar.placedMinutes,
      budget: this.calendar.budgetMinutes,
      cards: live.length,
    };
  }

  /** The multiplier, over everything that has actually run so far. */
  estimateStats() {
    const touched = this.items.filter((i) => i.estMinutes > 0);
    const est = touched.reduce((a, i) => a + i.estMinutes, 0);
    const real = touched.reduce((a, i) => a + i.realMinutes, 0);
    const worst = touched.slice()
      .sort((a, b) => (b.realMinutes / b.estMinutes) - (a.realMinutes / a.estMinutes))
      .slice(0, 5)
      .map((i) => ({ id: i.id, title: i.title, factor: Number((i.realMinutes / i.estMinutes).toFixed(2)),
                     est_h: Number((i.estMinutes / 60).toFixed(1)), real_h: Number((i.realMinutes / 60).toFixed(1)) }));
    return {
      cards: touched.length,
      estimated_h: Number((est / 60).toFixed(1)),
      real_h: Number((real / 60).toFixed(1)),
      factor: est ? Number((real / est).toFixed(2)) : null,
      over: touched.filter((i) => i.realMinutes > i.estMinutes * 1.25).length,
      worst,
    };
  }

  jobSpec(kind, item, overrides = {}) {
    const t = JOBS[kind];
    const spec = {
      kind, itemId: item?.id ?? null,
      minutes: t.minutes, cores: t.cores, ram: t.ram, agents: t.agents,
      tokens: item ? t.tokens(item) : t.tokens({ complexity: 3 }),
    };
    // Model choice only applies where a model actually runs. A build is a build.
    if (t.agents > 0) {
      const key = this.modelFor(kind);
      const m = MODELS[key];
      spec.model = key;
      spec.tokens = Math.round(spec.tokens * m.tokens);
      spec.minutes = Math.max(1, Math.round(spec.minutes * m.minutes));
    }
    // The estimate was optimistic, or it was not. Either way the machine pays.
    if (item?.effortFactor && ['plan_gen', 'code_gen', 'test_gen'].includes(kind)) {
      const said = spec.minutes;
      spec.minutes = Math.max(1, Math.round(spec.minutes * item.effortFactor));
      spec.tokens = Math.round(spec.tokens * (0.6 + 0.4 * item.effortFactor));
      this.bookEstimate(item, said, spec.minutes);
    }
    return { ...spec, ...overrides };
  }

  /**
   * @param done  what the job accomplishes when it really finishes
   * @param opts  { lost } — how to roll the item back when the work is thrown away
   */
  submit(kind, item, overrides, done, opts = {}, when = 'now') {
    const stage = this.stageOf(kind);
    if (stage && this.stages[stage] === 'humano') return this.byHand(kind, item, done);
    const spec = this.jobSpec(kind, item, overrides);
    const wrapped = (job) => this.resolveJob(job, item, done, opts);

    // "Leave it running tonight": the machine is free and you are not there.
    // Cheap in daylight cores, expensive if it stops and nobody is coming.
    if (when === 'night' && this.phase === 'play') {
      const at = this.calendar.nextFreeWindow(this.clock.now, spec.minutes, this.horizon);
      if (at == null) {
        // There is no gap left big enough. Better to say so than to sit on it.
        this.log('job_defer_impossible', { job: kind, item: spec.itemId, minutes: spec.minutes }, { snapshot: false });
      } else if (at > this.clock.now) {
        const placeholder = { id: `D${++this.deferSeq || (this.deferSeq = 1)}`, state: 'deferred', kind, itemId: spec.itemId, at };
        this.deferred = this.deferred || [];
        this.deferred.push(placeholder);
        this.log('job_deferred', { job: kind, item: spec.itemId, until: Calendar.label(at) }, { snapshot: false });
        this.clock.at(at, `defer:${kind}`, () => {
          this.deferred = this.deferred.filter((d) => d !== placeholder);
          const real = this.scheduler.submit({ ...spec, done: wrapped });
          if (real.state === 'rejected') {
            this.counters.rejected++;
            this.log('job_rejected', { job: kind, item: spec.itemId, reason: real.reason, deferred: true });
            opts.lost?.();
          }
        });
        return placeholder;
      }
    }

    const j = this.scheduler.submit({ ...spec, done: wrapped });
    if (j.state === 'rejected') {
      this.counters.rejected++;
      this.note_internal(`job_rejected:${kind}`, j.reason);
      this.log('job_rejected', { job: kind, item: item?.id, reason: j.reason });
    }
    return j;
  }

  /**
   * Not everything an agent runs comes back right. Three ways it goes wrong and
   * they cost completely different things — see FAILURE in tuning.mjs.
   *
   * The one that decides games is the middle one: the job stops and waits for a
   * person. At eleven on a Tuesday morning that is ten minutes. At half past
   * seven on a Friday it is the whole weekend.
   */
  resolveJob(job, item, done, opts = {}) {
    if (!job.agents) { done?.(); return; }

    const m = MODELS[job.model || this.modelDefault];
    const scale = FAILURE.complexity(item?.complexity ?? 3)
                * (item && !item.specWritten ? FAILURE.noSpecFactor : 1)
                * m.failure;

    if (this.rng.chance(Math.min(0.5, FAILURE.hardstop.p * scale))) {
      this.counters.hardStops++;
      const blocked = { id: job.id, kind: job.kind, itemId: job.itemId, tier: 'hardstop', at: this.clock.now, done: null, lost: opts.lost || null };
      this.blockedJobs.push(blocked);
      this.log('job_blocked', { job: job.kind, id: job.id, item: job.itemId, tier: 'hardstop', at: Calendar.label(this.clock.now) }, { snapshot: false });
      this.pushAlert({
        type: 'hardstop', jobId: job.id, itemId: job.itemId,
        text: `El agente se paró en seco en ${job.kind}${job.itemId ? ` (${job.itemId})` : ''} y lo que llevaba se perdió. Necesita que lo mires y lo relances.`,
      });
      return;
    }

    if (this.rng.chance(Math.min(0.5, FAILURE.attention.p * scale))) {
      this.counters.blocked++;
      const waited = this.humanFreeIn;
      this.log('job_blocked', {
        job: job.kind, id: job.id, item: job.itemId, tier: 'attention',
        at: Calendar.label(this.clock.now),
        wait_hint: Number.isFinite(waited) ? Math.round(waited) : null,
      }, { snapshot: false });
      this.pushAlert({
        type: 'blocked', jobId: job.id, itemId: job.itemId, autoResolve: true,
        text: `${job.kind}${job.itemId ? ` (${job.itemId})` : ''} se quedó esperando a que alguien lo destrabe. Empezó ${Calendar.label(this.clock.now)}.`,
      });
      // Queued, not lost: it resumes the next time you sit down.
      const blockedAt = this.clock.now;
      this.human('unblock', FAILURE.attention.unblockMinutes, job.itemId, () => {
        this.blockedWaitMinutes = (this.blockedWaitMinutes || 0) + (this.clock.now - blockedAt);
        done?.();
      });
      return;
    }

    done?.();

    if (item?.defects && this.rng.chance(Math.min(0.6, FAILURE.soft.p * scale))) {
      // It finished. It looks fine. It is not, and nothing tells you.
      this.counters.softFailures++;
      injectDefects(item, 'code', this.rng, { scale: FAILURE.soft.extraDefects * MODIFIERS.fixScale });
      this.log('job_soft_fail', { job: job.kind, item: item.id, model: job.model }, { snapshot: false });
    }
  }

  note_internal(kind, text) { this.journal.push({ t: this.clock.now, kind, text }); }

  log(action, params = {}, extra = {}) {
    if (!this.telemetry) return null;
    return this.telemetry.record(action, params, {
      tSim: this.clock.now,
      snapshot: extra.snapshot === false ? null : this.resourceSnapshot(),
      ...extra,
    });
  }

  resourceSnapshot() {
    return {
      t: this.clock.now,
      cores_free: this.pools.cores.free,
      ram_free: this.pools.ram.free,
      agents_free: this.pools.agents.free,
      tokens_left: this.budgets.tokens.left,
      human_busy_min: Math.max(0, this.humanBusyUntil - this.clock.now),
      jobs_running: this.scheduler.running.size,
      jobs_queued: this.scheduler.queue.length,
      wip: this.inFlight.length,
      open_alerts: this.alerts.filter((a) => !a.resolved).length,
    };
  }

  // ----------------------------------------------------------- player actions

  /**
   * Single entry point. Everything a player can do goes through here so the
   * tape is complete by construction — there is no side door.
   */
  dispatch(action, params = {}, meta = {}) {
    // The retro happens after the week is over. It is the only thing that does.
    if (this.finished && action !== 'retro') return { ok: false, error: 'run_finished' };
    const fn = this.actions[action];
    if (!fn) return { ok: false, error: `unknown_action:${action}` };
    if (this.phase === 'plan' && !PLAN_ACTIONS.has(action)) return { ok: false, error: 'plan_phase' };
    if (this.phase === 'play' && action === 'seal_plan') return { ok: false, error: 'already_sealed' };
    this.counters.actions++;
    let result;
    try {
      result = fn.call(this, params) || { ok: true };
    } catch (err) {
      result = { ok: false, error: String(err && err.message || err) };
    }
    this.log(action, params, { result, ui: meta.ui ?? null });
    // The ledger is the human-readable spine of the final report: what was
    // decided, when, and what the world said back.
    if (result?.ok !== false) {
      this.ledger.push({
        t: this.clock.now, at: Calendar.label(this.clock.now), epoch: Math.floor(this.clock.now / EPOCH.minutes),
        action, item: params.id || (Array.isArray(params.ids) ? params.ids.join('+') : null),
        detail: summariseParams(action, params), result: summariseResult(action, result),
      });
    }
    return result;
  }

  actions = {
    pull({ id }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      if (it.stage !== 'backlog') return { ok: false, error: 'already_pulled' };
      if (this.wipLimit && this.inFlight.length >= this.wipLimit) {
        return { ok: false, error: 'wip_limit', limit: this.wipLimit };
      }
      it.stage = 'requirements';
      it.pulledAt = this.clock.now;
      return { ok: true, stage: it.stage };
    },

    drop({ id, reason }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      it.dropped = true;
      it.droppedReason = reason || '';
      it.stage = it.stage === 'backlog' ? 'backlog' : it.stage;
      return { ok: true };
    },

    // ==================================================================
    // The delegated loop. You never write code here: you hand work out, you
    // read some of what comes back, and you decide what ships.
    // ==================================================================

    /**
     * Hand tasks to the agents. They come back with a plan, which lands in your
     * plan-review queue and waits for a block you booked for reading plans.
     */
    delegate({ ids, model = null }) {
      const items = (ids || []).map((i) => this.item(i)).filter(Boolean);
      if (!items.length) return { ok: false, error: 'no_items' };
      const taken = [];
      const refused = [];
      for (const it of items) {
        if (it.dropped || it.delegated) { refused.push(it.id); continue; }
        if (this.wipLimit && this.inFlight.length >= this.wipLimit) { refused.push(it.id); continue; }
        const blockers = (it.dependsOn || [])
          .map((d) => this.item(d))
          .filter((d) => d && !d.dropped && stageIndex(d.stage) < stageIndex('output_review'));
        if (blockers.length) { refused.push(it.id); continue; }

        it.delegated = true;
        it.stage = 'planning';
        it.pulledAt = it.pulledAt ?? this.clock.now;
        taken.push(it.id);
        const over = model ? { model } : {};
        const j = this.submit('plan_gen', it, over, () => this.planReady(it));
        if (j.state === 'rejected') { it.delegated = false; it.stage = 'backlog'; refused.push(it.id); taken.pop(); }
      }
      return taken.length ? { ok: true, delegated: taken.length, ids: taken, refused }
                          : { ok: false, error: 'none_delegated', refused };
    },

    /**
     * Who does this stage. `'ia'` hands it to an agent, a number is the share of
     * items you do yourself, `'humano'` is all of it by hand.
     *
     * Assigning an agent to something it cannot really do — reading a plan for
     * you, using the product for you — is allowed and recorded. The engine does
     * not moralise; it just makes the agent nearly useless at it, which is what
     * would actually happen.
     */
    set_stage({ stage, who }) {
      if (!STAGE_SPEC[stage]) return { ok: false, error: 'unknown_stage' };
      this.stages[stage] = who;
      if (stage === 'plan_review') this.trust.plan = typeof who === 'number' ? who : 0;
      if (stage === 'output_review') this.trust.output = typeof who === 'number' ? who : 0;
      const undelegable = !STAGE_SPEC[stage].delegable && who === 'ia';
      if (undelegable) {
        this.undelegated.push({ t: this.clock.now, stage });
        this.log('undelegable_delegated', { stage, label: STAGE_SPEC[stage].label }, { snapshot: false });
      }
      return { ok: true, stage, who, undelegable };
    },

    /** Kept for the reference policies and the old tapes. */
    set_trust({ plan = null, output = null }) {
      if (plan != null) this.actions.set_stage.call(this, { stage: 'plan_review', who: plan });
      if (output != null) this.actions.set_stage.call(this, { stage: 'output_review', who: output });
      return { ok: true, trust: { ...this.trust } };
    },

    /** These ones you read whatever the sampling says. Choosing which is the skill. */
    flag({ ids, on = true }) {
      for (const id of ids || []) { if (on) this.flagged.add(id); else this.flagged.delete(id); }
      return { ok: true, flagged: this.flagged.size };
    },

    /** Set once, applied to everything: how it is tested, shipped and announced. */
    set_policy({ tests = null, deploy = null, announce = null }) {
      if (tests && TEST_LEVELS[tests]) this.policy.tests = tests;
      if (deploy && DEPLOY[deploy]) this.policy.deploy = deploy;
      if (announce && ANNOUNCE[announce]) this.policy.announce = announce;
      return { ok: true, policy: { ...this.policy } };
    },

    /** Book these for a human to actually use. Slow, and the only thing that sees the visual. */
    test({ ids }) {
      const items = (ids || []).map((i) => this.item(i)).filter(Boolean);
      if (!items.length) return { ok: false, error: 'no_items' };
      for (const it of items) {
        if (it.manualQueued) continue;
        it.manualQueued = true;
        this.enqueue('manual_test', it.id, () => {
          it.manualQa = true;
          const caught = detect(it, 'manual_qa', this.rng);
          this.afterGate(it, caught, 'manual_qa');
          return { itemId: it.id, read: true, decision: caught.length ? 'reject' : 'approve' };
        });
      }
      return { ok: true, queued: items.length };
    },

    /** Where your forty hours go, and for what. The most consequential thing you set. */
    schedule({ blocks }) { return this.actions.set_attention.call(this, { blocks }); },

    /** Where your forty hours go. The single most consequential thing you set. */
    set_attention({ blocks }) {
      const cal = new Calendar({ blocks, budgetMinutes: this.calendar.budgetMinutes, fatigue: CALENDAR.fatigue });
      if (cal.overBudget > 0) {
        return { ok: false, error: 'over_budget', placed: cal.placedMinutes, budget: cal.budgetMinutes, over: cal.overBudget };
      }
      // An empty week is allowed. It is a terrible plan and the queues will say
      // so all week, but refusing it meant you could never delete the last
      // block — you could not clear the calendar to start over.
      this.calendar.setBlocks(cal.blocks);
      this.strandedLogged = false;
      this.pumpScheduled = null;
      this.pumpHuman();
      const night = cal.blocks.filter((b) => this.calendar.fatigueAt(b.start) > 1).length;
      return { ok: true, placed: cal.placedMinutes, blocks: cal.blocks.length, night_blocks: night };
    },

    /** Which model does the work. A budget that does not refill makes this real. */
    set_model({ model, job = null }) {
      if (!MODELS[model]) return { ok: false, error: 'unknown_model' };
      if (job) this.modelByJob[job] = model;
      else this.modelDefault = model;
      return { ok: true, model, job: job || 'default' };
    },

    /** Somebody has to go and look at the thing that stopped. */
    unblock({ jobId }) {
      const b = this.blockedJobs.find((x) => x.id === jobId);
      if (!b) return { ok: false, error: 'no_such_block' };
      if (b.claimed) return { ok: false, error: 'already_unblocking' };
      b.claimed = true;
      this.human('unblock', FAILURE.hardstop.unblockMinutes, b.itemId, () => {
        b.resolved = true;
        b.lost?.();   // the work it was doing is gone; it has to be run again
        this.blockedJobs = this.blockedJobs.filter((x) => x !== b);
        const alert = this.alerts.find((a) => a.jobId === jobId && !a.resolved);
        if (alert) { alert.resolved = true; alert.resolution = 'unblocked'; }
      });
      return { ok: true, queued: true, wait: Number.isFinite(this.humanFreeIn) ? Math.round(this.humanFreeIn) : null };
    },

    /**
     * Close the plan and start the week. What is sealed here is what the retro
     * gets compared against — which is the only reason it has to be sealed.
     */
    seal_plan({ order = [], placements = [], cut = [], assumptions = [], notes = '' }) {
      const attention = this.calendar.toJSON();
      const plan = {
        sealedAt: this.wallNow(),
        order, placements, cut, assumptions,
        notes: String(notes || '').slice(0, 2000),
        attention,
        models: { default: this.modelDefault, byJob: { ...this.modelByJob } },
        policy: { ...this.policy },
        // The sheet is the plan: who you put on each stage of the work.
        stages: { ...this.stages },
        trust: { ...this.trust },
        flagged: [...this.flagged],
        wipLimit: this.wipLimit,
      };
      plan.hash = hashPlan(plan);
      this.plan = plan;
      this.phase = 'play';
      this.pumpHuman();
      // The shape of the week goes on the tape, not just the hash: the scorer
      // reads results, and "left themselves hours on Saturday" is a decision.
      const weekend = attention.blocks.filter((b) => Math.floor(b.start / 1440) >= 5).length;
      const night = attention.blocks.filter((b) => this.calendar.fatigueAt(b.start) > 1).length;
      return {
        ok: true, hash: plan.hash, placed: attention.placed, blocks: attention.blocks.length,
        weekend_blocks: weekend, night_blocks: night,
        cut: cut.length, assumptions: assumptions.length, placements: placements.length,
      };
    },

    /**
     * After the week: their sealed plan next to what actually happened, and one
     * question. A small, specific change is the signal; "everything better" is
     * not. Nothing here affects the score — it is read, not counted.
     */
    /**
     * The second send. The report already left with the plan; this is whatever
     * they want to add once they have read it, and it travels on its own so the
     * first envelope is never held back waiting for someone to type.
     */
    retro({ text, provenance = null }) {
      this.retroNote = {
        t: this.clock.now, text: String(text || '').slice(0, 2000), provenance,
        planHash: this.plan?.hash || null, score: this.score(),
      };
      if (this.telemetry) this.telemetry.flush('retro');
      this.retroSentAt = this.wallNow();
      return { ok: true, sent: true };
    },

    /** A card moved on the board during planning. Recorded, no effect on the world. */
    plan_place({ id, day, lane, unattended }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      it.planned = { day, lane, unattended: !!unattended };
      return { ok: true };
    },

    set_wip({ n }) {
      this.wipLimit = n > 0 ? n : null;
      return { ok: true, wip: this.wipLimit };
    },

    reprioritise({ order }) {
      const rank = new Map(order.map((id, i) => [id, i]));
      this.items.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
      this.human('reprioritise', HUMAN_MINUTES.reprioritise, null, null);
      return { ok: true };
    },

    /** Writing an assumption down. Cheap, and the rubric pays for it. */
    note({ id, text }) {
      const it = id ? this.item(id) : null;
      if (it) it.assumptionsNoted++;
      this.notes.push({ t: this.clock.now, itemId: id || null, text: String(text || '').slice(0, 800) });
      this.human('note', HUMAN_MINUTES.note, id || null, null);
      return { ok: true, notes: this.notes.length };
    },

    /**
     * Ask the product owner something. Cheap in minutes, and the only way to
     * find out what an undefined term means. Matching is on the term, not on
     * phrasing — asking badly still counts as asking.
     */
    ask({ id, text }) {
      const it = this.item(id);
      const q = String(text || '').toLowerCase();
      this.questions.push({ t: this.clock.now, itemId: id || null, text: String(text || '').slice(0, 400) });
      this.human('escalate', 4, id || null, null);
      if (!it) return { ok: true, answer: this.scenario.genericAnswer || 'No hay nadie de producto disponible ahora mismo.' };
      const hit = (it.undefinedTerms || []).find((term) => q.includes(term.toLowerCase().split(' ')[0]) || q.includes(term.toLowerCase()));
      if (hit) {
        it.clarified = true;
        it.termAsked = hit;
        return { ok: true, answer: it.answers[hit] || `"${hit}" no existe. No lo habíamos definido: decide tú y déjalo escrito.`, resolvedTerm: hit };
      }
      const key = Object.keys(it.answers).find((k) => q.includes(k.toLowerCase()));
      if (key) return { ok: true, answer: it.answers[key] };
      return { ok: true, answer: this.scenario.genericAnswer || 'Buena pregunta. Asume lo que te parezca y déjalo escrito.' };
    },

    /** The full sit-down with the brief. Expensive, removes ambiguity outright. */
    clarify({ id }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      if (stageIndex(it.stage) > stageIndex('code')) return { ok: false, error: 'too_late' };
      this.human('clarify', HUMAN_MINUTES.clarify, id, () => {
        it.clarified = true;
        it.history.push({ t: this.clock.now, what: 'clarified' });
      });
      return { ok: true, queued: true };
    },

    spec({ id, mode = 'agent' }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      if (it.specWritten) return { ok: false, error: 'already_spec' };
      const done = () => {
        it.specWritten = true;
        it.stage = stageIndex(it.stage) < stageIndex('design') ? 'design' : it.stage;
        injectDefects(it, 'design', this.rng, { parallelCoupled: this.coupledLoad(it) });
      };
      if (mode === 'hand') { this.human('spec_hand', HUMAN_MINUTES.spec_hand, id, done); return { ok: true, mode }; }
      const j = this.submit('spec_gen', it, {}, done);
      return j.state === 'rejected' ? { ok: false, error: j.reason } : { ok: true, job: j.id, mode };
    },

    code({ id, mode = 'agent', when = 'now' }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      if (it.stage === 'backlog') return { ok: false, error: 'not_pulled' };
      if (it.coding) return { ok: false, error: 'already_coding' };
      if (it.codeMode) return { ok: false, error: 'already_coded' };
      const blockers = (it.dependsOn || [])
        .map((d) => this.item(d))
        .filter((d) => d && !d.dropped && stageIndex(d.stage) < stageIndex(DEPENDENCIES.blockUntilStage));
      if (blockers.length) return { ok: false, error: 'blocked_by', ids: blockers.map((d) => d.id) };
      it.coding = true;
      // Understanding is committed the moment you start building on it.
      if (!it.requirementsInjected) {
        it.requirementsInjected = true;
        injectDefects(it, 'requirements', this.rng, {});
        if (!it.specWritten) injectDefects(it, 'design', this.rng, { parallelCoupled: this.coupledLoad(it) });
      }
      const done = () => {
        it.coding = false;
        injectDefects(it, 'code', this.rng, { parallelCoupled: this.coupledLoad(it) });
        it.stage = 'verify';
        it.history.push({ t: this.clock.now, what: 'coded', mode });
      };
      if (mode === 'hand') {
        it.codeMode = mode;
        this.human('code_hand', HUMAN_MINUTES.code_hand + 6 * it.complexity, id, done);
        return { ok: true, mode };
      }
      const j = this.submit('code_gen', it, {}, done, { lost: () => { it.coding = false; it.codeMode = null; } }, when);
      // A rejected job must leave no trace, or the card is stuck for the week.
      if (j.state === 'rejected') { it.coding = false; return { ok: false, error: j.reason }; }
      it.codeMode = mode;
      return { ok: true, job: j.id, mode, model: this.modelFor('code_gen'), when };
    },

    /**
     * Tests. `level` decides whether the suite can see anything at all:
     * `happy` is the green suite that asserts the mock, `mutation` is the one
     * that has been made to fail on purpose before being trusted.
     */
    verify({ id, level = 'happy', when = 'now' }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      if (!TEST_LEVELS[level]) return { ok: false, error: 'bad_level' };
      if (level === 'none') { it.testLevel = 'none'; it.testsBite = 0; return { ok: true, level }; }
      const cfg = TEST_LEVELS[level];
      it.testLevel = level;
      it.testsBite = biteFor(level);
      const caught = [];
      let pending = cfg.jobs.length;
      const step = (gate) => {
        if (gate) caught.push(...detect(it, gate, this.rng));
        if (--pending === 0) this.afterGate(it, caught, level === 'mutation' ? 'mutation' : 'tests');
      };
      for (const kind of cfg.jobs) {
        const over = {};
        if (cfg.extraMinutes) over.minutes = Math.round(JOBS[kind].minutes * cfg.extraMinutes);
        if (cfg.extraTokens) over.tokens = Math.round(JOBS[kind].tokens(it) * cfg.extraTokens);
        const gate = kind === 'unit_tests' ? 'tests' : kind === 'mutation_run' ? 'mutation' : null;
        const j = this.submit(kind, it, over, () => step(gate), {}, when);
        if (j.state === 'rejected') { step(null); }
      }
      return { ok: true, level, bite: it.testsBite, when };
    },

    review({ id, by = 'human' }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      it.reviewedBy.push(by);
      if (by === 'human') {
        this.human('review_human', HUMAN_MINUTES.review_human, id, () => {
          this.afterGate(it, detect(it, 'review_human', this.rng), 'review_human');
        });
        return { ok: true, by };
      }
      const j = this.submit('review_agent', it, {}, () => {
        const caught = detect(it, 'review_agent', this.rng);
        // Agent review also produces noise. Chasing it costs the dev real time.
        if (this.rng.chance(0.45)) {
          this.human('review_human', 8, id, null);
          this.pushAlert({ type: 'false_positive', itemId: it.id, text: `La revisión automática marcó 2 hallazgos en ${it.id}; uno no existe.` });
        }
        this.afterGate(it, caught, 'review_agent');
      });
      return j.state === 'rejected' ? { ok: false, error: j.reason } : { ok: true, by, job: j.id };
    },

    manual_qa({ id }) {
      const it = this.item(id);
      if (!it) return { ok: false, error: 'no_such_item' };
      it.manualQa = true;
      this.human('manual_qa', HUMAN_MINUTES.manual_qa, id, () => {
        this.afterGate(it, detect(it, 'manual_qa', this.rng), 'manual_qa');
      });
      return { ok: true };
    },

    /** Batch the build or don't. Both cost something; that is the decision. */
    build({ ids, when = 'now' }) {
      const items = (ids || []).map((i) => this.item(i)).filter(Boolean);
      if (!items.length) return { ok: false, error: 'no_items' };
      const notReady = items.filter((i) => stageIndex(i.stage) < stageIndex('verify'));
      if (notReady.length) return { ok: false, error: 'not_coded', ids: notReady.map((i) => i.id) };
      this.counters.builds++;
      const minutes = BUILD.fixedMinutes + BUILD.perItemMinutes * items.length;
      const j = this.submit('build_android', items[0], { minutes, itemId: items.map((i) => i.id).join('+') }, () => {
        // A build breaks when something in the batch carries an open resource or
        // integration defect. With one item you know who; with five you bisect.
        const breaker = items.find((i) => openDefects(i).some((d) => d.kind === 'resource' || d.kind === 'integration') && this.rng.chance(0.55));
        if (breaker) {
          this.counters.buildFailures++;
          const bisect = items.length > 1 ? BUILD.bisectMinutesPerItem * items.length : HUMAN_MINUTES.triage_build_failure;
          this.pushAlert({ type: 'build_red', itemId: breaker.id, text: `Build en rojo con ${items.length} cambio(s) dentro. Aislar cuesta ~${bisect} min.` });
          this.human('triage_build_failure', bisect, breaker.id, () => {
            const d = openDefects(breaker).find((x) => x.kind === 'resource' || x.kind === 'integration');
            if (d) { d.found = 'build'; this.afterGate(breaker, [d], 'build'); }
          });
        } else {
          for (const i of items) i.stage = stageIndex(i.stage) < stageIndex('build') ? 'build' : i.stage;
        }
      }, {}, when);
      if (j.state === 'rejected') return { ok: false, error: j.reason };
      return { ok: true, job: j.id, batch: items.length, minutes, when };
    },

    deploy({ ids, strategy = 'full' }) {
      const items = (ids || []).map((i) => this.item(i)).filter(Boolean);
      if (!items.length) return { ok: false, error: 'no_items' };
      const notBuilt = items.filter((i) => stageIndex(i.stage) < stageIndex('build'));
      if (notBuilt.length) return { ok: false, error: 'not_built', ids: notBuilt.map((i) => i.id) };
      const cfg = DEPLOY[strategy] || DEPLOY.full;
      const j = this.submit('deploy', items[0], { minutes: JOBS.deploy.minutes + cfg.extraMinutes, itemId: items.map((i) => i.id).join('+') }, () => {
        for (const it of items) {
          it.deployStrategy = strategy;
          if (strategy === 'canary') this.afterGate(it, detect(it, 'canary', this.rng), 'canary');
          it.stage = 'deploy';
          it.deployedAt = this.clock.now;
          // Shipping finds things. Half of what got through surfaces in the
          // first hours, with real users on it; the rest takes days.
          const live = openDefects(it);
          for (const d of live) {
            const early = this.rng.chance(DEPLOY.discoveryShare);
            this.scheduleEscape(it, d, cfg.incidentMultiplier, early);
          }
          if (live.length) {
            this.log('deploy_discovery', { item: it.id, live: live.length, strategy }, { snapshot: false });
          }
        }
      });
      if (j.state === 'rejected') return { ok: false, error: j.reason };
      return { ok: true, job: j.id, strategy };
    },

    /**
     * Telling people. A deploy nobody hears about barely counts, and the
     * announcement is where a release note either says what changed or doesn't.
     */
    announce({ ids, audience = 'team', text = '' }) {
      const items = (ids || []).map((i) => this.item(i)).filter(Boolean);
      if (!items.length) return { ok: false, error: 'no_items' };
      const undeployed = items.filter((i) => stageIndex(i.stage) < stageIndex('deploy'));
      const cfg = ANNOUNCE[audience] || ANNOUNCE.team;
      this.announcements = this.announcements || [];
      this.announcements.push({ t: this.clock.now, ids: items.map((i) => i.id), audience, text: String(text || '').slice(0, 800), premature: undeployed.length > 0 });
      if (cfg.minutes) this.human('announce', cfg.minutes, null, null);
      for (const it of items) {
        if (stageIndex(it.stage) < stageIndex('deploy')) continue;
        it.announceAudience = audience;
        it.announcedAt = this.clock.now;
        it.stage = 'done';
        it.doneAt = this.clock.now;
        // Anything that misses the demo is worth half. It still shipped; it just
        // did not ship in time for the only person who was going to look.
        it.late = !!(this.deadline && this.clock.now > this.deadline.at);
        it.valueRealised = cfg.realised * (it.late ? (this.deadline.lateFactor ?? DEADLINE.lateFactor) : 1);
      }
      if (undeployed.length) {
        this.reputation -= 2 * undeployed.length;
        this.pushAlert({ type: 'announced_undeployed', text: `Anunciaste ${undeployed.map((i) => i.id).join(', ')} sin haber desplegado.` });
      }
      return { ok: true, audience, announced: items.length - undeployed.length, premature: undeployed.map((i) => i.id) };
    },

    // --- alerts -------------------------------------------------------------

    /** "Relánzalo" is not a diagnosis. It is, however, always available. */
    rerun({ alertId }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a || a.resolved) return { ok: false, error: 'no_such_alert' };
      this.ciState.reruns++;
      if (a.type === 'ci_red') {
        if (this.rng.chance(0.6)) {
          a.resolved = true; a.resolution = 'rerun_green';
          this.ciState.maskedCause = true;
          // It went green, so the real cause is still there and will come back.
          this.clock.after(this.rng.int(90, 200), 'script:ci_red', () => this.fireScripted({ type: 'ci_red', repeat: true }));
        } else {
          a.attempts = (a.attempts || 0) + 1;
        }
      } else { a.attempts = (a.attempts || 0) + 1; }
      return { ok: true, reruns: this.ciState.reruns, resolved: !!a.resolved };
    },

    investigate({ alertId }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a || a.resolved) return { ok: false, error: 'no_such_alert' };
      this.human('investigate', HUMAN_MINUTES.investigate, a.itemId || null, () => {
        a.resolved = true; a.resolution = 'investigated';
        if (a.type === 'ci_red') {
          this.ciState.investigated = true;
          a.finding = this.scenario.ciFinding || 'El reparto por JVM cambió al añadir clases de test: no es flaky, es aislamiento.';
        }
        if (a.itemId) {
          const it = this.item(a.itemId);
          const d = it && openDefects(it)[0];
          if (d) { d.found = 'investigate'; this.afterGate(it, [d], 'investigate'); }
        }
      });
      return { ok: true };
    },

    /** Hand a product decision back to whoever owns it. */
    escalate({ alertId, options = [], recommendation = '', text = '' }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a || a.resolved) return { ok: false, error: 'no_such_alert' };
      a.escalated = { t: this.clock.now, options, recommendation, text: String(text || '').slice(0, 800) };
      this.human('escalate', HUMAN_MINUTES.escalate, a.itemId || null, () => {
        this.clock.after(this.rng.int(30, 70), 'script:fork_answer', () => {
          a.answered = true;
          a.answer = a.fourthOption || this.scenario.forkAnswer;
          this.pushAlert({ type: 'fork_answer', parent: a.id, text: a.answer, itemId: a.itemId });
        });
      });
      return { ok: true, waiting: true };
    },

    /** Decide it yourself. Legitimate — as long as you know it was yours to take. */
    decide({ alertId, option, rationale = '' }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a || a.resolved) return { ok: false, error: 'no_such_alert' };
      a.resolved = true; a.resolution = 'decided'; a.decision = { option, rationale: String(rationale).slice(0, 600) };
      if (a.type === 'product_fork' && !a.escalated) {
        // Deciding a product fork alone is not punished mechanically. It is
        // recorded, because how it was taken is the measurement.
        const it = a.itemId && this.item(a.itemId);
        if (it && !rationale) this.reputation -= 1;
      }
      return { ok: true };
    },

    /**
     * The false premise, answered.
     *
     * Somewhere in the week an alert refers to something that never happened —
     * a decision "we agreed yesterday" when there was no yesterday and no
     * conversation. A person who is reading stops. A model completing text
     * accepts the premise, because accepting premises is what it does.
     *
     * Neither answer costs anything mechanically. The whole value is in which
     * one they pick, and how long they sat on it.
     */
    answer_premise({ alertId, stance, text = '' }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a || a.type !== 'false_premise') return { ok: false, error: 'no_such_alert' };
      if (a.resolved) return { ok: false, error: 'already_answered' };
      a.resolved = true;
      a.stance = stance;                       // 'confirm' | 'reject' | 'unsure'
      a.stanceText = String(text).slice(0, 600);
      return { ok: true, stance, was_true: false };
    },

    /**
     * "I do not have enough to decide this."
     *
     * Costs nothing, is never penalised, and on several of the seeded moments it
     * is the correct answer. Models almost never pick it: answering is the job.
     * A person with the clock running does.
     */
    dont_know({ alertId = null, id = null, text = '' }) {
      const a = alertId ? this.alerts.find((x) => x.id === alertId) : null;
      this.unsure = this.unsure || [];
      this.unsure.push({ t: this.clock.now, alertId, itemId: id, type: a?.type || null, text: String(text).slice(0, 600) });
      if (a && a.type === 'product_fork') {
        // Not knowing whose call it is, and saying so, is an escalation.
        a.escalated = { t: this.clock.now, options: [], recommendation: '', text: String(text).slice(0, 600), viaDontKnow: true };
        this.human('escalate', HUMAN_MINUTES.escalate, a.itemId || null, () => {
          this.clock.after(this.rng.int(30, 70), 'script:fork_answer', () => {
            a.answered = true;
            a.answer = a.fourthOption || this.scenario.forkAnswer;
            this.pushAlert({ type: 'fork_answer', parent: a.id, text: a.answer, itemId: a.itemId });
          });
        });
      }
      return { ok: true, recorded: true };
    },

    /** What they do when a better idea than theirs comes back. */
    respond_fork({ alertId, stance, text = '' }) {
      const a = this.alerts.find((x) => x.id === alertId);
      if (!a) return { ok: false, error: 'no_such_alert' };
      a.resolved = true;
      a.stance = stance; // 'accept' | 'defend' | 'merge'
      a.stanceText = String(text).slice(0, 600);
      return { ok: true, stance };
    },

    /**
     * A production bug, and three ways to answer it. None is free and none is
     * wrong on its own — which one, and how fast, is the measurement.
     *
     *   hotfix   — fix it properly. Costs half an hour of you plus a build, and
     *              a fix under pressure plants a little of its own.
     *   rollback — pull it back. The bleeding stops and so does the value.
     *   accept   — leave it. Costs nothing now; the SLA clock keeps running.
     */
    incident_action({ incidentId, choice, rationale = '' }) {
      const inc = this.incidents.find((x) => x.id === incidentId);
      if (!inc) return { ok: false, error: 'no_such_incident' };
      if (inc.resolved || inc.choice) return { ok: false, error: 'already_handled' };
      inc.choice = choice;
      inc.rationale = String(rationale).slice(0, 600);
      const it = inc.itemId ? this.item(inc.itemId) : null;
      const alert = this.alerts.find((a) => a.incidentId === inc.id && a.type === 'incident');

      if (choice === 'accept') {
        inc.resolved = false;
        inc.accepted = true;
        if (alert) { alert.resolved = true; alert.resolution = 'accepted'; }
        return { ok: true, choice, note: 'el margen sigue corriendo' };
      }

      if (choice === 'rollback') {
        this.human('investigate', INCIDENT.rollback.humanMinutes, inc.itemId, () => {
          inc.resolved = true;
          inc.fixed = true;
          const d = it && it.defects.find((x) => x.id === inc.defectId);
          if (d) d.fixed = true;
          // What you pulled back is not shipped any more.
          if (it && it.stage === 'done') it.valueRealised *= INCIDENT.rollback.valueKept;
          if (alert) { alert.resolved = true; alert.resolution = 'rolled_back'; }
          this.log('incident_resolved', { id: inc.id, how: 'rollback', item: inc.itemId }, { snapshot: false });
        }, true);
        return { ok: true, choice, queued: true };
      }

      if (choice === 'hotfix') {
        this.counters.rework++;
        if (it) it.reworkCount++;
        this.human('investigate', INCIDENT.hotfix.humanMinutes, inc.itemId, () => {
          // A legacy bug has no card of ours behind it, so there is no item to
          // hand the job — just the work.
          const j = this.submit('code_gen', it, { minutes: INCIDENT.hotfix.jobMinutes, itemId: inc.itemId }, () => {
            inc.resolved = true;
            inc.fixed = true;
            const d = it && it.defects.find((x) => x.id === inc.defectId);
            if (d) d.fixed = true;
            // Fixing in a hurry moves the problem a little. It always does.
            if (it) injectDefects(it, 'code', this.rng, { scale: INCIDENT.hotfix.extraDefectScale * MODIFIERS.fixScale });
            if (alert) { alert.resolved = true; alert.resolution = 'hotfixed'; }
            this.log('incident_resolved', { id: inc.id, how: 'hotfix', item: inc.itemId }, { snapshot: false });
          });
          if (j.state === 'rejected') {
            inc.choice = null;
            this.pushAlert({ type: 'note', autoResolve: true, text: `No pudiste lanzar el hotfix de ${inc.title}: ${j.reason}.` });
          }
        }, true);
        return { ok: true, choice, queued: true };
      }
      inc.choice = null;
      return { ok: false, error: 'unknown_choice' };
    },

    /** Kept for the short form. `incident_action` is the real surface. */
    hotfix({ id, incidentId }) {
      const inc = incidentId
        ? this.incidents.find((x) => x.id === incidentId)
        : this.incidents.find((x) => x.itemId === id && !x.resolved && !x.choice);
      if (!inc) return { ok: false, error: 'no_incident' };
      return this.actions.incident_action.call(this, { incidentId: inc.id, choice: 'hotfix' });
    },
  };

  // --------------------------------------------------------------- internals

  // =================================================================
  // The delegated pipeline, step by step. Every human touchpoint here is a
  // queue entry, which means it only happens in a block you booked for it.
  // =================================================================

  /** Pull whatever the pipe has room for, oldest first, respecting dependencies. */
  autoDelegate() {
    const ready = this.items.filter((it) => it.stage === 'backlog' && !it.dropped && !it.delegated
      && (it.dependsOn || []).every((d) => {
        const o = this.item(d);
        return !o || o.dropped || stageIndex(o.stage) >= stageIndex('output_review');
      }));
    if (!ready.length) return;
    const room = this.wipLimit ? Math.max(0, this.wipLimit - this.inFlight.length) : ready.length;
    const take = ready.slice(0, Math.min(room, 25));
    if (take.length) this.actions.delegate.call(this, { ids: take.map((i) => i.id) });
  }

  /**
   * Does this card reach your desk?
   *
   * Saying "leo el 35% de los planes" means you read thirty-five cards out of a
   * hundred, not that you skim all hundred badly. The ones you skip never enter
   * the queue and never cost you a minute — and that saved hour is exactly what
   * you are buying when you choose a share. Anything you flagged is always
   * read: flagging is how you say "this one, whatever the share says".
   */
  readsIt(it, share) {
    if (this.flagged.has(it.id)) return true;
    return this.rng.next() < (typeof share === 'number' ? share : 0);
  }

  /** The agent has a plan. It goes in the queue and waits for you. */
  planReady(it) {
    if (!it.requirementsInjected) {
      it.requirementsInjected = true;
      const md = MODELS[this.modelFor('plan_gen')].defects;
      injectDefects(it, 'requirements', this.rng, { modelDefects: md });
      injectDefects(it, 'design', this.rng, { parallelCoupled: this.coupledLoad(it), modelDefects: md });
    }
    it.stage = 'plan_review';
    it.planQueuedAt = this.clock.now;
    if (this.stages.plan_review === 'ia') {
      // You handed your own judgement to an agent. It will say yes to almost
      // everything, which is roughly what happens.
      this.submit('review_agent', it, { minutes: UNDELEGABLE_AI.plan_review.minutes }, () => {
        it.planRead = false;
        it.planByAgent = true;
        const caught = this.rng.chance(UNDELEGABLE_AI.plan_review.catch) ? detect(it, 'plan_review', this.rng) : [];
        for (const d of caught) d.fixed = true;
        this.startBuild(it);
      });
      return;
    }
    if (!this.readsIt(it, this.trust.plan)) {
      it.planRead = false;
      it.planSkipped = true;
      this.counters.planSkipped = (this.counters.planSkipped || 0) + 1;
      this.startBuild(it);
      return;
    }
    this.enqueue('plan_review', it.id, () => this.resolvePlanReview(it));
  }

  /**
   * Reading a plan is where "built the wrong thing" gets caught, and almost the
   * only place. Waving it through is fast and costs you nothing today.
   */
  resolvePlanReview(it) {
    // It only reached your desk because you chose to read it.
    const read = true;
    it.planRead = read;
    it.planRejects = it.planRejects || 0;
    const caught = read ? detect(it, 'plan_review', this.rng) : [];

    if (caught.length && it.planRejects < 2) {
      it.planRejects++;
      this.counters.planRejects = (this.counters.planRejects || 0) + 1;
      // Caught in the plan is the cheap place to catch it: nothing was built yet.
      for (const d of caught) d.fixed = true;
      it.stage = 'planning';
      this.submit('plan_gen', it, { minutes: 4 }, () => this.planReady(it));
      return { itemId: it.id, read, decision: 'reject' };
    }
    for (const d of caught) d.fixed = true;
    it.planApprovedAt = this.clock.now;
    this.startBuild(it);
    return { itemId: it.id, read, decision: 'approve' };
  }

  /** Approved: the agents build it and test it to whatever bar you set once. */
  startBuild(it) {
    it.stage = 'building';
    it.codeMode = it.codeMode || 'agent';
    this.submit('code_gen', it, {}, () => {
      injectDefects(it, 'code', this.rng, {
        parallelCoupled: this.coupledLoad(it),
        modelDefects: MODELS[this.modelFor('code_gen')].defects,
        planUnread: !it.planRead,
      });
      this.runPolicyTests(it, () => this.outputReady(it));
    }, { lost: () => { it.stage = 'plan_review'; this.enqueue('plan_review', it.id, () => this.resolvePlanReview(it)); } });
  }

  runPolicyTests(it, then) {
    if (this.stages.auto_tests === 'no') { it.testLevel = 'none'; it.testsBite = 0; then(); return; }
    const level = this.policy.tests;
    const cfg = TEST_LEVELS[level];
    if (!cfg || !cfg.jobs.length) { it.testLevel = 'none'; it.testsBite = 0; then(); return; }
    it.testLevel = level;
    it.testsBite = biteFor(level);
    let pending = cfg.jobs.length;
    const caught = [];
    for (const kind of cfg.jobs) {
      const gate = kind === 'unit_tests' ? 'tests' : kind === 'mutation_run' ? 'mutation' : null;
      const over = {};
      if (cfg.extraMinutes) over.minutes = Math.round(JOBS[kind].minutes * cfg.extraMinutes);
      const j = this.submit(kind, it, over, () => {
        if (gate) caught.push(...detect(it, gate, this.rng));
        if (--pending === 0) { this.afterGate(it, caught, level === 'mutation' ? 'mutation' : 'tests'); then(); }
      });
      if (j.state === 'rejected' && --pending === 0) then();
    }
  }

  /** Built. Now it waits for you to look at what came back. */
  outputReady(it) {
    it.stage = 'output_review';
    it.outputQueuedAt = this.clock.now;
    if (this.stages.output_review === 'ia') {
      this.submit('review_agent', it, { minutes: UNDELEGABLE_AI.output_review.minutes }, () => {
        it.outputRead = false;
        it.outputByAgent = true;
        const caught = this.rng.chance(UNDELEGABLE_AI.output_review.catch) ? detect(it, 'output_review', this.rng) : [];
        this.afterGate(it, caught, 'output_review');
        this.maybeManualTest(it);
      });
      return;
    }
    if (!this.readsIt(it, this.trust.output)) {
      it.outputRead = false;
      it.outputSkipped = true;
      this.counters.outputSkipped = (this.counters.outputSkipped || 0) + 1;
      this.maybeManualTest(it);
      return;
    }
    this.enqueue('output_review', it.id, () => this.resolveOutputReview(it));
  }

  /**
   * Manual testing, per the sheet. A share of the work gets used by a person;
   * the rest ships on the automation. Assigning it to an agent is allowed and
   * catches almost nothing, because an agent has no hands and no eyes.
   */
  maybeManualTest(it) {
    const who = this.stages.manual_test;
    if (who === 'ia') {
      this.submit('review_agent', it, { minutes: UNDELEGABLE_AI.manual_test.minutes }, () => {
        it.manualByAgent = true;
        const caught = this.rng.chance(UNDELEGABLE_AI.manual_test.catch) ? detect(it, 'manual_qa', this.rng) : [];
        this.afterGate(it, caught, 'manual_qa');
        this.shipIt(it);
      });
      return;
    }
    const share = typeof who === 'number' ? who : 0;
    if (share > 0 && !it.manualQueued && this.rng.next() < share) {
      it.manualQueued = true;
      it.stage = 'testing';
      this.enqueue('manual_test', it.id, () => {
        it.manualQa = true;
        const caught = detect(it, 'manual_qa', this.rng);
        this.afterGate(it, caught, 'manual_qa');
        this.shipIt(it);
        return { itemId: it.id, read: true, decision: caught.length ? 'reject' : 'approve' };
      });
      return;
    }
    this.shipIt(it);
  }

  resolveOutputReview(it) {
    const read = true;
    it.outputRead = read;
    it.outputRejects = it.outputRejects || 0;
    const caught = read ? detect(it, 'output_review', this.rng) : [];

    if (caught.length && it.outputRejects < 2) {
      it.outputRejects++;
      this.counters.outputRejects = (this.counters.outputRejects || 0) + 1;
      this.afterGate(it, caught, 'output_review');
      it.stage = 'building';
      this.clock.after(1, 'rework', () => this.outputReady(it));
      return { itemId: it.id, read, decision: 'reject' };
    }
    this.maybeManualTest(it);
    return { itemId: it.id, read, decision: 'approve' };
  }

  /**
   * Approved, so it ships — build, deploy and release note, all on the policy
   * you set once. Nothing here costs you a minute, which is the point: the
   * human is the reviewer, not the release engineer.
   */
  shipIt(it) {
    it.stage = 'shipping';
    this.submit('build_android', it, { minutes: BUILD.fixedMinutes }, () => {
      const cfg = DEPLOY[this.policy.deploy] || DEPLOY.canary;
      this.submit('deploy', it, { minutes: JOBS.deploy.minutes + cfg.extraMinutes }, () => {
        it.deployStrategy = this.policy.deploy;
        it.deployedAt = this.clock.now;
        if (this.policy.deploy === 'canary') this.afterGate(it, detect(it, 'canary', this.rng), 'canary');
        for (const d of openDefects(it)) {
          this.scheduleEscape(it, d, cfg.incidentMultiplier, this.rng.chance(DEPLOY.discoveryShare));
        }
        this.deliver(it);
      });
    });
  }

  /** In the week, or not in the presentation. */
  deliver(it) {
    const cfg = ANNOUNCE[this.policy.announce] || ANNOUNCE.client;
    const close = this.scenario.closesAt ?? CALENDAR.closesAt;
    const open = this.scenario.opensAt ?? CALENDAR.opensAt;
    it.stage = 'done';
    it.doneAt = this.clock.now;
    it.announceAudience = this.policy.announce;
    it.late = this.clock.now > close;
    if (it.late) {
      it.valueRealised = 0;
    } else {
      // Sooner is worth more: the same week compressed is the whole idea.
      const frac = Math.max(0, Math.min(1, (this.clock.now - open) / Math.max(1, close - open)));
      it.valueRealised = cfg.realised * (1 + DELIVERY.earlyBonus * (1 - frac));
    }
    this.counters.delivered = (this.counters.delivered || 0) + 1;
    this.log('delivered', {
      item: it.id, at: Calendar.label(this.clock.now), value: Number((it.impact * it.valueRealised).toFixed(2)),
      plan_read: !!it.planRead, output_read: !!it.outputRead, tested: !!it.manualQa, late: it.late,
    }, { snapshot: false });
  }

  /** A defect caught before release still costs: the item goes back for a fix. */
  afterGate(item, caught, gate) {
    if (!caught.length) return;
    this.log('defects_found', { item: item.id, gate, n: caught.length, kinds: caught.map((d) => d.kind) }, { snapshot: false });
    this.pushAlert({ type: 'defect_found', itemId: item.id, text: `${caught.length} defecto(s) encontrados en ${item.id} por ${gate}.`, autoResolve: true });
    item.reworkCount++;
    this.counters.rework++;
    item.rechecks = item.rechecks || {};
    const minutes = 4 + 3 * caught.length;
    this.submit('code_gen', item, { minutes, tokens: Math.round(JOBS.code_gen.tokens(item) * 0.45) }, () => {
      for (const d of caught) d.fixed = true;
      // Fixing plants a little of its own. Every fix moves the problem — but a
      // fix touches far less than a first write, hence the scale.
      injectDefects(item, 'code', this.rng, { parallelCoupled: this.coupledLoad(item), scale: MODIFIERS.fixScale });
      // You re-run the gate that caught it. Twice at most: after that you are
      // not verifying any more, you are hoping.
      const n = item.rechecks[gate] || 0;
      if (n < 2 && gate !== 'build' && gate !== 'investigate') {
        item.rechecks[gate] = n + 1;
        this.afterGate(item, detect(item, gate, this.rng), gate);
      }
    });
  }

  scheduleEscape(item, defect, incidentMultiplier, early = false) {
    defect.escaped = true;
    const delay = early
      ? this.rng.int(DEPLOY.discoveryWindow[0], DEPLOY.discoveryWindow[1])
      : this.rng.int(INCIDENT.latency[0], INCIDENT.latency[1]);
    this.clock.after(delay, 'incident', () => {
      if (defect.fixed) return;
      this.openIncident({
        itemId: item.id, defectId: defect.id, kind: defect.kind,
        weight: escapeWeight(defect, item) * incidentMultiplier,
        title: `${defect.kind} en ${item.id}`, source: early ? 'deploy_early' : 'deploy',
      });
    });
  }

  /**
   * Something is broken in front of users. Two things start at once: the damage,
   * and a clock. A P1 that sits until Monday is not the same bug on Monday — it
   * is a bug plus four days of people working around it.
   */
  openIncident({ itemId = null, defectId = null, kind = 'logic', weight = 2, title = '', source = 'deploy' }) {
    const severity = weight >= 4.5 ? 'p1' : 'p2';
    const inc = {
      id: `INC${this.incidents.length + 1}`, t: this.clock.now, itemId, defectId, kind, weight, severity, source,
      title: title || `${kind}${itemId ? ` en ${itemId}` : ''}`,
      dueAt: this.clock.now + INCIDENT.sla[severity],
      resolved: false, fixed: false, breached: false, choice: null,
    };
    this.incidents.push(inc);
    this.reputation -= weight * INCIDENT.reputationPerPoint;
    this.pushAlert({
      type: 'incident', itemId, incidentId: inc.id,
      text: `${severity.toUpperCase()} en producción — ${inc.title}. Los usuarios ya lo están viendo. ` +
            `Margen hasta ${Calendar.label(inc.dueAt)}.`,
    });
    this.log('incident', { id: inc.id, item: itemId, kind, source, severity, weight: Number(weight.toFixed(2)), due: inc.dueAt }, { snapshot: false });

    this.clock.at(inc.dueAt, 'sla', () => {
      if (inc.resolved) return;
      inc.breached = true;
      const extra = inc.weight * (INCIDENT.slaBreachMultiplier - 1);
      this.reputation -= extra;
      this.log('sla_breach', { id: inc.id, item: itemId, severity, extra: Number(extra.toFixed(2)) }, { snapshot: false });
      this.pushAlert({
        type: 'sla', incidentId: inc.id, itemId,
        text: `Se pasó el margen de ${inc.title} y sigue roto. A partir de aquí el daño ya no se recupera arreglándolo.`,
        autoResolve: true,
      });
    });
    return inc;
  }

  /**
   * End of a day. Not a pause and not a screen to click through — a line in the
   * log saying what the last twenty-four hours actually did, while the week
   * keeps running underneath it.
   */
  closeEpoch(at) {
    if (this.finished) return;
    const n = Math.floor(at / EPOCH.minutes) - 1;
    const from = this.epochMark || { ledger: 0, tokens: 0, human: 0, shipped: 0, incidents: 0 };
    const sc = this.score();
    const decisions = this.ledger.slice(from.ledger);
    const digest = {
      day: n,
      at: Calendar.label(at - 1),
      decisions: decisions.length,
      highlights: decisions.filter((d) => ['deploy', 'announce', 'escalate', 'drop', 'incident_action', 'answer_premise'].includes(d.action))
        .map((d) => `${d.action}${d.item ? ` ${d.item}` : ''}${d.detail ? ` (${d.detail})` : ''}`),
      shipped: sc.shipped - from.shipped,
      incidents: sc.incidents - from.incidents,
      tokens: sc.tokens_spent - from.tokens,
      your_minutes: sc.human_minutes - from.human,
      in_flight: this.inFlight.length,
      blocked: this.blockedJobs.length,
      open_incidents: this.incidents.filter((i) => !i.resolved).length,
    };
    this.epochs.push(digest);
    this.peakQueue = this.peakQueue || [];
    this.peakQueue.push(Object.values(this.queueDepth).reduce((a, b) => a + b, 0));
    this.epochMark = { ledger: this.ledger.length, tokens: sc.tokens_spent, human: sc.human_minutes, shipped: sc.shipped, incidents: sc.incidents };
    this.log('epoch_close', digest, { snapshot: false });
    this.pushAlert({
      type: 'epoch', autoResolve: true,
      text: `Cierre del ${EPOCH.label} ${n + 1}: ${digest.decisions} decisiones · ${digest.shipped} entregado(s) · ` +
            `${Math.round(digest.your_minutes)} min tuyos · ${digest.in_flight} en curso` +
            (digest.open_incidents ? ` · ${digest.open_incidents} incidente(s) abiertos` : ''),
    });
  }

  pushAlert(a) {
    const alert = { id: `A${this.alerts.length + 1}`, t: this.clock.now, resolved: false, ...a };
    this.alerts.push(alert);
    if (a.autoResolve) alert.resolved = true;
    return alert;
  }

  fireScripted(ev) {
    if (this.finished) return;
    if (ev.type === 'ci_red') {
      if (this.ciState.investigated) return; // root cause is gone; it does not come back
      this.ciState.redSeen++;
      this.pushAlert({ type: 'ci_red', text: ev.text || 'CI en rojo en un test que tu cambio no toca. Local pasa siete de siete.', itemId: ev.itemId || null });
    } else if (ev.type === 'product_fork') {
      this.pushAlert({
        type: 'product_fork', itemId: ev.itemId || null,
        text: ev.text, fourthOption: ev.fourthOption, options: ev.options || [],
      });
    } else if (ev.type === 'rush') {
      const it = makeItem(ev.item, this.items.length);
      it.rush = true;
      this.items.push(it);
      this.pushAlert({ type: 'rush', itemId: it.id, text: ev.text || `Entra ${it.id} "${it.title}" y lo piden para hoy.`, autoResolve: true });
    } else if (ev.type === 'prod_bug') {
      // Not from this week's work. Somebody else's release, or last month's.
      // The week does not care whose fault it is.
      this.openIncident({
        itemId: ev.itemId || null, kind: ev.kind || 'logic',
        weight: ev.weight ?? 5, title: ev.title, source: 'legacy',
      });
    } else if (ev.type === 'false_premise') {
      this.pushAlert({ type: 'false_premise', itemId: ev.itemId || null, text: ev.text });
    } else if (ev.type === 'note') {
      this.pushAlert({ type: 'note', text: ev.text, autoResolve: true });
    }
    this.log('scripted_event', { type: ev.type, at: this.clock.now }, { snapshot: false });
  }

  // ------------------------------------------------------------------ scoring

  /** What the player sees. The judgement of *how* they got here is not here. */
  score() {
    const shipped = this.items.filter((i) => i.stage === 'done');
    const delivered = shipped.reduce((a, i) => a + i.impact * i.valueRealised, 0);
    const escapedDefects = this.items.flatMap((i) => i.defects.filter((d) => d.escaped && !d.fixed).map((d) => ({ d, i })));
    const escapedWeight = escapedDefects.reduce((a, { d, i }) => a + escapeWeight(d, i), 0);
    const cycleTimes = shipped.filter((i) => i.pulledAt != null).map((i) => i.doneAt - i.pulledAt);
    const cleanShipped = shipped.filter((i) => !i.defects.some((d) => d.escaped && !d.fixed));
    const cleanValue = cleanShipped.reduce((a, i) => a + i.impact * i.valueRealised, 0);
    return {
      delivered: Number(delivered.toFixed(2)),
      shipped: shipped.length,
      clean_shipped: cleanShipped.length,
      late: shipped.filter((i) => i.late).length,
      escaped_defects: escapedDefects.length,
      escaped_weight: Number(escapedWeight.toFixed(2)),
      incidents: this.incidents.length,
      reputation: Number(this.reputation.toFixed(2)),
      /** The headline the player is playing for: value that shipped and stayed
       *  shipped. Anything that came back as an incident does not count. */
      clean_value: Number(cleanValue.toFixed(2)),
      quality_index: Number((delivered / (1 + escapedWeight)).toFixed(2)),
      tokens_spent: this.budgets.tokens.spent,
      tokens_left: this.budgets.tokens.left,
      human_minutes: this.humanMinutesUsed,
      avg_cycle_time: cycleTimes.length ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) : null,
      rework: this.counters.rework,
      jobs_rejected: this.counters.rejected,
      context_switches: this.counters.contextSwitches,
      preemptions: this.counters.preempted,
      soft_failures: this.counters.softFailures,
      blocked_jobs: this.counters.blocked,
      hard_stops: this.counters.hardStops,
      /** Minutes of yours that the machine spent waiting for you to sit down. */
      blocked_wait: Math.round(this.blockedWaitMinutes || 0),
      sla_breaches: this.incidents.filter((i) => i.breached).length,
      hotfixes: this.incidents.filter((i) => i.choice === 'hotfix').length,
      rollbacks: this.incidents.filter((i) => i.choice === 'rollback').length,
      accepted_incidents: this.incidents.filter((i) => i.accepted).length,
      /**
       * Hours the week did not contain. Open incidents, defects still live in
       * production and cards left half-built are all work somebody owes, and it
       * lands outside whatever was agreed. Counted, never quietly dropped.
       */
      spillover_min: this.spilloverMinutes(),
      night_minutes: this.counters.nightMinutes,
      attention_placed: this.calendar.placedMinutes,
      build_failures: this.counters.buildFailures,
      /** How far the agents' estimates were from the week that actually ran. */
      estimate_factor: this.estimateStats().factor,
      estimate_over: this.estimateStats().over,
      /** Stages a person cannot really hand over, handed over anyway. */
      undelegable_delegated: this.undelegated.length,
      t_sim: this.clock.now,
    };
  }

  /** Work that does not fit in the week and has to happen anyway. */
  spilloverMinutes() {
    const openIncidents = this.incidents.filter((i) => !i.resolved).length;
    const liveDefects = this.items.reduce(
      (a, i) => a + i.defects.filter((d) => d.escaped && !d.fixed).length, 0);
    const halfBuilt = this.items.filter(
      (i) => !i.dropped && i.pulledAt != null && i.stage !== 'done').length;
    return openIncidents * SPILLOVER.perOpenIncident
         + liveDefects * SPILLOVER.perEscapedDefect
         + halfBuilt * SPILLOVER.perUnfinishedCard;
  }

  /**
   * The week, written down: what was decided, what ran, what shipped, what
   * broke, and what is still owed when the lights go out. This is what gets
   * sent at the end — the tape is the evidence, this is the story.
   */
  report() {
    const sc = this.score();
    const shipped = this.items.filter((i) => i.stage === 'done');
    return {
      meta: {
        scenario: this.scenario.id, seed: this.seed,
        plan: this.plan ? { hash: this.plan.hash, cut: this.plan.cut, assumptions: this.plan.assumptions,
                            placements: this.plan.placements?.length ?? 0,
                            attention_h: Math.round(this.plan.attention.placed / 60) } : null,
        finished_at: Calendar.label(this.clock.now),
      },
      score: sc,
      epochs: this.epochs,
      decided: this.ledger.length,
      /** Who you put on each stage — the answer to "what did you delegate". */
      sheet: Object.entries(STAGE_SPEC).map(([key, spec]) => {
        const who = this.stages[key];
        return {
          stage: key, label: spec.label, delegable: spec.delegable, who,
          human_share: who === 'humano' ? 1 : who === 'ia' ? 0 : Number(who) || 0,
          canary: !spec.delegable && who === 'ia',
        };
      }),
      estimates: this.estimateStats(),
      shipped: shipped.map((i) => ({
        id: i.id, title: i.title, impact: i.impact,
        tests: i.testLevel, reviewed: i.reviewedBy.slice(), manual_qa: i.manualQa,
        deploy: i.deployStrategy, announced: i.announceAudience, late: !!i.late,
        value: Number((i.impact * i.valueRealised).toFixed(2)),
        rework: i.reworkCount,
        live_defects: i.defects.filter((d) => d.escaped && !d.fixed).length,
      })),
      /** What was still in somebody's hands at midnight, and where it stopped. */
      unfinished: this.items.filter((i) => !i.dropped && i.pulledAt != null && i.stage !== 'done')
        .map((i) => ({ id: i.id, title: i.title, stage: i.stage, impact: i.impact,
                       waited_h: Number((Math.max(0, this.clock.now - (i.planQueuedAt ?? i.pulledAt)) / 60).toFixed(1)) })),
      /** Never delegated at all: the week ended before they were even started. */
      untouched: this.items.filter((i) => !i.dropped && i.pulledAt == null)
        .map((i) => ({ id: i.id, title: i.title, impact: i.impact })),
      cut: this.items.filter((i) => i.dropped).map((i) => ({ id: i.id, reason: i.droppedReason || '' })),
      incidents: this.incidents.map((i) => ({
        id: i.id, title: i.title, severity: i.severity, source: i.source, item: i.itemId,
        opened: Calendar.label(i.t), due: Calendar.label(i.dueAt),
        choice: i.choice, resolved: i.resolved, breached: i.breached, rationale: i.rationale || '',
      })),
      spillover: {
        minutes: sc.spillover_min,
        hours: Number((sc.spillover_min / 60).toFixed(1)),
        open_incidents: this.incidents.filter((i) => !i.resolved).length,
        live_defects: this.items.reduce((a, i) => a + i.defects.filter((d) => d.escaped && !d.fixed).length, 0),
        unfinished: this.items.filter((i) => !i.dropped && i.pulledAt != null && i.stage !== 'done').length,
      },
      questions: this.questions,
      notes: this.notes,
      unsure: this.unsure || [],
      ledger: this.ledger,
      retro: this.retroNote || null,
    };
  }

  /** Everything the UI needs to draw a frame. Also what telemetry snapshots. */
  state() {
    return {
      t: this.clock.now,
      horizon: this.horizon,
      finished: this.finished,
      phase: this.phase,
      practice: this.practice,
      when: Calendar.label(this.clock.now),
      attended: this.calendar.isAttended(this.clock.now),
      calendar: this.calendar.toJSON(),
      deadline: this.deadline ? { ...this.deadline, when: Calendar.label(this.deadline.at), passed: this.clock.now > this.deadline.at } : null,
      models: { default: this.modelDefault, byJob: { ...this.modelByJob } },
      policy: { ...this.policy },
      trust: { ...this.trust },
      /** Who does each stage, the canaries, and how the estimates are holding. */
      stages: { ...this.stages },
      undelegated: this.undelegated.map((u) => u.stage),
      estimates: this.estimateStats(),
      flagged: [...this.flagged],
      queues: this.queueDepth,
      sessions: this.sessions.slice(-4),
      blocked: this.blockedJobs.map((b) => ({ id: b.id, kind: b.kind, item: b.itemId, tier: b.tier, at: b.at, claimed: !!b.claimed })),
      plan: this.plan ? { hash: this.plan.hash, cut: this.plan.cut, assumptions: this.plan.assumptions } : null,
      wipLimit: this.wipLimit,
      resources: {
        cores: { free: this.pools.cores.free, cap: this.pools.cores.capacity },
        ram: { free: this.pools.ram.free, cap: this.pools.ram.capacity },
        agents: { free: this.pools.agents.free, cap: this.pools.agents.capacity },
        tokens: { left: this.budgets.tokens.left, cap: this.budgets.tokens.total },
        human: { busyFor: Math.max(0, this.humanBusyUntil - this.clock.now), queued: this.humanQueue.length },
      },
      jobs: {
        running: this.scheduler.inFlight.map((j) => ({
          id: j.id, kind: j.kind, item: j.itemId, startedAt: j.startedAt, endsAt: j.finishesAt,
          swapped: j.swapped, model: j.model || null, cores: j.cores, ram: j.ram,
        })),
        queued: this.scheduler.queued.map((j) => ({ id: j.id, kind: j.kind, item: j.itemId, cores: j.cores, ram: j.ram })),
        deferred: (this.deferred || []).map((d) => ({ id: d.id, kind: d.kind, item: d.itemId, at: d.at })),
      },
      items: this.items.map((i) => ({
        id: i.id, title: i.title, kind: i.kind, stage: i.stage, impact: i.impact, complexity: i.complexity,
        brief: i.brief, modules: i.modules, dropped: !!i.dropped, rush: !!i.rush,
        clarified: i.clarified, specWritten: i.specWritten, codeMode: i.codeMode,
        testLevel: i.testLevel, reviewedBy: i.reviewedBy.slice(), manualQa: i.manualQa,
        assumptionsNoted: i.assumptionsNoted, reworkCount: i.reworkCount,
        dependsOn: i.dependsOn, planned: i.planned || null,
        deployStrategy: i.deployStrategy, announceAudience: i.announceAudience,
        // Defect counts are never exposed: the player sees symptoms, not the truth.
      })),
      alerts: this.alerts.filter((a) => !a.resolved || a.type === 'incident').slice(-12),
      incidents: this.incidents.map((i) => ({
        id: i.id, itemId: i.itemId, kind: i.kind, title: i.title, severity: i.severity,
        source: i.source, dueAt: i.dueAt, choice: i.choice, resolved: i.resolved, breached: i.breached,
      })),
      epochs: this.epochs.slice(-3),
      notes: this.notes.length,
      questions: this.questions.length,
      unsure: (this.unsure || []).length,
      score: this.score(),
    };
  }
}

export { Simulation, STAGES, DEFECTS };

