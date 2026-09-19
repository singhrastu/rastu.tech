/* Tests for the warm-up planner.
 *
 *     node build/parity-warmup.mjs
 *
 * Two classes of thing are pinned here.
 *
 * The first is arithmetic that a reader would notice immediately if it broke:
 * provider columns that do not add up to the day's total, a ramp that never
 * reaches the target, a rollback that sends somebody back to a day busier than
 * the one that got them into trouble.
 *
 * The second is provenance. Every curve in the planner is somebody's published
 * schedule, and the whole argument for using it is that it can be traced back.
 * If the stored table drifts from the document it came from, the citation on the
 * page becomes a lie that nothing else would catch. So the published tables are
 * asserted digit by digit against the figures their publishers print.
 */
import { plan, checkIn, splitByProvider, ladder, poolAdvice,
         PACES, PROVIDERS, THRESHOLDS, MAILBOX } from './js/warmup.js';

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
    else fails.push(`${n}: threw ${e.message!==undefined?e.message:e}`);
  }
};

// ------------------------------------------------------- published provenance
// Twilio SendGrid publishes these twenty-one numbers as a PDF for a sender
// heading to 1M a day. Braze publishes the identical set as its "moderate"
// schedule. Both were read from source; if this array stops matching them the
// attribution on the page stops being true.
is('the standard table is the published 21-day schedule',
   PACES.standard.table,
   [50, 100, 500, 1000, 2000, 4000, 8000, 16000, 25000, 35000, 50000,
    75000, 100000, 150000, 200000, 275000, 375000, 500000, 650000,
    825000, 1000000]);

// Customer.io publishes twenty stages of three days with an explicit ceiling of
// 1.5x per stage. The ceiling is the reason this is the careful preset.
is('the careful table is the published 20-stage schedule',
   PACES.careful.table,
   [100, 150, 225, 340, 500, 750, 1100, 1700, 2500, 3800,
    5700, 8500, 13000, 19500, 29000, 44000, 66000, 99000, 148000, 222000]);
is('and its stages are three days', PACES.careful.stageDays, 3);

{
  // The publisher's rule is "Never exceed 1.5x the previous stage's daily
  // volume in a single day", and their own printed table exceeds it in five of
  // its nineteen steps, topping out at 1.5455 between 1,100 and 1,700. The
  // cause is rounding to friendly numbers, and the overshoot is at most 3%.
  //
  // The table is kept exactly as published rather than corrected, because the
  // value of citing somebody else's schedule is that a reader can go and check
  // it. Silently improving it would break that. What is pinned instead is the
  // size of the discrepancy, so a future edit that drifts further is caught.
  const t = PACES.careful.table;
  const ratios = t.slice(1).map((v, i) => v / t[i]);
  const over = ratios.filter(r => r > 1.5001);
  is('the published careful table overshoots its own ceiling five times',
     over.length, 5);
  ok('but never by more than 3%', Math.max(...ratios) < 1.55);
  // The rule is applied strictly where this planner is the author: past the end
  // of the table, where the continuation is ours to control.
  is('the continuation rule holds the stated ceiling exactly',
     PACES.careful.beyond, 1.5);
}

{
  // Braze restricts its aggressive schedule to established senders, so the
  // shape should be visibly steeper than the standard one.
  const f = PACES.fast.table, s = PACES.standard.table;
  ok('the fast table ends higher than the standard one',
     f[f.length - 1] > s[s.length - 1]);
}

// ------------------------------------------------------------ the ladder
{
  const { steps, extended } = ladder('standard', 1000000, null);
  is('a 1M target reproduces the published curve exactly',
     steps, PACES.standard.table);
  is('and needs no extension', extended, false);
}
{
  // A smaller target should stop early on the published rungs, not rescale
  // them: day one of a 100k ramp is still 50, because that is what was published.
  const { steps } = ladder('standard', 100000, null);
  is('a 100k target stops on the published rung',
     steps, [50, 100, 500, 1000, 2000, 4000, 8000, 16000, 25000, 35000,
             50000, 75000, 100000]);
}
{
  const { steps, extended } = ladder('standard', 4000000, null);
  is('a target above the table is reached', steps[steps.length - 1], 4000000);
  is('and the extension is declared', extended, true);
  ok('the extension follows the published rule of doubling every two days',
     Math.abs(steps[21] / steps[20] - Math.SQRT2) < 0.01);
}
{
  const { steps } = ladder('careful', 222000, null);
  is('careful reaches its published end', steps[steps.length - 1], 222000);
}

// --------------------------------------------------------- the plan shape
{
  const p = plan({ level: 'ip', target: 1000000, pace: 'standard', ips: 1 });
  is('one day per step at a one-day stage', p.days.length, 21);
  is('day one is the published first rung', p.days[0].total, 50);
  is('the last day is the target', p.days[20].total, 1000000);
  is('the target is reported as reached', p.summary.reachesTargetOnDay, 21);
  ok('every day is numbered in order',
     p.days.every((d, i) => d.day === i + 1));
  ok('volume never goes backwards',
     p.days.every((d, i) => i === 0 || d.total >= p.days[i - 1].total));
}
{
  const p = plan({ level: 'domain', target: 222000, pace: 'careful' });
  is('a three-day stage produces three days per rung', p.days.length % 3, 0);
  is('the first three days hold the same volume',
     [p.days[0].total, p.days[1].total, p.days[2].total], [100, 100, 100]);
  is('and the stage number only moves on the fourth', p.days[3].stage, 2);
}
throws('a plan needs a target', () => plan({ level: 'ip' }), 'target volume');

// ------------------------------------------------------ provider arithmetic
// The columns have to add up. This is the first thing anybody checks and the
// easiest thing to get wrong once rounding is involved.
{
  const p = plan({ level: 'ip', target: 1000000, pace: 'standard' });
  const bad = p.days.filter(d => {
    const sum = PROVIDERS.reduce((a, x) => a + (d.perProvider[x.key] || 0), 0);
    return sum !== d.total;
  });
  is('provider columns sum to the day total on every day', bad.length, 0);
}
{
  // Including on awkward mixes that will not divide cleanly.
  const odd = { gmail: 33, microsoft: 33, yahoo: 33, apple: 0, other: 1 };
  const sums = [7, 13, 101, 999, 1000001].map(t => {
    const s = splitByProvider(t, odd);
    return Object.values(s).reduce((a, b) => a + b, 0);
  });
  is('an awkward mix still sums exactly', sums, [7, 13, 101, 999, 1000001]);
}
{
  const s = splitByProvider(1000, { gmail: 100, microsoft: 0, yahoo: 0, apple: 0, other: 0 });
  is('a single-provider mix puts everything in one column', s.gmail, 1000);
}
{
  const p = plan({ level: 'ip', target: 100000, pace: 'standard', sendWindow: 10 });
  const d = p.days[p.days.length - 1];
  // Hourly has to be consistent with the day it came from, allowing for the
  // ceiling on each provider and the tighter Gmail rate.
  const rebuilt = PROVIDERS.reduce((a, x) => a + (d.hourly[x.key] || 0) * 10, 0);
  ok('hourly rates reconstruct roughly to the daily total',
     rebuilt >= d.total * 0.5 && rebuilt <= d.total * 1.3);
  ok('gmail is rated more tightly than its share alone would give',
     d.hourly.gmail < Math.ceil(d.perProvider.gmail / 10) + 1);
}

// --------------------------------------------------------------- the pool
{
  const a = poolAdvice(1000000, 6);
  is('a million a day does not justify six addresses', a.tooMany, true);
  is('and one or two is what is published', a.range, [1, 2]);
  const p = plan({ level: 'ip', target: 1000000, ips: 6 });
  ok('the plan warns about it',
     p.warnings.some(w => /more than the published allocation/.test(w.text)));
}
{
  const a = poolAdvice(30000000, 9);
  is('thirty million a day does justify nine', a.tooMany, false);
}
{
  const p = plan({ level: 'ip', target: 100000, ips: 4 });
  const d = p.days[p.days.length - 1];
  is('per-address volume divides the day', d.perIp, Math.ceil(100000 / 4));
}
{
  const p = plan({ level: 'domain', target: 100000 });
  is('a domain plan has no per-address figure', p.days[0].perIp, null);
}

// ------------------------------------------------------------- mailboxes
{
  const p = plan({ level: 'mailbox', target: 200, mailboxes: 10 });
  is('each mailbox gets its share', p.perBox, 20);
  is('it starts at the conventional first day', p.days[0].perBox, MAILBOX.start);
  is('and the first day total is that times the mailboxes',
     p.days[0].total, MAILBOX.start * 10);
  is('it ends at the per-mailbox target',
     p.days[p.days.length - 1].perBox, 20);
  ok('the convention is declared rather than dressed up as a citation',
     p.assumptions.some(a => /No platform publishes a mailbox schedule/.test(a)));
}
{
  const p = plan({ level: 'mailbox', target: 5000, mailboxes: 2 });
  ok('an implausible per-mailbox volume is called out',
     p.warnings.some(w => /stops looking like a person/.test(w.text)));
}

// ------------------------------------------------------------ traffic type
{
  const t = plan({ level: 'ip', target: 100000, traffic: 'transactional' });
  ok('transactional says the numbers are ceilings, not quotas',
     t.assumptions.some(a => /ceiling to configure/.test(a)));
  const pr = plan({ level: 'ip', target: 100000, traffic: 'promotional' });
  ok('promotional leads with engagement',
     pr.assumptions.some(a => /recently engaged/.test(a)));
  const n = plan({ level: 'ip', target: 100000, traffic: 'newsletter' });
  ok('newsletter leads with cadence',
     n.assumptions.some(a => /cadence/.test(a)));
}

// ------------------------------------------------- honesty about thresholds
// Microsoft and Apple publish no complaint threshold. Inventing one, or
// borrowing Gmail's, would be the single most damaging thing this tool could do,
// because it would be confidently wrong in a way nobody could check.
is('microsoft has no published complaint threshold', THRESHOLDS.microsoft.complaint, null);
is('apple has no published complaint threshold', THRESHOLDS.apple.complaint, null);
is('gmail requires 0.3%', THRESHOLDS.gmail.complaint, 0.30);
is('and advises 0.1%', THRESHOLDS.gmail.advise, 0.10);
is('yahoo requires 0.3%', THRESHOLDS.yahoo.complaint, 0.30);
is('yahoo publishes no bulk volume threshold', THRESHOLDS.yahoo.bulkAt, null);
ok('the SNDS colour bands are described as filter output, not complaints',
   /classified as spam, not how often it was reported/.test(THRESHOLDS.microsoft.note));
ok('gmail denominator is recorded',
   /engaged/.test(THRESHOLDS.gmail.denominator));
ok('yahoo denominator is recorded and differs from gmail',
   THRESHOLDS.yahoo.denominator !== THRESHOLDS.gmail.denominator);
ok('every provider with a threshold cites where it came from',
   Object.values(THRESHOLDS).every(t => !t.complaint || (t.source && t.url)));

// ------------------------------------------------------------- the check-in
const base = plan({ level: 'ip', target: 1000000, pace: 'standard' });

{
  const r = checkIn(base, { day: 10, gmailComplaint: 0.02, bounce: 0.4 });
  is('clean figures advance', r.decision, 'advance');
  is('and there is a next volume', r.next.action, 'advance');
  ok('the next step names tomorrow', /150,000|35,000|50,000/.test(r.next.text));
}
{
  const r = checkIn(base, { day: 10, gmailComplaint: 0.15 });
  is('between advised and required, it holds', r.decision, 'hold');
  ok('and says how long', /two to three days/.test(r.next.text));
}
{
  const r = checkIn(base, { day: 12, gmailComplaint: 0.45 });
  is('at or above the required threshold, it rolls back', r.decision, 'rollback');
  ok('the rollback names a day', r.rollbackTo && r.rollbackTo.day > 0);
  ok('and the day it names is quieter than the one that broke',
     r.rollbackTo.total <= base.days[11].total);
}
{
  const r = checkIn(base, { day: 15, reputation: 'bad' });
  is('a bad reputation stops the ramp', r.decision, 'stop');
}
{
  const r = checkIn(base, { day: 15, blocked: true });
  is('a block stops the ramp', r.decision, 'stop');
}
{
  const r = checkIn(base, { day: 8, bounce: 6 });
  is('a 6% bounce rate rolls back', r.decision, 'rollback');
  ok('and cites the platform that acts first, since no provider publishes one',
     r.findings.some(f => /Amazon SES/.test(f.detail || '')));
}
{
  const r = checkIn(base, { day: 8, bounce: 3 });
  is('a 3% bounce rate holds', r.decision, 'hold');
}
{
  const r = checkIn(base, { day: 9, deferrals: true });
  is('deferrals hold the ramp', r.decision, 'hold');
  ok('and the receiver owns that finding',
     r.findings.some(f => f.owner === 'receiver'));
}

// The property that matters most: a reported breach must never come back as
// "carry on". Sweep the whole grid rather than trusting the branches above.
{
  const bad = [];
  for (let day = 1; day <= base.days.length; day++) {
    for (const obs of [{ gmailComplaint: 0.3 }, { gmailComplaint: 1 },
                       { yahooComplaint: 0.3 }, { bounce: 5 }, { bounce: 20 },
                       { blocked: true }, { reputation: 'bad' },
                       { reputation: 'low' }, { deferrals: true }]) {
      const r = checkIn(base, { day, ...obs });
      if (r.decision === 'advance') bad.push({ day, obs });
    }
  }
  is('no reported breach ever returns advance', bad.length, 0);
}
{
  // And a rollback must never point at a day that is busier than the one that
  // broke, which would be a rollback in name only.
  const bad = [];
  for (let day = 2; day <= base.days.length; day++) {
    const r = checkIn(base, { day, gmailComplaint: 2 });
    if (r.rollbackTo && r.rollbackTo.total > base.days[day - 1].total) {
      bad.push(day);
    }
  }
  is('a rollback never points at a busier day', bad, []);
}
{
  // An empty check-in is not a pass. It is a check-in with nothing in it, and
  // it must not read as clearance.
  const r = checkIn(base, { day: 3 });
  is('an empty check-in does not claim a breach', r.decision, 'advance');
  ok('but it says the dashboards are empty this early',
     r.findings.some(f => /will not show much yet/.test(f.detail || '')));
}
{
  const r = checkIn(base, { day: 999 });
  is('a day past the end is clamped to the last day', r.day, base.days.length);
}
{
  const r = checkIn(base, { day: base.days.length, gmailComplaint: 0.01 });
  ok('the final day says to hold the volume steady',
     /steady/.test(r.next.text));
}
{
  const r = checkIn(base, { day: 12, gmailComplaint: 0.45 });
  is('a rollback is marked as derived rather than published', r.derived, true);
}

// ------------------------------------------------------------- early gates
{
  const p = plan({ level: 'ip', target: 1000000 });
  ok('the first days warn that provider dashboards will be empty',
     p.days[0].gate.blind === true);
  ok('and later days do not', p.days[10].gate.blind === false);
  ok('every day carries a gate',
     p.days.every(d => d.gate && d.gate.complaints && d.gate.bounces));
  ok('every day cites the schedule it came from',
     p.days.every(d => typeof d.source === 'string' && d.source.length > 0));
}

// -------------------------------------------------------------- bulk status
{
  const p = plan({ level: 'domain', target: 20000 });
  ok('a bulk sender is told the status is permanent and domain-wide',
     p.warnings.some(w => /does not expire/.test(w.text)
                       && /primary\s+domain/.test(w.text)));
}
{
  const p = plan({ level: 'domain', target: 900 });
  ok('a small sender is not told about bulk rules',
     !p.warnings.some(w => /bulk sender/.test(w.text)));
}

if (fails.length) {
  console.error('\nwarmup failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  warmup ok (${pass} assertions over `
  + `${Object.keys(PACES).length} published schedules)`);
