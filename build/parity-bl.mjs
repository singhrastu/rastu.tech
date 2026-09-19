/* Tests for the blocklist check.
 *
 *     node build/parity-bl.mjs
 *
 * The whole point of this tool is refusing to answer when the list it asked is
 * not answering properly, so most of these are about the ways a list fails
 * rather than about the ways an address is listed.
 */
import { check, checkDomain, classify, canaryVerdict, reverseV4, isReservedV4,
         isV6, LISTS, DOMAIN_LISTS, UNQUERYABLE, UNQUERYABLE_DOMAIN }
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

{
  // A decommissioned zone answers nothing to everything, which is
  // indistinguishable from "you are clean" without the probe. This is what
  // happened to every checker still querying SORBS after June 2024.
  const r = await check('203.0.113.9', answers({}), zone('dead.test'));
  is('a dead zone yields no clean verdict', r.rows[0].state, 'undetermined');
  is('and says the zone is silent', r.rows[0].canary.state, 'silent');
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
  is('it is undetermined instead', r.rows[0].state, 'undetermined');
  is('and the reason names the resolver', r.rows[0].canary.state, 'refusing');
}
{
  const good = answers({
    '2.0.0.127.good.test': ['127.0.0.2'],
    '9.113.0.203.good.test': ['127.0.0.4'],
  });
  const r = await check('203.0.113.9', good, zone('good.test'));
  is('a real listing is reported', r.rows[0].state, 'listed');
  is('with the return code kept', r.rows[0].codes, ['127.0.0.4']);
  is('and the verdict is critical', r.verdict.severity, 'critical');
}
{
  const good = answers({ '2.0.0.127.good.test': ['127.0.0.2'] });
  const r = await check('203.0.113.9', good, zone('good.test'));
  is('a clean address on a working list is clean', r.rows[0].state, 'clean');
  is('and the verdict is ok', r.verdict.severity, 'ok');
}
{
  // The list is healthy but this one query failed. That is not a clean result.
  const flaky = async (name) => (name.startsWith('9.113.0.203.') ? null
    : name.startsWith('2.0.0.127.') ? ['127.0.0.2'] : []);
  const r = await check('203.0.113.9', flaky, zone('flaky.test'));
  is('a failed query on a healthy list is undetermined', r.rows[0].state, 'undetermined');
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
  is('it is undetermined', r.rows[0].state, 'undetermined');
  is('because it answered for INVALID', r.rows[0].canary.state, 'refusing');
}
{
  const good = async (name) => (name.startsWith('TEST.') ? ['127.0.0.2']
    : name.startsWith('bad-domain.test.') ? ['127.0.1.2'] : []);
  const listed = await checkDomain('bad-domain.test', good, dzone('test.'));
  is('a real domain listing is reported', listed.rows[0].state, 'listed');
  is('with its return code', listed.rows[0].codes, ['127.0.1.2']);
  const cleanRes = await checkDomain('good-domain.test', good, dzone('test.'));
  is('and a clean domain is clean', cleanRes.rows[0].state, 'clean');
}
{
  const dead = async () => [];
  const r = await checkDomain('example.com', dead, dzone('dead.test'));
  is('a silent domain zone yields no clean verdict', r.rows[0].state, 'undetermined');
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

if (fails.length) {
  console.error('\nblocklist failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  blocklist ok (${pass} assertions over ${LISTS.length} address lists `
  + `and ${DOMAIN_LISTS.length} domain lists)`);
