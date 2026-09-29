import { THEME } from './board.mjs';
import { STAGE_SPEC } from '../../engine/tuning.mjs';

/**
 * The assignment sheet, drawn.
 *
 * This is the answer to "¿qué delego?", and it is not a number of tasks — it is
 * a line per stage of the work. Two of those lines are the whole point:
 * *escribir el plan* is something an agent does in seconds, and *revisar el
 * plan* is something only you can do; they are different jobs and they live on
 * different rows. Three stages carry `delegable: false` because a person is the
 * only instrument that works there — reading a plan, reading a delivery, and
 * using the product with hands and eyes. You are still allowed to hand them
 * over. That door is deliberately open, and what it costs is measured.
 */

/** The options a row offers, in the order they should read. */
function optionsFor(stage) {
  const spec = STAGE_SPEC[stage];
  if (spec.delegable) return [['ia', 'agente'], ['humano', 'yo']];
  return [[0, 'nada'], [0.25, '25%'], [0.5, '50%'], [1, 'todo'], ['ia', 'agente']];
}

/** How much of this stage is yours, as the diagram should say it. */
function humanShare(who) {
  if (who === 'humano') return 1;
  if (who === 'ia') return 0;
  return Number(who) || 0;
}

/** "100% tuyo" / "10% tuyo" / "0% tuyo — lo hace un agente". */
function shareLabel(stage, who) {
  const spec = STAGE_SPEC[stage];
  const pct = Math.round(humanShare(who) * 100);
  if (who === 'ia') return spec.delegable ? '0% tuyo · agente' : '0% tuyo · delegas lo indelegable';
  if (who === 'humano') return '100% tuyo · a mano';
  return `${pct}% tuyo`;
}

/** A row assigned to an agent that no agent can really do. */
function isCanary(stage, who) {
  return !STAGE_SPEC[stage].delegable && who === 'ia';
}

const STAGE_KEYS = Object.keys(STAGE_SPEC);

/**
 * Draws the sheet as a column of rows and registers the hit regions.
 * Returns the height used, so the caller can lay out whatever comes next.
 */
function drawSheet(b, ctx, s, { x, y, w, compact = false, onDrag = null, demand = null, onPick = null }) {
  const hours = (min) => `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`;
  let cy = y;
  for (const stage of STAGE_KEYS) {
    const spec = STAGE_SPEC[stage];
    const who = s.stages?.[stage] ?? spec.aiDefault;
    const canary = isCanary(stage, who);
    const share = humanShare(who);

    const need = demand?.rows.find((r) => r.stage === stage) || null;
    b.text(spec.label, x, cy, {
      color: need && !need.covered ? THEME.warn : THEME.ink,
      font: '11px IBM Plex Sans, system-ui, sans-serif', max: w - 118,
    });
    if (need && onPick) {
      // The two halves of the screen are one decision: click the stage, get the
      // brush that books hours for it.
      b.region(`pick:${stage}`, x - 4, cy - 3, w - 110, 15, { cursor: 'pointer', onClick: () => onPick(need.kind) });
    }
    b.text(shareLabel(stage, who), x + w, cy, {
      color: canary ? THEME.bad : share === 0 ? THEME.faint : share === 1 ? THEME.attentionEdge : THEME.dim,
      font: '9.5px IBM Plex Mono, ui-monospace, monospace', align: 'right',
    });
    cy += 14;

    // The bar is the diagram: how much of this stage stays on your hands.
    b.rect(x, cy, w, 3, { fill: THEME.bg, radius: 2 });
    if (share > 0) b.rect(x, cy, w * share, 3, { fill: canary ? THEME.bad : THEME.attentionEdge, radius: 2 });
    cy += 7;

    // What this line costs you, against the hours you booked for it. Without
    // this the sheet and the calendar are two unrelated pictures.
    if (need) {
      const label = need.kind === 'free'
        ? `${need.cards} tarjetas ≈ ${hours(need.minutes)} · libre ${hours(need.pooled)}`
        : `${need.cards} tarjetas ≈ ${hours(need.minutes)} · reservadas ${hours(need.pooled)}`;
      b.text(label, x, cy, {
        color: need.covered ? THEME.faint : THEME.warn,
        font: '9.5px IBM Plex Mono, ui-monospace, monospace', max: w,
      });
      cy += 13;
    }

    const opts = optionsFor(stage);
    const bw = (w - (opts.length - 1) * 4) / opts.length;
    opts.forEach(([key, label], i) => {
      const on = who === key;
      const warn = key === 'ia' && !spec.delegable;
      const bx = x + i * (bw + 4);
      b.rect(bx, cy, bw, compact ? 22 : 24, {
        fill: on ? (warn ? THEME.bad : THEME.accent) : THEME.panel2,
        stroke: on ? (warn ? THEME.bad : THEME.accent) : THEME.line,
      });
      b.text(label, bx + bw / 2, cy + (compact ? 11 : 12), {
        color: on ? '#06121f' : warn ? THEME.dim : THEME.dim,
        font: '10.5px IBM Plex Sans, system-ui, sans-serif',
        align: 'center', baseline: 'middle', max: bw - 6, weight: on ? '600' : null,
      });
      b.region(`stage:${stage}:${key}`, bx, cy, bw, compact ? 22 : 24, {
        cursor: 'pointer', onDrag,
        onClick: () => ctx.act('set_stage', { stage, who: key }),
      });
    });
    cy += (compact ? 22 : 24) + (compact ? 8 : 12);
  }
  return cy - y;
}

export { optionsFor, humanShare, shareLabel, isCanary, STAGE_KEYS, drawSheet };

