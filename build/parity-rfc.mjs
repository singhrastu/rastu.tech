/* Tests for the RFC index.
 *
 *     node build/parity-rfc.mjs
 *
 * The thing this has to get right is that somebody arrives holding a number
 * that is wrong. They were handed "RFC 821" by a blog post, or "RFC 7489" by a
 * vendor, and both were correct once. Landing them on nothing is the failure
 * that matters, so the redirects are tested harder than the search is.
 */
import { readFileSync, existsSync } from 'node:fs';
import { buildIndex, search, statusNote, numberIn, bySection, warningsFor }
  from './js/rfc.js';

const data = JSON.parse(readFileSync(new URL('./rfcs.json', import.meta.url)));
const index = buildIndex(data);
const aliases = data.aliases || {};
const reqs = n => JSON.parse(
  readFileSync(new URL(`./rfc/${n}.json`, import.meta.url)));

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const find = n => index.find(e => e.num === n);

// ------------------------------------------------------------- the corpus
is('the index is built', index.length > 60, true);
is('RFC 5321 is in it', Boolean(find(5321)), true);
is('every entry has a category', index.filter(e => !e.category).length, 0);
is('every entry has a title', index.filter(e => !e.title).length, 0);

// Obsolete documents must not be entries. This is the whole point of the split.
is('RFC 821 is not an entry', Boolean(find(821)), false);
is('RFC 2821 is not an entry', Boolean(find(2821)), false);
is('RFC 7489 is not an entry, DMARC moved', Boolean(find(7489)), false);
is('RFC 4408 is not an entry, SPF moved', Boolean(find(4408)), false);
is('nothing in the index is obsolete',
   index.filter(e => aliases[e.num]).length, 0);

// ------------------------------------------------------------- redirects
{
  const r = search(index, aliases, '821');
  is('821 redirects', r.kind, 'redirected');
  is('and names what replaced it', r.redirect.now, [5321]);
  is('and shows that document', r.matches[0].num, 5321);
  is('and says what 821 was', r.redirect.title.includes('Simple Mail'), true);
}
{
  // A revision can split. Following only the first successor loses two thirds
  // of DMARC, which is the kind of quiet wrong answer that makes a reference
  // useless.
  const r = search(index, aliases, 'rfc 7489');
  is('7489 redirects to all three DMARC documents',
     r.redirect.now.sort((a, b) => a - b), [9989, 9990, 9991]);
  is('and all three are shown',
     r.matches.filter(m => [9989, 9990, 9991].includes(m.num)).length, 3);
}
is('a redirect works through two hops',
   search(index, aliases, '2821').redirect.now, [5321]);
is('a current number does not redirect',
   search(index, aliases, '5321').redirect, null);

// --------------------------------------------------------- how it is typed
is('a bare number', numberIn('5321'), 5321);
is('with the prefix', numberIn('RFC5321'), 5321);
is('with a space', numberIn('rfc 5321'), 5321);
is('inside a sentence', numberIn('see RFC 7208 section 4.6.4'), 7208);
is('and no number is null', numberIn('dkim'), null);
is('typed three ways, same answer',
   ['5321', 'RFC5321', 'rfc 5321'].map(q => search(index, aliases, q).matches[0].num),
   [5321, 5321, 5321]);

// ------------------------------------------------------------ name search
is('spf finds the SPF document',
   search(index, aliases, 'spf').matches[0].num, 7208);
is('dkim finds DKIM', search(index, aliases, 'dkim').matches[0].num, 6376);
is('mta-sts finds MTA-STS',
   search(index, aliases, 'mta-sts').matches[0].num, 8461);
is('an acronym does not match every abstract containing the letters',
   search(index, aliases, 'spf').matches.length < 12, true);
is('nothing matches nonsense',
   search(index, aliases, 'zzqqxx').matches.length, 0);
is('an empty query returns nothing', search(index, aliases, '').kind, 'empty');

// --------------------------------------------------------------- warnings
{
  const w = warningsFor(find(5321));
  is('5321 warns that it is amended', w[0].kind, 'amended');
  is('and names the amending RFC', w[0].refs.includes('RFC7504'), true);
}
is('an Informational document is flagged as carrying no standards weight',
   warningsFor({ status: 'INFORMATIONAL', updatedBy: [] })
     .some(w => w.kind === 'weight'), true);
is('a Proposed Standard is not flagged that way',
   warningsFor({ status: 'PROPOSED STANDARD', updatedBy: [] })
     .some(w => w.kind === 'weight'), false);

// ---------------------------------------------------------------- status
is('the retired Draft Standard level is explained',
   statusNote('DRAFT STANDARD').note.includes('retired'), true);
is('Informational is not presented as a standard',
   statusNote('INFORMATIONAL').kind, 'info');
is('every status in the index has an explanation',
   [...new Set(index.map(e => e.status))].filter(s => !statusNote(s).note), []);

// ---------------------------------------------------------- requirements
{
  const r = reqs(7208);
  is('SPF requirements were extracted', r.requirements.length > 40, true);
  is('and it adopts RFC 2119', r.uses_2119, true);
  is('every requirement has a level',
     r.requirements.filter(x => !['must', 'should', 'may'].includes(x.level)).length, 0);
  is('no RFC 2119 boilerplate survived',
     r.requirements.filter(x => /are to be interpreted as described/i.test(x.text)).length, 0);
  is('the publication rule is there',
     r.requirements.some(x => /MUST be published as a DNS TXT/.test(x.text)), true);
}
{
  // RFC 6152 is Standards Track and contains no uppercase keyword anywhere,
  // because it is a 2011 republication that never adopted the convention. An
  // empty list there is a fact. An empty list for a document that does adopt
  // 2119 would be a parser failure, and the two must not look alike.
  const r = reqs(6152);
  is('6152 has no requirements', r.requirements.length, 0);
  is('and says why: it never adopted RFC 2119', r.uses_2119, false);
}
{
  let suspect = 0;
  for (const e of index) {
    const r = reqs(e.num);
    if (r.uses_2119 && r.requirements.length === 0) suspect++;
  }
  is('no document adopts RFC 2119 and yields nothing', suspect, 0);
}
is('every entry has a requirements file',
   index.filter(e => !existsSync(new URL(`./rfc/${e.num}.json`, import.meta.url)))
     .map(e => e.num), []);

// ------------------------------------------------------------- grouping
{
  const g = bySection([
    { section: '2.10', heading: 'Ten', level: 'must', text: 'a' },
    { section: '2.9', heading: 'Nine', level: 'must', text: 'b' },
    { section: '2.9', heading: 'Nine', level: 'may', text: 'c' },
  ]);
  is('sections group', g.length, 2);
  is('and 2.10 sorts after 2.9, which a string sort gets wrong',
     g.map(x => x.section), ['2.9', '2.10']);
  is('items stay with their section', g[0].items.length, 2);
}

if (fails.length) {
  console.error('\nrfc failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  rfc ok (${pass} assertions over ${index.length} RFCs, `
  + `${Object.keys(aliases).length} aliases)`);
