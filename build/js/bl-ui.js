/* The blocklist check: the view.
 *
 * The result that matters most here is the one the tool refuses to give. A list
 * that failed its own RFC 5782 probe gets a row saying so and no verdict about
 * the address, because a dead list reports everyone as clean and a refusing one
 * reports everyone as listed.
 */
import { check, checkDomain, classify, LISTS, DOMAIN_LISTS } from './bl.js';
import { resolver } from './doh.js';
import { esc } from './findings.js';

/* Declared before main() runs, not after. main() is called at module load and a
   ?q= deep link dispatches a submit synchronously inside it, so a binding this
   path touches must already exist. Declaring it lower down is a temporal dead
   zone error that only appears on the deep link, never on a typed check. */
let widgetId = null;
let settle = null;

const form = document.getElementById('bl-form');
const input = document.getElementById('bl-in');
const out = document.getElementById('bl-out');
const runBtn = document.getElementById('bl-run');

/* "Clean" is a claim about every list. What this can honestly say is that the
   lists which answered did not list you, and while Spamhaus cannot be reached
   from a browser that is a narrower thing. */
const PILL = {
  listed: 'listed',
  'not-listed': 'not listed',
  partial: 'partly checked',
  none: 'no result',
};

const STATE_LABEL = {
  unconfigured: 'not checked',
  throttled: 'refused, not asked',
  silent: 'not answering',
  refusing: 'refusing this resolver',
  inverted: 'return codes do not match the spec',
  unreachable: 'lookup did not complete',
};

/* Turnstile, rendered once and reset thereafter.
 *
 * The widget owns its container. Calling render() on an element that already
 * holds one is invalid, and doing it on every check produced "Verification
 * failed" on the second and every check after it. reset() is the supported way
 * to ask for a fresh token, and it fires the same callback again.
 *
 * There is no promise-returning accessor in the API either: getResponse()
 * returns undefined until the widget has solved, which for a check fired
 * straight after page load is most of the time. So the callback is captured and
 * a promise is resolved from it.
 *
 * Invisible unless Cloudflare decides a person needs to do something. If it is
 * not configured, or it fails, the check still runs and the Spamhaus row reports
 * that it was refused rather than pretending the subject was clean.
 */
function challengeToken() {
  const el = document.getElementById('bl-turnstile');
  if (!el || !window.turnstile) return Promise.resolve('');
  const sitekey = el.getAttribute('data-sitekey');
  if (!sitekey) return Promise.resolve('');

  return new Promise((resolve) => {
    let done = false;
    const finish = (t) => { if (!done) { done = true; settle = null; resolve(t || ''); } };
    settle = finish;
    // A challenge that never comes back must not hold the whole check open.
    setTimeout(() => finish(''), 12000);

    try {
      if (widgetId === null) {
        widgetId = window.turnstile.render(el, {
          sitekey,
          action: 'blocklist',
          appearance: 'interaction-only',
          callback: (t) => { if (settle) settle(t); },
          'error-callback': () => { if (settle) settle(''); },
          'timeout-callback': () => { if (settle) settle(''); },
          'expired-callback': () => { if (settle) settle(''); },
        });
      } else {
        // A token is spent once, so every later check needs a fresh one. reset()
        // re-runs the challenge and calls the same callback again.
        window.turnstile.reset(widgetId);
      }
    } catch {
      finish('');
    }
  });
}

function main() {
  let running = false;
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (running) return;
    const raw = input.value.trim();
    if (!raw) return;
    const what = classify(raw);
    if (what.kind === 'bad') {
      out.className = 'report on';
      out.innerHTML = `<p class="note"><strong>That is neither an address nor a
        domain.</strong> Paste an IPv4 address such as <code>203.0.113.9</code> to
        check a sending host, or a domain such as <code>example.com</code> to check
        the domain itself.</p>`;
      return;
    }
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = 'Checking...';
    out.className = 'report on';
    const corpus = what.kind === 'domain' ? DOMAIN_LISTS : LISTS;
    out.innerHTML = `<p class="note">Checking
      <code>${esc(what.value || raw)}</code>.</p>`;
    try {
      const r = resolver();
      // Never throws: a failed lookup is null, which the checker treats as
      // "could not determine" rather than as an answer.
      const lookup = async (name) => {
        try { return await r.a(name); } catch { return null; }
      };
      // An address goes to the address lists and a domain to the domain lists.
      // They are different corpora answering different questions: an address is
      // listed because a host sent spam, a domain because it appeared in some.
      /* Spamhaus goes through the Worker, which holds a Data Query Service key
         as a secret. Returns the string 'unconfigured' when there is no key, so
         the row reports that rather than pretending the list was clean. */
      // One token per check: each can only be spent once, and all three queries
      // in a check go out together.
      const token = await challengeToken();
      /* One request per check, carrying the token once, and returning both
         probes and the subject together. */
      const dqs = async (q, zone) => {
        try {
          const r = await fetch('/api/dnsbl?q=' + encodeURIComponent(q)
            + '&zone=' + encodeURIComponent(zone)
            + (token ? '&t=' + encodeURIComponent(token) : ''));
          const d = await r.json().catch(() => null);
          if (!r.ok) return d && d.error ? 'blocked:' + d.error : null;
          if (d.configured === false) return 'unconfigured';
          return d.ok ? { up: d.up, down: d.down, answers: d.answers } : null;
        } catch { return null; }
      };
      render(what.kind === 'domain'
        ? await checkDomain(what.value, lookup, undefined, dqs,
                            (d) => r.existence(d))
        : await check(raw, lookup, undefined, dqs), what);
      history.replaceState(null, '', '?q=' + encodeURIComponent(raw));
    } catch (e) {
      out.innerHTML = `<p class="note"><strong>No result.</strong> ${esc(e.message || e)}</p>`;
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Check';
    }
  });

  const params = new URLSearchParams(location.search);
  const q = params.get('q') || params.get('ip');
  if (q) { input.value = q; form.dispatchEvent(new Event('submit')); }
}

function row(r) {
  const state = r.state;
  const cls = state === 'listed' ? 's-critical'
    : state === 'clean' ? 's-ok' : 's-warn';
  const needsWhy = state === 'undetermined' || state === 'not-checked';
  const verdict = state === 'listed'
    ? `<strong>listed</strong> <code>${r.codes.map(esc).join(' ')}</code>`
    : state === 'clean' ? 'not listed'
      : state === 'not-checked' ? '<span class="undet">not checked</span>'
        : `<span class="undet">could not determine</span>`;
  return `<tr class="${cls}">
    <td><strong>${esc(r.name)}</strong><span class="zone">${esc(r.zone)}</span></td>
    <td>${verdict}</td>
    <td class="why">${r.meanings && r.meanings.length
      ? r.meanings.map(m => `<strong>${esc(m.label)}.</strong> ${esc(m.detail)}`).join(' ')
      : needsWhy
      ? `<strong>${esc(STATE_LABEL[r.canary.state] || r.canary.state)}.</strong>
         ${esc(r.canary.why)}`
        : esc(r.note)}</td>
    <td>${state === 'listed' || state === 'not-checked'
      ? `<a href="${esc(r.delist)}">${state === 'listed' ? 'Delist' : 'Check there'}</a>`
      : '<span class="muted">&mdash;</span>'}</td>
  </tr>`;
}

function render(res, what) {
  const isDomain = res.kind === 'domain';
  if (!res.supported) {
    out.innerHTML = `<div class="head"><h2>${esc(res.ip || 'No address')}</h2></div>
      <p class="verdict-line s-info"><span class="pill">not checked</span>
      ${esc(res.reason)}</p>`;
    return;
  }
  const v = res.verdict;
  out.innerHTML = `
    <div class="head"><h2 tabindex="-1">${esc(res.ip)}</h2></div>
    <p class="verdict-line s-${v.severity === 'critical' ? 'fail' : v.severity}">
      <span class="pill">${PILL[v.state] || 'no result'}</span> ${esc(v.text)}</p>
    ${res.undetermined.length ? `<p class="note">Some lists could not be confirmed
      as working on this run. They are marked below, and nothing they returned is
      counted in the result above.</p>` : ''}
    <div class="scroll-x" tabindex="0" role="region" aria-label="Blocklist results">
      <table class="bl">
        <thead><tr><th>List</th><th>Result</th><th>What it means</th><th></th></tr></thead>
        <tbody>${res.rows.map(row).join('')}</tbody>
      </table>
    </div>
    ${isDomain ? `<p class="note">Domain lists answer a different question from
      address lists: a domain is listed because it turned up in spam, usually as a
      link, not because a particular machine sent it. The reputation of the address
      you send from is separate, and checking it means pasting the address.</p>` : ''}
    ${res.missing.length ? `<div class="warnbox s-info">
      <p><strong>${esc(res.missing.map(m => m.name).join(' and '))} could not be
      checked here.</strong> It is not included in the result above.</p>
      <p><a href="${esc(res.missing[0].delist)}">Check it directly at
      Spamhaus</a>.</p>
    </div>` : ''}`;
  out.querySelector('h2')?.focus();
}

/* Last, deliberately. Everything above is declared before the entry point
   runs, so a path that fires synchronously during start up, such as a deep
   link dispatching a submit, cannot reach a binding that does not exist yet. */
if (form) main();
