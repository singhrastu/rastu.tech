/* Tests for the header analyser.
 *
 *     node build/parity-headers.mjs
 *
 * This module is pure and deterministic, which makes it the most testable thing
 * on the site and leaves no excuse for the parsing bugs that killed the first
 * draft: a leading blank line aborting the parse, Gmail's semicolon-inside-a-
 * comment destroying header.d, IPv6 hops showing no address.
 */
import {
  unfold, pick, parseDate, parseReceived, parseAuthResults, parseArc,
  extract, dmarcOutcome, classifyFailure, analyse, domainOf, policyFromAR, platformOf, decodeWords
} from './js/headers.js';

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const find = (fs, needle) => fs.find(f => f.title.includes(needle));
const has = (n, hay, needle) => {
  if (String(hay).includes(needle)) pass++;
  else fails.push(`${n}: ${JSON.stringify(needle)} not in ${JSON.stringify(String(hay).slice(0, 160))}`);
};

// ------------------------------------------------------------------ unfolding
// A leading newline is what you get copying out of "Show original", and aborting
// there told the user their input was missing content that was visibly present.
is('a leading blank line does not abort the parse',
   unfold('\n\nFrom: a@b.com\nTo: c@d.com').length, 2);

// A whitespace-only line ends the block. Treating it as a continuation folds the
// entire message body into the last header.
is('a whitespace-only line ends the header block',
   unfold('From: a@b.com\n \nThis is the body: it looks like a header.').length, 1);

// RFC 5322 2.2.3 removes the CRLF and keeps the whitespace. Stripping it would
// concatenate Authentication-Results tokens into nonsense.
is('folding whitespace is preserved',
   unfold('X: one\n  two')[0][1], 'one  two');
is('bare LF is accepted', unfold('A: 1\nB: 2').length, 2);
is('CRLF is accepted', unfold('A: 1\r\nB: 2').length, 2);
is('lines with no colon are dropped', unfold('A: 1\ngarbage\nB: 2').length, 2);
is('duplicates are kept in order',
   pick(unfold('Received: a\nReceived: b'), 'received'), ['a', 'b']);

// ---------------------------------------------------------------------- dates
// RFC 5322 4.3: -0000 and the obsolete alphabetic zones mean "offset unknown",
// not UTC. Inventing an offset invents every delay computed across it.
is('a real offset is known',
   parseDate('Tue, 16 Sep 2026 10:00:00 +0300').offsetKnown, true);
is('-0000 means the offset is unknown',
   parseDate('Tue, 16 Sep 2026 10:00:00 -0000').offsetKnown, false);
is('an obsolete alphabetic zone is unknown',
   parseDate('Tue, 16 Sep 2026 10:00:00 EST').offsetKnown, false);
is('GMT is known', parseDate('Tue, 16 Sep 2026 10:00:00 GMT').offsetKnown, true);
is('a trailing (CEST) comment is ignored',
   parseDate('Tue, 16 Sep 2026 10:00:00 +0200 (CEST)').offsetKnown, true);
is('a two-digit year is expanded',
   new Date(parseDate('16 Sep 26 10:00:00 +0000').ts).getUTCFullYear(), 2026);
// Date.UTC rolls over silently, turning garbage into a plausible timestamp that
// then drives a delay calculation.
is('an impossible day is refused', parseDate('99 Sep 2026 10:00:00 +0000').ts, null);
is('an impossible hour is refused', parseDate('16 Sep 2026 25:00:00 +0000').ts, null);
is('an absurd offset is not trusted',
   parseDate('16 Sep 2026 10:00:00 +9900').offsetKnown, false);
is('unparseable input returns nothing', parseDate('sometime last week').ts, null);

// ------------------------------------------------------------------- Received
{
  // Postfix and Exchange write [IPv6:...]. Matching only hex and colons missed
  // every IPv6 hop, which then rendered with no address at all.
  const r = parseReceived('from mail.example.com ([IPv6:2001:db8::1]) by mx.test '
    + 'with ESMTPS id abc; Tue, 16 Sep 2026 10:00:00 +0000');
  is('an IPv6 address in brackets is found', r.ip, '2001:db8::1');
  is('the receiving host is found', r.by, 'mx.test');
  is('ESMTPS is TLS', r.tls, true);
}
{
  // ESMTPA is authenticated WITHOUT TLS, which is its own problem and was
  // previously detected as neither.
  const r = parseReceived('from x ([10.0.0.1]) by y with ESMTPA id q; '
    + 'Tue, 16 Sep 2026 10:00:00 +0000');
  is('ESMTPA is authenticated', r.authenticated, true);
  is('and is not TLS', r.tls, false);
}
{
  const r = parseReceived('from a ([192.0.2.1]) by b with ESMTPSA id q; '
    + 'Tue, 16 Sep 2026 10:00:00 +0000');
  is('ESMTPSA is both', [r.tls, r.authenticated], [true, true]);
}
{
  // The timestamp follows the FINAL semicolon; earlier ones belong to the head.
  const r = parseReceived('from a (helo=b; really) by c with ESMTP; '
    + 'Tue, 16 Sep 2026 10:00:00 +0000');
  is('the date comes after the last semicolon', r.date.offsetKnown, true);
}

// ------------------------------------------------- Authentication-Results
{
  // Gmail's actual output. The semicolon inside "(2048-bit key; unprotected)"
  // ended the dkim entry early and header.d - the signing domain, the one value
  // alignment depends on - was silently lost on the commonest input there is.
  const ar = parseAuthResults('mx.google.com; dkim=pass header.i=@example.com '
    + 'header.s=s1 header.b=abc (2048-bit key; unprotected) ; spf=pass '
    + 'smtp.mailfrom=bounce.example.com; dmarc=pass header.from=example.com');
  is('the authserv-id is read', ar.authserv, 'mx.google.com');
  is('all three methods survive a comment containing a semicolon',
     ar.methods.map(m => m.method), ['dkim', 'spf', 'dmarc']);
  is('and header.i survives with it',
     ar.methods[0].props['header.i'], '@example.com');
  is('and smtp.mailfrom', ar.methods[1].props['smtp.mailfrom'], 'bounce.example.com');
}

// -------------------------------------------------------------------- the ARC
{
  const h = unfold([
    'ARC-Seal: i=1; cv=none; d=relay.test; s=s1; b=x',
    'ARC-Message-Signature: i=1; d=relay.test; s=s1; b=y',
    'ARC-Authentication-Results: i=1; relay.test; spf=pass',
  ].join('\n'));
  is('a complete first instance is clean', parseArc(h).problems, []);
}
{
  const h = unfold('ARC-Seal: i=1; cv=pass; d=relay.test\n'
    + 'ARC-Message-Signature: i=1; d=relay.test\n'
    + 'ARC-Authentication-Results: i=1; relay.test; spf=pass');
  has('cv must be none at i=1', parseArc(h).problems.join(' '), 'requires cv=none at i=1');
}
{
  // RFC 8617 requires all three headers per instance; only two were checked.
  const h = unfold('ARC-Seal: i=1; cv=none\nARC-Message-Signature: i=1; d=x');
  has('a missing ARC-Authentication-Results is caught',
      parseArc(h).problems.join(' '), 'ARC-Authentication-Results');
}

// ------------------------------------------------------- the DMARC arithmetic
const msg = (o = {}) => [
  `Received: from ${o.hop || 'sender.test'} ([192.0.2.1]) by mx.google.com with `
    + `${o.proto || 'ESMTPS'} id a; Tue, 16 Sep 2026 10:00:00 +0000`,
  o.ar === null ? '' : `Authentication-Results: ${o.ar || 'mx.google.com; dkim=pass '
    + 'header.d=example.com header.s=s1; spf=pass smtp.mailfrom=example.com'}`,
  o.dkimSig ? `DKIM-Signature: ${o.dkimSig}` : '',
  `From: Sender <${o.from || 'hello@example.com'}>`,
  o.returnPath ? `Return-Path: <${o.returnPath}>` : '',
  o.extra || '',
  'Subject: Test',
].filter(Boolean).join('\n');

{
  const a = analyse(msg(), { now: 1758000000000 });
  is('both mechanisms align', [a.outcome.spfAligned, a.outcome.dkimAligned], [true, true]);
  is('so DMARC passes', a.outcome.pass, true);
  is('and every policy level delivers', a.outcome.disposition.reject, 'delivered');
  is('the finding is ok and owned by the reader',
     [a.findings[0].severity, a.findings[0].owner], ['ok', 'you']);
}
{
  // A subdomain signature: passes relaxed, fails strict. The arithmetic is the
  // product here, so both modes are asserted.
  const relaxed = dmarcOutcome(extract(msg({
    ar: 'mx.google.com; dkim=pass header.d=mail.example.com header.s=s1',
  })), { adkim: 'r' });
  const strict = dmarcOutcome(extract(msg({
    ar: 'mx.google.com; dkim=pass header.d=mail.example.com header.s=s1',
  })), { adkim: 's' });
  is('relaxed alignment accepts a subdomain signature', relaxed.dkimAligned, true);
  is('strict alignment rejects it', strict.dkimAligned, false);
  has('and says why', strict.steps[0].note, 'does not align');
}
{
  // The commonest ESP misconfiguration: a perfectly valid signature by the
  // provider rather than by you.
  const a = analyse(msg({
    ar: 'mx.google.com; dkim=pass header.d=esp.example.net header.s=s1; spf=fail '
      + 'smtp.mailfrom=bounce.esp.example.net',
  }), { now: 1758000000000 });
  is('a valid signature by the wrong domain still fails DMARC', a.outcome.pass, false);
  is('and is classified as an unaligned signer', a.failure.kind, 'unaligned-signer');
  is('which is the reader to fix', a.findings[0].owner, 'you');
  has('and names the domain that signed', a.findings[0].title, 'esp.example.net');
}
{
  // A forwarded message whose DKIM survives PASSES DMARC. Somebody reading its
  // headers is usually here because SPF failed, so the tool says why that is
  // expected instead of leaving them to guess.
  const a = analyse(msg({
    ar: 'mx.google.com; dkim=pass header.d=example.com header.s=s1; spf=fail '
      + 'smtp.mailfrom=fwd.relay.test',
    returnPath: 'bounces@fwd.relay.test',
  }), { now: 1758000000000 });
  is('aligned DKIM carries a forwarded message', a.outcome.pass, true);
  const note = find(a.findings, 'did not matter');
  is('and the SPF failure is explained rather than left hanging', Boolean(note), true);
  is('and attributed to the intermediary', note.owner, 'intermediary');
}
{
  // The case worth classifying: a list rewrote the body, breaking the signature,
  // and rewrote the envelope, breaking SPF. Two independent signs of an
  // intermediary are required so a plain SPF failure is never excused.
  const a = analyse(msg({
    ar: 'mx.google.com; dkim=fail header.d=example.com header.s=s1; spf=fail '
      + 'smtp.mailfrom=fwd.relay.test',
    returnPath: 'bounces@fwd.relay.test',
    extra: 'ARC-Seal: i=1; cv=none; d=relay.test\n'
      + 'ARC-Message-Signature: i=1; d=relay.test\n'
      + 'ARC-Authentication-Results: i=1; relay.test; spf=pass\n'
      + 'List-Id: <list.example.org>',
  }), { now: 1758000000000 });
  is('a forwarder that broke both is classified as forwarding', a.failure.kind, 'forwarded');
  is('and attributed to the intermediary, not the sender', a.findings[0].owner, 'intermediary');
  has('and the fix says there is nothing to change',
      a.findings[0].fix, 'Nothing in your configuration');
}
{
  // and the guard: one sign of an intermediary is not enough to excuse a failure
  const a = analyse(msg({
    ar: 'mx.google.com; dkim=none; spf=fail smtp.mailfrom=example.com',
  }), { now: 1758000000000 });
  is('a plain SPF failure is not excused as forwarding', a.failure.kind, 'unauthenticated');
}
{
  const a = analyse(msg({ ar: 'mx.google.com; dkim=fail header.d=example.com; spf=fail',
                          dkimSig: 'v=1; a=rsa-sha256; d=example.com; s=s1; h=from:to; b=x' }),
                    { now: 1758000000000 });
  is('a present-but-unverified signature is its own case', a.failure.kind, 'signature-broken');
}
{
  const a = analyse(msg({ ar: 'mx.google.com; dkim=none; spf=fail smtp.mailfrom=example.com' }),
                    { now: 1758000000000 });
  is('nothing aligned is unauthenticated', a.failure.kind, 'unauthenticated');
  is('and is critical', a.findings[0].severity, 'critical');
}
{
  const a = analyse(msg({ ar: null }), { now: 1758000000000 });
  is('with no Authentication-Results the verdict is undetermined, not a failure',
     a.outcome.determinable, false);
  is('and is reported as unattributable', a.findings[0].owner, 'unknown');
}

// ------------------------------------------- DKIM signature tag forensics
// Every "DKIM checker" on the market reads the DNS record. l=, x=, a= and h=
// are signature header tags, so a record checker structurally cannot see them,
// and the header tools that can see them do not parse them.
const sig = (tags) => analyse(msg({ dkimSig: tags }), { now: 1758000000000 }).findings;

{
  const f = find(sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=from:subject; l=4096; b=x'),
                 'body-length limit');
  is('l= is found', Boolean(f), true);
  is('and is critical', f.severity, 'critical');
  is('and is the reader to fix', f.owner, 'you');
  has('and says what it actually means', f.detail, 'append');
}
{
  const f = find(sig('v=1; a=rsa-sha1; d=example.com; s=s1; h=from:subject; b=x'), 'sha1');
  is('sha1 signing is flagged', Boolean(f), true);
}
{
  // now = 1758000000000 is 2025-09-16; x=1000000000 is 2001.
  const f = find(sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=from:subject; '
    + 'x=1000000000; b=x'), 'already expired');
  is('an expired signature is found', Boolean(f), true);
  is('and is critical', f.severity, 'critical');
}
{
  const f = find(sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=from:subject; '
    + 't=1757990000; x=1758000100; b=x'), 'expires less than 72 hours');
  is('a too-short validity window is flagged', Boolean(f), true);
}
{
  const f = find(sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=to:subject; b=x'),
                 'does not cover From:');
  is('an h= list missing from is caught', Boolean(f), true);
  is('and is critical, because RFC 6376 requires it', f.severity, 'critical');
}
{
  const f = find(sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=from:to; b=x'),
                 'Subject is not covered');
  is('an unsigned subject is flagged', Boolean(f), true);
  is('as a warning rather than a failure', f.severity, 'warn');
}
{
  is('a clean signature produces no signature findings',
     sig('v=1; a=rsa-sha256; d=example.com; s=s1; h=from:to:subject:date; b=x')
       .filter(f => f.scope.startsWith('DKIM ')).length, 0);
}

// ------------------------------------------------------------------- TLS
{
  // A leg between two separate estates, in the clear. This is a real exposure.
  const raw = [
    'Received: from out.sender.test ([192.0.2.1]) by relay.example.net with ESMTP id x; '
      + 'Tue, 16 Sep 2026 10:00:00 +0000',
    'Received: from relay.example.net ([192.0.2.2]) by mx.google.com with ESMTPS id y; '
      + 'Tue, 16 Sep 2026 10:00:05 +0000',
    'From: a@example.com',
  ].join('\n');
  const f = find(analyse(raw, { now: 1758000000000 }).findings, 'without TLS');
  is('a cleartext hop between organisations is found', Boolean(f), true);
  is('and belongs to the intermediary', f && f.owner, 'intermediary');
}
{
  /* Hops inside one provider's own estate are not an exposed leg. A platform
     that accepts over its HTTP API and moves the message between its own nodes
     shows several hops with no TLS marker, and reporting those as "in the clear"
     tells a sender their mail was readable when it never left one network. This
     is the shape SendGrid produces, and it was firing a false warning on it. */
  const raw = [
    'Received: by recvd-67f7866db.sendgrid.net with SMTP id z; '
      + 'Tue, 16 Sep 2026 10:00:01 +0000',
    'Received: from MzU0 (unknown) by geopod-ismtpd-0.sendgrid.net (SG) with HTTP id q; '
      + 'Tue, 16 Sep 2026 10:00:00 +0000',
    'Received: from o1.sendgrid.net ([192.0.2.9]) by mx.google.com with ESMTPS id y; '
      + 'Tue, 16 Sep 2026 10:00:05 +0000',
    'From: a@example.com',
  ].join('\n');
  const fs2 = analyse(raw, { now: 1758000000000 }).findings;
  is('internal hops raise no cleartext warning',
     Boolean(find(fs2, 'between organisations carried this without TLS')), false);
  is('and are reported as fine instead',
     Boolean(find(fs2, 'Every hop that left the sending platform used TLS')), true);
}
{
  const raw = 'Received: from a ([192.0.2.1]) by relay.test with ESMTPA id x; '
    + 'Tue, 16 Sep 2026 10:00:00 +0000\nFrom: a@example.com';
  const f = find(analyse(raw, { now: 1758000000000 }).findings, 'unencrypted connection');
  is('authenticating without TLS is critical', f && f.severity, 'critical');
}

// ---------------------------------------------------------------- timing
{
  // Two hops, one with an unknown offset. The delay across it must not be
  // computed at all rather than guessed.
  const raw = [
    'Received: from a ([192.0.2.1]) by b with ESMTPS id x; '
      + 'Tue, 16 Sep 2026 10:00:00 -0000',
    'Received: from b ([192.0.2.2]) by c with ESMTPS id y; '
      + 'Tue, 16 Sep 2026 10:00:30 +0000',
    'From: a@example.com',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000 });
  is('no delay is computed across an unknown offset',
     a.received.every(r => !r.delayKnown), true);
  is('and the reader is told why',
     Boolean(find(a.findings, 'no usable timezone')), true);
}
{
  const raw = [
    // topmost Received is the final hop, and its clock is five minutes behind
    'Received: from b ([192.0.2.2]) by c with ESMTPS id y; '
      + 'Tue, 16 Sep 2026 10:00:00 +0000',
    'Received: from a ([192.0.2.1]) by b with ESMTPS id x; '
      + 'Tue, 16 Sep 2026 10:05:00 +0000',
    'From: a@example.com',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000 });
  is('a backwards clock is called skew, not a negative delay',
     Boolean(find(a.findings, 'time running backwards')), true);
}

// ------------------------------------------------------------ trust boundary
{
  const raw = [
    'Authentication-Results: mx.google.com; dkim=pass header.d=example.com',
    'Authentication-Results: relay.test; dkim=pass header.d=example.com',
    'From: a@example.com',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000 });
  is('two auth headers with no named boundary is a warning',
     Boolean(find(a.findings, 'no way to tell which one to believe')), true);
}
{
  // RFC 8601 requires a receiver to strip inbound headers bearing its own
  // authserv-id. One surviving below the boundary is either a relay failing to
  // strip or a forgery.
  const raw = [
    'Authentication-Results: relay.test; dkim=pass header.d=example.com',
    'Authentication-Results: mx.mine.test; dkim=pass header.d=example.com',
    'From: a@example.com',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000, boundary: 'mx.mine.test' });
  is('a header claiming your own boundary below it is critical',
     find(a.findings, 'below your boundary')?.severity, 'critical');
}

// ------------------------------------------------------------------ refusals
{
  try { analyse('', {}); fails.push('empty input: did not throw'); }
  catch (e) { has('empty input is refused with a usable message', e.message, 'Paste the block'); }
}
{
  try { analyse('no colons here at all', {}); fails.push('garbage: did not throw'); }
  catch (e) { pass++; }
}

// ------------------------------------------------------------- bulk hygiene
{
  const raw = 'From: a@example.com\nList-Unsubscribe: <https://x.test/u?id=1>';
  is('List-Unsubscribe without one-click is flagged',
     Boolean(find(analyse(raw, { now: 1 }).findings, 'not one-click')), true);
  const ok = raw + '\nList-Unsubscribe-Post: List-Unsubscribe=One-Click';
  is('and with it, is not',
     Boolean(find(analyse(ok, { now: 1 }).findings, 'not one-click')), false);
}

// ------------------------------------------- the envelope sender is a mailbox
/* An Authentication-Results property is a mailbox, not a domain, and RFC 8601
   allows it quoted. SendGrid's VERP return path carries a local part longer than
   the domain. Comparing the whole string against the From: domain reported a
   record that aligns perfectly as not aligning, in red, on a message that had
   nothing wrong with it. */
{
  is('a quoted VERP mailbox yields its domain',
     domainOf('"bounces+35448233-8a4a-r=gmail.com@em5167.store.example.com"'),
     'em5167.store.example.com');
  is('angle brackets are stripped', domainOf('<user@example.com>'), 'example.com');
  is('a bare header.i keeps its domain', domainOf('@store.example.com'), 'store.example.com');
  is('a HELO name has no local part', domainOf('mail.example.com'), 'mail.example.com');
  is('the null sender yields nothing', domainOf('<>'), '');
  is('a trailing root label goes', domainOf('EXAMPLE.COM.'), 'example.com');

  const raw = [
    'Authentication-Results: mx.google.com; dkim=pass header.i=@store.example.com '
      + 'header.s=ctr; spf=pass (google.com: domain of bounces+1-a=b@em.store.example.com '
      + 'designates 1.2.3.4 as permitted sender) '
      + 'smtp.mailfrom="bounces+1-a=b@em.store.example.com"; '
      + 'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com',
    'Return-Path: <bounces+1-a=b@em.store.example.com>',
    'From: Brand <hello@example.com>',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000 });
  const spf = a.outcome.steps.find(s => s.mech === 'SPF');
  is('SPF authenticates the domain, not the mailbox', spf.authDomain,
     'em.store.example.com');
  is('and a subdomain aligns under relaxed', spf.aligned, true);
  is('so the message passes on SPF as well as DKIM', a.outcome.spfAligned, true);
}

// -------------------------------- the policy the receiver says it applied
{
  const a = analyse([
    'Authentication-Results: mx.google.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) '
      + 'header.from=example.com',
    'From: a@example.com',
  ].join('\n'), { now: 1758000000000 });
  const pol = policyFromAR(a.authResults[0]);
  is('the policy is read out of the comment', pol && pol.p, 'none');
  is('and so is the subdomain policy', pol && pol.sp, 'quarantine');
  is('p=none is raised as something to change',
     Boolean(find(a.findings, 'publishes DMARC but enforces nothing')), true);
}

// ----------------------------------------------- the platform, and its signature
{
  const raw = [
    'Authentication-Results: mx.google.com; dkim=pass header.i=@store.example.com '
      + 'header.s=ctr; dkim=pass header.i=@sendgrid.info header.s=smtpapi; '
      + 'spf=pass smtp.mailfrom="b+1@em.store.example.com"; '
      + 'dmarc=pass (p=NONE) header.from=example.com',
    'Received: from MzU0 (unknown) by geopod-ismtpd-0 (SG) with HTTP id q; '
      + 'Tue, 16 Sep 2026 10:00:00 +0000',
    'From: a@example.com',
  ].join('\n');
  const a = analyse(raw, { now: 1758000000000 });
  is('the platform is named', platformOf(a).name, 'SendGrid');
  const f = find(a.findings, "is meant not to align");
  is('its own signature is explained rather than flagged', Boolean(f), true);
  is('and is not reported as a problem', f && f.severity, 'ok');
}

// ------------------------------------------------ relaxed-only alignment
{
  const a = analyse([
    'Authentication-Results: mx.google.com; dkim=pass header.i=@mail.example.com '
      + 'header.s=k1; dmarc=pass (p=NONE) header.from=example.com',
    'From: a@example.com',
  ].join('\n'), { now: 1758000000000 });
  is('a subdomain-only pass warns about strict alignment',
     Boolean(find(a.findings, 'relaxed alignment only')), true);
}
{
  const a = analyse([
    'Authentication-Results: mx.google.com; dkim=pass header.i=@example.com '
      + 'header.s=k1; dmarc=pass (p=REJECT) header.from=example.com',
    'From: a@example.com',
  ].join('\n'), { now: 1758000000000 });
  is('an exact-domain pass does not',
     Boolean(find(a.findings, 'relaxed alignment only')), false);
}

// ----------------------------------------------------- structure and hygiene
{
  const a = analyse([
    'From: Real <real@example.com>',
    'From: Fake <fake@evil.test>',
    'Subject: x',
  ].join('\n'), { now: 1758000000000 });
  const f = find(a.findings, 'From headers');
  is('two From headers is critical', f && f.severity, 'critical');
}
{
  const a = analyse([
    'From: a@example.com',
    'Content-Type: text/html; charset=us-ascii',
  ].join('\n'), { now: 1758000000000 });
  is('html with no text part is raised',
     Boolean(find(a.findings, 'no plain text alternative')), true);
}
{
  const a = analyse([
    'From: a@example.com',
    'Content-Type: multipart/alternative; boundary=x',
  ].join('\n'), { now: 1758000000000 });
  is('multipart/alternative is not',
     Boolean(find(a.findings, 'no plain text alternative')), false);
}
{
  const a = analyse([
    'From: a@example.com',
    'Message-ID: <abc@geopod-ismtpd-canary-0>',
  ].join('\n'), { now: 1758000000000 });
  is('a Message-ID with no domain is raised',
     Boolean(find(a.findings, 'not anchored to a domain')), true);
}
{
  const a = analyse([
    'From: a@example.com',
    'Message-ID: <abc@example.com>',
  ].join('\n'), { now: 1758000000000 });
  is('a proper one is not',
     Boolean(find(a.findings, 'not anchored to a domain')), false);
}

// ------------------------------------------------------------- the subject
is('an encoded-word subject is decoded',
   decodeWords('Edit by R for Rabbit! =?UTF-8?B?8J+RlQ==?='),
   'Edit by R for Rabbit! \u{1F455}');
is('quoted-printable encoded-words decode too',
   decodeWords('=?utf-8?Q?caf=C3=A9?='), 'café');
is('plain text is left alone', decodeWords('just a subject'), 'just a subject');

if (fails.length) {
  console.error('\nheader analyser failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  header analyser ok (${pass} assertions)`);
