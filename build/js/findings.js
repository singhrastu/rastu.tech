/* One shape for "something is wrong, here is what to do about it", and one
 * renderer for it.
 *
 * Every tool on this site produces the same kind of output and, before this
 * module, produced it in a different shape each time: the domain check returned
 * {check, severity, finding, remediation, detail}, the SPF counter an ad-hoc
 * verdict string, the bounce classifier {category, action, advice}. Three shapes
 * for one idea, which meant three renderers and three voices.
 *
 * The part that is not merely tidying is `owner`. A finding that says what is
 * wrong without saying whose problem it is leaves the reader with the hardest
 * question unanswered. "SPF failed on this hop" is useless; "SPF failed because
 * this message was forwarded, which is normal and not yours to fix" is the
 * answer. No other tool in this category attributes its findings.
 *
 * Pure: builds HTML strings, touches no DOM, so it is testable in node.
 */

export const SEVERITY = ['critical', 'warn', 'info', 'ok'];
const SEV_RANK = { critical: 0, warn: 1, info: 2, ok: 3 };

/* Ordered by how much the reader can do about it. Within one severity band, the
   things they own come first. */
export const OWNER = ['you', 'intermediary', 'receiver', 'unknown'];
const OWNER_RANK = { you: 0, intermediary: 1, receiver: 2, unknown: 3 };

export const OWNER_LABEL = {
  you: 'Your problem',
  intermediary: 'In transit',
  receiver: 'Receiver side',
  unknown: 'Cannot attribute',
};
const OWNER_HINT = {
  you: 'Something in your sending configuration causes this.',
  intermediary: 'A forwarder or relay between sender and recipient caused this.',
  receiver: 'A decision made by the receiving system, not by your configuration.',
  unknown: 'Not determinable from what is available here.',
};

const SEV_LABEL = { critical: 'critical', warn: 'warning', info: 'note', ok: 'ok' };

/** Build a finding. Required: severity, owner, title. Everything else optional.
 *  Throws on a bad severity or owner, because a typo that silently sorts to the
 *  bottom is worse than a build failure. */
export function finding(f) {
  if (!SEV_RANK.hasOwnProperty(f.severity)) {
    throw new Error(`unknown severity ${JSON.stringify(f.severity)}`);
  }
  if (!OWNER_RANK.hasOwnProperty(f.owner)) {
    throw new Error(`unknown owner ${JSON.stringify(f.owner)}`);
  }
  if (!f.title) throw new Error('a finding needs a title');
  return {
    severity: f.severity,
    owner: f.owner,
    title: f.title,
    detail: f.detail || '',
    fix: f.fix || '',
    evidence: f.evidence || '',
    ref: f.ref || '',
    // Optional grouping label, e.g. "SPF" or "Hop 3".
    scope: f.scope || '',
  };
}

export function rank(findings) {
  return findings.slice().sort((a, b) =>
    SEV_RANK[a.severity] - SEV_RANK[b.severity]
    || OWNER_RANK[a.owner] - OWNER_RANK[b.owner]);
}

export function counts(findings) {
  const c = { critical: 0, warn: 0, info: 0, ok: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** The "fix these first" shortlist: things the reader owns, worst first, that
 *  actually have a fix attached. Anything without a fix is information, not a
 *  task, and does not belong on a to-do list. */
export function topFixes(findings, limit = 3) {
  return rank(findings)
    .filter(f => f.fix && f.owner === 'you' && f.severity !== 'ok')
    .slice(0, limit);
}

/** A one-line verdict, derived rather than written per tool so the phrasing
 *  cannot drift between them. Two facts matter to the reader and no others: how
 *  bad is it, and how much of it is mine. */
export function verdict(findings, noun = 'issue') {
  const c = counts(findings);
  const actionable = c.critical + c.warn;
  const mine = findings.filter(f => f.owner === 'you' && f.severity !== 'ok').length;
  if (!actionable) return { severity: 'ok', text: 'Nothing to fix.' };

  const plural = n => (n === 1 ? noun : noun + 's');
  let head;
  if (c.critical && c.warn) {
    head = `${c.critical} critical and ${c.warn} other ${plural(c.warn)}`;
  } else if (c.critical) {
    head = `${c.critical} critical ${plural(c.critical)}`;
  } else {
    head = `${c.warn} ${plural(c.warn)} worth fixing`;
  }

  let tail;
  if (mine === 0) tail = ', none of them yours to fix';
  else if (mine === actionable) tail = actionable === 1 ? ', and it is yours' : ', all of them yours';
  else tail = `, ${mine} of them yours`;

  return { severity: c.critical ? 'critical' : 'warn', text: head + tail + '.' };
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderOne(f) {
  return `<article class="fnd s-${f.severity} o-${f.owner}">
    <header>
      <span class="pill">${esc(SEV_LABEL[f.severity])}</span>
      ${f.scope ? `<span class="scope">${esc(f.scope)}</span>` : ''}
      <span class="owner" title="${esc(OWNER_HINT[f.owner])}">${esc(OWNER_LABEL[f.owner])}</span>
    </header>
    <h4>${esc(f.title)}</h4>
    ${f.detail ? `<p class="d">${esc(f.detail)}</p>` : ''}
    ${f.fix ? `<p class="fix"><b>Fix</b> ${esc(f.fix)}</p>` : ''}
    ${f.evidence ? `<code class="ev">${esc(f.evidence)}</code>` : ''}
    ${f.ref ? `<p class="ref"><a href="${esc(f.ref.url)}">${esc(f.ref.label)} &rarr;</a></p>` : ''}
  </article>`;
}

/**
 * @param {Array} findings
 * @param {Object} opts  { noun, emptyText, showOk }
 */
export function renderFindings(findings, opts = {}) {
  const noun = opts.noun || 'issue';
  const list = rank(findings).filter(f => opts.showOk ? true : f.severity !== 'ok');
  const c = counts(findings);
  const v = verdict(findings, noun);
  const fixes = topFixes(findings);

  const tiles = SEVERITY.filter(s => opts.showOk || s !== 'ok')
    .map(s => `<div class="t s-${s}"><b>${c[s]}</b><span>${SEV_LABEL[s]}</span></div>`)
    .join('');

  const shortlist = fixes.length > 1 ? `
    <ol class="shortlist">
      ${fixes.map(f => `<li><strong>${esc(f.title)}</strong> ${esc(f.fix)}</li>`).join('')}
    </ol>` : '';

  if (!list.length) {
    return `<p class="verdict-line s-ok"><span class="pill">ok</span>
      ${esc(opts.emptyText || 'Nothing to fix.')}</p>`;
  }

  return `
    <p class="verdict-line s-${v.severity}"><span class="pill">${
      v.severity === 'critical' ? 'critical' : v.severity === 'warn' ? 'check' : 'ok'
    }</span> ${esc(v.text)}</p>
    <div class="tiles">${tiles}</div>
    ${shortlist ? `<div class="sechead"><h3>Fix these first</h3></div>${shortlist}` : ''}
    <div class="findings">${list.map(renderOne).join('')}</div>`;
}

/** Plain text, for the copy-to-clipboard affordance every tool has. */
export function findingsText(findings, header) {
  const lines = header ? [header, ''] : [];
  for (const f of rank(findings)) {
    if (f.severity === 'ok') continue;
    lines.push(`[${f.severity.toUpperCase()}] ${f.scope ? f.scope + ': ' : ''}${f.title}`);
    lines.push(`    owner: ${OWNER_LABEL[f.owner]}`);
    if (f.detail) lines.push(`    ${f.detail}`);
    if (f.fix) lines.push(`    fix: ${f.fix}`);
    lines.push('');
  }
  return lines.join('\n');
}
