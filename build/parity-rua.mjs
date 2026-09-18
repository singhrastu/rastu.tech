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
import { parseReport, aggregate, aligns, organisational, VERDICT } from './js/rua.js';

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

if (fails.length) {
  console.error('\nDMARC reader failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  dmarc reader ok (${pass} assertions)`);
