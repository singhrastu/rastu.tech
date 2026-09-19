/* Tests for the blocklist check.
 *
 *     node build/parity-bl.mjs
 *
 * The whole point of this tool is refusing to answer when the list it asked is
 * not answering properly, so most of these are about the ways a list fails
 * rather than about the ways an address is listed.
 */
import { check, checkDomain, classify, canaryVerdict, reverseV4, isReservedV4,
         isV6, LISTS, DOMAIN_LISTS, UNQUERYABLE, UNQUERYABLE_DOMAIN,
         explainCodes, SPAMHAUS_CODES }
  from './js/bl.js';

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};

// --------------------------------------------------------------- addressing
is('an address is reversed for the query', reverseV4('203.0.113.9'), '9.113.0.203');
is('an octet over 255 is not an address', reverseV4('203.0.113.999'), null);
is('nor is a hostname', reverseV4('mail.example.com'), null);
is('private space is recognised', isReservedV4('192.168.1.1'), true);
is('and loopback', isReservedV4('127.0.0.1'), true);
is('and carrier grade NAT', isReservedV4('100.64.0.1'), true);
is('a routable address is not', isReservedV4('203.0.113.9'), false);
is('v6 is detected', isV6('2001:db8::1'), true);

// ------------------------------------------------------- the RFC 5782 gate
/* 127.0.0.2 MUST be listed and 127.0.0.1 MUST NOT be. Everything below is a way
   for a list to fail that test, and each one produces a different wrong answer
   in a checker that does not run it. */
is('a conformant list passes',
   canaryVerdict(['127.0.0.2'], []).state, 'conformant');
is('a dead zone is caught',
   canaryVerdict([], []).state, 'silent');
is('a list refusing the resolver is caught',
   canaryVerdict(['127.255.255.254'], ['127.255.255.254']).state, 'refusing');
is('an inverted list is caught',
   canaryVerdict([], ['127.0.0.1']).state, 'inverted');
is('an incomplete probe is not a verdict',
   canaryVerdict(null, []).state, 'unreachable');
is('and neither is the other half missing',
   canaryVerdict(['127.0.0.2'], null).state, 'unreachable');
is('every failure explains itself',
   [canaryVerdict([], []), canaryVerdict(['1'], ['1']), canaryVerdict(null, null)]
     .every(v => v.why.length > 40), true);

// ------------------------------------------------- what each failure produces
const zone = (z) => [{ zone: z, name: z, delist: '', note: '' }];
const answers = (map) => async (name) => (name in map ? map[name] : []);
/* Spamhaus is always prepended to the rows, so a test finds its list by zone
   rather than by position. */
const only = (r, z) => r.rows.find(x => x.zone === z);

{
  // A decommissioned zone answers nothing to everything, which is
  // indistinguishable from "you are clean" without the probe. This is what
  // happened to every checker still querying SORBS after June 2024.
  const r = await check('203.0.113.9', answers({}), zone('dead.test'));
  is('a dead zone yields no clean verdict', only(r, 'dead.test').state, 'undetermined');
  is('and says the zone is silent', only(r, 'dead.test').canary.state, 'silent');
  is('and the address is not reported as clean', r.clean.length, 0);
  is('and the overall verdict refuses to conclude', r.verdict.severity, 'warn');
}
{
  // Spamhaus answers 127.255.255.254 to every query from a public resolver,
  // including the address that must never be listed. A checker counting any A
  // record as a hit reports the whole internet as blocked.
  const refusing = answers({
    '2.0.0.127.refuse.test': ['127.255.255.254'],
    '1.0.0.127.refuse.test': ['127.255.255.254'],
    '9.113.0.203.refuse.test': ['127.255.255.254'],
  });
  const r = await check('203.0.113.9', refusing, zone('refuse.test'));
  is('a refusing list is not read as a listing', r.listed.length, 0);
  is('it is undetermined instead', only(r, 'refuse.test').state, 'undetermined');
  is('and the reason names the resolver', only(r, 'refuse.test').canary.state, 'refusing');
}
{
  const good = answers({
    '2.0.0.127.good.test': ['127.0.0.2'],
    '9.113.0.203.good.test': ['127.0.0.4'],
  });
  const r = await check('203.0.113.9', good, zone('good.test'));
  is('a real listing is reported', only(r, 'good.test').state, 'listed');
  is('with the return code kept', only(r, 'good.test').codes, ['127.0.0.4']);
  is('and the verdict is critical', r.verdict.severity, 'critical');
}
{
  const good = answers({ '2.0.0.127.good.test': ['127.0.0.2'] });
  const r = await check('203.0.113.9', good, zone('good.test'));
  is('a clean address on a working list is clean', only(r, 'good.test').state, 'clean');
  /* Not an unqualified pass. Spamhaus ZEN cannot be reached from a browser
     either, so the same caveat applies to addresses as to domains. */
  is('but the verdict is qualified, because ZEN was not asked',
     r.verdict.state, 'partial');
  is('and it names what was missed', r.verdict.text.includes('Spamhaus'), true);
}
{
  // The list is healthy but this one query failed. That is not a clean result.
  const flaky = async (name) => (name.startsWith('9.113.0.203.') ? null
    : name.startsWith('2.0.0.127.') ? ['127.0.0.2'] : []);
  const r = await check('203.0.113.9', flaky, zone('flaky.test'));
  is('a failed query on a healthy list is undetermined', only(r, 'flaky.test').state, 'undetermined');
  is('and is never counted as clean', r.clean.length, 0);
}

// ------------------------------------------------------------- unsupported
is('IPv6 is declined rather than half-checked',
   (await check('2001:db8::1', answers({}))).supported, false);
is('and says why',
   (await check('2001:db8::1', answers({}))).reason.includes('almost no blocklist'), true);
is('private space is declined',
   (await check('192.168.1.1', answers({}))).supported, false);
is('a hostname is declined',
   (await check('mail.example.com', answers({}))).supported, false);

// ------------------------------------------------------------- the corpus
is('every list has a delisting route',
   LISTS.filter(l => !l.delist).map(l => l.zone), []);
is('every list explains what it means',
   LISTS.filter(l => (l.note || '').length < 40).map(l => l.zone), []);
is('every unqueryable list explains why it is not queried',
   UNQUERYABLE.filter(l => (l.reason || '').length < 60).map(l => l.zone), []);
is('Spamhaus is named rather than quietly omitted',
   UNQUERYABLE.some(l => /spamhaus/i.test(l.zone)), true);
is('no Spamhaus zone is queried through a public resolver',
   LISTS.filter(l => /spamhaus|abuseat/i.test(l.zone)).map(l => l.zone), []);

// ------------------------------------------------------------ domain lists
/* Domain lists use the RFC 2606 reserved names as probes: TEST must be listed,
   INVALID must not. That catches a failure the IP side rarely produces, because
   a retired domain zone tends to be wildcarded to positive rather than switched
   off. AHBL did exactly that in 2015 to force people to stop querying it, so
   every checker without the probe reports every domain on earth as listed. */
const dzone = (z) => [{ zone: z, name: z, delist: '', note: '' }];

is('a domain is classified as a domain', classify('example.com').kind, 'domain');
is('and normalised', classify('HTTPS://Example.COM/path').value, 'example.com');
is('an address is classified as an address', classify('203.0.113.9').kind, 'ipv4');
is('v6 is recognised separately', classify('2001:db8::1').kind, 'ipv6');
is('a bare word is neither', classify('blah').kind, 'bad');
is('an empty box is empty', classify('   ').kind, 'empty');
is('an address with a bad octet is not an address', classify('203.0.113.999').kind, 'bad');

{
  const wildcarded = async (name) => ['127.0.0.2'];   // answers everything
  const r = await checkDomain('example.com', wildcarded, dzone('ahbl.test'));
  is('a wildcarded zone is not read as a listing', r.listed.length, 0);
  const ahbl = r.rows.find(x => x.zone === 'ahbl.test');
  is('it is undetermined', ahbl.state, 'undetermined');
  is('because it answered for INVALID', ahbl.canary.state, 'refusing');
}
{
  const good = async (name) => (name.startsWith('TEST.') ? ['127.0.0.2']
    : name.startsWith('bad-domain.test.') ? ['127.0.1.2'] : []);
  const row = (r, z) => r.rows.find(x => x.zone === z);
  const listed = await checkDomain('bad-domain.test', good, dzone('test.'));
  is('a real domain listing is reported', row(listed, 'test.').state, 'listed');
  is('with its return code', row(listed, 'test.').codes, ['127.0.1.2']);
  const cleanRes = await checkDomain('good-domain.test', good, dzone('test.'));
  is('and a clean domain is clean', row(cleanRes, 'test.').state, 'clean');
}
{
  const dead = async () => [];
  const r = await checkDomain('example.com', dead, dzone('dead.test'));
  is('a silent domain zone yields no clean verdict',
     r.rows.find(x => x.zone === 'dead.test').state, 'undetermined');
  is('and the overall verdict refuses to conclude', r.verdict.severity, 'warn');
}
is('every domain list has a delisting route',
   DOMAIN_LISTS.filter(l => !l.delist).map(l => l.zone), []);
is('every domain list explains what it means',
   DOMAIN_LISTS.filter(l => (l.note || '').length < 40).map(l => l.zone), []);
is('the Spamhaus domain list is named rather than omitted',
   UNQUERYABLE_DOMAIN.some(l => /spamhaus/i.test(l.zone)), true);
is('and no Spamhaus zone is queried through a public resolver',
   DOMAIN_LISTS.filter(l => /spamhaus/i.test(l.zone)).map(l => l.zone), []);

// -------------------------------------- a verdict accounts for what was skipped
/* The canary stops a broken list from speaking. The headline then has to
   remember it was there at all, or the page reports "clean" while the list that
   actually decides delivery was never asked. bettywins.com is listed by Spamhaus
   and by none of the six domain lists reachable from a browser, so the honest
   answer is "not listed on what answered", not "clean". */
{
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const r = await checkDomain('bettywins.com', good);
  is('an unqueryable list downgrades the verdict', r.verdict.state, 'partial');
  is('and it is not reported as a pass', r.verdict.severity, 'warn');
  is('the word clean is never used', /\bclean\b/i.test(r.verdict.text), false);
  is('and the gap is named', r.verdict.text.includes('Spamhaus'), true);
  is('the skipped lists are carried on the result', r.missing.length > 0, true);
}
{
  // With nothing missing, an unqualified pass is allowed again.
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const r = await checkDomain('example.com', good, DOMAIN_LISTS);
  const none = { ...r };
  is('the verdict names the count that answered',
     r.verdict.text.startsWith('Not listed on the 6'), true);
}
{
  const listing = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2']
    : n.startsWith('bad.test.') ? ['127.0.1.2'] : []);
  const r = await checkDomain('bad.test', listing,
    [{ zone: 'test.', name: 'test', delist: 'x', note: 'y'.repeat(45) }]);
  is('an actual listing still outranks the caveat', r.verdict.state, 'listed');
  is('and is critical', r.verdict.severity, 'critical');
}

// --------------------------------------------- Spamhaus is a row, not a footnote
/* Six green rows with the important list missing from the page is how somebody
   concludes they are fine. It appears in the table either way: as a result when
   a key is configured, and as "not checked" when there is none. */
{
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const r = await checkDomain('bettywins.com', good);
  is('Spamhaus is the first row', /spamhaus/i.test(r.rows[0].name), true);
  is('and is marked not checked', r.rows[0].state, 'not-checked');
  is('and is never counted as clean', r.clean.some(x => /spamhaus/i.test(x.name)), false);
  is('the verdict stays qualified', r.verdict.state, 'partial');
}
{
  // A key that works and reports a listing.
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const dqs = async () => ({ up: ['127.0.1.2'], down: [], answers: ['127.0.1.4'] });
  const r = await checkDomain('bettywins.com', good, undefined, dqs);
  is('with a key the listing is reported', r.rows[0].state, 'listed');
  is('and the verdict follows it', r.verdict.state, 'listed');
  is('and it is critical', r.verdict.severity, 'critical');
}
{
  // A revoked key, or one past its quota, must not read as clean.
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const dead = async () => ({ up: [], down: [], answers: [] });
  const r = await checkDomain('bettywins.com', good, undefined, dead);
  is('a key that fails its own probe is undetermined', r.rows[0].state, 'undetermined');
  is('and is not counted as clean', r.clean.some(x => /spamhaus/i.test(x.name)), false);
}
{
  // The canary runs through the key too: a key answering everything is as
  // dangerous as the public zone doing it.
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const wild = async () => ({ up: ['127.255.255.254'], down: ['127.255.255.254'], answers: ['127.255.255.254'] });
  const r = await checkDomain('bettywins.com', good, undefined, wild);
  is('a key answering everything is caught', r.rows[0].state, 'undetermined');
  is('as a refusal', r.rows[0].canary.state, 'refusing');
}
{
  const answersIp = (map) => async (name) => (name in map ? map[name] : []);
  const r = await check('203.0.113.9', answersIp({ '2.0.0.127.bl.spamcop.net': ['127.0.0.2'] }));
  is('the address path carries Spamhaus ZEN too', /zen/i.test(r.rows[0].name), true);
  is('marked not checked without a key', r.rows[0].state, 'not-checked');
}

// ------------------------------------------------- the return code is the answer
/* Being listed is half the information. "Low reputation" and "abused legitimate"
   are both listings and they mean opposite things about whose fault it is: the
   first says the domain exists to send spam, the second says somebody broke into
   a real site and it is now serving it. The remediation differs completely, and
   printing 127.0.1.2 and stopping throws that away. */
is('a spam domain code is named', explainCodes(['127.0.1.2'])[0].label, 'Low reputation');
is('an abused legitimate domain is distinguished from it',
   explainCodes(['127.0.1.102'])[0].label, 'Abused legitimate');
is('and says to find the hole first',
   explainCodes(['127.0.1.102'])[0].detail.includes('close the hole'), true);
is('PBL is explained as policy rather than reputation',
   explainCodes(['127.0.0.10'])[0].detail.includes('should not send mail directly'), true);
is('DROP says a single address cannot be fixed',
   explainCodes(['127.0.0.9'])[0].detail.includes('whole netblock'), true);
is('a refusal is not presented as a listing',
   explainCodes(['127.255.255.254'])[0].label, 'Not a listing');
is('an unknown code is admitted rather than guessed',
   explainCodes(['127.0.9.9'])[0].label, 'Unrecognised code');
is('every documented code carries an explanation',
   Object.values(SPAMHAUS_CODES).filter(([, d]) => d.length < 25).length, 0);
{
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const dqs = async () => ({ up: ['127.0.1.2'], down: [], answers: ['127.0.1.102'] });
  const r = await checkDomain('compromised.test', good, undefined, dqs);
  is('a listing carries its decoded meaning', r.rows[0].meanings[0].label,
     'Abused legitimate');
}

// ------------------------------------------- a refusal is not a clean result
/* The endpoint can decline before it looks anything up: too many checks from one
   address, or a missing challenge token. Both come back as an error rather than
   as an empty answer set, and an empty answer set is what "not listed" looks
   like. Reading one as the other is the whole failure this tool exists to stop,
   so a refusal is undetermined. */
{
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  for (const refusal of ['blocked:rate limited', 'blocked:challenge required']) {
    const dqs = async () => refusal;
    const r = await checkDomain('example.com', good, undefined, dqs);
    is(`${refusal} is undetermined`, r.rows[0].state, 'undetermined');
    is('and never clean', r.clean.some(x => /spamhaus/i.test(x.name)), false);
    is('and says it was refused rather than asked',
       r.rows[0].canary.state, 'throttled');
  }
}

// ---------------------------- a list that could not answer is the same hole
/* A list that was never asked and a list that could not answer leave the same
   gap in the result. Only the unasked ones were downgrading the verdict, so a
   refused Spamhaus lookup produced an unqualified "not listed" while the most
   important row sat in the table saying it had no idea. */
{
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const refused = async () => 'blocked:challenge required';
  const r = await checkDomain('bettywins.com', good, undefined, refused);
  is('a refused Spamhaus lookup qualifies the verdict', r.verdict.state, 'partial');
  is('and it is a warning, not a pass', r.verdict.severity, 'warn');
  is('and the gap is named', r.verdict.text.includes('Spamhaus'), true);
}
{
  // A dead ordinary list counts too, not only Spamhaus.
  const dqs = async () => ({ up: ['127.0.1.2'], down: [], answers: [] });
  const halfDead = async (n) => (n.startsWith('TEST.dead.test') ? [] :
    n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const r = await checkDomain('example.com', halfDead,
    [{ zone: 'dead.test', name: 'Dead list', delist: 'x', note: 'y'.repeat(45) },
     { zone: 'live.test', name: 'Live list', delist: 'x', note: 'y'.repeat(45) }],
    dqs);
  is('a silent ordinary list also qualifies it', r.verdict.state, 'partial');
  is('and it is named', r.verdict.text.includes('Dead list'), true);
}
{
  // Everything answered and nothing is missing: an unqualified pass is allowed.
  const good = async (n) => (n.startsWith('TEST.') ? ['127.0.0.2'] : []);
  const dqs = async () => ({ up: ['127.0.1.2'], down: [], answers: [] });
  const r = await checkDomain('example.com', good, undefined, dqs);
  is('with every list answering the verdict is unqualified',
     r.verdict.state, 'not-listed');
  is('and it is a pass', r.verdict.severity, 'ok');
  is('with no gap sentence', r.verdict.text.includes('did not answer'), false);
}

// -------------------------------- a name that does not exist is not checked
/* "Not listed on the 7 lists that answered" is true of every domain nobody
   owns, and it reads as a clean bill of health. Somebody checking a typo of
   their own domain takes the reassurance and leaves. The question is asked
   before any list is, so a name that does not resolve costs nothing and
   produces no verdict to misread. */
{
  let lookups = 0, spamhaus = 0;
  const counting = async (n) => { lookups++; return n.startsWith('TEST.') ? ['127.0.0.2'] : []; };
  const dqs = async () => { spamhaus++; return { up: ['127.0.1.2'], down: [], answers: [] }; };

  const gone = await checkDomain('blabla123321.com', counting, undefined, dqs,
                                 async () => 'nxdomain');
  is('a non-existent domain is not checked', gone.supported, false);
  is('and says why', gone.nxdomain, true);
  is('and no list was queried', lookups, 0);
  is('and no Spamhaus query was spent', spamhaus, 0);
  is('and there is no verdict to misread', gone.verdict, undefined);

  lookups = 0; spamhaus = 0;
  const real = await checkDomain('bettywins.com', counting, undefined, dqs,
                                 async () => 'exists');
  is('a real domain is checked', real.supported, true);
  is('and the lists are queried', lookups > 0, true);

  // A resolver having a bad minute must never declare a live domain dead.
  lookups = 0;
  const unsure = await checkDomain('bettywins.com', counting, undefined, dqs,
                                   async () => 'undetermined');
  is('an undetermined existence check does not block the run', unsure.supported, true);
  is('and the lists are still queried', lookups > 0, true);

  // Without the check wired in at all, behaviour is unchanged.
  lookups = 0;
  const noGate = await checkDomain('bettywins.com', counting, undefined, dqs);
  is('no existence check means no change', noGate.supported, true);
  is('and the lists are queried as before', lookups > 0, true);
}

if (fails.length) {
  console.error('\nblocklist failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  blocklist ok (${pass} assertions over ${LISTS.length} address lists `
  + `and ${DOMAIN_LISTS.length} domain lists)`);
