/* Tests for the shared findings layer.
 *
 *     node build/parity-findings.mjs
 *
 * This module decides the order every tool presents its results in, so getting
 * the ranking wrong would bury the one thing a reader can act on underneath
 * things they cannot.
 */
import { finding, rank, counts, topFixes, verdict, renderFindings, findingsText }
  from './js/findings.js';

let pass = 0; const fails = [];
const is = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const throws = (name, fn, needle) => {
  try { fn(); fails.push(`${name}: did not throw`); }
  catch (e) { e.message.includes(needle) ? pass++ : fails.push(`${name}: ${e.message}`); }
};

const f = (sev, own, extra = {}) =>
  finding({ severity: sev, owner: own, title: `${sev}/${own}`, ...extra });

// Ranking: severity first, and inside a band the reader's own problems first,
// because that is the part they can do something about.
is('ranks severity then owner',
   rank([f('warn', 'you'), f('critical', 'receiver'), f('critical', 'you'), f('info', 'you')])
     .map(x => x.title),
   ['critical/you', 'critical/receiver', 'warn/you', 'info/you']);

is('owner order within a band',
   rank([f('warn', 'unknown'), f('warn', 'receiver'), f('warn', 'intermediary'), f('warn', 'you')])
     .map(x => x.owner),
   ['you', 'intermediary', 'receiver', 'unknown']);

is('counts', counts([f('critical', 'you'), f('critical', 'you'), f('ok', 'you')]),
   { critical: 2, warn: 0, info: 0, ok: 1 });

// A finding with no fix is information, not a task, and must not reach a to-do list.
is('shortlist excludes findings with no fix',
   topFixes([f('critical', 'you'), f('critical', 'you', { fix: 'do the thing' })]).map(x => x.fix),
   ['do the thing']);
is('shortlist excludes other people\'s problems',
   topFixes([f('critical', 'receiver', { fix: 'not yours' })]).length, 0);
is('shortlist excludes ok',
   topFixes([f('ok', 'you', { fix: 'nothing needed' })]).length, 0);
is('shortlist is capped', topFixes(Array.from({ length: 9 },
   () => f('critical', 'you', { fix: 'x' })), 3).length, 3);

// Verdict phrasing, which is the first line a reader sees.
is('clean', verdict([f('ok', 'you')]).text, 'Nothing to fix.');
is('one critical, theirs',
   verdict([f('critical', 'receiver')]).text, '1 critical issue, none of them yours to fix.');
is('one critical, yours',
   verdict([f('critical', 'you')]).text, '1 critical issue, and it is yours.');
is('all yours',
   verdict([f('critical', 'you'), f('warn', 'you')]).text,
   '1 critical and 1 other issue, all of them yours.');
is('mixed ownership',
   verdict([f('critical', 'you'), f('warn', 'receiver'), f('warn', 'intermediary')]).text,
   '1 critical and 2 other issues, 1 of them yours.');
is('warnings only',
   verdict([f('warn', 'receiver'), f('warn', 'receiver')]).text,
   '2 issues worth fixing, none of them yours to fix.');
is('noun is configurable',
   verdict([f('warn', 'you')], 'problem').text, '1 problem worth fixing, and it is yours.');

// A typo in a severity would sort silently to the bottom, so it is a hard error.
throws('rejects an unknown severity', () => f('bad', 'you'), 'unknown severity');
throws('rejects an unknown owner', () => f('warn', 'nobody'), 'unknown owner');
throws('requires a title', () => finding({ severity: 'warn', owner: 'you' }), 'needs a title');

// Rendering: escaping is the one thing here that is a security property, since
// findings carry raw log lines and header values straight from user input.
{
  const html = renderFindings([finding({
    severity: 'critical', owner: 'you', title: 'x',
    evidence: '<script>alert(1)</script>', detail: 'a & b' })]);
  is('escapes evidence', html.includes('<script>'), false);
  is('escapes entities', html.includes('a &amp; b'), true);
}
{
  const html = renderFindings([f('ok', 'you')], { emptyText: 'All good here.' });
  is('empty state uses the given text', html.includes('All good here.'), true);
}
{
  const t = findingsText([f('critical', 'you', { fix: 'do it', detail: 'because' })], 'HEAD');
  is('text output carries the fix', t.includes('fix: do it'), true);
  is('text output carries the owner', t.includes('owner: Your problem'), true);
}

if (fails.length) {
  console.error('\nfindings layer failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  findings layer ok (${pass} assertions)`);
