/**
 * Discrete-event clock. Same idea as SimPy's environment: nothing "ticks",
 * the clock jumps to the next scheduled event. The UI decides how fast wall
 * time maps onto sim time; the engine only knows about sim minutes.
 */
class Clock {
  constructor(now = 0) {
    this.now = now;
    this.seq = 0;
    this.queue = []; // kept sorted by (at, seq): small N, insertion sort is fine
  }

  /** Schedule fn to run at absolute sim time `at`. Returns a cancel handle. */
  at(time, kind, fn) {
    const ev = { at: Math.max(time, this.now), seq: this.seq++, kind, fn, cancelled: false };
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1].at > ev.at ||
                    (this.queue[i - 1].at === ev.at && this.queue[i - 1].seq > ev.seq))) i--;
    this.queue.splice(i, 0, ev);
    return ev;
  }

  /** Schedule fn `delay` minutes from now. */
  after(delay, kind, fn) { return this.at(this.now + delay, kind, fn); }

  cancel(ev) { if (ev) ev.cancelled = true; }

  peek() {
    for (const ev of this.queue) if (!ev.cancelled) return ev;
    return null;
  }

  /**
   * Run every event with at <= target, in order, then park the clock at target.
   * Events may schedule more events; those run too if they fall inside the window.
   * Returns the number of events fired.
   */
  runTo(target, guard = 100000) {
    let fired = 0;
    for (;;) {
      const ev = this.peek();
      if (!ev || ev.at > target) break;
      if (++fired > guard) throw new Error('clock: runaway event loop');
      this.queue.splice(this.queue.indexOf(ev), 1);
      this.now = ev.at;
      ev.fn(this.now);
    }
    this.queue = this.queue.filter((e) => !e.cancelled);
    this.now = Math.max(this.now, target);
    return fired;
  }
}

export { Clock };

