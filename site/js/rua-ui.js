/* DMARC aggregate report reader: the view.
 *
 * The file is read with FileReader and parsed in this tab. Nothing is uploaded,
 * and that is not a nicety: an aggregate report is a list of every system that
 * sends mail as a domain, which is exactly the map an attacker would want.
 */
import { extractXml, ZipError, canInflate } from './unzip.js';
import { parseReport, aggregate, VERDICT } from './rua.js';
import { resolver, DnsUnavailable } from './doh.js';

const drop = document.getElementById('rua-drop');
const fileIn = document.getElementById('rua-file');
const pasteIn = document.getElementById('rua-paste');
const out = document.getElementById('rua-out');
if (drop && out) main();

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* Suffix match only, and only for senders common enough to be worth naming. A PTR
   is set by whoever controls the IP block and is not authenticated, so an unknown
   one is reported as unknown rather than guessed at. */
const ESP = [
  ['sendgrid.net', 'SendGrid'], ['mandrillapp.com', 'Mailchimp Transactional'],
  ['mcsv.net', 'Mailchimp'], ['mcdlv.net', 'Mailchimp'], ['rsgsv.net', 'Mailchimp'],
  ['mailjet.com', 'Mailjet'], ['mailgun.net', 'Mailgun'], ['mailgun.org', 'Mailgun'],
  ['sparkpostmail.com', 'SparkPost'], ['amazonses.com', 'Amazon SES'],
  ['1e100.net', 'Google'], ['google.com', 'Google'], ['googlemail.com', 'Google'],
  ['outlook.com', 'Microsoft 365'], ['protection.outlook.com', 'Microsoft 365'],
  ['hotmail.com', 'Microsoft'], ['zoho.com', 'Zoho'], ['zohomail.com', 'Zoho'],
  ['salesforce.com', 'Salesforce'], ['exacttarget.com', 'Salesforce Marketing Cloud'],
  ['pphosted.com', 'Proofpoint'], ['mimecast.com', 'Mimecast'],
  ['hubspot.com', 'HubSpot'], ['hubspotemail.net', 'HubSpot'],
  ['klaviyomail.com', 'Klaviyo'], ['sendinblue.com', 'Brevo'], ['brevo.com', 'Brevo'],
  ['postmarkapp.com', 'Postmark'], ['mtasv.net', 'Postmark'],
  ['constantcontact.com', 'Constant Contact'], ['icpbounce.com', 'iContact'],
  ['createsend.com', 'Campaign Monitor'], ['cmail19.com', 'Campaign Monitor'],
  ['sailthru.com', 'Sailthru'], ['iterable.com', 'Iterable'],
  ['braze.com', 'Braze'], ['customeriomail.com', 'Customer.io'],
  ['intercom.io', 'Intercom'], ['zendesk.com', 'Zendesk'], ['freshdesk.com', 'Freshdesk'],
  ['atlassian.net', 'Atlassian'], ['github.com', 'GitHub'], ['shopify.com', 'Shopify'],
  ['stripe.com', 'Stripe'], ['paypal.com', 'PayPal'], ['apple.com', 'Apple'],
  ['icloud.com', 'Apple'], ['yahoodns.net', 'Yahoo'], ['messagelabs.com', 'Symantec'],
  ['barracudanetworks.com', 'Barracuda'], ['smtp.goog', 'Google'],
  ['pipedrive.com', 'Pipedrive'], ['protonmail.ch', 'Proton'],
];
const espFor = (ptr) => {
  if (!ptr) return null;
  const h = ptr.toLowerCase();
  for (const [suffix, name] of ESP) if (h === suffix || h.endsWith('.' + suffix)) return name;
  return null;
};

/** Resolve PTR for the busiest sources only, with a small concurrency cap. A real
 *  report can carry hundreds of IPs and a throttled lookup is worse than none. */
async function nameSources(sources, limit = 25, concurrency = 6) {
  const r = resolver();
  const targets = sources.slice(0, limit);
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const s = targets[i++];
      try {
        const names = await r.ptr(s.ip);
        s.ptr = names[0] || null;
        s.esp = espFor(s.ptr);
        if (s.ptr) {
          // Forward-confirmed reverse DNS. A PTR alone proves nothing about who
          // controls the address, so an unconfirmed one is labelled.
          try {
            const addrs = await r.a(s.ptr);
            s.fcrdns = addrs.includes(s.ip);
          } catch { s.fcrdns = null; }
        }
      } catch (e) {
        s.ptr = undefined;                  // undefined = lookup failed, null = no PTR
        s.lookupFailed = e instanceof DnsUnavailable;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return sources;
}

function main() {
  if (!canInflate()) {
    out.className = 'report on';
    out.innerHTML = '<p class="note">This browser cannot decompress files, so only '
      + 'plain XML will work here. Safari 16.4, Firefox 113 or Chrome 103 and later '
      + 'handle .gz and .zip.</p>';
  }
  fileIn.addEventListener('change', () => handleFiles([...fileIn.files]));
  drop.addEventListener('dragover', ev => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', ev => {
    ev.preventDefault(); drop.classList.remove('over');
    handleFiles([...ev.dataTransfer.files]);
  });
  document.getElementById('rua-paste-run')?.addEventListener('click', () => {
    const t = pasteIn.value.trim();
    if (t) run([{ name: 'pasted.xml', text: t }]);
  });
}

async function handleFiles(files) {
  if (!files.length) return;
  out.className = 'report on';
  out.innerHTML = '<p class="note">Reading...</p>';
  const docs = [];
  for (const f of files) {
    try {
      docs.push(...await extractXml(f));
    } catch (e) {
      out.innerHTML = `<p class="note"><strong>${esc(f.name)} could not be opened.</strong> `
        + `${esc(e.message)}</p>`;
      return;
    }
  }
  run(docs);
}

async function run(docs) {
  let reports;
  try {
    reports = docs.map(d => parseReport(d.text));
  } catch (e) {
    out.innerHTML = `<p class="note"><strong>Not a usable report.</strong> ${esc(e.message)}</p>`;
    return;
  }
  if (!reports.some(r => r.rows.length)) {
    out.innerHTML = '<p class="note">That parsed as a DMARC report but contains no '
      + 'records, which means the reporter saw no mail for the domain in this window.</p>';
    return;
  }

  const agg = aggregate(reports);
  render(agg, false);
  out.innerHTML += '<p class="note" id="rua-naming">Resolving source names...</p>';
  await nameSources(agg.sources);
  render(agg, true);
}

const fmt = n => n.toLocaleString();
const day = ts => ts && isFinite(ts)
  ? new Date(ts * 1000).toISOString().slice(0, 10) : 'unknown';

function sourceName(s) {
  if (s.esp) return `<strong>${esc(s.esp)}</strong>`;
  if (s.ptr) return `<strong class="unk">Unknown sender</strong>`;
  if (s.ptr === null) return `<strong class="unk">No reverse DNS</strong>`;
  if (s.lookupFailed) return `<strong class="unk">Name lookup failed</strong>`;
  return `<strong class="unk">&mdash;</strong>`;
}

function render(agg, named) {
  const t = agg.totals;
  const pctAligned = t.total ? Math.round(1000 * t.aligned / t.total) / 10 : 0;

  const rows = agg.sources.map(s => {
    const [sev, label, advice] = VERDICT[s.verdict];
    return `<tr class="s-${sev}">
      <td>${sourceName(s)}
        <span class="ip">${esc(s.ip)}</span>
        ${named && s.ptr ? `<span class="ptr">${esc(s.ptr)}${
          s.fcrdns === false ? ' <em>unconfirmed</em>' : ''}</span>` : ''}</td>
      <td>${esc(s.headerFrom)}</td>
      <td class="num">${fmt(s.count)}</td>
      <td><span class="pill">${esc(label)}</span></td>
      <td class="why">${advice}
        ${s.reasons.size ? `<span class="tags">${[...s.reasons]
          .map(r => `<code>${esc(r)}</code>`).join('')}</span>` : ''}
        ${s.selectors.size ? `<span class="tags">selector ${[...s.selectors]
          .map(x => `<code>${esc(x)}</code>`).join('')}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const pol = agg.policy;
  out.innerHTML = `
    <div class="head">
      <h2>${esc(pol && pol.domain || 'report')}</h2>
      <button type="button" id="rua-copy" class="btn ghost sm">Copy as text</button>
    </div>
    <p class="verdict-line s-${t.failing ? 'warn' : 'ok'}">
      <span class="pill">${t.failing ? 'check' : 'ok'}</span>
      ${fmt(t.total)} messages from ${t.sources} source${t.sources === 1 ? '' : 's'},
      ${pctAligned}% aligned${t.failing ? `, ${fmt(t.failing)} authenticated by neither` : ''}</p>

    <div class="tiles">
      <div class="t s-ok"><b>${fmt(t.aligned)}</b><span>aligned</span></div>
      <div class="t s-fail"><b>${fmt(t.failing)}</b><span>unauthenticated</span></div>
      <div class="t s-info"><b>${t.sources}</b><span>sources</span></div>
      <div class="t s-info"><b>${esc(pol && pol.p || '?')}</b><span>policy</span></div>
    </div>

    <p class="note">Reported by ${esc(agg.reporters.join(', ') || 'unknown')} for
    ${day(agg.window.begin)} to ${day(agg.window.end)}. Published policy:
    <code>p=${esc(pol.p || '?')}</code>${pol.sp ? ` <code>sp=${esc(pol.sp)}</code>` : ''}
    <code>adkim=${esc(pol.adkim)}</code> <code>aspf=${esc(pol.aspf)}</code>
    <code>pct=${esc(pol.pct)}</code>.</p>

    ${t.disagreements ? `<p class="verdict-line s-warn"><span class="pill">note</span>
      ${fmt(t.disagreements)} messages where the reporter's own verdict disagrees with
      what its auth results support. The alignment shown here is computed from the
      auth results.</p>` : ''}

    <div class="scroll-x"><table class="rua">
      <thead><tr><th>Source</th><th>From domain</th><th class="num">Messages</th>
        <th>Result</th><th>What it means</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>

    <p class="note"><strong>How to read this.</strong> Alignment is computed here from
    <code>auth_results</code> against the <code>From:</code> domain, not taken from the
    reporter's <code>policy_evaluated</code>, because the two are routinely different and
    the difference is the whole point: SPF can pass and still not align, which needs a
    completely different fix from SPF being broken.</p>
    <p class="note">This is <strong>one receiver over one window</strong>, not a global
    pass rate. An unrecognised source is not evidence of spoofing: it is far more often a
    vendor somebody set up and forgot. Identify a source before you change policy because
    of it.</p>`;

  document.getElementById('rua-copy').addEventListener('click', ev => {
    const lines = [`${pol.domain} - DMARC aggregate report`,
      `${day(agg.window.begin)} to ${day(agg.window.end)}, via ${agg.reporters.join(', ')}`,
      `p=${pol.p} adkim=${pol.adkim} aspf=${pol.aspf} pct=${pol.pct}`, '',
      `${fmt(t.total)} messages, ${pctAligned}% aligned, ${fmt(t.failing)} unauthenticated`, ''];
    for (const s of agg.sources) {
      lines.push(`${VERDICT[s.verdict][1].padEnd(14)} ${String(s.count).padStart(7)}  `
        + `${s.esp || s.ptr || s.ip}  (${s.ip})  from=${s.headerFrom}`);
    }
    lines.push('', 'https://rastu.tech/dmarc/');
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      ev.target.textContent = 'Copied';
      setTimeout(() => { ev.target.textContent = 'Copy as text'; }, 1600);
    });
  });
}
