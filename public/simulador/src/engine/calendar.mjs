/**
 * Two calendars, not one.
 *
 * The machine runs seven days a week, twenty-four hours a day. You do not. The
 * whole point of this file is that those are different numbers: 10 080 minutes
 * of wall clock against roughly 2 400 minutes of you, and **you choose where
 * yours go**.
 *
 * That is what makes the weekend interesting. Queue six hours of agent work on
 * Friday evening and you get sixty hours of free machine. Have one of those
 * jobs stop and ask for a human at 19:40 on Friday, and it sits there until
 * Monday morning.
 */

const DAY = 1440;              // minutes in a day
const WEEK_DAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

class Calendar {
  /**
   * @param blocks  [{start, end}] absolute sim minutes when the human is at the desk
   * @param budgetMinutes  how much attention exists in total (the human's week)
   * @param fatigue  hour-of-day multipliers, see tuning.mjs
   */
  constructor({ blocks = [], budgetMinutes = 2400, fatigue = null } = {}) {
    this.budgetMinutes = budgetMinutes;
    this.fatigue = fatigue || { nightFrom: 22, nightTo: 6, nightFactor: 1.35, edgeFactor: 1.1, edgeSpan: 2 };
    this.setBlocks(blocks);
  }

  setBlocks(blocks) {
    // Normalise: sort, drop empties, merge only neighbours booked for the same
    // work. Two adjacent blocks of different kinds are two decisions, not one.
    const clean = (blocks || [])
      .map((b) => ({ start: Math.max(0, Math.round(b.start)), end: Math.round(b.end), kind: b.kind || 'free' }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
    const merged = [];
    for (const b of clean) {
      const last = merged[merged.length - 1];
      if (last && b.kind === last.kind && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else if (last && b.start < last.end) merged.push({ ...b, start: last.end, end: Math.max(last.end, b.end) });
      else merged.push({ ...b });
    }
    this.blocks = merged.filter((b) => b.end > b.start);
    return this;
  }

  get placedMinutes() { return this.blocks.reduce((a, b) => a + (b.end - b.start), 0); }
  get overBudget() { return Math.max(0, this.placedMinutes - this.budgetMinutes); }

  isAttended(t) { return this.blocks.some((b) => t >= b.start && t < b.end); }

  /** The block containing t, if any. */
  blockAt(t) { return this.blocks.find((b) => t >= b.start && t < b.end) || null; }

  /** A block booked for one kind of work takes that kind; `free` takes anything. */
  static accepts(block, kind) {
    if (!kind || kind === 'free') return true;
    return block.kind === kind || block.kind === 'free';
  }

  /**
   * First moment at or after t when you are at the desk **for this kind of
   * work**. Null when the week has no such block left — which is exactly what
   * "you booked no time to review plans" looks like from the queue's side.
   */
  nextAttention(t, kind = null) {
    const here = this.blockAt(t);
    if (here && Calendar.accepts(here, kind)) return t;
    for (const b of this.blocks) if (b.start >= t && Calendar.accepts(b, kind)) return b.start;
    return null;
  }

  /** The block that will serve this kind next, with the time it has left. */
  nextSession(t, kind = null) {
    const at = this.nextAttention(t, kind);
    if (at == null) return null;
    const block = this.blockAt(at) || this.blocks.find((b) => b.start === at);
    return block ? { at, block, minutes: block.end - at } : null;
  }

  /** How long until someone can look at this. Infinity when nobody ever will. */
  waitFor(t, kind = null) {
    const next = this.nextAttention(t, kind);
    return next == null ? Infinity : next - t;
  }

  minutesFor(kind) {
    return this.blocks.filter((b) => Calendar.accepts(b, kind) && (kind ? b.kind === kind : true))
      .reduce((a, b) => a + (b.end - b.start), 0);
  }

  /**
   * First moment at or after t when nobody is at the desk — which is when the
   * machine is all yours and nothing you start will be looked at.
   */
  nextUnattended(t) {
    if (!this.isAttended(t)) return t;
    const b = this.blockAt(t);
    return b ? b.end : t;
  }

  /**
   * Earliest moment from t where `minutes` of work fit with nobody at the desk
   * from start to finish. A half-hour job goes in the lunch gap; a three-hour
   * one waits for the evening. Without the length check, "leave it running
   * while I am away" quietly means "start it at one o'clock".
   */
  nextFreeWindow(t, minutes, limit = Infinity) {
    let c = this.nextUnattended(t);
    for (let guard = 0; guard < 64; guard++) {
      if (c > limit) return null;
      const clash = this.blocks.find((b) => b.start < c + minutes && b.end > c);
      if (!clash) return c;
      c = clash.end;
    }
    return null;
  }

  /** Night work is slower and plants more. Not a moral judgement, a measurement. */
  fatigueAt(t) {
    const hour = (t % DAY) / 60;
    const { nightFrom, nightTo, nightFactor, edgeFactor, edgeSpan } = this.fatigue;
    const inNight = hour >= nightFrom || hour < nightTo;
    if (inNight) return nightFactor;
    const nearNight = hour >= nightFrom - edgeSpan || hour < nightTo + edgeSpan;
    return nearNight ? edgeFactor : 1;
  }

  static dayOf(t) { return Math.floor(t / DAY); }
  static label(t) {
    const d = Calendar.dayOf(t) % 7;
    const hh = String(Math.floor((t % DAY) / 60)).padStart(2, '0');
    const mm = String(Math.floor(t % 60)).padStart(2, '0');
    return `${WEEK_DAYS[d]} ${hh}:${mm}`;
  }

  /**
   * What a candidate starts from: office hours, Monday to Friday, with the
   * mornings booked to review plans and the afternoons to review what came
   * back. It is a starting position and a bad one on purpose — rearranging it
   * is the first real decision of the game.
   */
  static officeHours({ days = 5, morning = [9, 13], afternoon = [14, 18] } = {}) {
    const blocks = [];
    for (let d = 0; d < days; d++) {
      blocks.push({ start: d * DAY + morning[0] * 60, end: d * DAY + morning[1] * 60, kind: 'plan_review' });
      blocks.push({ start: d * DAY + afternoon[0] * 60, end: d * DAY + afternoon[1] * 60, kind: 'output_review' });
    }
    return blocks;
  }

  toJSON() { return { blocks: this.blocks, budgetMinutes: this.budgetMinutes, placed: this.placedMinutes }; }
}

export { DAY, WEEK_DAYS, Calendar };

