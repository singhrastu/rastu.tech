/* Tests for the warm-up PDF writer.
 *
 *     node build/parity-warmup-pdf.mjs
 *
 * A PDF is the one output here that nobody proofreads before it leaves. It gets
 * downloaded, mailed on, and opened by somebody who was not in the room. A file
 * that renders blank, or loses its last page, or silently drops a row of the
 * schedule, is worse than no file at all, and none of those failures show up in
 * a screenshot of the page that produced it.
 *
 * So the structure is checked rather than assumed: the cross-reference table has
 * to point at the objects it claims, every byte has to be inside the range the
 * base fonts can encode, and every row of the schedule has to survive into the
 * text of the document.
 */
import { plan } from './js/warmup.js';
import { planPdf, wrap, widthOf } from './js/warmup-pdf.js';

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const ok = (n, cond) => is(n, !!cond, true);
const throws = (n, fn, needle) => {
  try { fn(); fails.push(`${n}: did not throw`); }
  catch (e) {
    if (String(e.message).includes(needle)) pass++;
    else fails.push(`${n}: threw ${e.message}`);
  }
};

const text = (bytes) => Buffer.from(bytes).toString('latin1');

// ------------------------------------------------------------- measurement
// Wrapping is the whole layout. If the width function is wrong every paragraph
// in the document is wrong with it, in a way that only shows up as text running
// off the edge of a page nobody looked at.
ok('a wider string measures wider',
   widthOf('mmmmm', 'reg', 10) > widthOf('iiiii', 'reg', 10));
ok('bold is wider than regular for the same text',
   widthOf('Hamburgefonstiv', 'bold', 10) > widthOf('Hamburgefonstiv', 'reg', 10));
ok('courier is uniform',
   Math.abs(widthOf('iiii', 'mono', 10) - widthOf('mmmm', 'mono', 10)) < 0.001);
is('an empty string has no width', widthOf('', 'reg', 10), 0);
{
  // Known metric: Helvetica space is 278/1000, so at 100pt it is 27.8pt.
  ok('a known glyph metric is right',
     Math.abs(widthOf(' ', 'reg', 100) - 27.8) < 0.01);
}

{
  const lines = wrap('the quick brown fox jumps over the lazy dog and keeps '
    + 'going for some distance after that', 'reg', 10, 120);
  ok('long text wraps to several lines', lines.length > 3);
  const over = lines.filter(l => widthOf(l, 'reg', 10) > 120);
  is('and no line exceeds the width it was given', over, []);
  is('no words are lost',
     lines.join(' ').split(/\s+/).length,
     'the quick brown fox jumps over the lazy dog and keeps going for some '
     .concat('distance after that').split(/\s+/).length);
}
{
  // A word longer than the column cannot be broken without hyphenation, so it
  // is allowed to overflow rather than vanish. Losing it silently would be worse.
  const lines = wrap('antidisestablishmentarianism', 'reg', 10, 20);
  is('an unbreakable word survives', lines, ['antidisestablishmentarianism']);
}
is('empty input yields one empty line', wrap('', 'reg', 10, 100), ['']);

// ---------------------------------------------------------- file structure
const p = plan({ level: 'ip', target: 1000000, pace: 'standard', ips: 1 });
const bytes = planPdf(p, { brand: 'Example', domain: 'example.com',
                           date: '2026-09-20' });
const doc = text(bytes);

ok('it is a PDF', doc.startsWith('%PDF-1.4'));
ok('and it is terminated', doc.trimEnd().endsWith('%%EOF'));
ok('it has some size', bytes.length > 4000);

{
  // Every byte has to be inside the range the base fonts encode. A stray
  // multi-byte character here is how a PDF ends up rendering a black diamond in
  // the middle of a sentence.
  const bad = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b > 0x7e && b !== 0x0a) bad.push({ at: i, byte: b });
  }
  is('every byte is inside the encodable range', bad.slice(0, 3), []);
}

{
  // The cross-reference table is the part a reader trusts absolutely. If an
  // offset is wrong the file opens blank in some readers and fine in others,
  // which is the worst possible way to be broken.
  const m = doc.match(/startxref\s+(\d+)/);
  ok('there is a startxref', !!m);
  const xrefAt = Number(m[1]);
  ok('it points at the xref keyword', doc.slice(xrefAt, xrefAt + 4) === 'xref');

  const section = doc.slice(xrefAt);
  const count = Number(section.match(/xref\s+0\s+(\d+)/)[1]);
  const entries = [...section.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
  is('the table holds one entry per object plus the free head',
     entries.length, count);

  const bad = [];
  entries.forEach((e, i) => {
    if (e[3] === 'f') return;
    const off = Number(e[1]);
    if (!doc.startsWith(`${i} 0 obj`, off)) {
      bad.push({ object: i, offset: off, found: doc.slice(off, off + 18) });
    }
  });
  is('every offset lands exactly on the object it names', bad, []);
}

{
  const objs = [...doc.matchAll(/^(\d+) 0 obj$/gm)].map(m => Number(m[1]));
  is('object numbers are contiguous from one',
     objs, objs.map((_, i) => i + 1));
  const size = Number(doc.match(/\/Size (\d+)/)[1]);
  is('the trailer size counts every object plus the free head',
     size, objs.length + 1);
}

{
  const kids = (doc.match(/\/Kids \[([^\]]*)\]/) || [, ''])[1].trim().split(/\s+R\s*/)
    .filter(Boolean).length;
  const count = Number(doc.match(/\/Count (\d+)/)[1]);
  const pageObjs = (doc.match(/\/Type \/Page\b/g) || []).length;
  is('the page count matches the kids array', count, kids);
  is('and matches the page objects that exist', pageObjs, count);
  ok('a full plan runs to more than one page', count > 1);
}

{
  // A wrong /Length truncates the stream, and the tail of the page disappears.
  const bad = [];
  const re = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g;
  let m;
  while ((m = re.exec(doc)) !== null) {
    if (Number(m[1]) !== m[2].length) {
      bad.push({ declared: Number(m[1]), actual: m[2].length });
    }
  }
  is('every stream length is the length of its stream', bad, []);
  ok('there is one stream per page', (doc.match(/\bstream\b/g) || []).length >= 2);
}

is('all three fonts are declared',
   ['/Helvetica ', '/Helvetica-Bold', '/Courier'].map(f => doc.includes(f)),
   [true, true, true]);

// --------------------------------------------------------------- contents
const shown = [...doc.matchAll(/\((.*?)\) Tj/g)].map(m => m[1]).join(' ');

ok('the title is on the page', shown.includes('Warm-up plan'));
ok('the brand is carried through', shown.includes('Example'));
ok('and the domain', shown.includes('example.com'));
ok('the date appears in the footer', shown.includes('2026-09-20'));
ok('the schedule is attributed to its publisher',
   shown.includes('SendGrid') || shown.includes('Braze'));
ok('the thresholds are stated', shown.includes('0.30%'));
ok('the recovery section is present', shown.includes('If it goes wrong'));
ok('the derived rollback is labelled as derived',
   /worked out rather than quoted|Derived here/.test(shown));
ok('it says no provider publishes a ramp',
   shown.includes('No mailbox provider publishes a ramp schedule'));
ok('Microsoft and Apple are not given an invented threshold',
   shown.includes('publish no complaint'));

{
  // Every stage has to survive into the document. A page break that drops a row
  // is the failure that would go unnoticed longest.
  const rows = [];
  let prev = null;
  for (const d of p.days) {
    if (!prev || prev.total !== d.total) { rows.push(d); prev = d; }
  }
  const missing = rows.filter(row =>
    !shown.includes(row.total.toLocaleString('en-US')));
  is('every stage volume appears in the document', missing.length, 0);
}
{
  const nums = (doc.match(/\(\d+ of (\d+)\) Tj/g) || []);
  const count = Number(doc.match(/\/Count (\d+)/)[1]);
  is('every page carries a page number', nums.length, count);
  ok('and they all agree on the total',
     new Set(nums.map(n => n.match(/of (\d+)/)[1])).size === 1);
}

// ------------------------------------------------------------- other plans
{
  // Sixty days across twenty stages is the case that exercises pagination.
  const careful = plan({ level: 'ip', target: 222000, pace: 'careful', ips: 3 });
  const d = text(planPdf(careful, {}));
  const count = Number(d.match(/\/Count (\d+)/)[1]);
  ok('a sixty-day plan paginates', count >= 2);
  ok('and shows the per-address column when there is a pool',
     /\(PER ADDR\) Tj/.test(d));
}
{
  const single = plan({ level: 'domain', target: 500 });
  const d = text(planPdf(single, {}));
  ok('a short plan still produces a valid file', d.startsWith('%PDF'));
  ok('and omits the per-address column', !/\(PER ADDR\) Tj/.test(d));
}
{
  const mb = plan({ level: 'mailbox', target: 200, mailboxes: 10 });
  ok('a mailbox plan renders', text(planPdf(mb, {})).includes('Warm-up plan'));
}
{
  // A brand with characters the base fonts cannot encode must not corrupt the
  // file. Folding beats emitting a byte no reader can interpret.
  const d = text(planPdf(p, { brand: 'Caffé “Smørrebrød” — 日本' }));
  ok('an awkward brand does not break the file', d.startsWith('%PDF'));
  const over = [...Buffer.from(d, 'latin1')].filter(b => b > 0x7e && b !== 0x0a);
  is('and introduces no unencodable bytes', over.length, 0);
}
{
  // Parentheses and backslashes end a PDF string early if they are not escaped,
  // which corrupts everything after them.
  const d = text(planPdf(p, { brand: 'A (test) \\ case' }));
  ok('parentheses in input are escaped', d.includes('A \\(test\\) \\\\ case'));
  ok('and the file is still terminated', d.trimEnd().endsWith('%%EOF'));
}

throws('a PDF needs a plan', () => planPdf(null, {}), 'needs a plan');
throws('and a plan with days', () => planPdf({ days: [] }, {}), 'needs a plan');

if (fails.length) {
  console.error('\nwarmup pdf failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  warmup pdf ok (${pass} assertions, `
  + `${(bytes.length / 1024).toFixed(1)} KB for a 21-day plan)`);
