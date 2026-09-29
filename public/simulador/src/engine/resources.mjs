/**
 * The scarce things. This is the part the candidate is actually playing against:
 * you cannot generate code, run the suite and build the APK at the same time on
 * one 32 GB laptop, and the token budget does not refill.
 *
 *   pools    — cores / RAM / agent licences: held for the duration of a job, then returned.
 *   budgets  — tokens: consumed, never returned.
 *   human    — capacity 1. The developer. Everything they do personally serialises here.
 */
class Pool {
  constructor(name, capacity, unit = '') {
    this.name = name; this.capacity = capacity; this.free = capacity; this.unit = unit;
    this.waiting = 0; this.peak = 0; this.busyMinutes = 0;
  }
  canEverFit(amount) { return amount <= this.capacity; }
  canTake(amount) { return amount <= this.free; }
  take(amount) {
    if (!this.canTake(amount)) throw new Error(`${this.name}: not enough free`);
    this.free -= amount;
    this.peak = Math.max(this.peak, this.capacity - this.free);
    return amount;
  }
  give(amount) { this.free = Math.min(this.capacity, this.free + amount); }
  get used() { return this.capacity - this.free; }
  get utilisation() { return this.capacity ? this.used / this.capacity : 0; }
}

class Budget {
  constructor(name, total) { this.name = name; this.total = total; this.spent = 0; }
  get left() { return this.total - this.spent; }
  canSpend(n) { return n <= this.left; }
  spend(n) {
    if (!this.canSpend(n)) return false;
    this.spent += n; return true;
  }
}

/**
 * Job scheduler. A job declares what it needs; it starts when everything is
 * free, otherwise it waits in FIFO order. Tokens are charged at start — a job
 * that cannot pay never starts.
 */
class Scheduler {
  constructor({ clock, pools, budgets, onStart, onFinish, swapThreshold = 0.9, swapPenalty = 1.6 }) {
    this.clock = clock; this.pools = pools; this.budgets = budgets;
    this.onStart = onStart || (() => {}); this.onFinish = onFinish || (() => {});
    this.swapThreshold = swapThreshold; this.swapPenalty = swapPenalty;
    this.queue = []; this.running = new Map(); this.nextId = 1;
  }

  /**
   * @param job {kind, itemId, minutes, cores, ram, agents, tokens, meta, done(job)}
   * @returns {id, rejected?} — rejected when the box can never satisfy it.
   */
  submit(job) {
    const j = {
      id: `J${this.nextId++}`, cores: 0, ram: 0, agents: 0, tokens: 0, meta: {},
      ...job, submittedAt: this.clock.now, state: 'queued',
    };
    for (const [key, pool] of Object.entries(this.pools)) {
      const want = j[key] || 0;
      if (want && !pool.canEverFit(want)) {
        j.state = 'rejected';
        j.reason = `${pool.name}: ${want}${pool.unit} > ${pool.capacity}${pool.unit}`;
        return j;
      }
    }
    if (j.tokens && !this.budgets.tokens.canSpend(j.tokens)) {
      j.state = 'rejected'; j.reason = 'tokens: budget exhausted';
      return j;
    }
    this.queue.push(j);
    this.pump();
    return j;
  }

  /** Start whatever fits, oldest first. Head-of-line blocking is deliberate: a
   *  queued Android build really does hold up the small jobs behind it. */
  pump() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i++) {
        const j = this.queue[i];
        if (!this.fits(j)) continue;
        this.queue.splice(i, 1);
        this.start(j);
        progressed = true;
        break;
      }
    }
  }

  fits(j) {
    for (const [key, pool] of Object.entries(this.pools)) {
      if ((j[key] || 0) > 0 && !pool.canTake(j[key])) return false;
    }
    if (j.tokens && !this.budgets.tokens.canSpend(j.tokens)) return false;
    return true;
  }

  start(j) {
    for (const [key, pool] of Object.entries(this.pools)) if (j[key]) pool.take(j[key]);
    if (j.tokens) this.budgets.tokens.spend(j.tokens);
    // Memory pressure does not kill the job, it drags it. Anyone who has run an
    // Android build next to an emulator on 32 GB recognises this.
    const pressure = this.pools.ram.utilisation >= this.swapThreshold;
    j.swapped = pressure;
    j.duration = Math.max(1, Math.round(j.minutes * (pressure ? this.swapPenalty : 1)));
    j.state = 'running';
    j.startedAt = this.clock.now;
    j.waitedMinutes = j.startedAt - j.submittedAt;
    j.finishesAt = j.startedAt + j.duration;
    this.running.set(j.id, j);
    this.onStart(j);
    this.clock.at(j.finishesAt, `job:${j.kind}`, () => this.finish(j));
  }

  finish(j) {
    this.running.delete(j.id);
    for (const [key, pool] of Object.entries(this.pools)) if (j[key]) pool.give(j[key]);
    for (const pool of Object.values(this.pools)) pool.busyMinutes += 0; // placeholder for reporting
    j.state = 'done';
    if (j.done) j.done(j);
    this.onFinish(j);
    this.pump();
  }

  get inFlight() { return [...this.running.values()]; }
  get queued() { return this.queue.slice(); }
}

export { Pool, Budget, Scheduler };

