import { THEME } from './board.mjs';
import { DAY } from '../../engine/calendar.mjs';

const DAY_NAMES = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

/** A block is booked for one kind of work, and you can see which at a glance. */
const KIND = {
  plan_review:   { label: 'revisar planes',   short: 'planes',   fill: '#1b3a5c', edge: '#4f9cf9' },
  output_review: { label: 'revisar entregas', short: 'entregas', fill: '#2a2247', edge: '#a371f7' },
  manual_test:   { label: 'pruebas manuales', short: 'pruebas',  fill: '#123528', edge: '#3fb950' },
  free:          { label: 'libre',            short: 'libre',    fill: '#2a2b1c', edge: '#d29922' },
};

/**
 * The week grid: seven columns of twenty-four hours. Shared by both phases so
 * the plan and the run are literally the same picture — which is the point,
 * because at the end you are shown one on top of the other.
 */
class WeekGrid {
  constructor({ x, y, w, h, days = 7, cardStrip = 74, headerH = 22, hourFrom = 0, hourTo = 24 }) {
    Object.assign(this, { x, y, w, h, days, cardStrip, headerH, hourFrom, hourTo });
    this.colW = w / days;
    this.gridY = y + headerH + cardStrip;
    this.gridH = h - headerH - cardStrip;
  }

  colX(day) { return this.x + day * this.colW; }
  dayAt(px) { const d = Math.floor((px - this.x) / this.colW); return d >= 0 && d < this.days ? d : null; }

  /** Absolute sim minute → y. */
  yFor(minute) {
    const hour = (minute % DAY) / 60;
    return this.gridY + ((hour - this.hourFrom) / (this.hourTo - this.hourFrom)) * this.gridH;
  }

  /** y → minute-of-day, snapped. */
  minuteAt(py, snap = 30) {
    const frac = (py - this.gridY) / this.gridH;
    const hour = this.hourFrom + frac * (this.hourTo - this.hourFrom);
    return Math.max(0, Math.min(DAY, Math.round((hour * 60) / snap) * snap));
  }

  inGrid(p) { return p.y >= this.gridY && p.y <= this.gridY + this.gridH && p.x >= this.x && p.x <= this.x + this.w; }
  inStrip(p) { return p.y >= this.y + this.headerH && p.y < this.gridY && p.x >= this.x && p.x <= this.x + this.w; }

  /** Frame, day headers, night shading and the hour rules. */
  draw(board, { today = null, deadline = null } = {}) {
    const b = board;
    b.rect(this.x, this.y, this.w, this.h, { fill: THEME.panel, stroke: THEME.line });

    for (let d = 0; d < this.days; d++) {
      const cx = this.colX(d);
      const weekend = d >= 5;
      if (weekend) b.rect(cx, this.y + this.headerH, this.colW, this.h - this.headerH, { fill: '#12161c', radius: 0 });
      b.text(`${DAY_NAMES[d]} ${d + 1}`, cx + 8, this.y + 6, {
        color: today === d ? THEME.accent : weekend ? THEME.faint : THEME.dim,
        font: '11px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', weight: today === d ? '600' : null,
      });
      if (d) b.line(cx, this.y + this.headerH, cx, this.y + this.h, { color: THEME.lineSoft });
    }
    b.line(this.x, this.gridY, this.x + this.w, this.gridY, { color: THEME.line });

    // Night band. Nothing stops you working in it; it just costs more.
    for (let d = 0; d < this.days; d++) {
      const cx = this.colX(d);
      const yTop = this.yFor(d * DAY + 22 * 60);
      b.rect(cx, yTop, this.colW, this.gridY + this.gridH - yTop, { fill: THEME.night, radius: 0 });
      b.rect(cx, this.gridY, this.colW, this.yFor(d * DAY + 6 * 60) - this.gridY, { fill: THEME.night, radius: 0 });
    }

    for (let hour = this.hourFrom; hour <= this.hourTo; hour += 3) {
      const yy = this.yFor(hour * 60) + (hour === 24 ? -1 : 0);
      b.line(this.x, yy, this.x + this.w, yy, { color: THEME.lineSoft });
      b.text(`${String(hour).padStart(2, '0')}h`, this.x - 7, yy, { color: THEME.faint, font: '9.5px IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace', align: 'right', baseline: 'middle' });
    }

    if (deadline != null) {
      const d = Math.floor(deadline / DAY);
      const dx = this.colX(d);
      const dy = this.yFor(deadline);
      b.line(dx, dy, dx + this.colW, dy, { color: THEME.bad, width: 2, dash: [4, 3] });
      b.text('demo', dx + this.colW - 4, dy - 11, { color: THEME.bad, font: '9.5px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', align: 'right' });
    }
  }

  /** The blocks of attention the player placed. */
  drawAttention(board, blocks, { editable = false, hoverBlock = null } = {}) {
    for (const bl of blocks) {
      const d = Math.floor(bl.start / DAY);
      if (d >= this.days) continue;
      const kind = KIND[bl.kind] || KIND.free;
      const x = this.colX(d) + 3;
      const y1 = this.yFor(bl.start);
      const y2 = this.yFor(bl.end);
      const active = hoverBlock === bl;
      board.rect(x, y1, this.colW - 6, Math.max(3, y2 - y1), {
        fill: kind.fill, stroke: active ? THEME.ink : kind.edge, radius: 4,
      });
      const h = y2 - y1;
      const hh = (m) => `${String(Math.floor((m % DAY) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (h > 26) {
        board.text(kind.short, x + 5, y1 + 5, { color: kind.edge, font: '10px IBM Plex Sans, system-ui, sans-serif', max: this.colW - 16, weight: '600' });
        board.text(`${hh(bl.start)}–${hh(bl.end)}`, x + 5, y1 + 19, {
          color: THEME.dim, font: '9.5px IBM Plex Mono, ui-monospace, monospace', max: this.colW - 16,
        });
      } else if (h > 12) {
        board.text(kind.short, x + 5, (y1 + y2) / 2, { color: kind.edge, font: '9.5px IBM Plex Sans, system-ui, sans-serif', baseline: 'middle', max: this.colW - 16 });
      }
    }
  }
}

export { DAY_NAMES, KIND, WeekGrid };

