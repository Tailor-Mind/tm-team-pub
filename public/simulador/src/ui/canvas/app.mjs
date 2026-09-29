import { Simulation, loadScenario, Telemetry, endpointSink, bufferedSink, seedFromString } from '../../engine/index.mjs';
import { watchInput } from '../provenance.mjs';
import { Board, THEME } from './board.mjs';
import { drawPlan } from './plan.mjs';
import { drawPlay } from './play.mjs';
import { drawPlanPhone, drawPlayPhone } from './phone.mjs';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/**
 * Mounts the canvas simulator.
 *
 * The whole game state lives in this closure. Nothing is attached to `window`
 * unless the page is opened with ?dev=1, which is how the tests drive it — and
 * which is stated rather than hidden.
 */
/**
 * Mounts the ladder.
 *
 * `config.scenarios` is a list; the practice ones come first. Anybody meeting
 * this for the first time gets a chooser instead of being dropped straight into
 * the round that counts — one task to see the loop, three to meet production,
 * and then the real thing. `config.scenario` (singular) still works and skips
 * the chooser entirely.
 */
function mount(root, config = {}) {
  const ladder = (config.scenarios || [config.scenario]).filter(Boolean);
  if (ladder.length > 1) return chooser(root, ladder, config);
  return run(root, ladder[0], config);
}

/** The front door: pick a rung. Practice rungs say what they are. */
function chooser(root, ladder, config) {
  const api = {};
  const paint = () => {
    root.innerHTML = `
      <div class="tm-pick">
        <div>
          <h1>La fábrica de software</h1>
          <p>Una semana. La máquina trabaja 168 horas; tú tienes 40 y decides para qué son.
             Empieza por la prueba: el bucle se entiende mirándolo una vez.</p>
          <ul>${ladder.map((sc, i) => {
            const n = (sc.backlog || []).length;
            return `<li data-i="${i}" class="${sc.practice ? 'practice' : ''}">
              <b>${esc(sc.name?.es || sc.id)}</b>
              <span>${n} tarea${n === 1 ? '' : 's'}${sc.practice ? ' · no se puntúa, no se envía nada' : ' · cuenta'}</span>
            </li>`;
          }).join('')}</ul>
          <p class="tm-foot">Puedes repetir las pruebas las veces que quieras. La ronda que cuenta se juega una vez.</p>
        </div>
      </div>`;
    for (const li of root.querySelectorAll('.tm-pick li')) {
      li.addEventListener('click', () => {
        const sc = ladder[Number(li.dataset.i)];
        const inner = run(root, sc, { ...config, ladder, onDone: next(sc) });
        Object.assign(api, inner);
      });
    }
  };
  /** After a practice round, offer the next rung instead of a dead end. */
  const next = (sc) => () => {
    const i = ladder.indexOf(sc);
    const after = ladder[i + 1];
    if (!after) return null;
    return { label: `Siguiente: ${after.name?.es || after.id} ▸`, go: () => {
      const inner = run(root, after, { ...config, ladder, onDone: next(after) });
      Object.assign(api, inner);
    } };
  };
  paint();
  return api;
}

function run(root, rawScenario, config = {}) {
  const scenario = loadScenario(rawScenario, config.lang || 'es');
  const seed = config.seed != null ? config.seed : seedFromString(config.candidate || uid());
  const runId = config.runId || uid();

  // A rehearsal sends nothing. Not "sends it and we ignore it" — nothing
  // leaves the browser, which is the only version of that promise worth making.
  const scored = !scenario.practice;
  const telemetry = new Telemetry({
    runId, sessionId: config.sessionId || uid(), candidate: config.candidate || null,
    seed, scenario: scenario.id,
    sink: config.endpoint && scored ? bufferedSink(endpointSink(config.endpoint)) : () => {},
  });
  const sim = new Simulation({ scenario, seed, telemetry }).start();

  const ui = {
    speed: 1, paused: true, drag: null, open: null, painting: null,
    selected: null, flash: null, flashAt: 0, simTime: 0, lastFrame: 0,
    tab: 'cards', scroll: 0,
    // Sim minutes per real second at 1x. The week is meant to be watched in
    // half a minute, not sat through: you run it, you see what came out.
    ratio: config.ratio || scenario.realTimeRatio || 400,
  };

  root.innerHTML = shell(scenario.practice);
  ui.tab = 'queues';
  const canvas = root.querySelector('canvas');
  const els = {
    target: root.querySelector('#tm-target'),
    text: root.querySelector('#tm-text'),
    ask: root.querySelector('#tm-ask'),
    note: root.querySelector('#tm-note'),
    hint: root.querySelector('#tm-hint'),
  };
  const prov = watchInput(els.text);

  const board = new Board(canvas);
  ui.lastRound = lastRoundNote(scenario.id);

  const ctx = {
    sim, ui, board,
    act(action, params = {}, meta = {}) {
      const r = sim.dispatch(action, params, meta);
      if (r && r.ok === false) flash(errorText(r));
      board.requestDraw();
      return r;
    },
    seal() {
      const s = sim.state();
      const cut = s.items.filter((i) => i.dropped).map((i) => i.id);
      const r = ctx.act('seal_plan', {
        cut, order: [], placements: [],
        assumptions: ui.assumptions || [],
        notes: `pruebas ${s.policy.tests} · despliegue ${s.policy.deploy} · ${sheetLine(s)} · ${s.flagged.length} marcadas`,
      });
      if (r.ok) { ui.paused = false; ui.lastFrame = 0; requestAnimationFrame(frame); }
    },
    cut(id) {
      const reason = prompt('¿Por qué lo dejas fuera?') ?? '';
      ctx.act('drop', { id, reason });
    },
    setAttention(blocks) {
      const r = sim.dispatch('set_attention', { blocks });
      if (!r.ok) flash(r.error === 'over_budget' ? `Te pasas por ${Math.round(r.over / 60)} h. Quita un bloque antes de poner otro.` : errorText(r));
      board.requestDraw();
      return r;
    },
    setSpeed(n) { ui.speed = n; sim.log('ui_speed', { speed: n }); },
    /** Run what is left of the week now, without watching it. */
    runToEnd() {
      sim.log('ui_run_to_end', { from: sim.clock.now });
      ui.paused = true;
      ui.simTime = sim.horizon;
      sim.advanceTo(sim.horizon);
      endRun('horizon');
    },
    togglePause() {
      ui.paused = !ui.paused; ui.lastFrame = 0;
      sim.log(ui.paused ? 'ui_pause' : 'ui_resume', {});
      if (!ui.paused) requestAnimationFrame(frame);
    },
    finish() { endRun('player'); },
  };

  function flash(msg) { ui.flash = msg; ui.flashAt = Date.now(); }
  function errorText(r) {
    const map = {
      over_budget: 'No te quedan horas que colocar.', wip_limit: 'Llegaste a tu límite de trabajo en curso.',
      not_coded: 'Todavía no está programado.', not_built: 'Ese build no quedó en verde.',
      blocked_by: `Falta que pase por pruebas ${(r.ids || []).join(', ')}.`,
      plan_phase: 'Eso es para cuando empiece la semana.', no_items: 'No hay nada seleccionado.',
      already_coded: 'Ya se programó.', already_spec: 'Ya tiene especificación.',
      no_attention: 'Coloca al menos un bloque de tu tiempo.',
    };
    return map[r.error] || r.error;
  }

  // --------------------------------------------------------------- text bar

  function submitText(kind) {
    const value = els.text.value.trim();
    if (!value) return;
    const provenance = prov.take(value);
    const id = els.target.value || null;
    if (kind === 'ask') {
      const r = ctx.act('ask', { id, text: value, provenance });
      if (r?.answer) { els.hint.textContent = r.answer; els.hint.className = 'tm-hint answer'; }
    } else {
      ctx.act('note', { id, text: value, provenance });
      els.hint.textContent = 'Anotado.';
      els.hint.className = 'tm-hint';
    }
    els.text.value = '';
  }
  els.ask.addEventListener('click', () => submitText('ask'));
  els.note.addEventListener('click', () => submitText('note'));
  els.text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) submitText('note');
  });

  function refreshTargets() {
    const s = sim.state();
    const live = s.items.filter((i) => !i.dropped && i.stage !== 'done');
    const sig = live.map((i) => i.id).join(',');
    if (els.target.dataset.sig === sig) return;
    const current = els.target.value;
    els.target.dataset.sig = sig;
    els.target.innerHTML = '<option value="">— sin tarjeta —</option>' +
      live.map((i) => `<option value="${i.id}">${i.id}</option>`).join('');
    if (current) els.target.value = current;
  }

  // ------------------------------------------------------------------ frame

  function frame(now) {
    if (sim.finished) return;
    if (sim.phase === 'play' && !ui.paused) {
      if (ui.lastFrame) {
        const dt = Math.min(1.5, (now - ui.lastFrame) / 1000);
        ui.simTime += dt * ui.ratio * ui.speed;
        sim.advanceTo(ui.simTime);
        if (sim.clock.now >= sim.horizon) return endRun('horizon');
      }
      ui.lastFrame = now;
    }
    if (ui.flash && Date.now() - ui.flashAt > 6000) ui.flash = null;
    refreshTargets();
    draw();
    requestAnimationFrame(frame);
  }

  function draw() {
    board.begin();
    const phone = board.mode === 'phone';
    if (sim.phase === 'plan') (phone ? drawPlanPhone : drawPlan)(board, ctx);
    else (phone ? drawPlayPhone : drawPlay)(board, ctx);
  }

  function endRun(reason) {
    sim.finish(reason);
    rememberRound(sim);
    draw();
    const over = root.querySelector('#tm-over');
    over.hidden = false;
    root.querySelector('#tm-over-body').textContent = summary(sim);
    root.querySelector('#tm-over-plan').innerHTML = sentNotice(sim) + planVsReality(sim) + reportHtml(sim);
    // A practice round has nothing to send and no score to defend: what it owes
    // the player is the next rung, not a form.
    const onwards = config.onDone?.() || null;
    if (onwards) {
      const wrap = root.querySelector('#tm-retro-wrap');
      const btn = document.createElement('button');
      btn.id = 'tm-next';
      btn.textContent = onwards.label;
      btn.addEventListener('click', () => onwards.go());
      wrap.parentNode.appendChild(btn);
    }
    if (!scored) {
      const wrap = root.querySelector('#tm-retro-wrap');
      wrap.hidden = true;
    }
    const box = root.querySelector('#tm-retro');
    const retroProv = watchInput(box);
    if (scored) box.focus();
    if (scored) root.querySelector('#tm-retro-send').addEventListener('click', () => {
      const value = box.value.trim();
      if (!value) return;
      sim.dispatch('retro', { text: value, provenance: retroProv.take(value) });
      root.querySelector('#tm-retro-wrap').innerHTML =
        '<p class="tm-done">Enviado. Es lo que vamos a leer primero.</p>';
    });
  }

  board.onPointer = () => board.requestDraw();
  document.addEventListener('visibilitychange', () => sim.log(document.hidden ? 'ui_blur' : 'ui_focus', {}));
  window.addEventListener('beforeunload', () => telemetry.flush('unload'));
  new ResizeObserver(() => { board.resize(); draw(); }).observe(canvas);

  draw();
  requestAnimationFrame(frame);

  const api = { sim, telemetry, ui, ctx, board, draw, endRun };
  if (new URLSearchParams(location.search).get('dev') === '1') window.tmSim = api;
  return api;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ROUNDS_KEY = 'tm.sim.rounds';

/** The assignment sheet in one sentence, for the sealed plan. */
function sheetLine(s) {
  const say = (who) => (who === 'ia' ? 'agente' : who === 'humano' ? 'yo' : `${Math.round(Number(who) * 100)}%`);
  return Object.entries(s.stages || {}).map(([k, v]) => `${k}=${say(v)}`).join(' ');
}

/**
 * What the last round taught you about how long things take.
 *
 * Estimates are the one thing that does carry from twelve tasks to fifty: you
 * cannot know the multiplier in advance, but after a week of it you can. This
 * is that statistic, kept on the player's own machine and shown back to them
 * on the planning screen of the next round.
 */
function pastRounds() {
  try { return JSON.parse(localStorage.getItem(ROUNDS_KEY) || '[]'); } catch { return []; }
}

function rememberRound(sim) {
  try {
    const r = sim.report();
    const rounds = pastRounds().filter((x) => x.scenario !== r.meta.scenario);
    rounds.push({
      scenario: r.meta.scenario, at: Date.now(),
      cards: r.estimates.cards, factor: r.estimates.factor, over: r.estimates.over,
      shipped: r.score.shipped, clean: r.score.clean_shipped,
      backlog: sim.items.filter((i) => !i.dropped).length,
      hours: Math.round(r.score.human_minutes / 60),
    });
    localStorage.setItem(ROUNDS_KEY, JSON.stringify(rounds.slice(-6)));
  } catch { /* a browser with storage off just loses the memory */ }
}

/** One line for the planner: the last round, in the terms that transfer. */
function lastRoundNote(scenarioId) {
  const prev = pastRounds().filter((r) => r.scenario !== scenarioId).sort((a, b) => b.at - a.at)[0];
  if (!prev || !prev.factor) return null;
  return `La ronda pasada (${prev.backlog} tareas): lo estimado se quedó corto ×${prev.factor.toFixed(2)}` +
    `${prev.over ? `, ${prev.over} tarjeta(s) se fueron muy por encima` : ''} · entregaste ${prev.clean}/${prev.shipped} limpias en ${prev.hours} h.`;
}

/**
 * The week, written out. Everything decided, run, shipped, broken and still
 * owed — which is the thing that actually gets read afterwards.
 */
const STAGE_ES = {
  backlog: 'sin empezar', requirements: 'requisitos', design: 'diseño',
  planning: 'el agente escribiendo el plan', plan_review: 'esperando a que leas el plan',
  code: 'programando', building: 'construyendo', verify: 'pruebas automáticas', review: 'revisión',
  output_review: 'esperando a que leas la entrega', testing: 'esperando pruebas manuales tuyas',
  build: 'build', shipping: 'desplegando', deploy: 'desplegado', announce: 'sin comunicar',
};

function reportHtml(sim) {
  const r = sim.report();
  const day = (e) => `<tr><td>${e.day + 1}</td><td>${e.decisions}</td><td>${e.shipped || '—'}</td>` +
    `<td>${Math.round(e.your_minutes)}′</td><td>${e.open_incidents || '—'}</td>` +
    `<td class="tm-hl">${esc(e.highlights.slice(0, 3).join(' · ')) || '—'}</td></tr>`;
  const ship = (i) => `<tr><td><b>${i.id}</b> ${esc(i.title)}</td><td>${i.tests}</td>` +
    `<td>${i.deploy || '—'}</td><td>${i.announced || 'a nadie'}</td>` +
    `<td>${i.value}${i.late ? ' <span class="tm-late">tarde</span>' : ''}</td></tr>`;
  const fire = (i) => `<tr><td>${i.severity.toUpperCase()}</td><td>${esc(i.title)}</td>` +
    `<td>${i.source === 'legacy' ? 'heredado' : i.source === 'deploy_early' ? 'al desplegar' : 'en producción'}</td>` +
    `<td>${i.choice || 'sin tocar'}${i.breached ? ' <span class="tm-late">fuera de margen</span>' : ''}</td></tr>`;

  const sheet = (l) => `<tr><td>${esc(l.label)}</td>` +
    `<td>${l.who === 'ia' ? 'un agente' : l.who === 'humano' ? 'tú, a mano' : `tú, el ${Math.round(l.human_share * 100)}%`}</td>` +
    `<td>${Math.round(l.human_share * 100)}% tuyo</td>` +
    `<td>${l.canary ? '<span class="tm-late">indelegable, delegado</span>' : l.delegable ? '' : 'sólo humano'}</td></tr>`;
  const pend = (i) => `<tr><td><b>${i.id}</b> ${esc(i.title)}</td><td>${esc(STAGE_ES[i.stage] || i.stage)}</td>` +
    `<td>${i.impact}</td><td>${i.waited_h} h esperando</td></tr>`;
  const est = r.estimates;
  const slip = (w) => `<tr><td><b>${w.id}</b> ${esc(w.title)}</td><td>${w.est_h} h</td><td>${w.real_h} h</td><td>×${w.factor}</td></tr>`;
  const dec = (d) => `<tr><td>${esc(d.at)}</td><td>${esc(d.action)}</td><td>${esc(d.item || '—')}</td>` +
    `<td>${esc(d.detail || '')}</td><td>${esc(d.result || '')}</td></tr>`;

  return `
    <h3>Quién hizo cada cosa</h3>
    <table class="tm-rep"><thead><tr><th>etapa</th><th>quién</th><th>parte tuya</th><th></th></tr></thead>
      <tbody>${r.sheet.map(sheet).join('')}</tbody></table>

    <h3>Lo que dijeron que tardaría, y lo que tardó</h3>
    ${est.factor
      ? `<p class="tm-spill">Sobre ${est.cards} tarjetas empezadas: <b>${est.estimated_h} h</b> estimadas,
           <b>${est.real_h} h</b> reales — <b>×${est.factor}</b>. ${est.over} se fueron más de un 25% por encima.
           Esa cifra es la que sirve para planificar la ronda siguiente.</p>
         ${est.worst.length ? `<table class="tm-rep"><thead><tr><th>la que peor se estimó</th><th>dicho</th><th>real</th><th></th></tr></thead>
           <tbody>${est.worst.map(slip).join('')}</tbody></table>` : ''}`
      : '<p class="tm-none">No llegó a arrancar nada como para medirlo.</p>'}

    <h3>La semana, día a día</h3>
    <table class="tm-rep"><thead><tr><th>día</th><th>decisiones</th><th>entregado</th><th>tuyo</th><th>fuegos</th><th>lo que pasó</th></tr></thead>
      <tbody>${r.epochs.map(day).join('')}</tbody></table>

    <h3>Lo que salió (${r.shipped.length})</h3>
    ${r.shipped.length
      ? `<table class="tm-rep"><thead><tr><th>tarjeta</th><th>pruebas</th><th>despliegue</th><th>comunicado</th><th>valor</th></tr></thead>
         <tbody>${r.shipped.map(ship).join('')}</tbody></table>`
      : '<p class="tm-none">Nada llegó a producción anunciado.</p>'}

    <h3>Lo que se rompió (${r.incidents.length})</h3>
    ${r.incidents.length
      ? `<table class="tm-rep"><thead><tr><th></th><th>qué</th><th>de dónde</th><th>qué hiciste</th></tr></thead>
         <tbody>${r.incidents.map(fire).join('')}</tbody></table>`
      : '<p class="tm-none">Ninguno.</p>'}

    <h3>Lo que quedó a medias (${r.unfinished.length})</h3>
    ${r.unfinished.length
      ? `<table class="tm-rep"><thead><tr><th>tarjeta</th><th>dónde se paró</th><th>impacto</th><th></th></tr></thead>
         <tbody>${r.unfinished.map(pend).join('')}</tbody></table>`
      : '<p class="tm-none">Nada quedó a medias.</p>'}

    <h3>Lo que ni se empezó (${r.untouched.length})</h3>
    ${r.untouched.length
      ? `<p class="tm-none">${r.untouched.map((i) => `<b>${i.id}</b> ${esc(i.title)}`).join(' · ')}</p>`
      : '<p class="tm-none">Todo entró en la máquina.</p>'}

    <h3>Lo que decidiste (${r.decided})</h3>
    ${r.ledger.length
      ? `<table class="tm-rep"><thead><tr><th>cuándo</th><th>qué</th><th>sobre</th><th>detalle</th><th>respuesta</th></tr></thead>
         <tbody>${r.ledger.map(dec).join('')}</tbody></table>`
      : '<p class="tm-none">Ninguna.</p>'}

    <h3>Lo que se sale de la semana</h3>
    <p class="tm-spill"><b>${r.spillover.hours} h</b> de trabajo que la semana no contenía:
      ${r.spillover.open_incidents} incidente(s) sin cerrar, ${r.spillover.live_defects} defecto(s)
      todavía vivos en producción y ${r.spillover.unfinished} tarjeta(s) a medias.
      Eso lo arregla alguien, y no dentro de lo acordado.</p>`;
}

/**
 * What already left, and when. The report and the sealed plan travel together
 * the instant the week closes — nothing waits for the player to write anything.
 * Whatever they add afterwards is a second, separate envelope, and saying so
 * plainly is the difference between a form and a black box.
 */
function sentNotice(sim) {
  if (!sim.telemetry?.sink || sim.practice) {
    return '<p class="tm-seal">Modo práctica: esto no se envía ni se puntúa.</p>';
  }
  const at = new Date(sim.sentAt || Date.now()).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  return `<p class="tm-sent">Informe y plan sellado enviados a las ${at}. Lo que escribas abajo va en un segundo envío.</p>`;
}

/** Their sealed plan, next to what the week actually did with it. */
function planVsReality(sim) {
  const plan = sim.plan;
  const s = sim.score();
  if (!plan) return '';
  const rows = [
    ['tu plan', `${plan.placements.length} tarjetas colocadas · ${plan.cut.length} fuera · ${Math.round(plan.attention.placed / 60)} h tuyas`],
    ['lo que pasó', `${s.shipped} entregadas · ${s.clean_shipped} sin incidentes${s.late ? ` · ${s.late} tras la demo` : ''}`],
    ['la máquina', `${Math.round(s.blocked_wait / 60)} h esperando a que la mirases · ${s.blocked_jobs + s.hard_stops} agentes parados`],
    ['de noche', `${Math.round(s.night_minutes / 60)} h tuyas fuera de hora`],
  ];
  return `<div class="tm-cmp">${rows.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')}</div>
    <p class="tm-seal">plan sellado <code>${plan.hash}</code></p>`;
}

function summary(sim) {
  const s = sim.score();
  return [
    `valor que se quedó ${s.clean_value}`,
    `entregados ${s.clean_shipped}/${s.shipped}${s.late ? ` (${s.late} tras la demo)` : ''}`,
    `defectos en producción ${s.escaped_defects}`,
    `agentes parados ${s.blocked_jobs + s.hard_stops} · máquina esperándote ${Math.round(s.blocked_wait / 60)} h`,
    `fuegos ${s.incidents} (${s.sla_breaches} fuera de margen) · hotfix ${s.hotfixes} · vuelta atrás ${s.rollbacks}`,
    `tokens ${(s.tokens_spent / 1000).toFixed(0)}k · tus horas ${Math.round(s.human_minutes / 60)}`,
  ].join(' · ');
}

function shell(practice) {
  return `
  <div class="tm-wrap">
    ${practice ? '<div class="tm-practice">Modo prueba · no se puntúa y no se envía nada</div>' : ''}
    <canvas id="tm-canvas"></canvas>
    <div class="tm-bar">
      <select id="tm-target" title="tarjeta"></select>
      <input id="tm-text" placeholder="Pregunta a producto, o deja un supuesto por escrito" autocomplete="off" />
      <button id="tm-ask">Preguntar</button>
      <button id="tm-note">Anotar</button>
      <span id="tm-hint" class="tm-hint"></span>
    </div>
    <p class="tm-disclosure">
      Esto registra lo que haces: cada decisión, cuándo la tomas, cuánto tardas en decidirla, y si el texto
      de estas cajas se escribe o se pega. No lee tu pantalla, tu portapapeles ni otras pestañas.
      El código es público y puedes abrirlo; si lo haces, cuéntanoslo, no resta.
    </p>
    <div id="tm-over" class="tm-over" hidden>
      <div>
        <h2>Se acabó la semana</h2>
        <p id="tm-over-body"></p>
        <div id="tm-over-plan"></div>
        <div id="tm-retro-wrap">
          <label for="tm-retro">Comentarios finales. Con esto delante: <b>¿qué cambiarías del plan que cerraste el lunes?</b></label>
          <textarea id="tm-retro" rows="3" placeholder="Un cambio concreto vale más que diez generales."></textarea>
          <button id="tm-retro-send">Enviar comentarios finales</button>
        </div>
      </div>
    </div>
  </div>`;
}

export { mount, pastRounds, lastRoundNote };

