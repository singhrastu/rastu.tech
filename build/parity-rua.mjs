/* Tests for the DMARC report reader.
 *
 *     node build/parity-rua.mjs
 *
 * The reader is fully deterministic - no network, no clock - so it is more
 * testable than the domain auditor, and the cases below are the ones where
 * getting it wrong would mean telling somebody to change a DMARC policy for the
 * wrong reason.
 */
import { DOMParser } from './xmlshim.mjs';
import { parseReport, aggregate, aligns, organisational, VERDICT,
         simulateReject, findingsFor } from './js/rua.js';

let pass = 0;
const fails = [];
const is = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};

// ---------------------------------------------------------------- alignment
is('relaxed alignment on a subdomain', aligns('bounce.example.com', 'example.com', 'r'), true);
is('strict alignment rejects a subdomain', aligns('bounce.example.com', 'example.com', 's'), false);
is('strict alignment accepts an exact match', aligns('example.com', 'example.com', 's'), true);
is('relaxed across an unrelated domain', aligns('esp.net', 'example.com', 'r'), false);
is('relaxed under a known multi-label suffix',
   aligns('mail.example.co.uk', 'example.co.uk', 'r'), true);
// Last-two-labels is the documented heuristic for any suffix outside the table,
// and it is right for every single-label TLD.
is('unknown single-label tld falls back to last two labels',
   organisational('a.b.example.qqqq'), 'example.qqqq');
is('a name that IS a public suffix has no organisation below it',
   organisational('co.uk'), null);
is('alignment is undetermined when one side has no organisational domain',
   aligns('co.uk', 'example.co.uk', 'r'), null);
is('organisational domain', organisational('a.b.example.co.uk'), 'example.co.uk');
is('a bare hostname has none', organisational('localhost'), null);

// ------------------------------------------------------------------ reports
const report = (rows, opts = {}) => `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>${opts.org || 'google.com'}</org_name>
    <email>noreply-dmarc@google.com</email><report_id>1</report_id>
    <date_range><begin>1758153600</begin><end>1758240000</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><p>${opts.p || 'reject'}</p>
    <adkim>${opts.adkim || 'r'}</adkim><aspf>${opts.aspf || 'r'}</aspf><pct>100</pct>
  </policy_published>
  ${rows}
</feedback>`;

const row = (o) => `<record><row><source_ip>${o.ip}</source_ip><count>${o.count}</count>
  <policy_evaluated><disposition>${o.disp || 'none'}</disposition>
    <dkim>${o.rdkim || 'fail'}</dkim><spf>${o.rspf || 'fail'}</spf>
    ${(o.reasons || []).map(t => `<reason><type>${t}</type><comment/></reason>`).join('')}
  </policy_evaluated></row>
  <identifiers><header_from>${o.from}</header_from></identifiers>
  <auth_results>
    ${(o.dkim || []).map(d =>
      `<dkim><domain>${d[0]}</domain><selector>${d[1]}</selector><result>${d[2]}</result></dkim>`).join('')}
    ${(o.spf || []).map(s =>
      `<spf><domain>${s[0]}</domain><scope>mfrom</scope><result>${s[1]}</result></spf>`).join('')}
  </auth_results></record>`;

const parse = (xml) => parseReport(xml, DOMParser);
const one = (rows, opts) => aggregate([parse(report(rows, opts))]);

// THE case this tool exists for: SPF authenticates but does not align. The raw
// result is pass and the DMARC result is fail, and they need different fixes.
{
  const a = one(row({ ip: '192.0.2.1', count: 100, from: 'example.com',
                      spf: [['esp-bounces.net', 'pass']], rspf: 'pass' }));
  is('spf passes raw but does not align', a.sources[0].verdict, 'none');
  is('and the reporter disagreeing is surfaced', a.totals.disagreements, 100);
}

{
  const a = one(row({ ip: '192.0.2.2', count: 50, from: 'example.com',
                      spf: [['mail.example.com', 'pass']], rspf: 'pass' }));
  is('spf aligned but no dkim', a.sources[0].verdict, 'spf');
  is('spf-only is a warning, not a pass', VERDICT[a.sources[0].verdict][0], 'warn');
}

{
  const a = one(row({ ip: '192.0.2.3', count: 20, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['fwd.net', 'fail']] }));
  is('dkim aligned and spf failed', a.sources[0].verdict, 'dkim');
}

{
  const a = one(row({ ip: '192.0.2.4', count: 7, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['fwd.net', 'fail']], reasons: ['forwarded'] }));
  is('a receiver saying forwarded is reported as forwarded', a.sources[0].verdict, 'forward');
}

{
  const a = one(row({ ip: '192.0.2.5', count: 900, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['example.com', 'pass']], rspf: 'pass' }));
  is('both aligned', a.sources[0].verdict, 'both');
  is('aligned volume counted', a.totals.aligned, 900);
  is('nothing failing', a.totals.failing, 0);
}

{
  const a = one(row({ ip: '192.0.2.6', count: 5, from: 'example.com',
                      dkim: [['sub.example.com', 's1', 'pass']], rdkim: 'pass' }),
                { adkim: 's' });
  is('strict adkim rejects the subdomain signature', a.sources[0].verdict, 'none');
}

// Sorting: the biggest failing source outranks a bigger passing one, because the
// biggest sender is rarely the problem and the biggest failing sender always is.
{
  const a = one(row({ ip: '192.0.2.7', count: 10000, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['example.com', 'pass']], rspf: 'pass' })
              + row({ ip: '192.0.2.8', count: 3, from: 'example.com' }));
  is('failing sources sort first', a.sources.map(s => s.ip), ['192.0.2.8', '192.0.2.7']);
  is('two distinct sources', a.totals.sources, 2);
}

// A source that is mostly fine with a failing tail must not read as clean.
{
  const a = one(row({ ip: '192.0.2.9', count: 500, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['example.com', 'pass']], rspf: 'pass' })
              + row({ ip: '192.0.2.9', count: 4, from: 'example.com' }));
  is('one source, worst verdict wins', a.sources.length, 1);
  is('and it is the failing one', a.sources[0].verdict, 'none');
  is('counts still add up', a.sources[0].count, 504);
}

// ------------------------------------------------------------------ refusals
const throws = (name, fn, needle) => {
  try { fn(); fails.push(`${name}: did not throw`); }
  catch (e) {
    if (e.message.includes(needle)) pass++;
    else fails.push(`${name}: wrong message: ${e.message}`);
  }
};
throws('malformed xml is refused', () => parse('<feedback><record></feedback>'), 'not valid XML');
throws('a non-report is refused', () => parse('<html><body/></html>'), 'not a DMARC aggregate report');
is('an empty report parses to zero rows', parse(report('')).rows.length, 0);

// Multiple reporters merge into one view.
{
  const a = aggregate([parse(report(row({ ip: '192.0.2.10', count: 5, from: 'example.com' }),
                                    { org: 'google.com' })),
                       parse(report(row({ ip: '192.0.2.10', count: 6, from: 'example.com' }),
                                    { org: 'yahoo.com' }))]);
  is('two reporters, one source', a.sources.length, 1);
  is('volumes combine', a.sources[0].count, 11);
  is('both reporters named', a.reporters.sort(), ['google.com', 'yahoo.com']);
}

// ------------------------------------------------- override reasons vs forwarding
// The worst bug this file has caught. RFC 7489 override reasons split into two
// groups meaning opposite things: forwarded/mailing_list/trusted_forwarder say a
// forwarder broke SPF and that is expected; local_policy/sampled_out/other say
// the receiver declined to apply the policy for reasons of its own. Treating the
// second group as forwarding renders a completely unauthenticated source as
// "Expected, not a problem" and hides it.
{
  const a = one(row({ ip: '10.0.0.1', count: 400, from: 'example.com',
                      reasons: ['local_policy'] }));
  is('local_policy is not forwarding', a.sources[0].verdict, 'none');
  is('and it still counts as failing', a.totals.failing, 400);
  is('and it is surfaced as an override', a.totals.overridden, 400);
}
{
  const a = one(row({ ip: '10.0.0.2', count: 7, from: 'example.com',
                      reasons: ['sampled_out'] }));
  is('sampled_out is not forwarding', a.sources[0].verdict, 'none');
}
{
  const a = one(row({ ip: '10.0.0.3', count: 7, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      reasons: ['mailing_list'] }));
  is('mailing_list is forwarding', a.sources[0].verdict, 'forward');
}

// ------------------------------------------------------------- the totals add up
// DMARC passes on SPF alignment OR DKIM alignment. Counting only 'both' and
// 'dkim' as aligned left an unexplained remainder in the headline.
{
  const a = one(row({ ip: '11.0.0.1', count: 100, from: 'example.com',
                      spf: [['example.com', 'pass']], rspf: 'pass' })
              + row({ ip: '11.0.0.2', count: 50, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass' })
              + row({ ip: '11.0.0.3', count: 25, from: 'example.com' }));
  is('spf-only counts as aligned, because DMARC passes on it', a.totals.aligned, 150);
  is('and the remainder is the failing count', a.totals.failing, 25);
  is('aligned plus failing equals the total',
     a.totals.aligned + a.totals.failing, a.totals.total);
}

// --------------------------------------------------- reporter disagreement, per mechanism
{
  // The reporter claims spf passed and dkim failed; the evidence says the
  // opposite on both. Collapsing each side to one boolean called this agreement.
  const a = one(row({ ip: '12.0.0.1', count: 30, from: 'example.com',
                      rspf: 'pass', rdkim: 'fail',
                      dkim: [['example.com', 's1', 'pass']],
                      spf: [['unrelated.net', 'pass']] }));
  is('opposite verdicts on both mechanisms is a disagreement',
     a.totals.disagreements, 30);
}
{
  const a = one(row({ ip: '12.0.0.2', count: 30, from: 'example.com',
                      rdkim: 'pass', dkim: [['example.com', 's1', 'pass']] }));
  is('agreement is not flagged', a.totals.disagreements, 0);
}

// ------------------------------------------------------------------ bad counts
// A missing or unreadable <count> used to become 0, producing a confident
// "0 messages from 340 sources, 0% aligned".
throws('a record with no count is refused',
  () => parse(report('<record><row><source_ip>1.1.1.1</source_ip>'
    + '<policy_evaluated><disposition>none</disposition></policy_evaluated></row>'
    + '<identifiers><header_from>example.com</header_from></identifiers>'
    + '<auth_results/></record>')), 'unreadable');
throws('a record with a non-numeric count is refused',
  () => parse(report(row({ ip: '1.1.1.1', count: 'lots', from: 'example.com' }))),
  'unreadable');
is('a legitimate zero count is kept',
   parse(report(row({ ip: '1.1.1.1', count: 0, from: 'example.com' }))).rows[0].count, 0);

// ---------------------------------------------------------------- p=reject
// The differentiator, so it gets the most careful tests. The distinction that
// matters: a forwarded message that kept aligned DKIM still passes DMARC and is
// not at risk, while a forwarded message that aligned on nothing is at risk but
// may survive a receiver's local override. Those are three different numbers.
{
  const a = one(
    row({ ip: '1.1.1.1', count: 1000, from: 'example.com',
          dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
          spf: [['example.com', 'pass']], rspf: 'pass' })
  + row({ ip: '2.2.2.2', count: 100, from: 'example.com' })
  + row({ ip: '3.3.3.3', count: 50, from: 'example.com', reasons: ['forwarded'] })
  + row({ ip: '4.4.4.4', count: 30, from: 'example.com',
          dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
          spf: [['fwd.net', 'fail']], reasons: ['forwarded'] }),
    { p: 'none' });
  const sim = simulateReject(a);
  is('certain rejections exclude forwarded', sim.certain, 100);
  is('possible rejections include forwarded', sim.possible, 150);
  is('forwarded-but-DKIM-aligned is not at risk', sim.forwarded, 50);
  is('percentages are of the whole report', sim.pctCertain, 8.5);
  is('at-risk sources are listed worst first',
     sim.sources.map(s => s.ip), ['2.2.2.2', '3.3.3.3']);
}
{
  const a = one(row({ ip: '1.1.1.1', count: 10, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass' }));
  is('a fully aligned report risks nothing', simulateReject(a).possible, 0);
}

// ---------------------------------------------------------------- findings
const titles = fs => fs.map(f => f.title);
const own = (fs, needle) => fs.find(f => f.title.includes(needle))?.owner;

{
  const a = one(row({ ip: '9.9.9.9', count: 500, from: 'example.com' }), { p: 'none' });
  const fs = findingsFor(a);
  is('p=none is reported', Boolean(fs.find(f => f.title.includes('p=none'))), true);
  is('and it is the reader\'s to fix', own(fs, 'p=none'), 'you');
  is('an unauthenticated source is critical at volume',
     fs.find(f => f.scope === 'Source').severity, 'critical');
  is('and it is theirs', own(fs, 'authenticates as neither'), 'you');
}
{
  // Forwarding must be attributed away from the reader, or they go and "fix"
  // something that is working exactly as designed.
  const a = one(row({ ip: '3.3.3.3', count: 40, from: 'example.com',
                      reasons: ['forwarded'] }), { p: 'reject' });
  const fs = findingsFor(a);
  is('forwarding is not the reader\'s problem', own(fs, 'forwarded'), 'intermediary');
  is('and it carries no action', fs.find(f => f.scope === 'Forwarding').fix.includes('Nothing to change'), true);
}
{
  const a = one(row({ ip: '5.5.5.5', count: 80, from: 'example.com',
                      spf: [['example.com', 'pass']], rspf: 'pass' }));
  const fs = findingsFor(a);
  is('spf-only is flagged', Boolean(fs.find(f => f.scope === 'DKIM')), true);
  is('as a warning, not a failure', fs.find(f => f.scope === 'DKIM').severity, 'warn');
}
{
  const a = one(row({ ip: '6.6.6.6', count: 5, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass',
                      spf: [['example.com', 'pass']], rspf: 'pass' }),
                { p: 'reject' });
  const fs = findingsFor(a);
  is('a clean report says so', fs.length, 1);
  is('and says it is clean', fs[0].severity, 'ok');
}
{
  const a = one(row({ ip: '7.7.7.7', count: 5, from: 'example.com',
                      dkim: [['example.com', 's1', 'pass']], rdkim: 'pass' }),
                { p: 'reject' });
  // sp=none under an enforcing policy is the quietest serious misconfiguration
  // there is, so it must come out as critical.
  const withSp = aggregate([parse(report(
    row({ ip: '7.7.7.7', count: 5, from: 'example.com',
          dkim: [['example.com', 's1', 'pass']], rdkim: 'pass' }),
    { p: 'reject' }))]);
  withSp.policy.sp = 'none';
  const fs = findingsFor(withSp);
  is('sp=none while enforcing is critical',
     fs.find(f => f.title.includes('Subdomains')).severity, 'critical');
}
{
  const a = one(row({ ip: '8.8.8.8', count: 9, from: 'example.com' }));
  a.policy.pct = '20';
  const fs = findingsFor(a);
  is('partial pct is flagged', Boolean(fs.find(f => f.title.includes('pct=20'))), true);
}

// Source memory: the point is that the second report shows what changed.
{
  const a = one(row({ ip: '1.2.3.4', count: 10, from: 'example.com' })
              + row({ ip: '5.6.7.8', count: 10, from: 'example.com' }));
  const known = new Set(['1.2.3.4|example.com']);
  const fs = findingsFor(a, { known });
  const nu = fs.find(f => f.scope === 'New');
  is('unseen sources are called out', Boolean(nu), true);
  is('and only the unseen ones', nu.detail.includes('5.6.7.8') && !nu.detail.includes('1.2.3.4'), true);
  is('with no memory, nothing is called new',
     Boolean(findingsFor(a).find(f => f.scope === 'New')), false);
}

if (fails.length) {
  console.error('\nDMARC reader failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  dmarc reader ok (${pass} assertions)`);
