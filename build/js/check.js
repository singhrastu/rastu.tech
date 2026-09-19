/* The domain auditor's user interface. All of the logic lives in audit.js, which
   is verified against the Python package at build time by build/parity.mjs. */
import { audit, looksLikeDomain } from './audit.js';
import { resolver, policyFetcher } from './doh.js';

const form = document.getElementById('check-form');
const input = document.getElementById('check-domain');
const out = document.getElementById('check-out');
const runBtn = document.getElementById('check-run');

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const ORDER = { fail: 0, warn: 1, info: 2, ok: 3 };
const LABEL = { fail: 'fail', warn: 'warn', info: 'info', ok: 'ok' };
const CHECK_ORDER = ['BULK-SENDER', 'SPF', 'DKIM', 'DMARC', 'MTA-STS', 'TLS-RPT', 'BIMI', 'MX'];

function main() {
  let running = false;

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (running) return;
    // One gate, shared with the SPF counter, so both refuse the same things and
    // say the same thing about why. A dot test alone let an IP address and a
    // string with spaces through to DNS.
    const v = looksLikeDomain(input.value);
    if (!v.ok) {
      out.innerHTML = `<p class="note">${esc(v.reason)}</p>`;
      out.className = 'report on';
      return;
    }
    const domain = v.domain;

    running = true;
    runBtn.disabled = true;
    runBtn.textContent = 'Checking...';
    out.className = 'report on';
    out.innerHTML = `<p class="note">Resolving <code>${esc(domain)}</code>. `
      + `DKIM alone probes 22 selectors, so give it a moment.</p>`;

    try {
      const rep = await audit(domain, resolver(), policyFetcher(''));
      render(domain, rep);
      history.replaceState(null, '', '?d=' + encodeURIComponent(domain));
    } catch (e) {
      // A DNS transport failure is not a finding. Reporting it as one would mean
      // telling someone their SPF is missing when their network blocked the lookup.
      out.innerHTML = `<p class="note"><strong>No result.</strong> ${esc(e.message || e)}`
        + (e.name === 'DnsUnavailable'
            ? ` A corporate network, VPN or ad blocker intercepting DNS lookups is
               the usual cause. Nothing above should be read as a verdict on this
               domain.`
            : '') + `</p>`;
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Check';
    }
  });

  const pre = new URLSearchParams(location.search).get('d');
  if (pre) { input.value = pre; form.requestSubmit(); }
}

function render(domain, rep) {
  const c = rep.counts();
  const verdict = rep.findings.find(f => f.check === 'BULK-SENDER');

  const tiles = ['fail', 'warn', 'info', 'ok'].map(s =>
    `<div class="t s-${s}"><b>${c[s]}</b><span>${LABEL[s]}</span></div>`).join('');

  const groups = [...new Set(rep.findings.map(f => f.check))]
    .sort((a, b) => {
      const ia = CHECK_ORDER.indexOf(a), ib = CHECK_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  const body = groups.map(g => {
    const rows = rep.findings.filter(f => f.check === g)
      .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
      .map(f => `<li class="s-${f.severity}">
          <span class="pill">${LABEL[f.severity]}</span>
          <span class="f">${esc(f.finding)}</span>
          ${f.remediation ? `<span class="rem">${esc(f.remediation)}</span>` : ''}
          ${f.detail ? `<code class="det">${esc(f.detail)}</code>` : ''}
        </li>`).join('');
    return `<section class="grp"><h3>${esc(g)}</h3><ul>${rows}</ul></section>`;
  }).join('');

  out.innerHTML = `
    <div class="head">
      <h2>${esc(domain)}</h2>
      <button type="button" id="copy-report" class="btn ghost sm">Copy as text</button>
    </div>
    ${verdict ? `<p class="verdict-line s-${verdict.severity}">
       <span class="pill">${LABEL[verdict.severity]}</span> ${esc(verdict.finding)}</p>` : ''}
    <div class="tiles">${tiles}</div>
    ${body}
    <p class="note">Checked from your browser. The domain you typed was never sent
    to this site. DKIM is reported as inconclusive rather
    than absent when no key is found: selectors are arbitrary strings chosen by
    the sender, so probing a list of common ones proves nothing either way.</p>`;

  document.getElementById('copy-report').addEventListener('click', ev => {
    const text = [`${domain} - email authentication audit`, ''].concat(
      rep.findings
        .slice()
        .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.check.localeCompare(b.check))
        .map(f => `[${f.severity.toUpperCase().padEnd(4)}] ${f.check}: ${f.finding}`
          + (f.remediation ? `\n         ${f.remediation}` : ''))
    ).concat(['', 'https://rastu.tech/check/ - github.com/singhrastu/dmarcsight']).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      ev.target.textContent = 'Copied';
      setTimeout(() => { ev.target.textContent = 'Copy as text'; }, 1600);
    });
  });
}

/* Last, deliberately. Everything above is declared before the entry point
   runs, so a path that fires synchronously during start up, such as a deep
   link dispatching a submit, cannot reach a binding that does not exist yet. */
if (form && input && out) main();
