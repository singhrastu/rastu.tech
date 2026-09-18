/* SPF lookup counter. Logic lives in audit.js so this page and the domain check
   can never disagree about a count; this module is the view only. */
import { spfTree } from './audit.js';
import { resolver } from './doh.js';

const form = document.getElementById('spf-form');
const input = document.getElementById('spf-domain');
const out = document.getElementById('spf-out');
const runBtn = document.getElementById('spf-run');
if (form && input && out) main();

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function main() {
  let running = false;
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (running) return;
    const domain = input.value.trim();
    if (!domain || !domain.includes('.')) {
      out.className = 'report on';
      out.innerHTML = '<p class="note">That does not look like a domain. Try example.com.</p>';
      return;
    }
    running = true; runBtn.disabled = true; runBtn.textContent = 'Counting...';
    out.className = 'report on';
    out.innerHTML = '<p class="note">Walking the include tree. Deeply nested records take a moment.</p>';
    try {
      render(await spfTree(domain, resolver()));
      history.replaceState(null, '', '?d=' + encodeURIComponent(domain));
    } catch (e) {
      out.innerHTML = `<p class="note"><strong>No result.</strong> ${esc(e.message || e)}`
        + (e.name === 'DnsUnavailable'
            ? ` A corporate network, VPN or ad blocker intercepting DNS-over-HTTPS is the
               usual cause.`
            : '') + `</p>`;
    } finally {
      running = false; runBtn.disabled = false; runBtn.textContent = 'Count lookups';
    }
  });
  const pre = new URLSearchParams(location.search).get('d');
  if (pre) { input.value = pre; form.requestSubmit(); }
}

const ALL_NOTE = {
  '-': ['ok', 'Ends in <code>-all</code>. Anything not listed fails outright, which is what you want.'],
  '~': ['warn', 'Ends in <code>~all</code> (softfail). Fine while validating sources; tighten to <code>-all</code>.'],
  '?': ['warn', 'Ends in <code>?all</code> (neutral). This tells receivers nothing.'],
  '+': ['fail', 'Ends in <code>+all</code>, which authorises the entire internet to send as you.'],
};

/* Walk the tree once, assigning each counted mechanism its running position. The
   mechanism that takes the count past ten is the one worth naming. */
function flatten(nodes, depth, acc) {
  for (const n of nodes) {
    if (n.cost) acc.running += n.cost;
    acc.rows.push({ ...n, depth, at: n.cost ? acc.running : null });
    if (n.children.length) flatten(n.children, depth + 1, acc);
  }
  return acc;
}

function render(res) {
  if (res.records.length > 1) {
    out.innerHTML = `<div class="head"><h2>${esc(res.domain)}</h2></div>
      <p class="verdict-line s-fail"><span class="pill">fail</span>
      ${res.records.length} SPF records published</p>
      <p class="note">Only one is allowed. Two or more is a permerror, and receivers
      treat a permerror as no SPF at all. Merge them into a single record.</p>
      ${res.records.map(r => `<code class="det">${esc(r)}</code>`).join('')}`;
    return;
  }
  if (!res.record) {
    out.innerHTML = `<div class="head"><h2>${esc(res.domain)}</h2></div>
      <p class="verdict-line s-fail"><span class="pill">fail</span> No SPF record</p>
      <p class="note">Nothing at the apex starting <code>v=spf1</code>. Publish one listing
      every source that sends as this domain, ending in <code>-all</code>.</p>`;
    return;
  }

  const { rows } = flatten(res.tree, 0, { running: 0, rows: [] });
  const n = res.count;
  const sev = n > 10 ? 'fail' : n >= 8 ? 'warn' : 'ok';
  const verdict = n > 10
    ? `${n} DNS lookups. Over the limit, so this record permerrors.`
    : n >= 8
      ? `${n} of 10 DNS lookups. ${10 - n} left before it breaks.`
      : `${n} of 10 DNS lookups. Comfortable.`;

  const body = rows.map(r => {
    const over = r.at !== null && r.at > 10;
    const cls = r.kind === 'free' ? 'free' : over ? 's-fail' : '';
    const at = r.at === null ? '' : `<span class="at${over ? ' over' : ''}">${r.at}</span>`;
    const label = r.kind === 'include' ? `include:${r.target}`
      : r.kind === 'redirect' ? `redirect=${r.target}` : r.target;
    return `<li class="${cls}" style="--d:${r.depth}">${at}
      <code>${esc(label)}</code>
      ${r.note ? `<span class="n">${esc(r.note)}</span>` : ''}
      ${r.record ? `<span class="rec">${esc(r.record)}</span>` : ''}</li>`;
  }).join('');

  const allNote = res.all && ALL_NOTE[res.all];

  out.innerHTML = `
    <div class="head"><h2>${esc(res.domain)}</h2>
      <button type="button" id="spf-copy" class="btn ghost sm">Copy as text</button></div>
    <p class="verdict-line s-${sev}"><span class="pill">${sev}</span> ${esc(verdict)}</p>
    <code class="det">${esc(res.record)}</code>
    ${allNote ? `<p class="verdict-line s-${allNote[0]}"><span class="pill">${allNote[0]}</span> ${allNote[1]}</p>` : ''}
    ${n > 10 ? `<p class="note"><strong>What this means right now.</strong> Over ten lookups the
      evaluation is a permerror under RFC 7208, and most receivers treat a permerror as no SPF
      at all. The record still resolves and still looks correct in a DNS lookup. It has simply
      stopped working. See <a href="/research/">how common this is</a>.</p>` : ''}
    <div class="tree"><ul>${body}</ul></div>
    <p class="note">The number on the left is the running lookup count. Mechanisms with no
    number cost nothing: <code>ip4:</code>, <code>ip6:</code>, <code>all</code> and
    <code>exp=</code> are evaluated without a DNS query. Counts are resolved live from your
    browser, so a record that has just changed is reflected immediately.</p>`;

  document.getElementById('spf-copy').addEventListener('click', ev => {
    const text = [`${res.domain} - SPF lookup count`, '', res.record, '', verdict, '']
      .concat(rows.filter(r => r.kind !== 'free').map(r =>
        `${String(r.at ?? '').padStart(3)}  ${'  '.repeat(r.depth)}${
          r.kind === 'include' ? 'include:' + r.target
          : r.kind === 'redirect' ? 'redirect=' + r.target : r.target}${
          r.note ? '   (' + r.note + ')' : ''}`))
      .concat(['', 'https://rastu.tech/spf/']).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      ev.target.textContent = 'Copied';
      setTimeout(() => { ev.target.textContent = 'Copy as text'; }, 1600);
    });
  });
}
