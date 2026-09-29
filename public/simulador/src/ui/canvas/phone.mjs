import { THEME } from './board.mjs';
import { DAY, WEEK_DAYS, Calendar } from '../../engine/calendar.mjs';
import { KIND } from './week.mjs';
import { drawSheet } from './sheet.mjs';

/**
 * The phone board.
 *
 * Not the desktop layout scaled down — a seven-column week at 420 logical pixels
 * is unreadable however carefully you shrink it. Here the week turns on its
 * side (days are rows, hours run across), the three panes become three tabs,
 * and dragging a card onto a grid becomes a day stepper, because dragging into
 * a 50-pixel column with a thumb is a bad time.
 *
 * Everything else — the engine, the decisions, what gets recorded — is the same
 * game. Only the composition changes.
 */

const PAD = 12;
const HEAD_H = 60;
const TABS_H = 42;
const ROW_H = 44;

// ------------------------------------------------------------------ chrome

function header(b, ctx, s, { title, sub, action }) {
  b.rect(0, 0, b.width, HEAD_H, { fill: THEME.panel, radius: 0 });
  b.line(0, HEAD_H, b.width, HEAD_H, { color: THEME.line });
  b.text(title, PAD, 12, { font: '16px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  b.text(sub, PAD, 34, { color: THEME.dim, font: '11px IBM Plex Sans, system-ui, sans-serif', max: b.width - 130 });
  if (action) {
    const w = 104;
    const x = b.width - PAD - w;
    b.rect(x, 14, w, 32, { fill: action.on ? THEME.ok : THEME.panel2, stroke: action.on ? THEME.ok : THEME.line });
    b.text(action.label, x + w / 2, 30, {
      color: action.on ? '#06170c' : THEME.faint, font: '12px IBM Plex Sans, system-ui, sans-serif',
      weight: '600', align: 'center', baseline: 'middle',
    });
    b.region('phone:action', x, 14, w, 32, { cursor: 'pointer', onClick: action.onClick });
  }
}

function tabs(b, ctx, items) {
  const { ui } = ctx;
  const y = HEAD_H;
  const w = b.width / items.length;
  b.rect(0, y, b.width, TABS_H, { fill: THEME.bg, radius: 0 });
  items.forEach(([key, label, badge], i) => {
    const x = i * w;
    const on = ui.tab === key;
    if (on) b.rect(x + 6, y + 5, w - 12, TABS_H - 10, { fill: THEME.panel2, stroke: THEME.line });
    let text = label;
    if (badge) text += ` ${badge}`;
    b.text(text, x + w / 2, y + TABS_H / 2, {
      color: on ? THEME.ink : THEME.faint, font: '12.5px IBM Plex Sans, system-ui, sans-serif',
      align: 'center', baseline: 'middle', weight: on ? '600' : null,
    });
    b.region(`tab:${key}`, x, y, w, TABS_H, {
      cursor: 'pointer',
      onClick: () => { if (ui.tab !== key) { ui.tab = key; ui.scroll = 0; } },
    });
  });
  b.line(0, y + TABS_H, b.width, y + TABS_H, { color: THEME.line });
  return y + TABS_H;
}

/**
 * A scrollable strip. Touch drags it, the wheel scrolls it, and a drag that
 * never moved is still a tap on whatever is under the finger — which is what
 * makes a list of buttons usable with a thumb.
 */
function scroller(b, ctx, id, x, y, w, h, contentH) {
  const { ui } = ctx;
  const max = Math.max(0, contentH - h);
  ui.scroll = Math.max(0, Math.min(max, ui.scroll || 0));
  const by = (dy) => { ui.scroll = Math.max(0, Math.min(max, ui.scroll + dy)); };
  b.onWheel = (delta, p) => {
    if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) return false;
    by(delta * 0.5);
    return true;
  };
  b.region(id, x, y, w, h, { onDrag: (_, d) => by(-d.dy) });
  if (max > 0) {
    const trackH = Math.max(28, (h / contentH) * h);
    const top = y + (ui.scroll / max) * (h - trackH);
    b.rect(x + w - 4, top, 3, trackH, { fill: THEME.line, radius: 2 });
  }
  return { top: y - ui.scroll, drag: (_, d) => by(-d.dy) };
}

// ------------------------------------------------------------------- cards

function cardRow(b, ctx, it, x, y, w, { actions = [], scrollDrag, reserveRight = 0 }) {
  const { ui } = ctx;
  const open = ui.open === it.id;
  const acts = open ? actions : [];
  const briefH = open ? 30 : 0;
  const actsH = acts.length ? Math.ceil(acts.length / 2) * 32 + 4 : 0;
  const h = ROW_H + briefH + actsH;

  b.rect(x, y, w, h, { fill: THEME.panel2, stroke: open ? THEME.accent : THEME.line });
  b.rect(x, y, 3, h, { fill: it.kind === 'bug' ? THEME.bad : it.kind === 'chore' ? THEME.faint : THEME.accent, radius: 2 });
  b.text(it.id, x + 11, y + 8, { color: THEME.dim, font: '10.5px IBM Plex Mono, ui-monospace, monospace' });
  b.text(`×${it.impact}`, x + w - 10, y + 8, { color: THEME.dim, font: '10.5px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
  // Leave the badge its corner: a title sliding under it is the classic
  // canvas bug, because nothing clips for you here.
  b.text(it.title, x + 11, y + 24, { color: THEME.ink, font: '12.5px IBM Plex Sans, system-ui, sans-serif', max: w - 22 - reserveRight });

  if (open) b.paragraph(it.brief, x + 11, y + ROW_H - 2, w - 22, { maxLines: 2, lineHeight: 14, font: '11px IBM Plex Sans, system-ui, sans-serif' });

  // The whole row is the tap target for opening it, and also drags the list.
  b.region(`row:${it.id}`, x, y, w, ROW_H, {
    cursor: 'pointer',
    onDrag: scrollDrag,
    onClick: () => { ui.open = open ? null : it.id; ui.selected = it.id; },
  });

  let ax = x + 8, ay = y + ROW_H + briefH + 2;
  acts.forEach(([label, fn], i) => {
    const cw = (w - 24) / 2;
    if (i % 2 === 0 && i) { ay += 32; ax = x + 8; }
    b.rect(ax, ay, cw, 28, { fill: THEME.bg, stroke: THEME.line, radius: 6 });
    b.text(label, ax + cw / 2, ay + 14, {
      color: THEME.ink, font: '11.5px IBM Plex Sans, system-ui, sans-serif',
      align: 'center', baseline: 'middle', max: cw - 10,
    });
    b.region(`pact:${it.id}:${label}`, ax, ay, cw, 28, { cursor: 'pointer', onDrag: scrollDrag, onClick: fn });
    ax += cw + 8;
  });
  return h;
}

// ------------------------------------------------------------ week as rows

function weekRows(b, ctx, s, x, y, w, h, { editable, now = null }) {
  const { ui } = ctx;
  const labelW = 34;
  const gridX = x + labelW;
  const gridW = w - labelW;
  // Fill the space it is given: on a tall phone seven cramped rows in the top
  // third look like a bug, not a design.
  const rowH = Math.max(28, Math.min(72, (h - 18) / 7));
  const tx = (minute) => gridX + ((minute % DAY) / DAY) * gridW;
  const rowY = (d) => y + 16 + d * rowH;

  for (let hour = 0; hour <= 24; hour += 6) {
    const hx = gridX + (hour / 24) * gridW;
    b.text(`${String(hour).padStart(2, '0')}`, hx, y, { color: THEME.faint, font: '9px IBM Plex Mono, ui-monospace, monospace', align: hour === 24 ? 'right' : 'left' });
    b.line(hx, y + 14, hx, y + 16 + 7 * rowH, { color: THEME.lineSoft });
  }

  for (let d = 0; d < 7; d++) {
    const ry = rowY(d);
    b.rect(gridX, ry, gridW, rowH - 2, { fill: d >= 5 ? '#12161c' : THEME.panel, radius: 4 });
    // night bands
    b.rect(gridX, ry, tx(6 * 60) - gridX, rowH - 2, { fill: THEME.night, radius: 0 });
    b.rect(tx(22 * 60), ry, gridX + gridW - tx(22 * 60), rowH - 2, { fill: THEME.night, radius: 0 });
    b.text(WEEK_DAYS[d], x, ry + rowH / 2, {
      color: d >= 5 ? THEME.faint : THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', baseline: 'middle',
    });
  }

  for (const bl of s.calendar.blocks) {
    const d = Math.floor(bl.start / DAY);
    if (d >= 7) continue;
    const k = KIND[bl.kind] || KIND.free;
    const x1 = tx(bl.start), x2 = tx(bl.end);
    b.rect(x1, rowY(d) + 3, Math.max(3, x2 - x1), rowH - 8, { fill: k.fill, stroke: k.edge, radius: 3 });
    if (x2 - x1 > 34) b.text(k.short, x1 + 4, rowY(d) + rowH / 2 - 1, { color: k.edge, font: '8.5px IBM Plex Sans, system-ui, sans-serif', baseline: 'middle', max: x2 - x1 - 8 });
  }

  if (s.deadline) {
    const d = Math.floor(s.deadline.at / DAY);
    if (d < 7) b.line(tx(s.deadline.at), rowY(d), tx(s.deadline.at), rowY(d) + rowH - 2, { color: THEME.bad, width: 2 });
  }

  if (now != null) {
    const d = Math.floor(now / DAY);
    if (d < 7) {
      b.rect(tx(now) - 1, rowY(d), 2, rowH - 2, { fill: THEME.accent, radius: 1 });
      b.text('ahora', tx(now) + 4, rowY(d) - 1, { color: THEME.accent, font: '8.5px IBM Plex Sans, system-ui, sans-serif' });
    }
  }

  if (editable) {
    // Painting hours with a thumb: drag left-to-right along a day.
    b.region('pgrid', gridX, y + 16, gridW, 7 * rowH, {
      cursor: 'crosshair',
      onDown: (p) => {
        const d = Math.floor((p.y - (y + 16)) / rowH);
        ui.painting = { day: d, from: snap((p.x - gridX) / gridW) };
      },
      onDrag: (p) => { if (ui.painting) ui.painting.to = snap((p.x - gridX) / gridW); },
      onDrop: () => {
        const pa = ui.painting; ui.painting = null;
        if (!pa || pa.to == null || pa.day < 0 || pa.day > 6) return;
        const a = Math.min(pa.from, pa.to), z = Math.max(pa.from, pa.to);
        if (z - a < 60) return;
        const start = pa.day * DAY + a, end = pa.day * DAY + z;
        if (ui.brush === 'erase') {
          ctx.setAttention(s.calendar.blocks.filter((o) => !(o.start < end && o.end > start)));
          return;
        }
        const kept = [];
        for (const o of s.calendar.blocks) {
          if (o.end <= start || o.start >= end) { kept.push(o); continue; }
          if (o.start < start) kept.push({ ...o, end: start });
          if (o.end > end) kept.push({ ...o, start: end });
        }
        ctx.setAttention([...kept, { start, end, kind: ui.brush || 'plan_review' }]);
      },
    });
    if (ui.painting?.to != null) {
      const a = Math.min(ui.painting.from, ui.painting.to), z = Math.max(ui.painting.from, ui.painting.to);
      const k = KIND[ui.brush] || KIND.plan_review;
      b.rect(tx(a), rowY(ui.painting.day) + 3, tx(z) - tx(a), rowH - 8,
        { fill: k.fill, stroke: k.edge, alpha: 0.8, radius: 3 });
    }
  }
  return 16 + 7 * rowH;
}

const snap = (frac) => Math.max(0, Math.min(DAY, Math.round((frac * DAY) / 30) * 30));

// -------------------------------------------------------------------- alerts

function alertList(b, ctx, s, x, y, w, scrollDrag) {
  const live = s.alerts.filter((a) => !a.resolved || a.type === 'incident' || a.type === 'epoch').slice(-12).reverse();
  if (!live.length) {
    b.text('Nada por ahora.', x + 4, y, { color: THEME.faint, font: '12px IBM Plex Sans, system-ui, sans-serif' });
    return 24;
  }
  let cy = y;
  for (const a of live) {
    const color = a.type === 'incident' || a.type === 'hardstop' || a.type === 'sla' ? THEME.bad
      : a.type === 'ci_red' || a.type === 'blocked' || a.type === 'stranded' ? THEME.warn
      : a.type === 'product_fork' || a.type === 'fork_answer' || a.type === 'false_premise' ? THEME.busy
      : a.type === 'epoch' ? THEME.attentionEdge : THEME.line;
    const used = b.paragraph(a.text, x + 10, cy + 8, w - 20, { maxLines: 4, lineHeight: 14, font: '11.5px IBM Plex Sans, system-ui, sans-serif', measure: true });
    const choices = alertChoices(ctx, s, a);
    const btnH = choices.length ? 32 : 0;
    b.rect(x, cy, w, used + 16 + btnH, { fill: THEME.panel2, stroke: color });
    b.paragraph(a.text, x + 10, cy + 8, w - 20, { maxLines: 4, lineHeight: 14, font: '11.5px IBM Plex Sans, system-ui, sans-serif', color: THEME.ink });
    let bx = x + 10;
    for (const [label, fn] of choices) {
      const cw = Math.min((w - 24) / choices.length, 118);
      b.rect(bx, cy + used + 12, cw, 26, { fill: THEME.bg, stroke: color, radius: 6 });
      b.text(label, bx + cw / 2, cy + used + 25, {
        color: THEME.ink, font: '11px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', max: cw - 8,
      });
      b.region(`palert:${a.id}:${label}`, bx, cy + used + 12, cw, 26, { cursor: 'pointer', onDrag: scrollDrag, onClick: fn });
      bx += cw + 6;
    }
    cy += used + 16 + btnH + 8;
  }
  return cy - y;
}

function alertChoices(ctx, s, a) {
  if (a.resolved && a.type !== 'incident') return [];
  if (a.type === 'ci_red') return [['relanzar', () => ctx.act('rerun', { alertId: a.id })], ['investigar', () => ctx.act('investigate', { alertId: a.id })]];
  if (a.type === 'hardstop') return [['ir a mirarlo', () => ctx.act('unblock', { jobId: a.jobId })]];
  if (a.type === 'false_premise') return [
    ['confirmo', () => ctx.act('answer_premise', { alertId: a.id, stance: 'confirm' })],
    ['no quedamos', () => ctx.act('answer_premise', { alertId: a.id, stance: 'reject' })],
    ['no me consta', () => ctx.act('answer_premise', { alertId: a.id, stance: 'unsure' })],
  ];
  if (a.type === 'product_fork') return [
    ['escalar', () => ctx.act('escalate', { alertId: a.id, text: '' })],
    ['decido yo', () => ctx.act('decide', { alertId: a.id, option: 'b' })],
    ['no me alcanza', () => ctx.act('dont_know', { alertId: a.id })],
  ];
  if (a.type === 'fork_answer') return [
    ['mejor la suya', () => ctx.act('respond_fork', { alertId: a.id, stance: 'accept' })],
    ['sigo con la mía', () => ctx.act('respond_fork', { alertId: a.id, stance: 'defend' })],
  ];
  if (a.type === 'incident' && a.incidentId) {
    const inc = s.incidents.find((i) => i.id === a.incidentId);
    if (inc && !inc.choice) return [
      ['arreglar ya', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'hotfix' })],
      ['echar atrás', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'rollback' })],
      ['dejarlo', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'accept' })],
    ];
  }
  return [];
}

// ------------------------------------------------------------------- phase 1

function drawPlanPhone(board, ctx) {
  const b = board;
  const s = ctx.sim.state();
  const { ui } = ctx;
  if (!['week', 'who', 'how', 'backlog'].includes(ui.tab)) ui.tab = 'week';
  ui.brush = ui.brush || 'plan_review';

  header(b, ctx, s, {
    title: 'Tu semana',
    sub: `${Math.round(s.calendar.placed / 60)} h de 40 · ${s.items.filter((i) => !i.dropped).length} tareas`,
    action: { label: 'Empezar ▸', on: s.calendar.placed > 0, onClick: () => ctx.seal() },
  });
  const top = tabs(b, ctx, [['week', 'Semana'], ['who', 'Quién hace qué'], ['how', 'La red'], ['backlog', 'Backlog']]);
  const areaH = b.height - top - PAD;

  if (ui.tab === 'week') {
    b.paragraph(ui.lastRound || 'La máquina trabaja los 7 días. Tú tienes 40 horas: elige para qué son y píntalas.',
      PAD, top + 8, b.width - PAD * 2, { maxLines: 3, lineHeight: 14, font: '11px IBM Plex Sans, system-ui, sans-serif',
        color: ui.lastRound ? THEME.warn : THEME.dim });
    let bx = PAD, by = top + 54;
    for (const key of ['plan_review', 'output_review', 'manual_test', 'free', 'erase']) {
      const on = ui.brush === key;
      const k = KIND[key];
      const label = key === 'erase' ? 'borrar' : k.short;
      const w = key === 'erase' ? 54 : (b.width - PAD * 2 - 54 - 24) / 4;
      b.rect(bx, by, w, 30, { fill: on ? (k ? k.fill : '#3a1f1f') : THEME.panel2, stroke: on ? (k ? k.edge : THEME.bad) : THEME.line });
      b.text(label, bx + w / 2, by + 15, {
        color: on ? (k ? k.edge : THEME.bad) : THEME.dim, font: '11px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', max: w - 8,
      });
      b.region(`pbrush:${key}`, bx, by, w, 30, { cursor: 'pointer', onClick: () => { ui.brush = key; } });
      bx += w + 6;
    }
    weekRows(b, ctx, s, PAD, by + 40, b.width - PAD * 2, areaH - 94, { editable: true });
    return;
  }

  if (ui.tab === 'backlog') {
    const items = s.items.filter((i) => !i.dropped);
    b.paragraph('Marca las que vas a leer sí o sí. Con 100 tareas no te caben todas: elegir cuáles es la decisión.',
      PAD, top + 8, b.width - PAD * 2, { maxLines: 2, lineHeight: 14, font: '11px IBM Plex Sans, system-ui, sans-serif' });
    const listY = top + 44;
    const sc = scroller(b, ctx, 'plist', 0, listY, b.width, areaH - 44, items.length * 40);
    let cy = sc.top;
    for (const it of items) {
      const on = (s.flagged || []).includes(it.id);
      b.rect(PAD, cy, b.width - PAD * 2, 36, { fill: THEME.panel2, stroke: on ? THEME.warn : THEME.line });
      b.text(on ? '★' : '☆', PAD + 10, cy + 12, { color: on ? THEME.warn : THEME.faint, font: '13px IBM Plex Sans, system-ui, sans-serif' });
      b.text(it.id, PAD + 30, cy + 6, { color: THEME.dim, font: '10px IBM Plex Mono, ui-monospace, monospace' });
      b.text(it.title, PAD + 30, cy + 20, { color: THEME.ink, font: '11px IBM Plex Sans, system-ui, sans-serif', max: b.width - PAD * 2 - 76 });
      b.text(`${it.impact}·${it.complexity}`, b.width - PAD - 10, cy + 12, { color: THEME.faint, font: '9.5px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
      b.region(`pflag:${it.id}`, PAD, cy, b.width - PAD * 2, 36, {
        cursor: 'pointer', onDrag: sc.drag, onClick: () => ctx.act('flag', { ids: [it.id], on: !on }),
      });
      cy += 40;
    }
    return;
  }

  if (ui.tab === 'who') {
    // Delegar, dicho de verdad: una línea por etapa, la parte que sigue siendo
    // tuya, y lo que esa parte le va a pedir a la semana.
    const need = ctx.sim.demand();
    const over = need.needed > need.budget;
    b.text('LO QUE PIDE TU HOJA', PAD, top + 10, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
    b.text(`${(need.needed / 60).toFixed(0)} h de ${Math.round(need.budget / 60)}`, b.width - PAD, top + 10, {
      color: over ? THEME.bad : THEME.ok, font: '11px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    b.rect(PAD, top + 26, b.width - PAD * 2, 5, { fill: THEME.bg, radius: 3 });
    b.rect(PAD, top + 26, Math.min(1, need.needed / Math.max(1, need.budget)) * (b.width - PAD * 2), 5,
      { fill: over ? THEME.bad : THEME.attentionEdge, radius: 3 });
    b.text(over ? 'No cabe: lee menos, o devuelve alguna etapa a los agentes.'
                : 'Toca una etapa para ir a reservarle horas.',
      PAD, top + 38, { color: over ? THEME.warn : THEME.faint, font: '10px IBM Plex Sans, system-ui, sans-serif' });
    const listY = top + 56;
    const sc = scroller(b, ctx, 'wlist', 0, listY, b.width, areaH - 56, 7 * 68 + 20);
    drawSheet(b, ctx, s, {
      x: PAD, y: sc.top, w: b.width - PAD * 2, onDrag: sc.drag, demand: need,
      onPick: (kind) => { ui.brush = kind === 'free' ? 'free' : kind; ui.tab = 'week'; ui.scroll = 0; },
    });
    return;
  }

  // Cómo trabajo: the bar you set once for all of them.
  let y = top + 10;
  const rowOf = (title, note, opts, current, onPick) => {
    b.text(title, PAD, y, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
    y += 14;
    if (note) { b.paragraph(note, PAD, y, b.width - PAD * 2, { maxLines: 2, lineHeight: 13, font: '10.5px IBM Plex Sans, system-ui, sans-serif' }); y += 26; }
    let bx = PAD;
    const w = (b.width - PAD * 2 - (opts.length - 1) * 6) / opts.length;
    for (const [key, label] of opts) {
      const on = current === key;
      b.rect(bx, y, w, 34, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
      b.text(label, bx + w / 2, y + 17, {
        color: on ? '#06121f' : THEME.dim, font: '11px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', max: w - 6, weight: on ? '600' : null,
      });
      b.region(`popt:${title}:${label}`, bx, y, w, 34, { cursor: 'pointer', onClick: () => onPick(key) });
      bx += w + 6;
    }
    y += 44;
  };
  rowOf('CÓMO SE PRUEBA TODO', 'La red que coge lo que no vas a leer.',
    [['happy', 'feliz'], ['edge', 'bordes'], ['mutation', 'mutación']], s.policy.tests, (k) => ctx.act('set_policy', { tests: k }));
  rowOf('QUÉ MODELO PLANIFICA', 'El caro donde equivocarse sale caro.',
    [['rapido', 'rápido'], ['equilibrado', 'medio'], ['fuerte', 'fuerte']],
    s.models.byJob.plan_gen || s.models.default, (k) => ctx.act('set_model', { model: k, job: 'plan_gen' }));
  rowOf('CÓMO SE DESPLIEGA', null, [['canary', 'canary'], ['full', 'directo']], s.policy.deploy, (k) => ctx.act('set_policy', { deploy: k }));
  b.paragraph('Cuánto lees de cada cosa está en «Quién hace qué»: es la misma decisión que a quién le das cada etapa.',
    PAD, y + 4, b.width - PAD * 2, { maxLines: 3, lineHeight: 14, font: '10.5px IBM Plex Sans, system-ui, sans-serif', color: THEME.faint });
}

// ------------------------------------------------------------------- phase 2

function drawPlayPhone(board, ctx) {
  const b = board;
  const s = ctx.sim.state();
  const { ui } = ctx;
  if (!['queues', 'week', 'alerts'].includes(ui.tab)) ui.tab = 'queues';

  const sc = s.score;
  const openFires = s.incidents.filter((i) => !i.resolved).length;
  header(b, ctx, s, {
    title: s.when,
    sub: `${sc.clean_shipped}/${sc.shipped} entregadas · ${sc.escaped_defects} en producción · ${(sc.human_minutes / 60).toFixed(1)}/40 h`,
    action: { label: ui.paused ? '▶  seguir' : '❚❚  pausa', on: ui.paused, onClick: () => ctx.togglePause() },
  });

  let sx = PAD;
  for (const sp of [1, 2, 4]) {
    const on = ui.speed === sp;
    b.rect(sx, HEAD_H + 6, 44, 28, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
    b.text(`${sp}×`, sx + 22, HEAD_H + 20, { color: on ? '#06121f' : THEME.dim, font: '11.5px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle' });
    b.region(`pspeed:${sp}`, sx, HEAD_H + 6, 44, 28, { cursor: 'pointer', onClick: () => ctx.setSpeed(sp) });
    sx += 50;
  }
  b.text(s.attended ? 'en el escritorio' : 'no hay nadie delante', sx + 6, HEAD_H + 20, {
    color: s.attended ? THEME.ok : THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif', baseline: 'middle', max: b.width - sx - 76,
  });
  b.rect(b.width - PAD - 58, HEAD_H + 6, 58, 28, { fill: THEME.panel2, stroke: THEME.line });
  b.text('terminar', b.width - PAD - 29, HEAD_H + 20, { color: THEME.dim, font: '10.5px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle' });
  b.region('pfinish', b.width - PAD - 58, HEAD_H + 6, 58, 28, { cursor: 'pointer', onClick: () => ctx.finish() });

  const y = (() => {
    const yy = HEAD_H + 40;
    const w = b.width / 3;
    const items = [['queues', 'Colas'], ['week', 'Semana'], ['alerts', `Alertas${openFires ? ` (${openFires})` : ''}`]];
    b.line(0, yy, b.width, yy, { color: THEME.line });
    items.forEach(([key, label], i) => {
      const x = i * w;
      const on = ui.tab === key;
      if (on) b.rect(x + 6, yy + 5, w - 12, TABS_H - 10, { fill: THEME.panel2, stroke: THEME.line });
      b.text(label, x + w / 2, yy + TABS_H / 2, {
        color: on ? THEME.ink : (key === 'alerts' && openFires ? THEME.bad : THEME.faint),
        font: '12.5px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle', weight: on ? '600' : null,
      });
      b.region(`tab:${key}`, x, yy, w, TABS_H, { cursor: 'pointer', onClick: () => { if (ui.tab !== key) { ui.tab = key; ui.scroll = 0; } } });
    });
    b.line(0, yy + TABS_H, b.width, yy + TABS_H, { color: THEME.line });
    return yy + TABS_H;
  })();
  const areaH = b.height - y - PAD;

  if (ui.tab === 'week') { weekRows(b, ctx, s, PAD, y + 14, b.width - PAD * 2, areaH - 14, { editable: false, now: s.t }); return; }

  if (ui.tab === 'alerts') {
    const list = scroller(b, ctx, 'palerts', 0, y + 6, b.width, areaH, 4000);
    alertList(b, ctx, s, PAD, list.top + 8, b.width - PAD * 2, list.drag);
    return;
  }

  // Colas: the whole game on a phone screen. It scrolls, because on a short
  // screen the levers must still be reachable.
  const qs = scroller(b, ctx, 'pqueues', 0, y + 4, b.width, areaH, 700);
  let cy = qs.top + 10;
  for (const key of ['plan_review', 'output_review', 'manual_test']) {
    const n = s.queues[key] || 0;
    const k = KIND[key];
    const blocks = s.calendar.blocks.filter((x) => x.kind === key || x.kind === 'free');
    const here = blocks.find((x) => s.t >= x.start && s.t < x.end);
    const next = here ? s.t : (blocks.filter((x) => x.start > s.t).sort((a, c) => a.start - c.start)[0]?.start ?? null);
    const deep = n > 12;
    b.rect(PAD, cy, b.width - PAD * 2, 56, { fill: THEME.panel2, stroke: deep ? THEME.warn : THEME.line });
    b.rect(PAD, cy, 3, 56, { fill: k.edge, radius: 2 });
    b.text(k.label, PAD + 12, cy + 8, { color: THEME.ink, font: '12px IBM Plex Sans, system-ui, sans-serif' });
    b.text(String(n), b.width - PAD - 12, cy + 6, {
      color: n === 0 ? THEME.faint : deep ? THEME.warn : THEME.ink,
      font: '20px IBM Plex Mono, ui-monospace, monospace', align: 'right', weight: '600',
    });
    b.text(next == null ? 'no reservaste ni un bloque para esto' : next <= s.t ? 'lo estás haciendo ahora' : `siguiente ${Calendar.label(next)}`,
      PAD + 12, cy + 28, { color: next == null ? THEME.bad : THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif', max: b.width - PAD * 2 - 24 });
    b.rect(PAD + 12, cy + 46, b.width - PAD * 2 - 24, 4, { fill: THEME.bg, radius: 2 });
    if (n) b.rect(PAD + 12, cy + 46, (b.width - PAD * 2 - 24) * Math.min(1, n / 30), 4, { fill: deep ? THEME.warn : k.edge, radius: 2 });
    b.region(`pq:${key}`, PAD, cy, b.width - PAD * 2, 56, { onDrag: qs.drag });
    cy += 64;
  }

  const backlog = s.items.filter((i) => i.stage === 'backlog' && !i.dropped);
  // El trabajo se delega solo en cuanto está listo. La palanca de media semana
  // es la contraria: cuando la pila gana, leer menos.
  cy += 6;
  b.text('SI TE ESTÁS AHOGANDO, LEE MENOS', PAD + 2, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  cy += 16;
  const liveRow = (label, stage) => {
    const current = s.stages?.[stage];
    b.text(label, PAD + 2, cy, { color: THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif' });
    b.text(current === 'ia' ? 'un agente' : `${Math.round((Number(current) || 0) * 100)}%`,
      b.width - PAD - 2, cy, { color: current === 'ia' ? THEME.bad : THEME.dim,
      font: '10.5px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 14;
    const opts = [[1, 'todo'], [0.5, '50%'], [0.25, '25%'], [0, 'nada']];
    const w = (b.width - PAD * 2 - 18) / 4;
    opts.forEach(([key, text], i) => {
      const on = current !== 'ia' && Math.abs((Number(current) || 0) - key) < 0.001;
      const bx = PAD + i * (w + 6);
      b.rect(bx, cy, w, 30, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
      b.text(text, bx + w / 2, cy + 15, {
        color: on ? '#06121f' : THEME.dim, font: '11px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', weight: on ? '600' : null,
      });
      b.region(`plive:${stage}:${text}`, bx, cy, w, 30, { cursor: 'pointer', onDrag: qs.drag, onClick: () => ctx.act('set_stage', { stage, who: key }) });
    });
    cy += 38;
  };
  liveRow('planes que lees', 'plan_review');
  liveRow('entregas que lees', 'output_review');
  liveRow('lo que pruebas a mano', 'manual_test');
  cy += 6;

  const stat = (label, value, color = THEME.ink) => {
    b.text(label, PAD + 2, cy, { color: THEME.faint, font: '11px IBM Plex Sans, system-ui, sans-serif' });
    b.text(String(value), b.width - PAD - 2, cy, { color, font: '11.5px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 20;
  };
  stat('sin delegar', backlog.length, backlog.length ? THEME.warn : THEME.faint);
  stat('en manos de los agentes', s.items.filter((i) => !['backlog', 'done'].includes(i.stage) && !i.dropped).length);
  stat('entregadas', s.items.filter((i) => i.stage === 'done').length, THEME.ok);
  if (s.estimates?.factor) {
    stat('tardando sobre lo estimado', `${s.estimates.factor.toFixed(2)}×`,
      s.estimates.factor > 1.3 ? THEME.warn : THEME.ink);
  }
  stat('fuera de la semana', `${Math.round(sc.spillover_min / 60)} h`, sc.spillover_min > 240 ? THEME.warn : THEME.dim);
}

export { drawPlanPhone, drawPlayPhone };

