/* Header analyser: the view.
 *
 * The design problem is not extraction, it is confidence. Almost every field here
 * can be forged by whoever sent the message, and the parts that cannot be are
 * only the hops above the recipient's own boundary. So everything renders with a
 * trust level attached, and the things this cannot know are said out loud rather
 * than quietly omitted.
 */
import { analyse } from './headers.js';

const form = document.getElementById('hdr-form');
const input = document.getElementById('hdr-in');
const boundaryIn = document.getElementById('hdr-boundary');
const out = document.getElementById('hdr-out');
if (form && input && out) main();

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const RESULT_SEV = {
  pass: 'ok', fail: 'fail', softfail: 'warn', neutral: 'info', none: 'info',
  permerror: 'fail', temperror: 'warn', policy: 'warn', bestguesspass: 'info',
};

function dur(s) {
  if (s === null) return '<span class="muted">&mdash;</span>';
  if (s < 0) return `<span class="skew">clock skew ${Math.abs(s)}s</span>`;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function main() {
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const raw = input.value;
    if (!raw.trim()) return;
    out.className = 'report on';
    try {
      render(analyse(raw, { now: Date.now(), boundary: boundaryIn.value.trim() || null }));
    } catch (e) {
      out.innerHTML = `<p class="note"><strong>Could not read that.</strong> ${esc(e.message)}</p>`;
    }
  });
  document.getElementById('hdr-clear')?.addEventListener('click', () => {
    input.value = ''; out.className = 'report'; out.innerHTML = '';
  });
}

function render(a) {
  const hops = a.received.map((r, i) => {
    const first = i === 0;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td>${r.by ? `<code>${esc(r.by)}</code>` : '<span class="muted">unknown</span>'}
        ${r.ip ? `<span class="ip">${esc(r.ip)}</span>` : ''}
        ${first && r.from ? `<span class="warnnote">claims to be ${esc(r.from)}</span>` : ''}</td>
      <td>${r.proto ? `<code>${esc(r.proto)}</code>` : '<span class="muted">&mdash;</span>'}
        ${r.tls ? '<span class="tls">TLS</span>' : ''}</td>
      <td class="num">${r.delayKnown ? dur(r.delaySec)
        : '<span class="muted" title="One of the timestamps has no usable timezone">&mdash;</span>'}</td>
      <td class="raw"><code>${esc(r.raw.slice(0, 180))}${r.raw.length > 180 ? '...' : ''}</code></td>
    </tr>`;
  }).join('');

  const authBlocks = a.authResults.map((ar, i) => {
    const trusted = a.boundary && ar.authserv
      && ar.authserv.toLowerCase().includes(a.boundary.toLowerCase());
    const rows = ar.methods.map(m => {
      const sev = RESULT_SEV[m.result] || 'info';
      const props = Object.entries(m.props)
        .map(([k, v]) => `<code>${esc(k)}=${esc(v)}</code>`).join(' ');
      return `<li class="s-${sev}"><span class="pill">${esc(m.result)}</span>
        <strong>${esc(m.method)}</strong> ${props}</li>`;
    }).join('');
    return `<div class="ar${trusted ? ' trusted' : ''}">
      <h4><code>${esc(ar.authserv || '?')}</code>
        ${trusted ? '<span class="badge">your boundary</span>'
          : i === 0 ? '<span class="badge">topmost</span>' : ''}</h4>
      <ul>${rows || '<li class="muted">no methods parsed</li>'}</ul></div>`;
  }).join('');

  const dkimBlocks = a.dkim.map(d => `
    <div class="sig">
      <h4><code>d=${esc(d.tags.d || '?')}</code> <code>s=${esc(d.tags.s || '?')}</code>
        <code>a=${esc(d.tags.a || '?')}</code></h4>
      ${d.notes.map(([sev, txt]) =>
        `<p class="s-${sev}"><span class="pill">${sev}</span> ${esc(txt)}</p>`).join('')
        || '<p class="muted">Nothing structurally wrong with this signature.</p>'}
    </div>`).join('');

  const unknownTz = a.received.filter(r => r.date.ts && !r.date.offsetKnown).length;

  out.innerHTML = `
    <div class="head"><h2>${esc(a.subject || '(no subject)')}</h2></div>
    <table class="kv"><tbody>
      ${a.from ? `<tr><th>From</th><td>${esc(a.from)}</td></tr>` : ''}
      ${a.to ? `<tr><th>To</th><td>${esc(a.to)}</td></tr>` : ''}
      ${a.returnPath ? `<tr><th>Return-Path</th><td>${esc(a.returnPath)}
        ${a.envelopeDomain && a.fromDomain && a.envelopeDomain !== a.fromDomain
          ? `<span class="warnnote">differs from the From: domain, which is what SPF
             alignment turns on</span>` : ''}</td></tr>` : ''}
      ${a.date.raw ? `<tr><th>Date</th><td>${esc(a.date.raw)}</td></tr>` : ''}
      ${a.messageId ? `<tr><th>Message-ID</th><td><code>${esc(a.messageId)}</code></td></tr>` : ''}
      ${a.listUnsubscribe ? `<tr><th>List-Unsubscribe</th><td><code>${esc(a.listUnsubscribe)}</code>
        ${a.listUnsubscribePost ? '<span class="tls">one-click</span>'
          : '<span class="warnnote">no List-Unsubscribe-Post, so this is not one-click and does not meet the bulk sender requirement</span>'}</td></tr>` : ''}
    </tbody></table>

    <h3>Authentication</h3>
    ${authBlocks || '<p class="empty">No Authentication-Results header. Either the '
      + 'receiver does not stamp one, or it was not included in what you pasted.</p>'}
    <p class="note"><strong>Which of these can you trust?</strong> Authentication-Results
    headers are plain text and trivially forged. Only the one written by your own inbound
    boundary means anything, and from a pasted block there is no way to work out which
    that is. ${a.boundary ? `You named <code>${esc(a.boundary)}</code>, which is marked
    above.` : 'Name your inbound gateway above and it will be marked.'}</p>

    ${a.receivedSpf.length ? `<h3>Received-SPF</h3>
      ${a.receivedSpf.map(v => `<code class="det">${esc(v)}</code>`).join('')}` : ''}

    ${a.dkim.length ? `<h3>DKIM signatures</h3>${dkimBlocks}
      <p class="note">This reads what each signature <em>claims</em>. Verifying one needs
      the canonicalised message body, which is not in a header paste, so nothing here
      tells you whether a signature actually holds.</p>` : ''}

    ${a.arc.count ? `<h3>ARC chain</h3>
      <p>${a.arc.count} instance${a.arc.count === 1 ? '' : 's'}.
      ${a.arc.problems.length ? '' : 'Structurally intact.'}</p>
      ${a.arc.problems.map(p => `<p class="s-warn"><span class="pill">warn</span> ${esc(p)}</p>`).join('')}
      <p class="note">Structure only. Validating an ARC chain cryptographically is not
      possible from headers alone.</p>` : ''}

    <h3>Path, oldest first</h3>
    <div class="scroll-x"><table class="hops">
      <thead><tr><th class="num">#</th><th>Received by</th><th>Protocol</th>
        <th class="num">Delay</th><th>Raw</th></tr></thead>
      <tbody>${hops}</tbody></table></div>
    ${a.slowest ? `<p class="note">Slowest hop: ${dur(a.slowest.delaySec)} into
      <code>${esc(a.slowest.by || '?')}</code>.</p>` : ''}
    <p class="note"><strong>On the timings.</strong> Each hop stamps its own clock and
    those clocks are not synchronised, so a delay is an estimate and a negative one is
    skew rather than time travel. ${unknownTz ? `${unknownTz} timestamp${unknownTz === 1
      ? ' has' : 's have'} no usable timezone, so the delays across
      ${unknownTz === 1 ? 'it' : 'them'} are not shown at all rather than guessed.` : ''}
    The <code>from</code> name on the first hop is whatever the connecting client said in
    its EHLO, which is to say: whatever it wanted to say.</p>`;
}
