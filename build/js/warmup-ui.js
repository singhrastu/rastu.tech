/* The warm-up planner: the view.
 *
 * All of the arithmetic lives in warmup.js, which has no DOM and no network and
 * is covered by build/parity-warmup.mjs. This file collects the inputs, renders
 * the plan, and hands the check-in its findings.
 *
 * The plan is shown one row per stage rather than one row per day. A careful
 * plan runs sixty days across twenty stages, and sixty rows of which three are
 * identical is harder to read than twenty rows that say which days they cover.
 * It is also how the platforms print their own tables.
 */
import { plan, checkIn, PACES, PROVIDERS, DEFAULT_MIX, THRESHOLDS }
  from './warmup.js';
import { planPdf } from './warmup-pdf.js';
import { finding, renderFindings, findingsText, esc } from './findings.js';

const form = document.getElementById('wu-form');
const out = document.getElementById('wu-out');
const ciForm = document.getElementById('wu-ci');
const ciOut = document.getElementById('wu-ci-out');
const ciPanel = document.getElementById('wu-ci-panel');
const mixRow = document.getElementById('wu-mix');
const paceNote = document.getElementById('wu-pace-note');
const mixNote = document.getElementById('wu-mix-note');
const countWrap = document.getElementById('wu-count-wrap');
const pdfBtn = document.getElementById('wu-pdf');

/* The last plan built, so the check-in below can answer against it rather than
   against a schedule the reader has to describe again. */
let current = null;

const text = (id) => {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
};

const num = (id) => {
  const el = document.getElementById(id);
  if (!el) return null;
  const raw = String(el.value || '').replace(/[,\s]/g, '');
  if (raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};

/* A chip group behaves like a radio set, except for the signals group where
   more than one thing can be true at once. */
function group(id, multi) {
  const root = document.getElementById(id);
  if (!root) return { value: () => (multi ? [] : ''), on: () => {} };
  const btns = [...root.querySelectorAll('button')];
  const api = {
    value: () => (multi
      ? btns.filter(b => b.classList.contains('on')).map(b => b.dataset.v)
      : (btns.find(b => b.classList.contains('on')) || btns[0]).dataset.v),
    on: (fn) => btns.forEach(b => b.addEventListener('click', () => {
      if (multi) b.classList.toggle('on');
      else btns.forEach(x => x.classList.toggle('on', x === b));
      btns.forEach(x => x.setAttribute('aria-pressed',
        x.classList.contains('on') ? 'true' : 'false'));
      if (fn) fn(b.dataset.v);
    })),
  };
  btns.forEach(b => {
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
  });
  return api;
}

const level = group('wu-level');
const traffic = group('wu-traffic');
const pace = group('wu-pace');
const rep = group('wu-rep');
const signals = group('wu-signals', true);

function buildMix() {
  if (!mixRow) return;
  mixRow.innerHTML = PROVIDERS.map(p => `
    <div style="flex:1 1 7rem">
      <label class="lbl-mi" for="wu-mix-${p.key}">${esc(p.name)}</label>
      <input class="field" id="wu-mix-${p.key}" type="text" inputmode="numeric"
             spellcheck="false" autocomplete="off" value="${DEFAULT_MIX[p.key]}">
    </div>`).join('');
  mixRow.addEventListener('input', showMixTotal);
  showMixTotal();
}

function readMix() {
  const m = {};
  for (const p of PROVIDERS) m[p.key] = Math.max(0, num('wu-mix-' + p.key) || 0);
  return m;
}

function showMixTotal() {
  if (!mixNote) return;
  const m = readMix();
  const sum = PROVIDERS.reduce((a, p) => a + m[p.key], 0);
  mixNote.textContent = sum === 100
    ? 'These are used to split each day across the providers you send to.'
    : `These add up to ${sum}. They do not have to reach 100: the split uses `
      + `their proportions either way.`;
}

function showPaceNote(v) {
  if (!paceNote) return;
  const p = PACES[v || pace.value()];
  if (!p) { paceNote.textContent = ''; return; }
  paceNote.textContent = `${p.shape} ${p.note}`;
}

function showLevel(v) {
  // Addresses only mean something for an address or pool. For a domain there is
  // nothing to divide, and for mailboxes the field counts inboxes instead.
  const lvl = v || level.value();
  if (!countWrap) return;
  const label = countWrap.querySelector('label');
  if (lvl === 'domain') {
    countWrap.style.display = 'none';
  } else {
    countWrap.style.display = '';
    if (label) label.textContent = lvl === 'mailbox' ? 'Mailboxes' : 'Addresses';
  }
}

/* ------------------------------------------------------------- rendering */

const fmt = (n) => Number(n).toLocaleString('en-US');

/* Days collapse into the stages they belong to, so a stage that holds one
   volume for three days is one row that says so. */
function stages(p) {
  const rows = [];
  for (const d of p.days) {
    const last = rows[rows.length - 1];
    if (last && last.total === d.total && last.stage === d.stage) {
      last.to = d.day;
    } else {
      rows.push({ from: d.day, to: d.day, ...d });
    }
  }
  return rows;
}

function planTable(p) {
  const keys = PROVIDERS.filter(x => (p.mix[x.key] || 0) > 0);
  const showPerIp = p.level === 'ip' && p.ips > 1;
  const rows = stages(p);

  return `<div class="scroll-x" tabindex="0" role="region"
       aria-label="Warm-up schedule">
    <table class="bl">
      <thead><tr>
        <th>Days</th><th>A day</th>
        ${keys.map(k => `<th>${esc(k.name)}</th>`).join('')}
        ${showPerIp ? '<th>Per address</th>' : ''}
        <th>Gmail an hour</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${r.from === r.to ? r.from : `${r.from} to ${r.to}`}</td>
        <td><b>${fmt(r.total)}</b></td>
        ${keys.map(k => `<td>${fmt(r.perProvider[k.key] || 0)}</td>`).join('')}
        ${showPerIp ? `<td>${fmt(r.perIp)}</td>` : ''}
        <td>${fmt(r.hourly.gmail || 0)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function gateBlock(p) {
  const blind = p.days.filter(d => d.gate.blind).length;
  return `<div class="grp">
    <h3>What has to hold before each step</h3>
    <ul>
      <li class="s-warn">Gmail and Yahoo reported spam both under
        <b>0.3%</b>, each measured against its own source.</li>
      <li class="s-warn">Hard bounces under <b>2%</b>. A sending platform will
        usually act on this before any provider does.</li>
      <li class="s-warn">No new 4xx deferrals from a provider you are ramping.
        Microsoft returns 421 RP-001 to RP-003 for exactly this.</li>
      ${blind ? `<li class="s-info">For roughly the first ${blind}
        ${blind === 1 ? 'day' : 'days'} the provider dashboards will show little
        or nothing, because neither Google nor Yahoo reports at low volume and
        neither publishes the volume where reporting starts. Until then your own
        SMTP responses are the only signal.</li>` : ''}
    </ul>
  </div>`;
}

function renderPlan(p) {
  const s = p.summary;
  const warn = p.warnings.map(w => `<div class="warnbox s-${w.severity === 'warn'
    ? 'warn' : 'info'}"><p>${esc(w.text)}</p></div>`).join('');

  out.className = 'report on';
  out.innerHTML = `
    <div class="head"><h2 tabindex="-1">${esc(p.pace.name)} ramp to
      ${fmt(p.target)} a day</h2></div>
    <p class="verdict-line s-ok"><span class="pill">${s.days} days</span>
      ${p.level === 'mailbox'
        ? `${fmt(p.mailboxes)} ${p.mailboxes === 1 ? 'mailbox' : 'mailboxes'} at
           ${fmt(p.perBox)} a day each by day ${s.days}.`
        : `Reaches ${fmt(p.target)} a day on day ${s.reachesTargetOnDay || s.days}.`}</p>

    <div class="tiles">
      <div class="t"><b>${s.days}</b><span>days</span></div>
      <div class="t"><b>${fmt(s.firstDay)}</b><span>on day one</span></div>
      <div class="t"><b>${fmt(s.finalDay)}</b><span>at the end</span></div>
      <div class="t"><b>${fmt(s.totalMessages)}</b><span>sent getting there</span></div>
    </div>

    ${warn}
    ${planTable(p)}
    ${gateBlock(p)}

    <div class="grp">
      <h3>What this plan assumes</h3>
      <ul>${p.assumptions.map(a => `<li class="s-info">${esc(a)}</li>`).join('')}
        <li class="s-info">${esc(p.pace.shape)} The volumes are a route to the
          target. What decides whether you keep them is the set of figures
          above.</li>
      </ul>
    </div>

    <div class="row-2">
      <span></span>
      <div class="actions">
        <button class="btn ghost sm" type="button" id="wu-copy">Copy the plan</button>
      </div>
    </div>`;

  const copyBtn = document.getElementById('wu-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => copy(copyBtn, planText(p)));
  out.querySelector('h2')?.focus();
}

function planText(p) {
  const keys = PROVIDERS.filter(x => (p.mix[x.key] || 0) > 0);
  const head = ['Days', 'A day', ...keys.map(k => k.name)].join('\t');
  const body = stages(p).map(r => [
    r.from === r.to ? r.from : `${r.from}-${r.to}`,
    r.total, ...keys.map(k => r.perProvider[k.key] || 0),
  ].join('\t')).join('\n');
  return `Warm-up plan: ${p.pace.name} ramp to ${fmt(p.target)} a day\n\n`
    + `${head}\n${body}\n\n`
    + `Before each step: Gmail and Yahoo spam under 0.3%, hard bounces under 2%, `
    + `no new deferrals.\nhttps://rastu.tech/warmup/\n`;
}

/* The file is built here and handed over as a download. A blob link is the only
   route available: the page is served under a policy that allows scripts and
   images from this origin only, so there is nothing to render a preview into and
   nothing to fetch a template from. The object URL is released straight after,
   because the bytes stay in memory until it is.

   The date is read here rather than inside the writer, which has no clock so
   that its output is reproducible from a test. */
function download(p) {
  let url = null;
  try {
    const bytes = planPdf(p, {
      brand: text('wu-brand'),
      domain: text('wu-domain'),
      date: new Date().toLocaleDateString('en-GB',
        { day: 'numeric', month: 'long', year: 'numeric' }),
    });
    const name = ['warmup', text('wu-domain').replace(/[^a-z0-9.-]/gi, ''),
                  String(p.target)].filter(Boolean).join('-') + '.pdf';
    url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    pdfBtn.textContent = 'Could not build the file';
    setTimeout(() => { pdfBtn.textContent = 'Download the PDF'; }, 2400);
    return;
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

async function copy(btn, text) {
  const was = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Blocked';
  }
  setTimeout(() => { btn.textContent = was; }, 1600);
}

/* ------------------------------------------------------------- check-in */

function renderCheckIn(r, p) {
  const fs = r.findings.map(f => finding(f));
  const act = { advance: 'ok', hold: 'warn', rollback: 'critical', stop: 'critical' };
  const label = { advance: 'Advance', hold: 'Hold', rollback: 'Roll back',
                  stop: 'Stop' };

  ciOut.className = 'report on';
  ciOut.innerHTML = `
    <div class="head"><h2 tabindex="-1">Day ${r.day} of ${p.days.length}</h2></div>
    <p class="verdict-line s-${act[r.decision] === 'critical' ? 'fail'
      : act[r.decision]}">
      <span class="pill">${label[r.decision]}</span> ${esc(r.next.text)}</p>
    ${renderFindings(fs, { noun: 'problem',
      emptyText: 'Nothing you reported is near a published limit.' })}
    ${r.derived ? `<div class="warnbox s-info"><p>No platform publishes how far
      to go back after a bad day, so the rollback above is worked out here rather
      than taken from a vendor document: return to the last stage at or below
      half the volume that caused it, hold three days, and resume at the careful
      pace. ${esc(THRESHOLDS.gmail.recovery)}</p></div>` : ''}
    <div class="row-2">
      <span></span>
      <div class="actions">
        <button class="btn ghost sm" type="button" id="wu-ci-copy">Copy</button>
      </div>
    </div>`;

  const b = document.getElementById('wu-ci-copy');
  if (b) {
    b.addEventListener('click', () => copy(b,
      findingsText(fs, `Warm-up check-in, day ${r.day}: ${label[r.decision]}. `
        + `${r.next.text}`) + '\nhttps://rastu.tech/warmup/\n'));
  }
  ciOut.querySelector('h2')?.focus();
}

/* ----------------------------------------------------------------- wiring */

function build(ev) {
  if (ev) ev.preventDefault();
  const target = num('wu-target');
  if (!target || target < 1) {
    out.className = 'report on';
    out.innerHTML = '<p class="empty">Put in the volume you want to reach, as '
      + 'messages a day.</p>';
    return;
  }
  try {
    current = plan({
      level: level.value(),
      traffic: traffic.value(),
      pace: pace.value(),
      target,
      mix: readMix(),
      ips: num('wu-count') || 1,
      mailboxes: num('wu-count') || 1,
      sendWindow: num('wu-window') || 12,
    });
  } catch (e) {
    out.className = 'report on';
    out.innerHTML = `<p class="empty">${esc(e.message || String(e))}</p>`;
    return;
  }
  renderPlan(current);
  if (pdfBtn) pdfBtn.disabled = false;
  if (ciPanel) ciPanel.classList.remove('hidden');
  const day = document.getElementById('wu-day');
  if (day) day.setAttribute('max', String(current.days.length));
}

function stand(ev) {
  if (ev) ev.preventDefault();
  if (!current) {
    ciOut.className = 'report on';
    ciOut.innerHTML = '<p class="empty">Build a plan above first, so there is a '
      + 'schedule to answer against.</p>';
    return;
  }
  const sig = signals.value();
  renderCheckIn(checkIn(current, {
    day: num('wu-day') || 1,
    gmailComplaint: num('wu-gc'),
    yahooComplaint: num('wu-yc'),
    bounce: num('wu-b'),
    reputation: rep.value(),
    deferrals: sig.includes('deferrals'),
    blocked: sig.includes('blocked'),
  }), current);
}

function main() {
  buildMix();
  showPaceNote();
  showLevel();
  level.on(showLevel);
  traffic.on();
  pace.on(showPaceNote);
  rep.on();
  signals.on();
  form.addEventListener('submit', build);
  if (pdfBtn) pdfBtn.addEventListener('click', () => { if (current) download(current); });
  if (ciForm) ciForm.addEventListener('submit', stand);
  build();
}

/* Last, deliberately. Everything above is declared before the entry point runs,
   because main() builds a plan straight away and anything that path reaches has
   to exist by then. */
if (form) main();
