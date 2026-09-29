/**
 * Telemetry. The simulation is the instrument; this is the tape.
 *
 * What we record is deliberately boring and complete: every action, when it
 * happened in sim time and in wall time, how long the player sat on the decision
 * before committing to it, and a snapshot of the world they were looking at.
 * No interpretation happens here — the mapping from tape to judgement lives in
 * the private `scoring/` folder, so this file can ship on the public site.
 *
 * Privacy: no free-text is captured beyond what the player types into the
 * simulator's own note/ask fields, and those are shown as recorded. Nothing is
 * read from the page, the clipboard, or anywhere else.
 */
class Telemetry {
  constructor({ runId, sessionId, candidate, seed, scenario, sink, batchSize = 25, flushMs = 15000, now = () => Date.now() }) {
    this.meta = { v: 1, run_id: runId, session_id: sessionId, candidate: candidate || null, seed, scenario };
    this.sink = sink || (() => {});
    this.batchSize = batchSize;
    this.flushMs = flushMs;
    this.now = now;
    this.seq = 0;
    this.buffer = [];
    this.all = [];
    this.startedWall = now();
    this.lastActionWall = this.startedWall;
    this.timer = null;
  }

  /**
   * @param action  short verb, e.g. 'pull', 'clarify', 'deploy'
   * @param params  the decision's parameters (what they chose)
   * @param extra   {snapshot, ui, result}
   */
  record(action, params = {}, extra = {}) {
    const wall = this.now();
    const ev = {
      ...this.meta,
      seq: this.seq++,
      action,
      params,
      t_sim: extra.tSim ?? null,
      t_wall_ms: wall - this.startedWall,
      /** Time between the previous committed action and this one. Hesitation in
       *  front of an ambiguous item reads very differently from hesitation in
       *  front of a mechanical one. */
      deliberation_ms: wall - this.lastActionWall,
      result: extra.result ?? null,
      snapshot: extra.snapshot ?? null,
      ui: extra.ui ?? null,
    };
    this.lastActionWall = wall;
    this.all.push(ev);
    this.buffer.push(ev);
    if (this.buffer.length >= this.batchSize) this.flush();
    else this.arm();
    return ev;
  }

  arm() {
    if (this.timer || typeof setTimeout !== 'function') return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush(reason = 'batch') {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buffer.length) return null;
    const batch = { ...this.meta, event: 'sim_batch', reason, sent_at: new Date().toISOString(), events: this.buffer };
    this.buffer = [];
    try { this.sink(batch); } catch { /* telemetry must never break the game */ }
    return batch;
  }

  toJsonl() { return this.all.map((e) => JSON.stringify(e)).join('\n'); }
}

/**
 * Browser sink: text/plain keeps it a CORS-simple request, which is what the
 * Apps Script Web App accepts without a preflight.
 */
function endpointSink(url, { keepalive = true } = {}) {
  return (batch) => {
    if (!url) return;
    const body = JSON.stringify(batch);
    if (keepalive && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (ok) return;
    }
    fetch(url, { method: 'POST', mode: 'no-cors', keepalive, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body })
      .catch(() => {});
  };
}

/** Sink that also survives a lost connection: replay is manual, via the UI. */
function bufferedSink(inner, storageKey = 'tm_sim_outbox') {
  return (batch) => {
    try {
      const store = globalThis.localStorage;
      if (store) {
        const pending = JSON.parse(store.getItem(storageKey) || '[]');
        pending.push(batch);
        store.setItem(storageKey, JSON.stringify(pending.slice(-40)));
      }
    } catch { /* storage full or blocked; the POST still goes out */ }
    inner(batch);
  };
}

export { Telemetry, endpointSink, bufferedSink };

