/* Tests for "is this a domain, and does it exist".
 *
 *     node build/parity-domain.mjs
 *
 * Every other check reads an empty DNS answer as "no record", which is the right
 * reading for a domain somebody owns and the wrong one for a typo. A page of
 * failures against blablablaxyz.com reads as findings about a real domain, and
 * somebody acts on them.
 *
 * The risk runs the other way too, and it is the worse of the two: telling a
 * sender their live domain does not exist. So absence is only ever claimed when
 * two resolvers independently agree on NXDOMAIN, and the tests below pin both
 * directions.
 */
import { audit, spfTree, looksLikeDomain } from './js/audit.js';

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};

const noFetch = async () => [null, 'fetch disabled'];
const res = (txt = {}, existence) => ({
  async txt(n) { return txt[n] || []; },
  async mx() { return []; },
  async a() { return []; },
  async ptr() { return []; },
  ...(existence ? { existence: async () => existence } : {}),
});

// ------------------------------------------------------ a name that is absent
{
  const rep = await audit('blablablaxyz.com', res({}, 'nxdomain'), noFetch, ['s1']);
  is('a non-existent domain yields one finding', rep.findings.length, 1);
  is('and it says so plainly', rep.findings[0].finding.includes('does not exist'), true);
  is('and it is a failure', rep.findings[0].severity, 'fail');
  is('and nothing else is reported about it',
     rep.findings.filter(f => f.check !== 'Domain').length, 0);
  const tree = await spfTree('blablablaxyz.com', res({}, 'nxdomain'));
  is('the SPF counter agrees', tree.nxdomain, true);
  is('and offers no record verdict', tree.record, null);
}

// -------------------------------------------- never claimed without agreement
{
  const rep = await audit('example.com',
    res({ 'example.com': ['v=spf1 -all'] }, 'undetermined'), noFetch, ['s1']);
  is('an undetermined lookup never claims absence',
     rep.findings.some(f => f.finding.includes('does not exist')), false);
  is('and the audit runs normally', rep.findings.length > 1, true);
}
{
  const rep = await audit('example.com',
    res({ 'example.com': ['v=spf1 -all'] }, 'exists'), noFetch, ['s1']);
  is('an existing domain is audited', rep.findings.length > 1, true);
}
{
  // The fixture harness and the Python original have no existence check at all.
  // Their behaviour must be exactly what it was before this existed.
  const rep = await audit('example.com', res({ 'example.com': ['v=spf1 -all'] }),
                          noFetch, ['s1']);
  is('a resolver without the check is unaffected',
     rep.findings.some(f => f.finding.includes('does not exist')), false);
  is('and still produces its findings', rep.findings.length > 1, true);
}

// ------------------------------------------------------------ the syntax gate
/* Permissive on purpose. Turning away a valid name in the browser is a worse
   failure than spending two round trips on a bad one, so only rules no hostname
   can break are enforced here and DNS decides the rest. */
for (const good of ['example.com', 'sub.example.co.uk', 'xn--bcher-kva.example',
                    'mail.a-b.example.org', 'a.co']) {
  is(`${good} reaches DNS`, looksLikeDomain(good).ok, true);
}
for (const [bad, why] of [['', 'an empty box'], ['blah', 'no dot'],
                          ['192.0.2.1', 'an IP address'], ['exa mple.com', 'a space'],
                          ['-bad.com', 'a leading hyphen'], ['bad-.com', 'a trailing hyphen'],
                          ['a..b.com', 'an empty label'],
                          ['x'.repeat(64) + '.com', 'an over-long label'],
                          ['café.com', 'a non-ASCII label']]) {
  is(`${why} is refused before any lookup`, looksLikeDomain(bad).ok, false);
}
is('a URL is reduced to its domain',
   looksLikeDomain('https://example.com/path').domain, 'example.com');
is('an address is reduced to its domain',
   looksLikeDomain('user@example.com').domain, 'example.com');
is('a trailing root label is dropped',
   looksLikeDomain('EXAMPLE.COM.').domain, 'example.com');
is('every refusal explains itself',
   ['', 'blah', '192.0.2.1', 'a..b.com'].every(b => (looksLikeDomain(b).reason || '').length >= 10),
   true);
is('and the ones with a cause name it',
   ['blah', '192.0.2.1', 'a..b.com'].every(b => (looksLikeDomain(b).reason || '').length > 30),
   true);

if (fails.length) {
  console.error('\ndomain gate failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  domain gate ok (${pass} assertions)`);
