/* Which email RFC you should be reading, and what it actually requires.
 *
 * Pure: no DOM, no network. The index is passed in.
 *
 * Three things make an RFC hard to use, and none of them are visible on the
 * document you land on:
 *
 *   1. It has been replaced. Search for the SMTP RFC and you get 821, still
 *      labelled INTERNET STANDARD, while the document that replaced it is
 *      labelled DRAFT STANDARD. The status field actively misleads.
 *   2. It is current but amended. RFC 5321 is the right document and RFC 7504
 *      changed part of it. Nothing on either page says so.
 *   3. What binds an implementation is a few dozen sentences, not ninety pages.
 *
 * So a search resolves a replaced number to the current document, every entry
 * carries what amends it, and the requirements are the RFC 2119 sentences with
 * the section each came from.
 */

/** Everything in the index, flattened into one searchable shape. */
export function buildIndex(data) {
  return (data.rfcs || []).map(e => ({
    num: e.num,
    id: e.id,
    title: e.title,
    status: e.status,
    published: e.published,
    category: e.category,
    abstract: e.abstract || '',
    updates: e.updates || [],
    updatedBy: e.updated_by || [],
    replaces: e.replaces || [],
    relTitles: e.rel_titles || {},
    counts: e.req_counts || { must: 0, should: 0, may: 0 },
    errata: e.errata || '',
    doi: e.doi || '',
    authors: e.authors || [],
    terms: `rfc${e.num} ${e.num} ${e.title} ${e.category} ${e.abstract || ''}`
      .toLowerCase(),
  }));
}

/* The maturity ladder, which is the single most misread field on an RFC.
   A document does not become an Internet Standard by being current, and an old
   Internet Standard outranks its own replacement on paper. */
const STATUS = {
  'INTERNET STANDARD': ['std', 'Internet Standard',
    'The top of the standards track. Note that an old document can hold this '
    + 'label while the document that replaced it holds a lower one.'],
  'DRAFT STANDARD': ['std', 'Draft Standard',
    'A retired maturity level. Documents that reached it kept the label, so it '
    + 'appears on current work such as RFC 5321.'],
  'PROPOSED STANDARD': ['std', 'Proposed Standard',
    'On the standards track and stable enough to implement. Most of the email '
    + 'stack lives here permanently.'],
  'BEST CURRENT PRACTICE': ['bcp', 'Best Current Practice',
    'Not a protocol specification. Operational guidance the community has '
    + 'agreed on.'],
  'INFORMATIONAL': ['info', 'Informational',
    'Published for the record. It carries no standards weight, which is worth '
    + 'knowing before citing it as a requirement.'],
  'EXPERIMENTAL': ['exp', 'Experimental',
    'Published to be tried, not to be relied on. Implementations may disagree.'],
  'HISTORIC': ['hist', 'Historic', 'Superseded or abandoned.'],
  'UNKNOWN': ['info', 'Unknown', 'The index does not record a status.'],
};

export function statusNote(status) {
  const s = STATUS[(status || '').toUpperCase()];
  return s ? { kind: s[0], label: s[1], note: s[2] }
    : { kind: 'info', label: status || 'Unknown', note: '' };
}

/** The number in a query, however it was typed: 5321, RFC5321, rfc 5321. */
export function numberIn(query) {
  const m = String(query || '').match(/\b(?:rfc\s*)?(\d{1,5})\b/i);
  return m ? Number(m[1]) : null;
}

const SCORE = { number: 100, title: 60, word: 40, abstract: 25 };

/**
 * @param {Array}  index    from buildIndex
 * @param {Object} aliases  replaced number -> what replaced it
 * @param {string} query    a number, a name, or words
 * @returns {{matches: Array, redirect: Object|null, kind: string}}
 */
export function search(index, aliases, query) {
  const q = String(query || '').trim();
  if (!q) return { matches: [], redirect: null, kind: 'empty' };

  const lower = q.toLowerCase();
  const n = numberIn(q);

  // A replaced document is not in the index. Say what replaced it and show
  // that instead, because landing on nothing is the worst possible answer for
  // somebody who has just been handed an obsolete number.
  let redirect = null;
  if (n !== null && aliases && aliases[n] && !index.some(e => e.num === n)) {
    const a = aliases[n];
    redirect = {
      num: n,
      id: a.id,
      title: a.title,
      status: a.status,
      published: a.published,
      now: (a.now || []).map(rid => Number(String(rid).replace(/\D/g, ''))),
      note: a.note || '',
    };
  }

  const scored = [];
  for (const e of index) {
    let score = 0;
    let why = '';
    if (n !== null && e.num === n) { score = SCORE.number; why = 'number'; }
    else if (redirect && redirect.now.includes(e.num)) {
      score = SCORE.number; why = 'replaced ' + redirect.num;
    } else if (e.title.toLowerCase().includes(lower)) {
      score = SCORE.title; why = 'title';
    } else if (wordHit(e.title, lower) || wordHit(e.category, lower)) {
      score = SCORE.word; why = 'name';
    } else if (lower.length >= 4 && e.abstract.toLowerCase().includes(lower)) {
      score = SCORE.abstract; why = 'abstract';
    }
    if (score) scored.push({ ...e, score, why });
  }

  // Two documents can both have the acronym in the title. "dkim" should land
  // on the signature specification, not on a companion document that happens
  // to have a lower number, so ties break on standards weight and then on how
  // much the document actually specifies.
  scored.sort((a, b) =>
    b.score - a.score
    || rank(a.status) - rank(b.status)
    || (b.counts.must + b.counts.should) - (a.counts.must + a.counts.should)
    || a.num - b.num);
  return {
    matches: scored,
    redirect,
    kind: redirect ? 'redirected' : n !== null ? 'number' : 'text',
  };
}

const RANK = {
  'INTERNET STANDARD': 0, 'DRAFT STANDARD': 1, 'PROPOSED STANDARD': 1,
  'BEST CURRENT PRACTICE': 2, 'INFORMATIONAL': 3, 'EXPERIMENTAL': 4,
  'HISTORIC': 5,
};
function rank(status) {
  const r = RANK[(status || '').toUpperCase()];
  return r === undefined ? 3 : r;
}

/* "spf" must match "Sender Policy Framework (SPF) for Authorizing Use of
   Domains" without also matching every abstract containing the letters. */
function wordHit(hay, needle) {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`, 'i')
    .test(hay || '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Requirements for one RFC, grouped by section in document order. */
export function bySection(reqs) {
  const out = [];
  const seen = new Map();
  for (const r of reqs || []) {
    const key = r.section || '';
    if (!seen.has(key)) {
      const group = { section: key, heading: r.heading || '', items: [] };
      seen.set(key, group);
      out.push(group);
    }
    seen.get(key).items.push(r);
  }
  return out.sort((a, b) => cmpSection(a.section, b.section));
}

/* 2.10 comes after 2.9, which a string sort gets wrong. */
function cmpSection(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? -1 : pa[i];
    const y = pb[i] === undefined ? -1 : pb[i];
    if (x !== y) return x - y;
  }
  return 0;
}

/** What the reader should know before trusting this document. */
export function warningsFor(e) {
  const out = [];
  if (e.updatedBy && e.updatedBy.length) {
    out.push({
      kind: 'amended',
      title: `Amended by ${e.updatedBy.length} later `
        + (e.updatedBy.length === 1 ? 'RFC' : 'RFCs'),
      detail: 'This is the current document and part of it has been changed '
        + 'since publication. Read these alongside it.',
      refs: e.updatedBy,
    });
  }
  const s = statusNote(e.status);
  if (s.kind === 'info' || s.kind === 'exp') {
    out.push({
      kind: 'weight',
      title: `${s.label}, not a standard`,
      detail: s.note,
      refs: [],
    });
  }
  return out;
}
