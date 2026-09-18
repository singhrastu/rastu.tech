/* Header analyser: the view.
 *
 * Findings first, evidence second. The reason someone pastes a header block is
 * that something went wrong and they need to know whether it is theirs to fix,
 * so the answer to that goes at the top and the raw material goes underneath it.
 */
import { analyse } from './headers.js';
import { renderFindings, findingsText, esc } from './findings.js';

const form = document.getElementById('hdr-form');
const input = document.getElementById('hdr-in');
const boundaryIn = document.getElementById('hdr-boundary');
const out = document.getElementById('hdr-out');

let last = null;

function main() {
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const raw = input.value;
    if (!raw.trim()) {
      say('Paste a header block into the box first. In Gmail it is under the three '
        + 'dots, "Show original"; in Outlook, File then Properties.');
      input.focus();
      return;
    }
    if (raw.length > 2_000_000) {
      say('That is over two megabytes. Header blocks are kilobytes, so this is almost '
        + 'certainly a whole mailbox export. Paste one message.');
      return;
    }
    run(raw);
  });

  document.getElementById('hdr-clear')?.addEventListener('click', () => {
    input.value = '';
    boundaryIn.value = '';
    out.className = 'report';
    out.innerHTML = '';
    input.focus();
  });

  out.addEventListener('click', ev => {
    if (ev.target.id === 'hdr-copy' && last) {
      copy(findingsText(last.findings,
        `Header analysis${last.subject ? ': ' + last.subject : ''}`)
        + '\nhttps://rastu.tech/headers/', ev.target);
    }
    const t = ev.target.closest('[data-toggle]');
    if (t) {
      const el = document.getElementById(t.getAttribute('data-toggle'));
      if (el) {
        const open = el.classList.toggle('open');
        t.textContent = open ? 'Hide raw' : 'Show raw';
      }
    }
  });
}

const say = (html) => {
  out.className = 'report on';
  out.innerHTML = `<p class="empty">${html}</p>`;
};

/* The clipboard is absent on insecure origins and can be refused outright. */
function copy(text, btn) {
  const done = (label) => {
    btn.textContent = label;
    setTimeout(() => { btn.textContent = 'Copy findings'; }, 1800);
  };
  if (!navigator.clipboard || !navigator.clipboard.writeText) return done('Unavailable');
  navigator.clipboard.writeText(text).then(() => done('Copied'), () => done('Blocked'));
}

function run(raw) {
  out.className = 'report on';
  try {
    last = analyse(raw, { now: Date.now(), boundary: boundaryIn.value.trim() || null });
  } catch (e) {
    return say(`<strong>Could not read that.</strong> ${esc(e.message)}`);
  }
  render(last);
  out.querySelector('h2')?.focus();
}

function dur(s) {
  if (s === null) return '<span class="muted" title="One of the two timestamps has no usable timezone">&mdash;</span>';
  if (s < 0) return `<span class="skew">clock skew</span>`;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const RESULT_SEV = {
  pass: 'ok', fail: 'critical', softfail: 'warn', neutral: 'info', none: 'info',
  permerror: 'critical', temperror: 'warn', policy: 'warn', bestguesspass: 'info',
};

/** The alignment arithmetic, shown as arithmetic. This is the part no other tool
 *  does for an arbitrary pasted message. */
function alignmentPanel(o) {
  if (!o.determinable) {
    return `<div class="align"><h3>DMARC</h3><p class="empty">${esc(o.reason)}</p></div>`;
  }
  const rows = o.steps.map(s => `
    <tr class="${s.aligned === true ? 's-ok' : s.aligned === null ? 's-info' : 's-critical'}">
      <td><strong>${esc(s.mech)}</strong></td>
      <td><span class="pill">${esc(s.result)}</span></td>
      <td><code>${esc(s.authDomain || '—')}</code></td>
      <td class="op">vs</td>
      <td><code>${esc(s.fromDomain)}</code></td>
      <td><code>${s.mech === 'SPF' ? 'aspf' : 'adkim'}=${esc(s.mode)}</code></td>
      <td>${s.aligned === true ? 'aligns'
          : s.aligned === null ? 'undetermined' : 'does not align'}</td>
    </tr>`).join('');

  return `
    <div class="align">
      <h3>How a receiver worked this out</h3>
      <div class="scroll-x" tabindex="0" role="region" aria-label="Alignment arithmetic">
        <table class="arith">
          <thead><tr><th>Mechanism</th><th>Result</th><th>Authenticated</th><th></th>
            <th>From: domain</th><th>Mode</th><th>Alignment</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="note">DMARC passes if <strong>either</strong> mechanism aligns. SPF
      authenticates the envelope sender, so it is the Return-Path domain that has to
      match, not the address the recipient sees.</p>
      <div class="dispo">
        ${['none', 'quarantine', 'reject'].map(p => `
          <div class="${o.pass ? 's-ok' : p === 'none' ? 's-warn' : 's-critical'}">
            <b>p=${p}</b><span>${esc(o.disposition[p])}</span></div>`).join('')}
      </div>
    </div>`;
}

function authPanel(f) {
  if (!f.authResults.length) return '';
  const boundaryAt = f.boundary
    ? f.authResults.findIndex(a => a.authserv
        && a.authserv.toLowerCase() === String(f.boundary).toLowerCase())
    : -1;

  const blocks = f.authResults.map((ar, i) => {
    const trusted = i === boundaryAt;
    const belowBoundary = boundaryAt >= 0 && i > boundaryAt;
    const rows = ar.methods.map(m => {
      const sev = RESULT_SEV[m.result] || 'info';
      const props = Object.entries(m.props)
        .map(([k, v]) => `<code>${esc(k)}=${esc(v)}</code>`).join(' ');
      return `<li class="s-${sev}"><span class="pill">${esc(m.result)}</span>
        <strong>${esc(m.method)}</strong> ${props}</li>`;
    }).join('');
    return `<div class="ar${trusted ? ' trusted' : ''}${belowBoundary ? ' untrusted' : ''}">
      <h4><code>${esc(ar.authserv || '?')}</code>
        ${trusted ? '<span class="badge ok">your boundary</span>' : ''}
        ${belowBoundary ? '<span class="badge warn">below your boundary, so forgeable</span>'
          : ''}</h4>
      <ul>${rows || '<li class="muted">no methods parsed</li>'}</ul></div>`;
  }).join('');

  return `<div class="sechead"><h3>What the receivers recorded</h3></div>${blocks}`;
}

function render(a) {
  const hops = a.received.map((r, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td>${r.by ? `<code>${esc(r.by)}</code>` : '<span class="muted">unknown</span>'}
        ${r.ip ? `<span class="ip">${esc(r.ip)}</span>` : ''}
        ${i === 0 && r.from
          ? `<span class="warnnote">claims to be ${esc(r.from)}, which is whatever
             the connecting client said in EHLO</span>` : ''}</td>
      <td>${r.proto ? `<code>${esc(r.proto)}</code>` : '<span class="muted">&mdash;</span>'}
        ${r.tls === true ? '<span class="tls">TLS</span>' : ''}
        ${r.tls === false ? '<span class="cleartext">cleartext</span>' : ''}
        ${r.authenticated ? '<span class="tls">auth</span>' : ''}</td>
      <td class="num">${dur(r.delayKnown ? r.delaySec : null)}</td>
    </tr>`).join('');

  out.className = 'report on';
  out.innerHTML = `
    <div class="head">
      <h2 tabindex="-1">${esc(a.subject || '(no subject)')}</h2>
      <button type="button" id="hdr-copy" class="btn ghost sm">Copy findings</button>
    </div>

    <table class="kv"><tbody>
      ${a.from ? `<tr><th>From</th><td>${esc(a.from)}</td></tr>` : ''}
      ${a.returnPath ? `<tr><th>Return-Path</th><td>${esc(a.returnPath)}
        ${a.envelopeDomain && a.fromDomain && a.envelopeDomain !== a.fromDomain
          ? '<span class="warnnote">a different domain from From:, which is what SPF '
            + 'alignment turns on</span>' : ''}</td></tr>` : ''}
      ${a.date.raw ? `<tr><th>Date</th><td>${esc(a.date.raw)}</td></tr>` : ''}
      ${a.messageId ? `<tr><th>Message-ID</th><td><code>${esc(a.messageId)}</code></td></tr>` : ''}
    </tbody></table>

    ${renderFindings(a.findings, { noun: 'issue', showOk: true,
        emptyText: 'Nothing here needs fixing.' })}

    ${alignmentPanel(a.outcome)}
    ${authPanel(a)}

    <div class="sechead"><h3>The path, oldest hop first</h3></div>
    ${a.received.length ? `
      <div class="scroll-x" tabindex="0" role="region" aria-label="Delivery path">
        <table class="hops">
          <thead><tr><th class="num">#</th><th>Received by</th><th>Protocol</th>
            <th class="num">Waited</th></tr></thead>
          <tbody>${hops}</tbody>
        </table>
      </div>
      <p class="note">Each hop stamps its own clock and those clocks are not
      synchronised, so a gap is an estimate and a negative one is skew rather than time
      travel. Where a timestamp carries no usable timezone the gap is left blank instead
      of guessed. The first hop's claimed name is whatever the connecting client said in
      its EHLO, which is to say: whatever it wanted to say.</p>
      <p><button type="button" class="btn ghost sm" data-toggle="hdr-raw">Show raw</button></p>
      <pre id="hdr-raw" class="rawhops">${a.received.map((r, i) =>
        `${i + 1}. ${esc(r.raw)}`).join('\n\n')}</pre>`
      : '<p class="empty">No Received headers in what you pasted. Those are what record '
        + 'the path, so nothing here can say how the message travelled. They are usually '
        + 'at the top of the block.</p>'}`;
}

if (form && input && out && boundaryIn) main();
