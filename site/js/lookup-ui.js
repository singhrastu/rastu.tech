/* The SMTP response lookup: the view.
 *
 * One box. Paste a whole log line, type a code, type three digits of one, or
 * type what it said. The answer appears as you type, because the thing somebody
 * wants at three in the morning is the verdict, not a search results page.
 */
import { buildIndex, search, verdictFor } from './lookup.js';
import { esc } from './findings.js';

const box = document.getElementById('lk-q');
const out = document.getElementById('lk-out');
const browse = document.getElementById('lk-browse');
const count = document.getElementById('lk-count');

/* Codes with a written page, injected by the build so the lookup can link to
   the deep version where one exists. */
const PAGES = (() => {
  try { return JSON.parse(document.getElementById('lk-pages').textContent); }
  catch { return {}; }
})();

let index = null;
let debounce = null;

const ACTION_SEV = {
  deliver: 'ok', retry: 'info', throttle: 'warn',
  review: 'warn', fix_config: 'warn', suppress: 'critical', pause: 'critical',
};
const ACTION_WHAT = {
  deliver: 'Accepted. Nothing to do.',
  retry: 'Retry on the normal schedule.',
  throttle: 'Slow down for this provider, then retry.',
  review: 'Change the message, not the rate.',
  fix_config: 'A configuration problem. Retrying will not help.',
  suppress: 'Remove the address. Retrying costs reputation.',
  pause: 'Stop sending here and fix the cause first.',
};

async function boot() {
  if (!box || !out) return;
  box.disabled = true;
  box.placeholder = 'Loading the registry...';
  try {
    const reg = await (await fetch('/registry.json')).json();
    index = buildIndex(reg);
    if (count) count.textContent = `${index.length} responses`;
  } catch (e) {
    out.className = 'report on';
    out.innerHTML = '<p class="empty">The response registry could not be loaded, so '
      + 'the lookup is unavailable. The pages below still work.</p>';
    return;
  }
  box.disabled = false;
  box.placeholder = 'Paste a bounce, or type a code: 5.7.1, 550, 512, mailbox full';
  box.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 120);
  });
  box.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { box.value = ''; run(); }
  });
  // The examples are the fastest way to show what "any part of it" means.
  for (const b of document.querySelectorAll('[data-lk]')) {
    b.addEventListener('click', () => {
      box.value = b.getAttribute('data-lk');
      run();
      box.focus();
    });
  }
  const q = new URLSearchParams(location.search).get('q');
  if (q) { box.value = q; run(); }
  else box.focus();
}

function pageFor(code) {
  return PAGES[code] || null;
}

function entry(m, lead) {
  const sev = ACTION_SEV[m.action] || 'info';
  const page = pageFor(m.code);
  const cls = m.cls === '2' ? 'Accepted' : m.cls === '4' ? 'Temporary'
    : m.cls === '5' ? 'Permanent' : 'Intermediate';

  return `<article class="lk ${lead ? 'lead' : ''} s-${sev}">
    <header>
      <code class="c">${esc(m.code)}</code>
      <span class="cls">${cls}</span>
      ${m.provider ? `<span class="prov">${esc(m.provider)}</span>` : ''}
      ${m.why === 'range' ? '<span class="prov">matched inside this range</span>' : ''}
      <span class="act">${esc((m.action || '').replace('_', ' '))}</span>
    </header>
    <h3>${esc(m.title || '(no description published)')}</h3>
    ${lead ? `<p class="does">${esc(ACTION_WHAT[m.action] || '')}</p>` : ''}
    ${m.note ? `<p class="d">${esc(m.note)}</p>` : ''}
    ${lead && m.body ? `<p class="d dim">${esc(m.body)}</p>` : ''}
    <p class="src">
      ${page ? `<a href="${esc(page)}">Read the full page</a> &middot; ` : ''}
      ${m.kind === 'enhanced' && m.specific === false
        ? '<span title="The action follows from the class and subject of this code. '
          + 'I have not worked this specific failure myself, so treat it as a safe '
          + 'default rather than a tested one.">action derived from '
          + 'its class</span> &middot; '
        : ''}
      <span class="from">${esc(m.source || '')}</span>
    </p>
  </article>`;
}

function run() {
  const q = box.value;
  if (!q.trim()) {
    out.className = 'report';
    out.innerHTML = '';
    if (browse) browse.classList.remove('hidden');
    history.replaceState(null, '', location.pathname);
    return;
  }
  if (browse) browse.classList.add('hidden');

  const res = search(index, q);
  history.replaceState(null, '', '?q=' + encodeURIComponent(q));

  if (!res.matches.length) {
    out.className = 'report on';
    out.innerHTML = `<p class="empty"><strong>No match for that.</strong> The registry
      covers the RFC 5321 reply codes, the IANA enhanced status codes and Microsoft's
      own, which is most of what a mail log will show you. A provider's private code
      or a free-text refusal will not be here.</p>`;
    return;
  }

  const [lead, ...rest] = res.matches;
  const v = verdictFor(lead);
  const extracted = res.codes.enhanced.concat(res.codes.basic);

  out.className = 'report on';
  out.innerHTML = `
    ${res.kind === 'pasted' && extracted.length
      ? `<p class="lk-read">Read <code>${extracted.map(esc).join('</code> and <code>')}</code>
         out of what you pasted.</p>` : ''}
    ${entry(lead, true)}
    ${rest.length ? `<div class="lk-more">
      <h4>${rest.length} other ${rest.length === 1 ? 'entry' : 'entries'} matched</h4>
      ${rest.slice(0, 40).map(m => entry(m, false)).join('')}
      ${rest.length > 40 ? `<p class="note">and ${rest.length - 40} more. Narrow the
        query to see them.</p>` : ''}
    </div>` : ''}`;
}

boot();
