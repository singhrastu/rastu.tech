/* DMARC aggregate report reader: the view.
 *
 * The file is read with FileReader and parsed in this tab. Nothing is uploaded,
 * and that is not a nicety: an aggregate report lists every system that sends
 * mail as a domain, which is exactly the map an attacker would want.
 *
 * Findings first, table second. The question people arrive with is "can I move
 * to p=reject without breaking my own mail", so that answer is the headline and
 * everything else is supporting evidence.
 */
import { extractXml, ZipError, canInflate } from './unzip.js';
import { parseReport, aggregate, VERDICT, findingsFor, simulateReject,
         loadKnown, saveKnown } from './rua.js';
import { renderFindings, findingsText, esc } from './findings.js';
import { resolver, DnsUnavailable } from './doh.js';

const drop = document.getElementById('rua-drop');
const fileIn = document.getElementById('rua-file');
const pasteIn = document.getElementById('rua-paste');
const out = document.getElementById('rua-out');

/* Suffix match only, and only for senders common enough to be worth naming. A
   PTR is set by whoever controls the IP block and is not authenticated, so an
   unknown one is reported as unknown rather than guessed at. */
const ESP = [
  ['sendgrid.net', 'SendGrid'], ['mandrillapp.com', 'Mailchimp Transactional'],
  ['mcsv.net', 'Mailchimp'], ['mcdlv.net', 'Mailchimp'], ['rsgsv.net', 'Mailchimp'],
  ['mailjet.com', 'Mailjet'], ['mailgun.net', 'Mailgun'], ['mailgun.org', 'Mailgun'],
  ['sparkpostmail.com', 'SparkPost'], ['amazonses.com', 'Amazon SES'],
  ['1e100.net', 'Google'], ['google.com', 'Google'], ['googlemail.com', 'Google'],
  ['smtp.goog', 'Google'], ['outlook.com', 'Microsoft 365'],
  ['protection.outlook.com', 'Microsoft 365'], ['hotmail.com', 'Microsoft'],
  ['zoho.com', 'Zoho'], ['zohomail.com', 'Zoho'], ['salesforce.com', 'Salesforce'],
  ['exacttarget.com', 'Salesforce Marketing Cloud'], ['pphosted.com', 'Proofpoint'],
  ['mimecast.com', 'Mimecast'], ['hubspot.com', 'HubSpot'],
  ['hubspotemail.net', 'HubSpot'], ['klaviyomail.com', 'Klaviyo'],
  ['sendinblue.com', 'Brevo'], ['brevo.com', 'Brevo'], ['postmarkapp.com', 'Postmark'],
  ['mtasv.net', 'Postmark'], ['constantcontact.com', 'Constant Contact'],
  ['icpbounce.com', 'iContact'], ['createsend.com', 'Campaign Monitor'],
  ['cmail19.com', 'Campaign Monitor'], ['sailthru.com', 'Sailthru'],
  ['iterable.com', 'Iterable'], ['braze.com', 'Braze'],
  ['customeriomail.com', 'Customer.io'], ['intercom.io', 'Intercom'],
  ['zendesk.com', 'Zendesk'], ['freshdesk.com', 'Freshdesk'],
  ['atlassian.net', 'Atlassian'], ['github.com', 'GitHub'], ['shopify.com', 'Shopify'],
  ['stripe.com', 'Stripe'], ['paypal.com', 'PayPal'], ['apple.com', 'Apple'],
  ['icloud.com', 'Apple'], ['yahoodns.net', 'Yahoo'], ['messagelabs.com', 'Symantec'],
  ['barracudanetworks.com', 'Barracuda'], ['pipedrive.com', 'Pipedrive'],
  ['protonmail.ch', 'Proton'],
];
const espFor = (ptr) => {
  if (!ptr) return null;
  const h = ptr.toLowerCase();
  for (const [suffix, name] of ESP) if (h === suffix || h.endsWith('.' + suffix)) return name;
  return null;
};

/** Canonical form for comparing two spellings of one address. */
function normIp(ip) {
  if (!ip || !ip.includes(':')) return (ip || '').trim();
  const [head, tail] = ip.trim().toLowerCase().split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const groups = ip.includes('::')
    ? [...h, ...new Array(8 - h.length - t.length).fill('0'), ...t]
    : ip.trim().toLowerCase().split(':');
  return groups.map(g => g.padStart(4, '0')).join(':');
}

let state = { agg: null, known: new Set(), rejected: [] };

function main() {
  state.known = loadKnown(localStorage);
  if (!canInflate()) {
    out.className = 'report on';
    out.innerHTML = '<p class="empty">This browser cannot decompress files, so only '
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
    else say('Paste the XML of an aggregate report into the box first.');
  });
  out.addEventListener('click', onResultClick);
}

const say = (html) => { out.className = 'report on'; out.innerHTML = `<p class="empty">${html}</p>`; };

async function handleFiles(files) {
  if (!files.length) return;
  const tooBig = files.find(f => f.size > 40 * 1024 * 1024);
  if (tooBig) {
    return say(`<strong>${esc(tooBig.name)} is ${(tooBig.size / 1048576).toFixed(0)} MB.</strong> `
      + 'Aggregate reports are never this large. If this really is one, split it.');
  }
  out.className = 'report on';
  out.innerHTML = `<p class="empty">Reading ${files.length === 1 ? esc(files[0].name)
    : files.length + ' files'}...</p>`;
  const docs = [];
  const skipped = [];
  for (const f of files) {
    try {
      docs.push(...await extractXml(f));
    } catch (e) {
      // Drop the file, keep the batch. Somebody dragging in a month of reports
      // should not lose twenty-nine of them to one truncated download.
      skipped.push(`${f.name}: ${e.message}`);
    }
  }
  if (!docs.length) {
    return say('<strong>Nothing could be opened.</strong> ' + esc(skipped.join(' ')));
  }
  run(docs, skipped);
}

async function run(docs, skipped = []) {
  const reports = [];
  const rejected = [...skipped];
  for (const d of docs) {
    // Named, so that one bad file in thirty is identifiable rather than just
    // "a file was not valid XML".
    try { reports.push(parseReport(d.text)); }
    catch (e) { rejected.push(`${d.name}: ${e.message}`); }
  }
  if (!reports.length) {
    return say('<strong>Nothing usable.</strong> ' + esc(rejected.join(' ')));
  }
  if (!reports.some(r => r.rows.length)) {
    return say('That parsed as a DMARC report but contains no records, which means the '
      + 'reporter saw no mail for the domain in this window. That is a valid result.');
  }

  state.agg = aggregate(reports);
  state.rejected = rejected;
  render();
  out.querySelector('h2')?.focus();

  // Names are a courtesy, so they arrive after the answer rather than blocking it.
  const note = document.getElementById('rua-naming');
  if (note) note.textContent = 'Resolving source names...';
  await nameSources(state.agg.sources);
  render();
}

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
          // Forward-confirmed reverse DNS: a PTR alone proves nothing about who
          // controls an address, so an unconfirmed one is labelled. Compared on
          // normalised form, because the report and the resolver disagree about
          // how to write an IPv6 address and a string compare marked every
          // single IPv6 source unconfirmed.
          try {
            const want = normIp(s.ip);
            s.fcrdns = (await r.a(s.ptr)).some(a => normIp(a) === want);
          } catch { s.fcrdns = null; }
        }
      } catch (e) {
        s.ptr = undefined;                 // undefined = failed, null = no PTR
        s.lookupFailed = e instanceof DnsUnavailable;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function onResultClick(ev) {
  const mark = ev.target.closest('[data-mark]');
  if (mark) {
    const key = mark.getAttribute('data-mark');
    state.known.has(key) ? state.known.delete(key) : state.known.add(key);
    saveKnown(localStorage, state.known);
    render();
    return;
  }
  if (ev.target.id === 'rua-forget') {
    state.known.clear();
    saveKnown(localStorage, state.known);
    render();
    return;
  }
  if (ev.target.id === 'rua-copy') {
    const f = findingsFor(state.agg, { known: state.known });
    const text = findingsText(f, `${state.agg.policy.domain} - DMARC aggregate report`)
      + '\nhttps://rastu.tech/dmarc/';
    copy(text, ev.target);
  }
}

/* The clipboard API is absent on insecure origins and can be refused outright.
   Without this the button throws inside the handler and does nothing visible. */
function copy(text, btn) {
  const done = (label) => {
    const was = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = was === label ? 'Copy findings' : was; }, 1800);
  };
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    return done('Clipboard unavailable');
  }
  navigator.clipboard.writeText(text).then(() => done('Copied'),
    () => done('Copy blocked'));
}

const fmt = n => n.toLocaleString();
const day = ts => (ts && isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : '?');

function sourceName(s) {
  if (s.esp) return esc(s.esp);
  if (s.ptr) return `<span class="unk">${esc(s.ptr)}</span>`;
  if (s.ptr === null) return '<span class="unk">No reverse DNS</span>';
  if (s.lookupFailed) return '<span class="unk">Name lookup failed</span>';
  return '<span class="unk">&mdash;</span>';
}

/** The headline. Nothing else on the page answers the question people actually
 *  came with, and no other free reader answers it at all. */
function rejectPanel(sim) {
  if (sim.alreadyEnforcing) {
    return sim.possible
      ? `<div class="sim s-warn">
          <h3>You are already at p=reject</h3>
          <p>${fmt(sim.possible)} of ${fmt(sim.total)} messages in this report failed
          DMARC, so receivers were entitled to reject them. If any of that is your own
          mail, it is not arriving.</p></div>`
      : `<div class="sim s-ok"><h3>You are at p=reject and nothing failed</h3>
          <p>Every message in this report authenticated and aligned.</p></div>`;
  }
  if (!sim.possible) {
    return `<div class="sim s-ok">
      <h3>Moving to p=reject would break nothing</h3>
      <p>Every one of the ${fmt(sim.total)} messages in this report already authenticates
      and aligns. On this evidence you can enforce today.</p></div>`;
  }
  return `<div class="sim s-${sim.pctCertain >= 1 ? 'fail' : 'warn'}">
    <h3>If you moved to p=reject today</h3>
    <div class="sim-nums">
      <div><b>${sim.pctCertain}%</b><span>would stop arriving<br>${fmt(sim.certain)} messages</span></div>
      ${sim.forwarded ? `<div class="soft"><b>+${Math.round(1000 * sim.forwarded / sim.total) / 10}%</b>
        <span>might, depending on the receiver<br>${fmt(sim.forwarded)} forwarded</span></div>` : ''}
    </div>
    <p class="sim-note">Forwarded mail that failed is counted separately because at
    p=reject a receiver is entitled to reject it, and many apply a local override for
    forwarders they recognise instead. Both ends of the range are shown rather than one
    number that would be wrong half the time.</p>
  </div>`;
}

function render() {
  const agg = state.agg;
  if (!agg) return;
  const pol = agg.policy || {};
  const sim = simulateReject(agg);
  const findings = findingsFor(agg, { known: state.known });

  const rows = agg.sources.map(s => {
    const [sev, label, advice] = VERDICT[s.verdict];
    const key = `${s.ip}|${s.headerFrom}`;
    const mine = state.known.has(key);
    return `<tr class="s-${sev}">
      <td><strong>${sourceName(s)}</strong>
        <span class="ip">${esc(s.ip)}</span>
        ${s.ptr && s.fcrdns === false ? '<span class="ptr"><em>reverse DNS unconfirmed</em></span>' : ''}</td>
      <td>${esc(s.headerFrom)}</td>
      <td class="num">${fmt(s.count)}</td>
      <td><span class="pill">${esc(label)}</span></td>
      <td class="why">${advice}</td>
      <td><button type="button" class="btn ghost sm${mine ? ' on' : ''}"
            data-mark="${esc(key)}"
            title="Remembered in this browser only, so next month's report can show what changed">${
              mine ? 'Mine' : 'Mark mine'}</button></td>
    </tr>`;
  }).join('');

  out.className = 'report on';
  out.innerHTML = `
    <div class="head">
      <h2 tabindex="-1">${esc(pol.domain || 'report')}</h2>
      <button type="button" id="rua-copy" class="btn ghost sm">Copy findings</button>
    </div>
    <p class="note">${esc(agg.reporters.join(', ') || 'unknown reporter')},
      ${day(agg.window.begin)} to ${day(agg.window.end)} &middot;
      ${fmt(agg.totals.total)} messages &middot; ${agg.totals.sources} sources &middot;
      <code>p=${esc(pol.p || '?')}</code>${pol.sp ? ` <code>sp=${esc(pol.sp)}</code>` : ''}
      <code>adkim=${esc(pol.adkim)}</code> <code>aspf=${esc(pol.aspf)}</code>
      <code>pct=${esc(pol.pct)}</code></p>
    ${state.rejected && state.rejected.length
      ? `<p class="verdict-line s-warn"><span class="pill">note</span>
         ${state.rejected.length} file(s) could not be read and are not included:
         ${esc(state.rejected.join('; '))}</p>` : ''}

    ${rejectPanel(sim)}

    ${renderFindings(findings, { noun: 'issue',
        emptyText: 'Nothing in this report needs fixing.' })}

    <div class="sechead"><h3>Every source</h3>
      <p>Failing sources first, then by volume. Marking a source as yours keeps it in
      this browser only, so the next report you drop in can show what is new.
      ${state.known.size ? `<button type="button" id="rua-forget" class="btn ghost sm">Forget
      all ${state.known.size} marked</button>` : ''}</p></div>
    ${agg.sources.length > 25 ? `<p class="note">Names are resolved for the 25
      busiest sources only: a report with ${agg.sources.length} of them would mean
      hundreds of DNS lookups, and a throttled lookup is worse than none. The rest
      show their IP.</p>` : ''}
    <div class="scroll-x" tabindex="0" role="region" aria-label="Every source in this report">
      <table class="rua">
      <thead><tr><th>Source</th><th>From domain</th><th class="num">Messages</th>
        <th>Result</th><th>Meaning</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note" id="rua-naming"></p>

    <p class="note"><strong>One receiver, one window.</strong> This is not your global
    pass rate. An unrecognised source is not evidence of spoofing either: it is far more
    often a vendor somebody set up and forgot. Identify a source before you change policy
    because of it.</p>`;
}

// Called last on purpose: `state` is a `let`, so calling main() above its
// declaration is a temporal-dead-zone error and the whole module fails to run.
if (drop && out) main();
