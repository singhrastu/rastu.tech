/* The RFC lookup: the view.
 *
 * One box. Type a number you were handed, a name you half remember, or the
 * thing you are trying to do. The number you were handed is often the wrong
 * one, which is the case this is built around.
 */
import { buildIndex, search, statusNote, warningsFor } from './rfc.js';
import { esc } from './findings.js';

const box = document.getElementById('rfc-q');
const out = document.getElementById('rfc-out');
const browse = document.getElementById('rfc-browse');

let index = null;
let aliases = {};
let debounce = null;

async function boot() {
  if (!box || !out) return;
  box.disabled = true;
  box.placeholder = 'Loading the index...';
  try {
    const data = await (await fetch('/rfcs.json')).json();
    index = buildIndex(data);
    aliases = data.aliases || {};
  } catch {
    out.className = 'report on';
    out.innerHTML = '<p class="empty">The index could not be loaded, so the lookup '
      + 'is unavailable. The list below still works.</p>';
    return;
  }
  box.disabled = false;
  box.placeholder = 'A number, a name, or what you are trying to do: 5321, DKIM, MTA-STS';
  box.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 120);
  });
  box.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { box.value = ''; run(); }
  });
  for (const b of document.querySelectorAll('[data-rfc]')) {
    b.addEventListener('click', () => {
      box.value = b.getAttribute('data-rfc');
      run();
      box.focus();
    });
  }
  const q = new URLSearchParams(location.search).get('q');
  if (q) { box.value = q; run(); }
  else box.focus();
}

function card(e, lead) {
  const s = statusNote(e.status);
  const warn = lead ? warningsFor(e) : [];
  const n = e.counts.must + e.counts.should + e.counts.may;

  return `<article class="rfc ${lead ? 'lead' : ''}">
    <header>
      <code class="c">RFC ${e.num}</code>
      <span class="st st-${s.kind}">${esc(s.label)}</span>
      <span class="cat">${esc(e.category)}</span>
      <span class="yr">${esc(e.published)}</span>
    </header>
    <h3><a href="/rfc/${e.num}/">${esc(e.title)}</a></h3>
    ${warn.map(w => `<p class="warn-line">
      <strong>${esc(w.title)}</strong> ${esc(w.detail)}
      ${w.refs.length ? w.refs.map(r =>
        `<a href="/rfc/${String(r).replace(/\D/g, '')}/">${esc(r.replace('RFC', 'RFC '))}</a>`)
        .join(' ') : ''}</p>`).join('')}
    ${lead && e.abstract ? `<p class="d">${esc(trim(e.abstract, 340))}</p>` : ''}
    <p class="src">
      ${n ? `<a href="/rfc/${e.num}/">${n} normative requirement${n === 1 ? '' : 's'}</a>
         <span class="lv">${e.counts.must} must, ${e.counts.should} should,
         ${e.counts.may} may</span> &middot; ` : ''}
      <a href="https://www.rfc-editor.org/rfc/rfc${e.num}.html">Read the RFC</a>
    </p>
  </article>`;
}

function trim(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const stop = cut.lastIndexOf('. ');
  return stop > n * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd() + '...';
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

  const res = search(index, aliases, q);
  history.replaceState(null, '', '?q=' + encodeURIComponent(q));

  if (!res.matches.length && !res.redirect) {
    out.className = 'report on';
    out.innerHTML = `<p class="empty"><strong>Nothing matches that.</strong> This
      index covers the email RFCs that are current: transport, message format,
      authentication, transport security, internationalization, submission,
      reporting and anti-abuse. An RFC from another area will not be here.</p>`;
    return;
  }

  const r = res.redirect;
  out.className = 'report on';
  out.innerHTML = `
    ${r ? redirectBanner(r) : ''}
    ${res.matches.map((m, i) => card(m, i === 0)).join('')}`;
}

/* The answer somebody needs when they have been handed a dead number, which is
   most of the reason this page exists. */
function redirectBanner(r) {
  if (!r.now.length) {
    return `<div class="redirect s-warn">
      <p><strong>RFC ${r.num} is not current.</strong> ${esc(r.title)},
      ${esc(r.status.toLowerCase())}, published ${esc(r.published)}.</p>
      <p>${esc(r.note || 'It has been withdrawn.')}</p>
    </div>`;
  }
  const list = r.now.map(n => `<a href="/rfc/${n}/">RFC ${n}</a>`).join(', ');
  return `<div class="redirect s-warn">
    <p><strong>RFC ${r.num} has been replaced.</strong> ${esc(r.title)} was
    published ${esc(r.published)} and is no longer the document to read.</p>
    <p>Read ${list} instead${r.now.length > 1
      ? '. It was replaced by more than one document, and all of them apply'
      : ''}.</p>
  </div>`;
}

boot();
