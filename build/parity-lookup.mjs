/* Tests for the SMTP response lookup.
 *
 *     node build/parity-lookup.mjs
 *
 * People arrive holding very different amounts of the answer: a whole log line,
 * a full code, three digits, a basic code, or just the words. Every one of those
 * has to land on the right entry, and a documented range has to match the codes
 * inside it, which is the case every other reference misses.
 */
import { readFileSync } from 'node:fs';
import { buildIndex, search, extractCodes, inRange, verdictFor, KNOWN_BASIC }
  from './js/lookup.js';

const reg = JSON.parse(readFileSync(new URL('./registry.json', import.meta.url)));
const index = buildIndex(reg);

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const top = (q) => search(index, q).matches[0];
const codes = (q, n = 3) => search(index, q).matches.slice(0, n).map(m => m.code);

// -------------------------------------------------------------- the corpus
is('the index is built from every source', index.length > 250, true);
is('basic codes are in it', index.some(i => i.kind === 'basic' && i.code === '550'), true);
is('IANA codes are in it', index.some(i => i.kind === 'enhanced' && i.code === '5.1.1'), true);
is('Microsoft codes are in it',
   index.some(i => i.kind === 'provider' && i.code.startsWith('5.7.6')), true);

// ------------------------------------------------------------ exact lookups
is('a full enhanced code', top('5.1.1').code, '5.1.1');
is('and it knows what to do', top('5.1.1').action, 'suppress');
is('a basic reply code', top('550').kind, 'basic');
is('a transient code', top('4.2.2').code, '4.2.2');
is('and 4.2.2 is a retry, not a suppression', top('4.2.2').action, 'retry');

// -------------------------------------------------------- partial fragments
// "512" is the whole query someone types when they have 5.7.512 in front of
// them and cannot be bothered typing the rest.
is('three digits find the code they end', codes('512').includes('5.7.512'), true);
is('a class and subject prefix lists the family',
   codes('5.7', 40).every(c => c.startsWith('5.7')), true);
is('and there are plenty of them', search(index, '5.7').matches.length > 10, true);

// ------------------------------------------------------------ ranges
// Microsoft documents 5.7.606-649 as one row. Every code inside it has to
// resolve, and no other reference does this.
is('a code inside a documented range resolves',
   Boolean(search(index, '5.7.620').matches.find(m => m.code.includes('-'))), true);
is('and it is the banned-IP entry',
   search(index, '5.7.620').matches[0].title.toLowerCase().includes('banned sending ip'), true);
is('a code outside the range does not match it',
   Boolean(search(index, '5.7.999').matches.find(m => m.code === '5.7.606-649')), false);
is('inRange is exclusive at the edges it should be',
   [inRange({ low: '5.7.606', high: '5.7.649' }, '5.7.605'),
    inRange({ low: '5.7.606', high: '5.7.649' }, '5.7.606'),
    inRange({ low: '5.7.606', high: '5.7.649' }, '5.7.649'),
    inRange({ low: '5.7.606', high: '5.7.649' }, '5.7.650')],
   [false, true, true, false]);

// ----------------------------------------------------- a whole pasted line
{
  const q = '550 5.7.1 Service unavailable; Client host [203.0.113.9] blocked using '
    + 'zen.spamhaus.org';
  const r = search(index, q);
  is('a pasted line yields its enhanced code', r.codes.enhanced, ['5.7.1']);
  is('and the enhanced code wins over the basic one', r.matches[0].code, '5.7.1');
  is('and it is recognised as a paste', r.kind, 'pasted');
}
{
  const r = search(index, '421-4.7.28 Our system has detected an unusual rate of '
    + 'unsolicited mail originating from your IP address. gsmtp');
  is('a Gmail deferral resolves', r.matches[0].code, '4.7.28');
  is('to a throttle', r.matches[0].action, 'throttle');
}
{
  // The basic code embedded in an enhanced code must not be read as a basic code.
  const r = search(index, '550 5.7.606 Access denied, banned sending IP');
  is('5.7.606 is found', Boolean(r.matches.find(m => m.code.startsWith('5.7.606'))), true);
  is('and 606 is not treated as a basic reply code', r.codes.basic.includes('606'), false);
}

// An IP address in a bounce is not a list of reply codes. A bare three-digit
// match reads 203 out of [203.0.113.9] and reports it as one.
is('an IP address is not mistaken for reply codes',
   extractCodes('550 5.7.1 Client host [203.0.113.9] blocked').basic, ['550']);
is('and neither is a port or a queue id',
   extractCodes('451 4.7.1 try later; id 4f2a-250-333 port 587').basic, ['451']);
is('a multiline reply keeps both codes',
   extractCodes('250-mx.google.com at your service\\n250 SMTPUTF8').basic, ['250']);
is('the enhanced code is still found alongside',
   extractCodes('550 5.7.1 blocked').enhanced, ['5.7.1']);
is('587 is a port and not a reply code', KNOWN_BASIC.has('587'), false);
is('every code the RFC defines is in the known set',
   reg.basic.filter(b => !KNOWN_BASIC.has(b.code)).map(b => b.code), []);

// ------------------------------------------------------------- word search
is('plain words find an entry',
   Boolean(search(index, 'mailbox full').matches.length), true);
is('and a long paste does not fall back to word matching',
   search(index, 'this is a long sentence about mailboxes being full and other things')
     .kind, 'pasted');

// ------------------------------------------------------------- the verdict
is('a 5xx is permanent', verdictFor(top('5.1.1')).label, 'Permanent');
is('a 4xx is temporary', verdictFor(top('4.2.2')).label, 'Temporary');
is('a 2xx is accepted', verdictFor(top('250')).label, 'Accepted');

// ------------------------------------------------------- honesty of labels
// A derived action is a sound default and is not the same as somebody having
// operated the failure. The two must stay distinguishable.
{
  const written = index.filter(i => i.kind === 'enhanced' && i.specific);
  const derived = index.filter(i => i.kind === 'enhanced' && !i.specific);
  is('some actions are written', written.length > 15, true);
  is('and most are derived from the class', derived.length > written.length, true);
  is('every enhanced entry declares which it is',
     index.filter(i => i.kind === 'enhanced' && i.specific === undefined).length, 0);
}
is('nothing is left without an action',
   index.filter(i => !i.action).length, 0);
is('every entry cites where it came from',
   index.filter(i => !i.source).length, 0);

// ---------------------------------------------------------------- nothing
is('an empty query returns nothing', search(index, '').matches.length, 0);
is('and says so', search(index, '').kind, 'empty');
is('a query matching nothing returns nothing',
   search(index, 'zzzzqqqq').matches.length, 0);

if (fails.length) {
  console.error('\nlookup failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  lookup ok (${pass} assertions over ${index.length} entries)`);
