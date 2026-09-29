/**
 * Immediate-mode 2D canvas with hit testing. No framework, no scene graph.
 *
 * The absence of a scene graph is deliberate and it is the whole security
 * argument for drawing this on a canvas at all: there is no retained tree of
 * objects for anything to enumerate. Each frame draws pixels and throws the
 * layout away; the state lives in a closure the page never exposes.
 *
 * It does not hide the board from a person with eyes, or from a model with
 * vision. What it removes is the DOM an automated agent would drive.
 */

const THEME = {
  bg: '#0d1117', panel: '#161b22', panel2: '#1c2229', line: '#2a323c', lineSoft: '#222a33',
  ink: '#e6edf3', dim: '#8b98a5', faint: '#5c6773',
  accent: '#4f9cf9', ok: '#3fb950', warn: '#d29922', bad: '#f85149', busy: '#a371f7',
  night: '#101a2b', attention: '#1b3a5c', attentionEdge: '#2f6fb0',
  font: '13px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  mono: '12px IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
};

class Board {
  /**
   * The board is composed once, at a fixed logical size, and scaled to whatever
   * space it is given. A dense seven-column week does not reflow into a phone
   * column in any useful way — squashing it just breaks the composition — so it
   * shrinks as a whole instead, and every proportion survives.
   */
  constructor(canvas, { onPointer = () => {}, maxScale = 1.6 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.regions = [];
    this.dpr = 1;
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.maxScale = maxScale;
    this.mode = 'desktop';
    this.pointer = { x: -1, y: -1, down: false };
    this.dragging = null;
    this.hovered = null;
    this.onPointer = onPointer;
    this._bind();
    this.resize();
  }

  // ------------------------------------------------------------------- setup

  /**
   * Three layouts, not one design squashed three ways. The logical width is
   * chosen by breakpoint and the logical height follows the real aspect ratio,
   * so the board fills the screen exactly and each mode gets a composition
   * written for the shape it is actually in.
   */
  static layoutFor(cssW) {
    if (cssW < 700) return { w: 420, mode: 'phone' };
    if (cssW < 1150) return { w: 900, mode: 'tablet' };
    return { w: 1440, mode: 'desktop' };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(240, Math.floor(rect.width));
    const cssH = Math.max(240, Math.floor(rect.height));
    this.cssW = cssW;
    this.cssH = cssH;

    const { w, mode } = Board.layoutFor(cssW);
    this.mode = mode;
    this.scale = Math.min(this.maxScale, cssW / w);
    // Everything the layout code sees is the logical canvas, always.
    this.width = Math.round(cssW / this.scale);
    this.height = Math.max(420, Math.round(cssH / this.scale));
    this.offset = { x: 0, y: 0 };

    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
  }

  /** Element pixels → the logical coordinates every draw call works in. */
  toLogical(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.offset.x) / this.scale,
      y: (clientY - r.top - this.offset.y) / this.scale,
    };
  }

  _bind() {
    const pt = (ev) => this.toLogical(ev.clientX, ev.clientY);
    this.canvas.addEventListener('pointerdown', (ev) => {
      const p = pt(ev);
      this.pointer = { ...p, down: true };
      const hit = this.pick(p);
      if (hit && (hit.onDrag || hit.onDown)) {
        this.canvas.setPointerCapture(ev.pointerId);
        this.dragging = hit.onDrag ? { region: hit, from: p, last: p, moved: false } : null;
        hit.onDown?.(p, hit);
      }
      this.onPointer('down', p, hit);
      this.requestDraw();
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      const p = pt(ev);
      this.pointer = { ...p, down: this.pointer.down };
      if (this.dragging) {
        const d = this.dragging;
        if (Math.abs(p.x - d.from.x) + Math.abs(p.y - d.from.y) > 3) d.moved = true;
        d.region.onDrag?.(p, { dx: p.x - d.last.x, dy: p.y - d.last.y, from: d.from });
        d.last = p;
      } else {
        const hit = this.pick(p);
        this.canvas.style.cursor = hit?.cursor || 'default';
        this.hovered = hit?.id ?? null;
      }
      this.requestDraw();
    });
    const finish = (ev) => {
      const p = pt(ev);
      this.pointer.down = false;
      if (this.dragging) {
        const d = this.dragging;
        this.dragging = null;
        const target = this.pick(p);
        d.region.onDrop?.(p, target, d);
        // A drag that never moved is a click.
        if (!d.moved) d.region.onClick?.(p, d.region);
      } else {
        const hit = this.pick(p);
        hit?.onClick?.(p, hit);
      }
      this.onPointer('up', p);
      this.requestDraw();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', () => { this.dragging = null; });
    this.canvas.addEventListener('wheel', (ev) => {
      const p = pt(ev);
      if (this.onWheel?.(ev.deltaY, p)) { ev.preventDefault(); this.requestDraw(); }
    }, { passive: false });
    window.addEventListener('resize', () => { this.resize(); this.requestDraw(); });
  }

  requestDraw() { this.dirty = true; }

  /** Topmost region under the point. Later registrations win, like painting. */
  pick(p) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
    }
    return null;
  }

  // ------------------------------------------------------------------ frames

  begin() {
    this.regions = [];
    const c = this.ctx;
    // Paint the whole element first, in device space, so the letterbox around a
    // scaled board is the board's own colour and not the host page's.
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = THEME.bg;
    c.fillRect(0, 0, this.cssW, this.cssH);
    c.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale,
                   this.offset.x * this.dpr, this.offset.y * this.dpr);

    if (this.tooSmall) {
      this.notice();
      return null;
    }
    return c;
  }

  /** Below a certain width the board is not small, it is unreadable. Say so. */
  notice() {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cx = this.cssW / 2;
    const lines = [
      ['La fábrica', `600 ${THEME.font.split(' ').slice(1).join(' ')}`, THEME.ink, 20],
      ['El tablero necesita una ventana más ancha.', THEME.font, THEME.dim, 22],
      ['Ábrelo a pantalla completa, o en un monitor.', THEME.font, THEME.faint, 20],
    ];
    let y = this.cssH / 2 - 34;
    for (const [text, font, color, step] of lines) {
      c.save();
      c.font = font; c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, cx, y);
      c.restore();
      y += step;
    }
  }

  /** Register an interactive rectangle for this frame. */
  region(id, x, y, w, h, handlers = {}) {
    const r = { id, x, y, w, h, ...handlers };
    this.regions.push(r);
    return r;
  }

  // ----------------------------------------------------------------- drawing

  rect(x, y, w, h, { fill, stroke, radius = 8, lineWidth = 1, alpha = 1, dash = null } = {}) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = alpha;
    c.beginPath();
    c.roundRect(x, y, Math.max(0, w), Math.max(0, h), radius);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lineWidth; if (dash) c.setLineDash(dash); c.stroke(); }
    c.restore();
  }

  text(str, x, y, { color = THEME.ink, font = THEME.font, align = 'left', baseline = 'top', max = null, weight = null } = {}) {
    const c = this.ctx;
    c.save();
    c.font = weight ? `${weight} ${font}` : font;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = baseline;
    let s = String(str ?? '');
    if (max != null) s = this.fit(s, max, c.font);
    c.fillText(s, x, y);
    c.restore();
    return c.measureText(s).width;
  }

  /** Truncate to fit, with an ellipsis. Canvas has no text-overflow. */
  fit(str, max, font) {
    const c = this.ctx;
    c.save();
    if (font) c.font = font;
    if (c.measureText(str).width <= max) { c.restore(); return str; }
    let lo = 0, hi = str.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (c.measureText(str.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1;
    }
    c.restore();
    return str.slice(0, lo) + '…';
  }

  /** Word-wrapped paragraph. Returns the height it used. */
  paragraph(str, x, y, w, { color = THEME.dim, font = THEME.font, lineHeight = 16, maxLines = 3, measure = false } = {}) {
    const c = this.ctx;
    c.save();
    c.font = font; c.fillStyle = measure ? 'transparent' : color; c.textBaseline = 'top';
    const words = String(str ?? '').split(/\s+/);
    let line = '', lines = 0;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > w && line) {
        if (lines + 1 >= maxLines) { c.fillText(this.fit(`${line} ${word}`, w), x, y + lines * lineHeight); lines++; line = ''; break; }
        c.fillText(line, x, y + lines * lineHeight);
        lines++; line = word;
      } else line = test;
    }
    if (line && lines < maxLines) { c.fillText(this.fit(line, w), x, y + lines * lineHeight); lines++; }
    c.restore();
    return lines * lineHeight;
  }

  chip(label, x, y, { color = THEME.dim, bg = THEME.panel2, border = THEME.line, pad = 6, h = 17, font = '10.5px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' } = {}) {
    const c = this.ctx;
    c.save(); c.font = font;
    const w = c.measureText(label).width + pad * 2;
    c.restore();
    this.rect(x, y, w, h, { fill: bg, stroke: border, radius: 999 });
    this.text(label, x + pad, y + h / 2, { color, font, baseline: 'middle' });
    return w;
  }

  line(x1, y1, x2, y2, { color = THEME.line, width = 1, dash = null } = {}) {
    const c = this.ctx;
    c.save();
    c.strokeStyle = color; c.lineWidth = width;
    if (dash) c.setLineDash(dash);
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    c.restore();
  }

  /** Dependency arrow: an elbow with a head, drawn behind the cards. */
  arrow(x1, y1, x2, y2, { color = THEME.faint, width = 1.5 } = {}) {
    const c = this.ctx;
    c.save();
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = width;
    const mx = (x1 + x2) / 2;
    c.beginPath();
    c.moveTo(x1, y1);
    c.bezierCurveTo(mx, y1, mx, y2, x2 - 6, y2);
    c.stroke();
    c.beginPath();
    c.moveTo(x2, y2); c.lineTo(x2 - 7, y2 - 4); c.lineTo(x2 - 7, y2 + 4);
    c.closePath(); c.fill();
    c.restore();
  }

  meter(x, y, w, label, value, cap, { unit = '', color = THEME.accent, hot = 0.9 } = {}) {
    const pct = cap ? Math.min(1, value / cap) : 0;
    const c = pct >= hot ? THEME.bad : pct >= 0.7 ? THEME.warn : color;
    this.text(label, x, y, { color: THEME.dim, font: '10.5px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' });
    this.text(`${Math.round(value)}${unit}/${cap}${unit}`, x + w, y, { color: THEME.dim, font: '10.5px IBM Plex Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', align: 'right' });
    this.rect(x, y + 14, w, 5, { fill: THEME.panel2, radius: 3 });
    this.rect(x, y + 14, w * pct, 5, { fill: c, radius: 3 });
    return 24;
  }
}

export { THEME, Board };

