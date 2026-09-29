import { THEME } from './board.mjs';
import { WeekGrid, KIND } from './week.mjs';
import { drawSheet } from './sheet.mjs';
import { DAY } from '../../engine/calendar.mjs';

const PAD = 14;
const LEFT_W = 296;
const RIGHT_W = 284;
const NET_H = 176;

/**
 * Phase one: the planner.
 *
 * The week is 168 hours of machine and 40 hours of you, and this screen is
 * where you decide what your forty are for. You are not scheduling tasks — the
 * agents will do those. You are scheduling **yourself**: when you sit down to
 * read plans, when to read what came back, when to put your own hands on the
 * product. Everything queued for a kind of work you never booked simply waits.
 */
function drawPlan(board, ctx) {
  const b = board;
  const s = ctx.sim.state();
  const { ui } = ctx;
  ui.brush = ui.brush || 'plan_review';
  // What the sheet is asking of the week, so both halves of the screen talk
  // about the same forty hours.
  const need = ctx.sim.demand();

  const gridX = PAD + LEFT_W + PAD + 26;
  const gridW = b.width - gridX - RIGHT_W - PAD * 2;
  const grid = new WeekGrid({
    x: gridX, y: 108, w: Math.max(320, gridW), h: b.height - 108 - PAD - 74, cardStrip: 6,
  });
  ui.grid = grid;

  header(b, ctx, s, need);
  brushBar(b, ctx, grid);
  grid.draw(b, { deadline: s.deadline?.at ?? null });
  grid.drawAttention(b, s.calendar.blocks, { editable: true });
  painter(b, ctx, s, grid);
  whoDoesWhat(b, ctx, s, need);
  theNet(b, ctx, s);
  backlog(b, ctx, s);
  footer(b, ctx, s, grid);
}

function header(b, ctx, s, need) {
  b.text('El plan de tu semana', PAD, 14, { font: '18px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  b.text('La máquina trabaja 168 horas. Tú tienes 40. Esto decide para qué son las tuyas.',
    PAD, 38, { color: THEME.dim, font: '12px IBM Plex Sans, system-ui, sans-serif' });
  // What the previous round taught you about how long things take. It is the
  // one number that transfers between rounds, so it is shown where you plan.
  b.text(ctx.ui.lastRound || 'Abre el lunes 09:00 · cierra el domingo 23:59 · el lunes se presenta lo que esté entregado',
    PAD, 56, { color: ctx.ui.lastRound ? THEME.warn : THEME.faint, font: '11px IBM Plex Sans, system-ui, sans-serif',
               max: b.width - PAD - 470 });

  // The button lives up here, not at the bottom of a column that can fall off
  // the fold on a short screen. It is the only way out of this screen.
  const bw = 196, bx = b.width - PAD - bw;
  const ready = s.calendar.placed > 0;
  b.rect(bx, 12, bw, 34, { fill: ready ? THEME.ok : THEME.panel2, stroke: ready ? THEME.ok : THEME.line });
  b.text('Empezar la semana ▸', bx + bw / 2, 29, {
    color: ready ? '#06170c' : THEME.faint, font: '13px IBM Plex Sans, system-ui, sans-serif',
    weight: '600', align: 'center', baseline: 'middle',
  });
  b.region('seal', bx, 12, bw, 34, { cursor: 'pointer', onClick: () => ctx.seal() });
  b.text(ready ? 'el plan se sella y ya no se toca' : 'reserva al menos un bloque de tu tiempo',
    bx + bw / 2, 52, { color: THEME.faint, font: '9.5px IBM Plex Sans, system-ui, sans-serif', align: 'center' });

  // Booked against asked-for, side by side. One number is what you set aside;
  // the other is what the sheet on the left is going to want.
  const rx = bx - 14 - 236;
  b.meter(rx, 12, 236, 'horas tuyas colocadas', s.calendar.placed / 60, s.calendar.budgetMinutes / 60,
    { unit: 'h', color: THEME.attentionEdge, hot: 1.01 });
  const over = need.needed > s.calendar.placed;
  b.text('tu hoja pide', rx, 44, { color: THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif' });
  b.text(`${(need.needed / 60).toFixed(0)} h`, rx + 236, 44, {
    color: over ? THEME.bad : THEME.ok, font: '11px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
}

/** The palette. Pick what a block is for, then paint it on the week. */
function brushBar(b, ctx, grid) {
  const { ui } = ctx;
  const y = 78;
  b.text('PINTA TU SEMANA CON:', grid.x, y + 6, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  let x = grid.x + 150;
  for (const key of ['plan_review', 'output_review', 'manual_test', 'free', 'erase']) {
    const on = ui.brush === key;
    const k = KIND[key];
    const label = key === 'erase' ? 'borrar' : k.label;
    const w = key === 'erase' ? 62 : 118;
    b.rect(x, y, w, 24, {
      fill: on ? (k ? k.fill : '#3a1f1f') : THEME.panel2,
      stroke: on ? (k ? k.edge : THEME.bad) : THEME.line,
    });
    b.text(label, x + w / 2, y + 12, {
      color: on ? (k ? k.edge : THEME.bad) : THEME.dim,
      font: '11px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle', max: w - 10,
    });
    b.region(`brush:${key}`, x, y, w, 24, { cursor: 'pointer', onClick: () => { ui.brush = key; } });
    x += w + 6;
  }
}

function painter(b, ctx, s, grid) {
  const { ui } = ctx;

  const paint = {
    onDown: (p) => { ui.painting = { day: grid.dayAt(p.x), from: grid.minuteAt(p.y) }; },
    onDrag: (p) => { if (ui.painting) ui.painting.to = grid.minuteAt(p.y); },
    onDrop: () => {
      const pa = ui.painting; ui.painting = null;
      if (!pa || pa.day == null || pa.to == null) return;
      const a = Math.min(pa.from, pa.to), z = Math.max(pa.from, pa.to);
      if (z - a < 30) return;
      const start = pa.day * DAY + a, end = pa.day * DAY + z;
      if (ui.brush === 'erase') {
        ctx.setAttention(s.calendar.blocks.filter((o) => !(o.start < end && o.end > start)));
        return;
      }
      // Painting over something replaces it: an hour has one purpose.
      const kept = [];
      for (const o of s.calendar.blocks) {
        if (o.end <= start || o.start >= end) { kept.push(o); continue; }
        if (o.start < start) kept.push({ ...o, end: start });
        if (o.end > end) kept.push({ ...o, start: end });
      }
      ctx.setAttention([...kept, { start, end, kind: ui.brush }]);
    },
  };

  // The empty grid paints. So does an existing block — repainting over what you
  // already booked is the first thing anyone tries when rearranging a week, and
  // a block that only knows how to be deleted makes that impossible.
  b.region('grid', grid.x, grid.gridY, grid.w, grid.gridH, { cursor: 'crosshair', ...paint });
  s.calendar.blocks.forEach((bl, i) => {
    const d = Math.floor(bl.start / DAY);
    if (d >= grid.days) return;
    b.region(`blk:${i}`, grid.colX(d) + 3, grid.yFor(bl.start), grid.colW - 6,
      Math.max(8, grid.yFor(bl.end) - grid.yFor(bl.start)), {
        cursor: 'crosshair',
        ...paint,
        // A drag repaints; a click that never moved removes it.
        onClick: () => ctx.setAttention(s.calendar.blocks.filter((o) => o !== bl)),
      });
  });

  if (ui.painting?.to != null && ui.painting.day != null) {
    const d = ui.painting.day;
    const a = Math.min(ui.painting.from, ui.painting.to), z = Math.max(ui.painting.from, ui.painting.to);
    const k = KIND[ui.brush] || { fill: '#3a1f1f', edge: THEME.bad };
    b.rect(grid.colX(d) + 3, grid.yFor(d * DAY + a), grid.colW - 6,
      grid.yFor(d * DAY + z) - grid.yFor(d * DAY + a),
      { fill: k.fill, stroke: k.edge, alpha: 0.8, radius: 4 });
  }
}

/**
 * Who does each stage — the sheet, and the real content of "el plan".
 *
 * Writing a plan and reading a plan are two different jobs on two different
 * rows: the first is the thing an agent does in seconds, the second is the
 * thing only you can do. The bar under each row says how much of that stage
 * stays on your hands, which is the number the whole week is decided by.
 */
function whoDoesWhat(b, ctx, s, need) {
  const x = PAD, y = 108;
  const h = b.height - y - PAD - 74;
  b.rect(x, y, LEFT_W, h, { fill: THEME.panel, stroke: THEME.line });
  b.text('QUIÉN HACE CADA COSA', x + 12, y + 12, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  b.paragraph('Delegar no es un número de tareas: es una línea por etapa. Tres de ellas no son delegables de verdad — y aun así puedes darlas.',
    x + 12, y + 28, LEFT_W - 24, { maxLines: 3, lineHeight: 13, font: '10.5px IBM Plex Sans, system-ui, sans-serif', color: THEME.faint });
  const used = drawSheet(b, ctx, s, {
    x: x + 12, y: y + 74, w: LEFT_W - 24, compact: h < 620, demand: need,
    // Clicking a stage arms the brush that books hours for it.
    onPick: (kind) => { ctx.ui.brush = kind; },
  });

  let cy = y + 74 + used + 2;
  const canaries = (s.undelegated || []).length;
  if (cy < y + h - 26) {
    b.text(canaries
      ? `${canaries} etapa(s) indelegable(s) en manos de un agente. Se anota.`
      : 'Todo lo indelegable sigue siendo tuyo.',
      x + 12, cy, { color: canaries ? THEME.bad : THEME.faint, font: '10px IBM Plex Sans, system-ui, sans-serif', max: LEFT_W - 24 });
    cy += 16;
  }

  // The sum, which is the sentence the whole screen exists to say.
  if (cy < y + h - 46) {
    const over = need.needed > need.budget;
    b.line(x + 12, cy, x + LEFT_W - 12, cy, { color: THEME.line });
    cy += 10;
    b.text('LO QUE PIDE TU HOJA', x + 12, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
    b.text(`${(need.needed / 60).toFixed(0)} h de ${Math.round(need.budget / 60)}`,
      x + LEFT_W - 12, cy, {
        color: over ? THEME.bad : need.needed > need.budget * 0.85 ? THEME.warn : THEME.ok,
        font: '11px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 15;
    const bw = LEFT_W - 24;
    b.rect(x + 12, cy, bw, 5, { fill: THEME.bg, radius: 3 });
    b.rect(x + 12, cy, Math.min(bw, bw * (need.needed / Math.max(1, need.budget))), 5,
      { fill: over ? THEME.bad : THEME.attentionEdge, radius: 3 });
    cy += 12;
    b.paragraph(over
      ? 'No cabe. O lees menos, o devuelves alguna etapa a los agentes.'
      : 'Es una estimación: da por hecho que todas las tarjetas llegan hasta ti.',
      x + 12, cy, bw, { maxLines: 2, lineHeight: 12,
        font: '10px IBM Plex Sans, system-ui, sans-serif', color: over ? THEME.warn : THEME.faint });
  }
}

/**
 * The net: the bar every card has to clear whether or not you look at it.
 *
 * Set once, applies to all hundred. This is the part of quality that scales
 * without costing you an hour, and it is the only reason reading a share of
 * the work is survivable at all.
 */
function theNet(b, ctx, s) {
  const x = b.width - RIGHT_W - PAD, y = 108;
  b.rect(x, y, RIGHT_W, NET_H, { fill: THEME.panel, stroke: THEME.line });
  b.text('LA RED QUE COGE LO QUE NO LEES', x + 12, y + 12, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  let cy = y + 32;
  const row = (label, opts, current, onPick) => {
    b.text(label, x + 12, cy, { color: THEME.faint, font: '10px IBM Plex Sans, system-ui, sans-serif' });
    cy += 13;
    const w = (RIGHT_W - 24 - (opts.length - 1) * 5) / opts.length;
    opts.forEach(([key, text], i) => {
      const on = current === key;
      const bx = x + 12 + i * (w + 5);
      b.rect(bx, cy, w, 24, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
      b.text(text, bx + w / 2, cy + 12, {
        color: on ? '#06121f' : THEME.dim, font: '10.5px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', max: w - 6, weight: on ? '600' : null,
      });
      b.region(`net:${label}:${text}`, bx, cy, w, 24, { cursor: 'pointer', onClick: () => onPick(key) });
    });
    cy += 32;
  };
  row('cómo se prueba todo', [['happy', 'feliz'], ['edge', 'bordes'], ['mutation', 'mutación']],
    s.policy.tests, (k) => ctx.act('set_policy', { tests: k }));
  row('cómo se despliega', [['canary', 'canary'], ['full', 'directo']],
    s.policy.deploy, (k) => ctx.act('set_policy', { deploy: k }));
  row('qué modelo escribe el plan', [['rapido', 'rápido'], ['equilibrado', 'medio'], ['fuerte', 'fuerte']],
    s.models.byJob.plan_gen || s.models.default, (k) => ctx.act('set_model', { model: k, job: 'plan_gen' }));
}

/** The work itself. You do not schedule it — you mark what you will always read. */
function backlog(b, ctx, s) {
  const { ui } = ctx;
  const x = b.width - RIGHT_W - PAD, y = 108 + NET_H + 10;
  const h = b.height - y - PAD - 74;
  b.rect(x, y, RIGHT_W, h, { fill: THEME.panel, stroke: THEME.line });
  b.text(`EL BACKLOG · ${s.items.filter((i) => !i.dropped).length}`, x + 12, y + 10,
    { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  b.text(`★ ${s.flagged?.length ?? 0} marcadas`, x + RIGHT_W - 12, y + 10,
    { color: THEME.warn, font: '10px IBM Plex Sans, system-ui, sans-serif', align: 'right' });
  b.paragraph('Marca las que vas a leer sí o sí, pase lo que pase con el muestreo. Elegir cuáles es la decisión.',
    x + 12, y + 26, RIGHT_W - 24, { maxLines: 2, lineHeight: 13, font: '10.5px IBM Plex Sans, system-ui, sans-serif' });

  const items = s.items.filter((i) => !i.dropped);
  const rowH = 26;
  const visible = Math.floor((h - 62) / rowH);
  ui.scroll = Math.max(0, Math.min(Math.max(0, items.length - visible) * rowH, ui.scroll || 0));
  b.region('blist', x, y + 58, RIGHT_W, h - 62, {
    onDrag: (_, d) => { ui.scroll = Math.max(0, Math.min(Math.max(0, items.length - visible) * rowH, (ui.scroll || 0) - d.dy)); },
  });
  b.onWheel = (delta, p) => {
    if (p.x < x || p.x > x + RIGHT_W) return false;
    ui.scroll = Math.max(0, Math.min(Math.max(0, items.length - visible) * rowH, (ui.scroll || 0) + delta * 0.5));
    return true;
  };

  let cy = y + 58 - (ui.scroll || 0);
  for (const it of items) {
    if (cy > y + h - 20) break;
    if (cy >= y + 52) {
      const on = (s.flagged || []).includes(it.id);
      b.text(on ? '★' : '☆', x + 12, cy + 6, { color: on ? THEME.warn : THEME.faint, font: '12px IBM Plex Sans, system-ui, sans-serif' });
      b.text(it.id, x + 28, cy + 7, { color: THEME.dim, font: '10px IBM Plex Mono, ui-monospace, monospace' });
      b.text(it.title, x + 72, cy + 7, { color: THEME.ink, font: '10.5px IBM Plex Sans, system-ui, sans-serif', max: RIGHT_W - 116 });
      b.text(`${it.impact}·${it.complexity}`, x + RIGHT_W - 12, cy + 7,
        { color: THEME.faint, font: '9.5px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
      b.region(`flag:${it.id}`, x + 6, cy, RIGHT_W - 12, rowH - 2, {
        cursor: 'pointer',
        onDrag: (_, d) => { ui.scroll = Math.max(0, (ui.scroll || 0) - d.dy); },
        onClick: () => ctx.act('flag', { ids: [it.id], on: !on }),
      });
    }
    cy += rowH;
  }
}

function footer(b, ctx, s, grid) {
  const y = b.height - 66;
  b.text('Arrastra sobre la rejilla para reservar horas del tipo elegido. Un clic sobre un bloque lo quita.',
    PAD, y, { color: THEME.dim, font: '11.5px IBM Plex Sans, system-ui, sans-serif' });
  b.text('Lo que se encole para un tipo de trabajo que no reservaste se queda esperando toda la semana.',
    PAD, y + 17, { color: THEME.faint, font: '11px IBM Plex Sans, system-ui, sans-serif' });
  if (ctx.ui.flash) b.text(ctx.ui.flash, PAD, y + 34, { color: THEME.bad, font: '11.5px IBM Plex Sans, system-ui, sans-serif' });
}

export { drawPlan };

