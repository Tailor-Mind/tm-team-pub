import { THEME } from './board.mjs';
import { WeekGrid, KIND } from './week.mjs';
import { DAY, Calendar } from '../../engine/calendar.mjs';

const PAD = 14;
const LEFT_W = 292;
const RIGHT_W = 272;

/**
 * Phase two: the week runs, and what you watch is not cards — it is queues.
 *
 * Twelve tasks and a hundred tasks look identical from the machine's side. The
 * difference shows up here, in how deep the piles get and how long the next
 * block of your time is away. Somebody drowning can see it happening.
 */
function drawPlay(board, ctx) {
  const b = board;
  const s = ctx.sim.state();
  const gridX = PAD + LEFT_W + PAD + 26;
  const gridW = b.width - gridX - RIGHT_W - PAD * 2;
  const grid = new WeekGrid({
    x: gridX, y: 84, w: Math.max(300, gridW), h: b.height - 84 - PAD - 16, cardStrip: 8,
  });
  ctx.ui.grid = grid;

  header(b, ctx, s);
  grid.draw(b, { today: Math.floor(s.t / DAY), deadline: s.deadline?.at ?? null });
  grid.drawAttention(b, s.calendar.blocks, {});
  jobBars(b, ctx, s, grid);
  nowLine(b, s, grid);
  queues(b, ctx, s);
  rightRail(b, ctx, s);
}

// ------------------------------------------------------------------- header

function header(b, ctx, s) {
  const { ui } = ctx;
  b.text(s.when, PAD, 12, { font: '19px IBM Plex Mono, ui-monospace, monospace', weight: '600' });
  b.text(s.attended ? `en el escritorio · ${KIND[s.calendar.blocks.find((x) => s.t >= x.start && s.t < x.end)?.kind || 'free'].label}` : 'no hay nadie delante',
    PAD, 38, { color: s.attended ? THEME.ok : THEME.faint, font: '11px IBM Plex Sans, system-ui, sans-serif', max: LEFT_W });
  b.text(`${Math.round((s.t / s.horizon) * 100)}% de la semana`, PAD, 55, { color: THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif' });

  let x = PAD + 168;
  const btn = (label, w, on, fn) => {
    b.rect(x, 14, w, 24, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
    b.text(label, x + w / 2, 26, { color: on ? '#06121f' : THEME.ink, font: '11.5px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle', weight: on ? '600' : null });
    b.region(`h:${label}`, x, 14, w, 24, { cursor: 'pointer', onClick: fn });
    x += w + 6;
  };
  btn(ui.paused ? '▶' : '❚❚', 40, ui.paused, () => ctx.togglePause());
  for (const sp of [1, 2, 4]) btn(`${sp}×`, 34, ui.speed === sp, () => ctx.setSpeed(sp));
  btn('terminar', 66, false, () => ctx.finish());

  const sc = s.score;
  const openFires = s.incidents.filter((i) => !i.resolved).length;
  const cells = [
    ['entregadas', `${sc.clean_shipped}/${sc.shipped}`, sc.shipped ? THEME.ok : THEME.dim],
    ['valor en pie', sc.clean_value.toFixed(1), sc.clean_value > 0 ? THEME.ok : THEME.dim],
    ['en producción', String(sc.escaped_defects), sc.escaped_defects ? THEME.bad : THEME.ink],
    ['fuegos', String(openFires), openFires ? THEME.bad : THEME.ink],
    ['tus horas', `${(sc.human_minutes / 60).toFixed(1)}/40`, sc.human_minutes > 2100 ? THEME.warn : THEME.ink],
    ['fuera de semana', `${Math.round(sc.spillover_min / 60)}h`, sc.spillover_min > 240 ? THEME.warn : THEME.dim],
  ];
  const cx0 = x + 16;
  const step = Math.max(84, Math.min(120, (b.width - cx0 - PAD - 30) / cells.length));
  cells.forEach(([label, value, color], i) => {
    const cx = cx0 + i * step;
    b.text(value, cx, 14, { color, font: '17px IBM Plex Mono, ui-monospace, monospace', weight: '600' });
    b.text(label, cx, 38, { color: THEME.faint, font: '9.5px IBM Plex Sans, system-ui, sans-serif', max: step - 8 });
  });
  if (ui.flash) b.text(ui.flash, b.width - PAD, 58, { color: THEME.bad, font: '11.5px IBM Plex Sans, system-ui, sans-serif', align: 'right' });
}

// -------------------------------------------------------------------- queues

function queues(b, ctx, s) {
  const x = PAD, y = 84;
  const h = b.height - y - PAD - 16;
  b.rect(x, y, LEFT_W, h, { fill: THEME.panel, stroke: THEME.line });
  b.text('TUS COLAS', x + 12, y + 10, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });

  let cy = y + 30;
  for (const key of ['plan_review', 'output_review', 'manual_test']) {
    const n = s.queues[key] || 0;
    const k = KIND[key];
    const nextAt = nextBlockFor(s, key);
    const deep = n > 12;
    b.rect(x + 10, cy, LEFT_W - 20, 54, { fill: THEME.panel2, stroke: deep ? THEME.warn : THEME.line });
    b.rect(x + 10, cy, 3, 54, { fill: k.edge, radius: 2 });
    b.text(k.label, x + 22, cy + 8, { color: THEME.ink, font: '12px IBM Plex Sans, system-ui, sans-serif' });
    b.text(String(n), x + LEFT_W - 22, cy + 6, {
      color: n === 0 ? THEME.faint : deep ? THEME.warn : THEME.ink,
      font: '20px IBM Plex Mono, ui-monospace, monospace', align: 'right', weight: '600',
    });
    const note = nextAt == null
      ? 'no reservaste ni un bloque para esto'
      : nextAt <= s.t ? 'lo estás haciendo ahora' : `siguiente bloque ${Calendar.label(nextAt)}`;
    b.text(note, x + 22, cy + 28, {
      color: nextAt == null ? THEME.bad : THEME.faint,
      font: '10.5px IBM Plex Sans, system-ui, sans-serif', max: LEFT_W - 44,
    });
    // A bar that fills as the pile grows: drowning should look like drowning.
    const frac = Math.min(1, n / 30);
    b.rect(x + 22, cy + 44, LEFT_W - 44, 4, { fill: THEME.bg, radius: 2 });
    if (n) b.rect(x + 22, cy + 44, (LEFT_W - 44) * frac, 4, { fill: deep ? THEME.warn : k.edge, radius: 2 });
    cy += 62;
  }

  // The work delegates itself the moment it is ready — that is what having
  // agents means. The control that matters mid-week is not "hand out five
  // more", it is the one you reach for when the pile is winning: read less.
  const backlog = s.items.filter((i) => i.stage === 'backlog' && !i.dropped);
  const inFlight = s.items.filter((i) => !['backlog', 'done'].includes(i.stage) && !i.dropped).length;
  cy += 2;
  b.text('SI TE ESTÁS AHOGANDO, LEE MENOS', x + 12, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  cy += 16;
  const shareRow = (label, stage, current) => {
    b.text(label, x + 14, cy, { color: THEME.faint, font: '10px IBM Plex Sans, system-ui, sans-serif' });
    // The number, always, because the sheet allows shares the buttons do not.
    b.text(current === 'ia' ? 'un agente' : `${Math.round((Number(current) || 0) * 100)}%`,
      x + LEFT_W - 14, cy, { color: current === 'ia' ? THEME.bad : THEME.dim,
      font: '10px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 12;
    const opts = [[1, 'todo'], [0.5, '50%'], [0.25, '25%'], [0, 'nada']];
    const w = (LEFT_W - 28 - 3 * 5) / 4;
    opts.forEach(([key, text], i) => {
      const on = current !== 'ia' && Math.abs((Number(current) || 0) - key) < 0.001;
      const bx = x + 14 + i * (w + 5);
      b.rect(bx, cy, w, 22, { fill: on ? THEME.accent : THEME.panel2, stroke: on ? THEME.accent : THEME.line });
      b.text(text, bx + w / 2, cy + 11, {
        color: on ? '#06121f' : THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', weight: on ? '600' : null,
      });
      b.region(`live:${stage}:${text}`, bx, cy, w, 22, {
        cursor: 'pointer', onClick: () => ctx.act('set_stage', { stage, who: key }),
      });
    });
    cy += 28;
  };
  shareRow('planes que lees', 'plan_review', s.stages?.plan_review ?? s.trust?.plan);
  shareRow('entregas que lees', 'output_review', s.stages?.output_review ?? s.trust?.output);
  shareRow('lo que pruebas a mano', 'manual_test', s.stages?.manual_test);
  cy += 4;

  const stat = (label, value, color = THEME.ink) => {
    b.text(label, x + 14, cy, { color: THEME.faint, font: '10.5px IBM Plex Sans, system-ui, sans-serif' });
    b.text(String(value), x + LEFT_W - 14, cy, { color, font: '11px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 17;
  };
  stat('sin delegar', backlog.length, backlog.length ? THEME.warn : THEME.faint);
  stat('en manos de los agentes', inFlight);
  stat('entregadas', s.items.filter((i) => i.stage === 'done').length, THEME.ok);
  stat('marcadas ★', (s.flagged || []).length, THEME.warn);
  // What the agents said it would take, against what it is taking.
  const est = s.estimates || {};
  if (est.factor) {
    stat('tardando sobre lo estimado', `${est.factor.toFixed(2)}×`,
      est.factor > 1.3 ? THEME.warn : est.factor > 1 ? THEME.ink : THEME.ok);
    stat('tarjetas pasadas de plazo', est.over || 0, est.over ? THEME.warn : THEME.faint);
  }
  if ((s.undelegated || []).length) {
    stat('indelegable en manos de un agente', (s.undelegated || []).length, THEME.bad);
  }

  cy += 8;
  b.text('ÚLTIMAS SESIONES', x + 12, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  cy += 16;
  for (const ses of (s.sessions || []).slice().reverse()) {
    if (cy > y + h - 16) break;
    b.text(`${ses.label} · ${KIND[ses.kind]?.short || ses.kind}`, x + 14, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif' });
    b.text(`${ses.items} en ${ses.minutes}′`, x + LEFT_W - 14, cy, { color: THEME.faint, font: '10px IBM Plex Mono, ui-monospace, monospace', align: 'right' });
    cy += 15;
  }
}

function nextBlockFor(s, kind) {
  const blocks = s.calendar.blocks.filter((b) => b.kind === kind || b.kind === 'free');
  const here = blocks.find((b) => s.t >= b.start && s.t < b.end);
  if (here) return s.t;
  const next = blocks.filter((b) => b.start > s.t).sort((a, b) => a.start - b.start)[0];
  return next ? next.start : null;
}

// ---------------------------------------------------------------- job bars

const JOB_COLOR = {
  plan_gen: '#5b8def', spec_gen: '#5b8def', code_gen: THEME.accent, test_gen: '#48b0a0',
  unit_tests: '#48b0a0', mutation_run: THEME.ok, review_agent: THEME.busy,
  build_android: THEME.warn, deploy: '#e07a5f',
};

function jobBars(b, ctx, s, grid) {
  const lanes = new Map();
  const place = (day) => { const n = lanes.get(day) || 0; lanes.set(day, n + 1); return n; };
  for (const j of s.jobs.running) {
    const day = Math.floor(j.startedAt / DAY);
    if (day >= grid.days) continue;
    const lane = place(day);
    const x = grid.colX(day) + 4 + (lane % 3) * 4;
    const y1 = grid.yFor(j.startedAt);
    const y2 = Math.min(grid.gridY + grid.gridH, grid.yFor(Math.min(j.endsAt, (day + 1) * DAY - 1)));
    b.rect(x, y1, grid.colW - 14, Math.max(3, y2 - y1), { fill: JOB_COLOR[j.kind] || THEME.accent, alpha: 0.85, radius: 3 });
  }
  for (const bl of s.blocked) {
    const day = Math.floor(bl.at / DAY);
    if (day >= grid.days) continue;
    const y1 = grid.yFor(bl.at);
    const y2 = Math.min(grid.gridY + grid.gridH, grid.yFor(Math.min(s.t, (day + 1) * DAY - 1)));
    b.rect(grid.colX(day) + 1, y1, 4, Math.max(6, y2 - y1), { fill: THEME.bad, radius: 2, alpha: 0.85 });
  }
  const load = s.jobs.running.length + s.jobs.queued.length;
  if (load) {
    b.text(`${s.jobs.running.length} corriendo · ${s.jobs.queued.length} en cola`, grid.x + grid.w - 6, grid.gridY + 4,
      { color: THEME.faint, font: '10px IBM Plex Sans, system-ui, sans-serif', align: 'right' });
  }
}

function nowLine(b, s, grid) {
  const day = Math.floor(s.t / DAY);
  if (day >= grid.days) return;
  const y = grid.yFor(s.t);
  b.line(grid.colX(day), y, grid.colX(day) + grid.colW, y, { color: THEME.accent, width: 2 });
}

// ---------------------------------------------------------------- right rail

function rightRail(b, ctx, s) {
  const x = b.width - RIGHT_W - PAD, y = 84;
  const h = b.height - y - PAD - 16;
  b.rect(x, y, RIGHT_W, h, { fill: THEME.panel, stroke: THEME.line });

  let cy = y + 12;
  b.text('LA MÁQUINA', x + 12, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  cy += 18;
  const r = s.resources;
  cy += b.meter(x + 12, cy, RIGHT_W - 24, 'núcleos', r.cores.cap - r.cores.free, r.cores.cap);
  cy += b.meter(x + 12, cy, RIGHT_W - 24, 'RAM', r.ram.cap - r.ram.free, r.ram.cap, { unit: 'G' });
  cy += b.meter(x + 12, cy, RIGHT_W - 24, 'licencias', r.agents.cap - r.agents.free, r.agents.cap);
  cy += b.meter(x + 12, cy, RIGHT_W - 24, 'tokens', (r.tokens.cap - r.tokens.left) / 1000, r.tokens.cap / 1000, { unit: 'k' });
  cy += 12;

  b.text('LO QUE ESTÁ PASANDO', x + 12, cy, { color: THEME.dim, font: '10px IBM Plex Sans, system-ui, sans-serif', weight: '600' });
  cy += 18;
  const live = s.alerts.filter((a) => !a.resolved || ['incident', 'epoch', 'session'].includes(a.type)).slice(-8).reverse();
  if (!live.length) b.text('—', x + 12, cy, { color: THEME.faint, font: '11px IBM Plex Sans, system-ui, sans-serif' });
  for (const a of live) {
    if (cy > y + h - 56) break;
    const color = ['incident', 'hardstop', 'sla'].includes(a.type) ? THEME.bad
      : ['ci_red', 'blocked', 'stranded'].includes(a.type) ? THEME.warn
      : ['product_fork', 'fork_answer', 'false_premise'].includes(a.type) ? THEME.busy
      : a.type === 'session' ? THEME.attentionEdge : THEME.line;
    const used = b.paragraph(a.text, x + 18, cy + 6, RIGHT_W - 36, { maxLines: 3, lineHeight: 13, font: '10.5px IBM Plex Sans, system-ui, sans-serif', measure: true });
    const choices = choicesFor(ctx, s, a);
    b.rect(x + 12, cy, RIGHT_W - 24, used + 14 + (choices.length ? 24 : 0), { fill: THEME.panel2, stroke: color });
    b.paragraph(a.text, x + 18, cy + 6, RIGHT_W - 36, { maxLines: 3, lineHeight: 13, font: '10.5px IBM Plex Sans, system-ui, sans-serif', color: THEME.ink });
    let bx = x + 18, by = cy + used + 9;
    for (const [label, fn] of choices) {
      const cw = Math.min((RIGHT_W - 44) / choices.length, 108);
      b.rect(bx, by, cw, 17, { fill: THEME.bg, stroke: color, radius: 5 });
      b.text(label, bx + cw / 2, by + 9, { color: THEME.ink, font: '10px IBM Plex Sans, system-ui, sans-serif', align: 'center', baseline: 'middle', max: cw - 6 });
      b.region(`al:${a.id}:${label}`, bx, by, cw, 17, { cursor: 'pointer', onClick: fn });
      bx += cw + 5;
    }
    cy += used + 20 + (choices.length ? 24 : 0);
  }
}

function choicesFor(ctx, s, a) {
  if (a.resolved && a.type !== 'incident') return [];
  if (a.type === 'ci_red') return [['relanzar', () => ctx.act('rerun', { alertId: a.id })], ['investigar', () => ctx.act('investigate', { alertId: a.id })]];
  if (a.type === 'hardstop') return [['ir a mirarlo', () => ctx.act('unblock', { jobId: a.jobId })]];
  if (a.type === 'false_premise') return [
    ['confirmo', () => ctx.act('answer_premise', { alertId: a.id, stance: 'confirm' })],
    ['no quedamos', () => ctx.act('answer_premise', { alertId: a.id, stance: 'reject' })],
    ['no me consta', () => ctx.act('answer_premise', { alertId: a.id, stance: 'unsure' })]];
  if (a.type === 'product_fork') return [
    ['escalar', () => ctx.act('escalate', { alertId: a.id, text: '' })],
    ['decido yo', () => ctx.act('decide', { alertId: a.id, option: 'b' })],
    ['no me alcanza', () => ctx.act('dont_know', { alertId: a.id })]];
  if (a.type === 'fork_answer') return [
    ['mejor la suya', () => ctx.act('respond_fork', { alertId: a.id, stance: 'accept' })],
    ['sigo con la mía', () => ctx.act('respond_fork', { alertId: a.id, stance: 'defend' })]];
  if (a.type === 'incident' && a.incidentId) {
    const inc = s.incidents.find((i) => i.id === a.incidentId);
    if (inc && !inc.choice) return [
      ['arreglar ya', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'hotfix' })],
      ['echar atrás', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'rollback' })],
      ['dejarlo', () => ctx.act('incident_action', { incidentId: a.incidentId, choice: 'accept' })]];
  }
  return [];
}

export { drawPlay };

