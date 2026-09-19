/* Build a warm-up plan for an IP, a sending domain, or a set of mailboxes.
 *
 * Pure: no DOM, no network, no clock. Everything is derived from the arguments,
 * which is what makes the whole thing testable and what lets the page and the
 * PDF share one source of truth.
 *
 * Three curves, because one ramp does not suit a brand new domain and a company
 * moving an established programme onto new addresses. They differ in how fast
 * volume compounds, not in shape: every one starts small, grows geometrically
 * while the numbers are trivial, and eases as it approaches the target.
 *
 * The receivers are the part that is not a judgement call. Gmail and Yahoo both
 * publish a reported-spam limit and both mean it; Microsoft and Apple publish
 * none, so none is assumed for them. Those limits are held separately from the
 * curve, because the curve is how fast you would like to go and the limits are
 * what decides whether you get to.
 */

/* ------------------------------------------------------------------ curves */

/* Real rungs rather than a formula. A generated curve puts a sender on 1,287 a
   day on a Tuesday, which nobody configures and nobody remembers; these are the
   round numbers an operator actually sets a rate limit to. Past the end of a
   table the stated rule continues it. */
export const PACES = {
  careful: {
    name: 'Careful',
    shape: 'Holds each volume for three days, and never grows by more than half '
         + 'again between stages.',
    stageDays: 3,
    // Three days a stage because reputation signals lag sending by a day or two.
    // A shorter hold tells you nothing you can act on.
    table: [100, 150, 225, 340, 500, 750, 1100, 1700, 2500, 3800,
            5700, 8500, 13000, 19500, 29000, 44000, 66000, 99000, 148000, 222000],
    beyond: 1.5,
    beyondText: 'grow by half again per stage',
    note: 'For a new domain, an address with no history, or anything that has '
        + 'been filtered before.',
  },
  standard: {
    name: 'Standard',
    shape: 'Doubles while the volumes are still small, then eases as it comes '
         + 'up on the target.',
    stageDays: 1,
    // The default. Doubling is free while a day's volume is in the hundreds and
    // expensive once it is in the hundreds of thousands, so the growth rate
    // comes down as the absolute numbers go up.
    table: [50, 100, 500, 1000, 2000, 4000, 8000, 16000, 25000, 35000, 50000,
            75000, 100000, 150000, 200000, 275000, 375000, 500000, 650000,
            825000, 1000000],
    beyond: Math.SQRT2,   // doubling across two days
    beyondText: 'double every two days',
    note: 'The default, and the right choice for most senders with a list they '
        + 'collected themselves.',
  },
  fast: {
    name: 'Fast',
    shape: 'Close to doubling the whole way.',
    stageDays: 1,
    table: [50, 100, 500, 1000, 2500, 5000, 9000, 16000, 29000, 52000, 98000,
            160000, 225000, 315000, 450000, 615000, 875000, 1200000, 1750000,
            2750000],
    beyond: 2,
    beyondText: 'double daily',
    note: 'Only worth taking when the domain already has a sending history and '
        + 'the list is one you know is clean.',
  },
};

/* Mailbox warm-up is a different problem at a different scale: a few dozen
   messages a day from one inbox, not a ramp to millions. No platform publishes
   a table for it, so this is a plain linear ramp and is labelled as convention
   rather than dressed up with a citation it does not have. */
export const MAILBOX = {
  start: 5,
  step: 5,
  ceiling: 50,
  note: 'A mailbox is meant to look like a person at a keyboard, so this rises '
      + 'in fives rather than compounding.',
};

/* --------------------------------------------------------------- providers */

export const PROVIDERS = [
  { key: 'gmail', name: 'Gmail' },
  { key: 'microsoft', name: 'Microsoft' },
  { key: 'yahoo', name: 'Yahoo and AOL' },
  { key: 'apple', name: 'Apple iCloud' },
  { key: 'other', name: 'Everything else' },
];

export const DEFAULT_MIX = {
  gmail: 40, microsoft: 25, yahoo: 15, apple: 10, other: 10,
};

/* What each provider actually publishes, and against what.
 *
 * The denominators differ and are not interchangeable. Gmail measures reports
 * against mail delivered to the inbox of engaged recipients; Yahoo against all
 * inbox mail; Microsoft's SNDS against accepted recipients; a sending platform
 * against mail sent. The same sending behaviour produces different percentages at each
 * one, so a single averaged complaint figure would be wrong everywhere. They
 * are kept apart here and compared only against their own source.
 *
 * `complaint: null` means the provider publishes no number. That is a fact
 * about the provider, not a gap in this table, and the plan says so rather than
 * borrowing somebody else's figure to fill the hole. */
export const THRESHOLDS = {
  gmail: {
    complaint: 0.30,
    advise: 0.10,
    denominator: 'messages delivered to the inbox of engaged recipients',
    where: 'Postmaster Tools',
    source: 'Google, Email sender guidelines',
    url: 'https://support.google.com/a/answer/81126',
    recovery: 'Mitigation becomes available after 7 consecutive days below 0.3%.',
    bulkAt: 5000,
    bulkBasis: 'counted across the whole primary domain, subdomains included, '
             + 'in any 24 hours. The status does not expire once it applies.',
  },
  microsoft: {
    complaint: null,
    denominator: null,
    where: 'SNDS',
    source: 'Microsoft, Outlook.com postmaster',
    url: 'https://substrate.office.com/ip-domain-management-snds/postmaster/policies',
    // Worth stating plainly, because the opposite is repeated everywhere: the
    // SNDS colour bands are the share of an IP's mail that the filter classified
    // as spam, green under 10% and red over 90%. They are not complaint rates.
    note: 'Microsoft publishes no complaint-rate threshold. The green, yellow '
        + 'and red bands in SNDS report how much of the mail from an address '
        + 'was classified as spam, not how often it was reported.',
    bulkAt: 5000,
    bulkBasis: 'counted against the domain in the From header.',
    connectionCeiling: 500,
    deferralCodes: ['421 RP-001', '421 RP-002', '421 RP-003'],
  },
  yahoo: {
    complaint: 0.30,
    denominator: 'messages delivered to the inbox',
    where: 'Sender Hub',
    source: 'Yahoo, sender best practices',
    url: 'https://senders.yahooinc.com/best-practices/',
    note: 'Yahoo declines to publish a volume threshold for bulk senders.',
    bulkAt: null,
  },
  apple: {
    complaint: null,
    denominator: null,
    where: null,
    source: 'Apple, postmaster information for iCloud Mail',
    url: 'https://support.apple.com/en-us/102322',
    note: 'Apple publishes no thresholds and offers no feedback loop, so the '
        + 'only signal is the SMTP response.',
    bulkAt: null,
  },
  other: {
    complaint: null, denominator: null, where: null,
    source: null, url: null,
    note: 'Thresholds vary. Watch the SMTP responses.',
    bulkAt: null,
  },
};

/* Whoever you send through will act before any mailbox provider does, and on
   tighter numbers: a complaint rate several times lower than Gmail's, measured
   against mail sent rather than mail delivered. These are the levels at which
   an account typically goes under review and then gets suspended, and they are
   the ones that actually end a ramp. */
export const PLATFORM_LIMITS = {
  name: 'your sending platform',
  bounceReview: 5, bouncePause: 10,
  complaintReview: 0.1, complaintPause: 0.5,
  denominator: 'messages sent',
};

/* Total daily volume to address count. The constraint is the total, not the
   volume per address: one address carries three million a day perfectly well.
   Spreading a small volume across many addresses is the shape filters are built
   to catch, so asking for more than this is a warning rather than a setting. */
export const IP_ALLOCATION = [
  { upTo: 3000000, ips: [1, 2] },
  { upTo: 8000000, ips: [2, 3] },
  { upTo: 12000000, ips: [3, 4] },
  { upTo: 16000000, ips: [4, 5] },
  { upTo: 20000000, ips: [5, 6] },
  { upTo: 22000000, ips: [6, 7] },
  { upTo: 25000000, ips: [7, 8] },
  { upTo: 30000000, ips: [8, 10] },
  { upTo: Infinity, ips: [10, 12] },
];

/** How many addresses a target volume justifies, and whether a request fits. */
export function poolAdvice(target, ips) {
  const row = IP_ALLOCATION.find(r => target <= r.upTo);
  const [lo, hi] = row.ips;
  const asked = Number(ips) || 1;
  return {
    suggested: lo, range: [lo, hi], asked,
    tooMany: asked > hi,
    tooFew: asked < lo,
  };
}

/* ------------------------------------------------------------------ helpers */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Split a day's volume across providers, with the rounding loss given back. */
export function splitByProvider(total, mix) {
  const keys = PROVIDERS.map(p => p.key).filter(k => (mix[k] || 0) > 0);
  const sum = keys.reduce((a, k) => a + mix[k], 0) || 1;
  const out = {};
  let used = 0;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) { out[k] = total - used; return; }
    const v = Math.round(total * (mix[k] / sum));
    out[k] = v;
    used += v;
  });
  // A rounding remainder has to land somewhere or the columns stop summing to
  // the total, which is the first thing anybody checks.
  if (keys.length) out[keys[keys.length - 1]] = Math.max(0, total - used);
  return out;
}

/** The volume ladder for a pace, extended past the published table if needed. */
export function ladder(pace, target, startAt) {
  const p = PACES[pace] || PACES.standard;
  const steps = [];
  let started = false;

  for (const v of p.table) {
    if (!started && startAt && v < startAt) continue;
    started = true;
    if (v >= target) { steps.push(target); return { steps, paceRef: p, extended: false }; }
    steps.push(v);
  }
  if (!steps.length) steps.push(Math.min(target, p.table[0]));

  // Past the end of the table, the publisher's own continuation rule applies.
  let extended = false;
  let guard = 0;
  while (steps[steps.length - 1] < target && guard++ < 400) {
    const next = Math.round(steps[steps.length - 1] * p.beyond);
    extended = true;
    if (next >= target) { steps.push(target); break; }
    steps.push(next);
  }
  return { steps, paceRef: p, extended };
}

/* ---------------------------------------------------------------- the plan */

/**
 * @param {object} o
 * @param {'ip'|'domain'|'mailbox'} o.level
 * @param {number} o.target      messages a day at the end of the ramp
 * @param {object} o.mix         percentages per provider key
 * @param {number} o.ips         addresses in the pool (level 'ip')
 * @param {number} o.mailboxes   inboxes (level 'mailbox')
 * @param {'transactional'|'promotional'|'newsletter'} o.traffic
 * @param {'careful'|'standard'|'fast'} o.pace
 * @param {number} o.sendWindow  hours a day sending actually happens
 * @param {boolean} o.weekends   send at weekends
 */
export function plan(o = {}) {
  const level = ['ip', 'domain', 'mailbox'].includes(o.level) ? o.level : 'ip';
  const traffic = ['transactional', 'promotional', 'newsletter']
    .includes(o.traffic) ? o.traffic : 'promotional';
  const paceKey = PACES[o.pace] ? o.pace : 'standard';
  const mix = { ...DEFAULT_MIX, ...(o.mix || {}) };
  const sendWindow = clamp(Number(o.sendWindow) || 12, 1, 24);
  const weekends = o.weekends !== false;
  const warnings = [];
  const assumptions = [];

  const asked = Math.floor(Number(o.target) || 0);
  if (asked < 1) throw new Error('a warm-up plan needs a target volume');
  const target = asked;

  return level === 'mailbox'
    ? mailboxPlan({ target, o, mix, sendWindow, warnings, assumptions, traffic })
    : volumePlan({ level, target, paceKey, mix, sendWindow, weekends, traffic,
                   ips: Math.max(1, Math.floor(Number(o.ips) || 1)),
                   warnings, assumptions });
}

function volumePlan(a) {
  const { level, target, paceKey, mix, sendWindow, weekends, traffic, ips,
          warnings, assumptions } = a;

  const pool = poolAdvice(target, ips);
  if (level === 'ip' && pool.tooMany) {
    warnings.push({
      severity: 'warn',
      text: `${ips} addresses for ${fmt(target)} a day is more than the `
          + `published allocation suggests, which is ${pool.range[0]} to `
          + `${pool.range[1]}. Volume spread thinly across many addresses is a `
          + `pattern filters are built to catch, and each address still has to `
          + `be warmed separately.`,
    });
  }

  const { steps, paceRef, extended } = ladder(paceKey, target, null);
  const stageDays = paceRef.stageDays;

  // Transactional volume is triggered by whatever the application does, so a
  // daily ladder is a ceiling to configure rather than a quota to send. The
  // plan is the same shape; what changes is what the numbers mean.
  const isTransactional = traffic === 'transactional';
  if (isTransactional) {
    assumptions.push('Transactional volume follows your users, not a schedule. '
      + 'Treat each day as the ceiling to configure, not a quota to fill.');
  }
  if (traffic === 'promotional') {
    assumptions.push('Send to your most recently engaged recipients first and '
      + 'widen the window only while the response holds.');
  }
  if (traffic === 'newsletter') {
    assumptions.push('Keep the sending day and the cadence fixed. A list that '
      + 'expects Tuesday should not suddenly arrive on Friday.');
  }

  const days = [];
  let dayNo = 0;
  steps.forEach((vol, stageIdx) => {
    for (let d = 0; d < stageDays; d++) {
      dayNo++;
      const perProvider = splitByProvider(vol, mix);
      const perIp = level === 'ip' ? Math.ceil(vol / ips) : null;
      days.push({
        day: dayNo,
        stage: stageIdx + 1,
        total: vol,
        perProvider,
        perIp,
        hourly: hourlyFor(perProvider, sendWindow, ips, level),
        connections: connectionsFor(vol),
        gate: gateFor(stageIdx, steps.length),
        // Whether this rung is one of the set ones or a continuation past the
        // end of them, so a reader can see where the table stopped and the
        // rule took over.
        basis: stageIdx < paceRef.table.length
          ? `${paceRef.name} pace`
          : `${paceRef.name} pace, ${paceRef.beyondText}`,
      });
    }
  });

  assumptions.push(`Sending is spread over about ${sendWindow} hours a day.`);
  if (!weekends) {
    assumptions.push('Weekends are skipped, so the calendar runs longer than '
      + 'the day count.');
  }
  if (extended) {
    warnings.push({
      severity: 'info',
      text: `The published table stops below your target, so the days beyond it `
          + `follow the same publisher's rule for continuing: `
          + `${paceRef.beyondText}.`,
    });
  }
  if (target >= (THRESHOLDS.gmail.bulkAt || Infinity)) {
    warnings.push({
      severity: 'info',
      text: `At ${fmt(target)} a day you are a bulk sender at Gmail and at `
          + `Microsoft. Gmail counts the 5,000 across your whole primary `
          + `domain including subdomains, and the status does not expire.`,
    });
  }

  return {
    level, traffic, target, ips, mix, sendWindow, weekends,
    pace: { key: paceKey, ...paceRef },
    pool,
    days,
    summary: summarise(days, level, target),
    warnings,
    assumptions,
  };
}

function mailboxPlan(a) {
  const { target, o, mix, sendWindow, warnings, assumptions, traffic } = a;
  const boxes = Math.max(1, Math.floor(Number(o.mailboxes) || 1));
  const perBox = Math.ceil(target / boxes);

  if (perBox > MAILBOX.ceiling) {
    warnings.push({
      severity: 'warn',
      text: `${fmt(target)} a day across ${boxes} `
          + `${boxes === 1 ? 'mailbox' : 'mailboxes'} works out at `
          + `${fmt(perBox)} each. Above about ${MAILBOX.ceiling} a day a `
          + `mailbox stops looking like a person typing, so add mailboxes or `
          + `move to a sending platform.`,
    });
  }

  const days = [];
  let vol = MAILBOX.start;
  let dayNo = 0;
  while (dayNo < 60) {
    dayNo++;
    const capped = Math.min(vol, perBox);
    const total = capped * boxes;
    days.push({
      day: dayNo,
      stage: dayNo,
      total,
      perBox: capped,
      perProvider: splitByProvider(total, mix),
      perIp: null,
      hourly: Math.max(1, Math.ceil(capped / sendWindow)),
      connections: 1,
      gate: gateFor(dayNo - 1, Math.ceil((perBox - MAILBOX.start) / MAILBOX.step) + 1),
      basis: 'Mailbox ramp',
    });
    if (capped >= perBox) break;
    vol += MAILBOX.step;
  }

  assumptions.push(MAILBOX.note);
  assumptions.push('Replies matter more than volume here. A mailbox that never '
    + 'receives a reply reads as automated however slowly it ramps.');

  return {
    level: 'mailbox', traffic, target, mailboxes: boxes, perBox, mix, sendWindow,
    pace: { key: 'mailbox', name: 'Mailbox', source: 'convention',
            note: MAILBOX.note },
    pool: null,
    days,
    summary: summarise(days, 'mailbox', target),
    warnings,
    assumptions,
  };
}

/* Hourly rate is the number that actually gets configured. A daily total is
   what a plan shows, but an MTA enforces a rate, and a day's volume delivered
   in one burst is a different event to a receiver than the same volume spread
   across the day. Gmail is held tighter than the rest during a ramp because a
   deferral there is the most expensive one to earn. */
function hourlyFor(perProvider, sendWindow, ips, level) {
  const out = {};
  for (const p of PROVIDERS) {
    const v = perProvider[p.key] || 0;
    if (!v) continue;
    const perAddress = level === 'ip' ? v / ips : v;
    const base = Math.ceil(perAddress / sendWindow);
    out[p.key] = p.key === 'gmail'
      ? Math.max(1, Math.ceil(base * 0.6))
      : Math.max(1, base);
  }
  return out;
}

function connectionsFor(vol) {
  // Kept far below Microsoft's published ceiling of 500 simultaneous
  // connections. Early on, one at a time is plenty and costs nothing.
  if (vol < 5000) return 1;
  if (vol < 50000) return 2;
  if (vol < 500000) return 5;
  return 10;
}

/* Every step carries the condition that has to hold before the next one, which
   is the part a day-count schedule leaves out. */
function gateFor(idx, total) {
  const early = idx < 3;
  return {
    complaints: 'Gmail and Yahoo both under 0.3%',
    bounces: 'hard bounces under 2%',
    deferrals: 'no new 4xx deferrals from a provider you are ramping',
    blind: early,
    // Telling somebody to check a dashboard that has nothing in it is worse
    // than telling them nothing. Neither Google nor Yahoo publishes the volume
    // at which reporting starts, and neither shows anything at the bottom of a
    // ramp.
    note: early
      ? 'At this volume Postmaster Tools and Sender Hub will probably show '
        + 'nothing at all. Watch your own SMTP responses instead.'
      : '',
    last: idx === total - 1,
  };
}

function summarise(days, level, target) {
  const last = days[days.length - 1] || { day: 0, total: 0 };
  const reached = days.findIndex(d => d.total >= target);
  return {
    days: days.length,
    weeks: Math.ceil(days.length / 7),
    reachesTargetOnDay: reached >= 0 ? days[reached].day : null,
    firstDay: days[0] ? days[0].total : 0,
    finalDay: last.total,
    totalMessages: days.reduce((a, d) => a + d.total, 0),
    level,
  };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/* ------------------------------------------------------------- the check-in */

/* What to do on day N given what actually happened.
 *
 * Going back is the part a schedule leaves out. The rule: return to the last
 * stage at or below half the volume that caused the trouble, hold three days
 * because the receivers' signals lag sending by one or two, and resume at the
 * careful pace whatever you were on before.
 *
 * @param {object} p   a plan, from plan()
 * @param {object} obs { day, gmailComplaint, yahooComplaint, bounce,
 *                       deferrals, reputation, blocked }
 */
export function checkIn(p, obs = {}) {
  const day = clamp(Math.floor(Number(obs.day) || 1), 1, p.days.length);
  const today = p.days[day - 1];
  const findings = [];
  const num = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);

  const gmail = num(obs.gmailComplaint);
  const yahoo = num(obs.yahooComplaint);
  const bounce = num(obs.bounce);
  const deferrals = !!obs.deferrals;
  const blocked = !!obs.blocked;
  const reputation = obs.reputation || '';

  let decision = 'advance';
  const worse = (d) => {
    const order = { advance: 0, hold: 1, rollback: 2, stop: 3 };
    if (order[d] > order[decision]) decision = d;
  };

  if (blocked) {
    worse('stop');
    findings.push({
      severity: 'critical', owner: 'you', scope: 'Delivery',
      title: 'Sending is blocked, so the ramp is over until that is resolved',
      detail: 'A block is not a slow day. Continuing to send into one deepens '
            + 'the problem and costs reputation you have already paid for.',
      fix: 'Find the cause before sending again: check the listing, read the '
         + 'refusal text, and fix what it names. Resume from the rollback day '
         + 'below once delivery is accepted again.',
    });
  }

  if (reputation === 'low' || reputation === 'bad') {
    worse('stop');
    findings.push({
      severity: 'critical', owner: 'you', scope: 'Gmail',
      title: `Gmail domain reputation is ${reputation}`,
      detail: 'At this level Gmail is already filtering most of what you send. '
            + 'More volume makes it worse, not better.',
      fix: 'Stop increasing. Send only to people who opened something in the '
         + 'last 30 days until reputation recovers, then restart the ramp.',
      ref: { url: THRESHOLDS.gmail.url, label: THRESHOLDS.gmail.source },
    });
  }

  const complaintCheck = (value, key) => {
    const t = THRESHOLDS[key];
    if (value === null || !t.complaint) return;
    if (value >= t.complaint) {
      worse('rollback');
      findings.push({
        severity: 'critical', owner: 'you', scope: t.where || key,
        title: `${providerName(key)} complaint rate is at or above ${t.complaint}%`,
        detail: `${providerName(key)} measures this against ${t.denominator}. `
              + `At this level the ramp cannot continue without making the `
              + `problem permanent.`,
        fix: 'Roll back as set out below, and cut to your most recently '
           + 'engaged recipients before resuming.',
        evidence: `${value}% against a ${t.complaint}% threshold`,
        ref: { url: t.url, label: t.source },
      });
    } else if (t.advise && value >= t.advise) {
      worse('hold');
      findings.push({
        severity: 'warn', owner: 'you', scope: t.where || key,
        title: `${providerName(key)} complaint rate is above ${t.advise}%`,
        detail: `${t.complaint}% is the level ${providerName(key)} requires. `
              + `${t.advise}% is the level it advises staying under, and you `
              + `are between the two.`,
        fix: 'Hold at the current volume for two to three days and watch the '
           + 'direction before going further.',
        evidence: `${value}% against ${t.advise}% advised, ${t.complaint}% required`,
        ref: { url: t.url, label: t.source },
      });
    }
  };
  complaintCheck(gmail, 'gmail');
  complaintCheck(yahoo, 'yahoo');

  if (bounce !== null) {
    if (bounce >= 5) {
      worse('rollback');
      findings.push({
        severity: 'critical', owner: 'you', scope: 'List',
        title: 'Hard bounce rate is at or above 5%',
        detail: `No mailbox provider publishes a bounce threshold, but sending `
              + `platforms do, and they act first. ${PLATFORM_LIMITS.name} `
              + `reviews an account at ${PLATFORM_LIMITS.bounceReview}% and can `
              + `suspend sending at ${PLATFORM_LIMITS.bouncePause}%.`,
        fix: 'Stop and clean the list. A bounce rate this high usually means '
           + 'the source of the addresses is the problem, not the ramp.',
        evidence: `${bounce}% hard bounces`,
        ref: { url: PLATFORM_LIMITS.url, label: PLATFORM_LIMITS.name },
      });
    } else if (bounce >= 2) {
      worse('hold');
      findings.push({
        severity: 'warn', owner: 'you', scope: 'List',
        title: 'Hard bounce rate is above 2%',
        detail: 'Bounces at this level say the list has addresses that were '
              + 'never valid, which reads as a sender who does not know who '
              + 'they are writing to.',
        fix: 'Hold the volume and remove every hard bounce before the next step.',
        evidence: `${bounce}% hard bounces`,
      });
    }
  }

  if (deferrals) {
    worse('hold');
    findings.push({
      severity: 'warn', owner: 'receiver', scope: 'Deferrals',
      title: 'A provider is deferring mail',
      detail: 'A 4xx is the receiver asking for less, and it is the earliest '
            + 'signal you get. Microsoft returns 421 RP-001 to RP-003 for '
            + 'exactly this and ties them to reputation rather than a fixed cap.',
      fix: 'Hold at this volume, lower the hourly rate to that provider, and '
         + 'let the queue drain before stepping up.',
      ref: { url: THRESHOLDS.microsoft.url, label: THRESHOLDS.microsoft.source },
    });
  }

  if (!findings.length) {
    findings.push({
      severity: 'ok', owner: 'you', scope: 'Ramp',
      title: 'Everything you reported is inside its threshold',
      detail: today.gate.blind
        ? 'At this volume the provider dashboards will not show much yet, so '
          + 'this rests mostly on your own SMTP responses.'
        : 'Nothing reported is at or near a published limit.',
      fix: '',
    });
  }

  const target = rollbackTarget(p, day, decision);

  return {
    day, today, decision, findings,
    next: nextStep(p, day, decision, target),
    rollbackTo: target,
    derived: decision === 'rollback' || decision === 'stop',
  };
}

function providerName(key) {
  const p = PROVIDERS.find(x => x.key === key);
  return p ? p.name : key;
}

/* Back to the last day whose volume was at or below half of where the trouble
   started. Half is a judgement, not a published figure, and the output says so. */
function rollbackTarget(p, day, decision) {
  if (decision !== 'rollback' && decision !== 'stop') return null;
  const at = p.days[day - 1].total;
  const floor = Math.max(p.days[0].total, Math.floor(at / 2));
  for (let i = day - 1; i >= 0; i--) {
    if (p.days[i].total <= floor) return p.days[i];
  }
  return p.days[0];
}

function nextStep(p, day, decision, target) {
  const today = p.days[day - 1];
  if (decision === 'stop') {
    return {
      action: 'stop',
      text: 'Stop increasing. Fix what is named above, then restart from day '
          + `${target ? target.day : 1} at ${fmt(target ? target.total : p.days[0].total)} a day.`,
    };
  }
  if (decision === 'rollback') {
    return {
      action: 'rollback',
      text: `Go back to day ${target.day} at ${fmt(target.total)} a day, hold `
          + `there for three days, and resume at the careful pace even if you `
          + `started on a faster one.`,
    };
  }
  if (decision === 'hold') {
    return {
      action: 'hold',
      text: `Hold at ${fmt(today.total)} a day for two to three days. Step up `
          + `only once the figures above have come back inside their limits.`,
    };
  }
  const tomorrow = p.days[day] || null;
  return {
    action: 'advance',
    text: tomorrow
      ? `Move to ${fmt(tomorrow.total)} a day.`
      : `The ramp is complete at ${fmt(today.total)} a day. Keep the volume `
        + `steady from here: a long gap undoes it.`,
  };
}
