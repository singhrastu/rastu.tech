/* Look up any SMTP response, from any fragment of it.
 *
 * Pure: no DOM, no network. The registry is passed in.
 *
 * The thing this has to get right is that people arrive holding very different
 * amounts of the answer. Sometimes a whole log line. Sometimes "5.7.512".
 * Sometimes just "512", or "550", or the words "mailbox full". All of those have
 * to land on the same entry, and a range like Microsoft's 5.7.606-649 has to
 * match every code inside it, which is the case every other reference misses.
 */

/** Everything in the registry, flattened into one searchable shape. */
export function buildIndex(reg) {
  const items = [];

  for (const b of reg.basic || []) {
    items.push({
      kind: 'basic',
      code: b.code,
      cls: b.code[0],
      title: b.text,
      body: '',
      action: b.code[0] === '2' || b.code[0] === '3' ? 'deliver'
        : b.code[0] === '4' ? 'retry' : 'review',
      note: '',
      source: 'RFC 5321',
      terms: (b.code + ' ' + b.text).toLowerCase(),
    });
  }

  for (const e of reg.enhanced || []) {
    items.push({
      kind: 'enhanced',
      code: e.code,
      cls: e.cls,
      subject: e.subject,
      title: e.sample,
      body: e.desc,
      action: e.action,
      note: e.note,
      specific: e.specific,
      canonical: e.canonical,
      basic: e.basic,
      source: e.ref,
      terms: (e.code + ' ' + e.sample + ' ' + e.desc).toLowerCase(),
    });
  }

  for (const m of reg.microsoft || []) {
    items.push({
      kind: 'provider',
      provider: m.provider,
      code: m.code,
      low: m.low,
      high: m.high,
      cls: m.code[0],
      title: m.sample,
      body: m.why,
      note: m.fix,
      action: actionFromText(m.code, m.sample + ' ' + m.why),
      source: m.source,
      url: m.url,
      terms: (m.code + ' ' + m.sample + ' ' + m.why).toLowerCase(),
    });
  }

  for (const p of reg.provider || []) {
    items.push({
      kind: 'provider',
      provider: p.provider,
      code: p.code,
      low: p.code, high: p.code,
      cls: /^\d/.test(p.code) ? p.code[0] : '5',
      title: p.text,
      body: '',
      note: '',
      action: actionFromText(p.code, p.text),
      source: p.source,
      terms: (p.code + ' ' + p.provider + ' ' + p.text).toLowerCase(),
    });
  }

  return items;
}

/* A provider's own wording is usually clearer about the action than its code
   class is, so it decides where it can. */
function actionFromText(code, text) {
  const t = (text || '').toLowerCase();
  if (/try again later|temporarily|throttl|too many|exceeded threshold|server busy/.test(t)) {
    return 'throttle';
  }
  if (/banned|blocked|denied|suspicious|reputation|not accepted from this ip/.test(t)) {
    return 'pause';
  }
  if (/doesn't exist|does not exist|not found|no longer|invalid recipient/.test(t)) {
    return 'suppress';
  }
  if (/spf|dkim|dmarc|certificate|tls|dnssec|dane|authenticat/.test(t)) return 'fix_config';
  if (code[0] === '4') return 'retry';
  return 'review';
}

const CODE_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/g;

/* The reply codes RFC 5321 section 4.2.3 defines, plus the handful that are in
   universal use without being in that list. This is a closed set, and checking
   against it is the only way to tell a reply code from a port number: "587" and
   "465" look exactly like 5xx codes and are neither. */
export const KNOWN_BASIC = new Set([
  '211', '214', '220', '221', '235', '250', '251', '252', '334', '354',
  '421', '450', '451', '452', '455',
  '500', '501', '502', '503', '504', '521', '523', '530', '535', '538',
  '550', '551', '552', '553', '554', '555', '556',
]);

const BASIC_RE = /(?:^|[\s(,;])([2-5]\d\d)(?=[\s\-:]|$)/g;

/** Every code mentioned in a pasted line, in the order they appear. */
export function extractCodes(text, known = KNOWN_BASIC) {
  const t = String(text);
  const enhanced = [...t.matchAll(CODE_RE)].map(m => m[0]);
  const basic = [...t.matchAll(BASIC_RE)].map(m => m[1])
    // Not a real reply code, so not a reply code: this is what keeps "port 587"
    // and the 203 out of [203.0.113.9] from being reported as responses.
    .filter(b => known.has(b))
    // And the 550 inside "5.7.606" is part of the enhanced code, not separate.
    .filter(b => !enhanced.some(e => e.replace(/\./g, '') === b || e.includes(b)));
  return { enhanced: [...new Set(enhanced)], basic: [...new Set(basic)] };
}

/** Does `code` fall inside an entry that is written as a range? */
export function inRange(item, code) {
  if (!item.low || !item.high || item.low === item.high) return false;
  const parts = (s) => s.split('.').map(Number);
  const [c1, c2, c3] = parts(code);
  const [l1, l2, l3] = parts(item.low);
  const [h1, h2, h3] = parts(item.high);
  if (c1 !== l1 || c2 !== l2) return false;
  return c3 >= Math.min(l3, h3) && c3 <= Math.max(l3, h3);
}

/* Ranked so that the strongest evidence wins. An exact code beats a range,
   a range beats a prefix, and a word match comes last because a query of "550"
   should not be outranked by a description that happens to contain it. */
const SCORE = {
  exact: 100, range: 90, prefix: 70, fragment: 55, basicLink: 40, text: 20,
};

/**
 * @param {Array} index  from buildIndex
 * @param {string} query anything: a code, a fragment, a whole log line, words
 * @returns {{matches: Array, codes: Object, kind: string}}
 */
export function search(index, query) {
  const q = String(query || '').trim();
  if (!q) return { matches: [], codes: { enhanced: [], basic: [] }, kind: 'empty' };

  const found = extractCodes(q);
  const pasted = q.length > 24 || found.enhanced.length || found.basic.length > 0;
  const lower = q.toLowerCase();
  const bare = q.replace(/\s+/g, '');
  // A fragment is the tail of a code: "512" should find 5.7.512.
  const isFragment = /^\d{1,3}$/.test(bare);
  const isPrefix = /^[245](\.\d{0,3}){0,2}\.?$/.test(bare);

  const scored = [];
  for (const it of index) {
    let score = 0;
    let why = '';

    if (found.enhanced.includes(it.code)) { score = SCORE.exact; why = 'exact'; }
    else if (it.code === bare) { score = SCORE.exact; why = 'exact'; }
    else if (found.basic.includes(it.code)) { score = SCORE.exact; why = 'exact'; }

    if (!score) {
      for (const c of found.enhanced.concat(isFragment || isPrefix ? [] : [])) {
        if (inRange(it, c)) { score = SCORE.range; why = 'range'; break; }
      }
    }
    if (!score && /^[245]\.\d{1,3}\.\d{1,3}$/.test(bare) && inRange(it, bare)) {
      score = SCORE.range; why = 'range';
    }
    if (!score && isPrefix && it.code.startsWith(bare.replace(/\.$/, '') + '.')) {
      score = SCORE.prefix; why = 'prefix';
    }
    if (!score && isFragment && it.code.split('.').pop().startsWith(bare)
        && it.code.includes('.')) {
      score = SCORE.fragment; why = 'fragment';
    }
    // An enhanced code whose canonical basic pairing is what was typed.
    if (!score && found.basic.length && it.basic
        && found.basic.some(b => it.basic.includes(b))) {
      score = SCORE.basicLink; why = 'pairs with ' + found.basic[0];
    }
    if (!score && !pasted && lower.length >= 3 && it.terms.includes(lower)) {
      score = SCORE.text; why = 'text';
    }

    if (score) scored.push({ ...it, score, why });
  }

  scored.sort((a, b) =>
    b.score - a.score
    || a.code.localeCompare(b.code, undefined, { numeric: true })
    || a.kind.localeCompare(b.kind));

  return {
    matches: scored,
    codes: found,
    kind: pasted ? 'pasted' : isFragment ? 'fragment' : isPrefix ? 'prefix' : 'text',
  };
}

/** A one-line answer for the top match, which is what somebody actually wants. */
export function verdictFor(match) {
  if (!match) return null;
  const CLS = {
    '2': ['ok', 'Accepted'],
    '3': ['info', 'Intermediate'],
    '4': ['warn', 'Temporary'],
    '5': ['critical', 'Permanent'],
  };
  const [sev, label] = CLS[match.cls] || ['info', 'Unknown class'];
  return { severity: sev, label, action: match.action };
}
