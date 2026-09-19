#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""What each email RFC is, why it exists, and what it means to operate it.

The index gives you status, history and the normative requirements. None of that
tells you what the document is for, which is the thing that makes an RFC hard to
approach: you can read every MUST in RFC 7208 and still not know why SPF has a
ten-lookup ceiling or what happens the day you cross it.

Each entry has three parts, deliberately short:

    what      one or two sentences. What the document actually specifies.
    problem   what was broken before it existed, or what it was written to stop.
    operate   what it means for somebody running mail: what to do, what breaks
              when it is ignored, and where the sharp edge is.

Everything here is checkable against the RFC itself or against published
behaviour of the mailbox providers. Where an entry has no note it renders the
index data alone, which is honest: a page that invents commentary to look
complete is worth less than one that stops.
"""

NOTES = {
    # ------------------------------------------------------------- transport
    5321: {
        "what": "The SMTP protocol itself: how a client and server open a session, "
                "identify themselves, hand over an envelope and a message, and what "
                "each reply code means.",
        "problem": "Mail predates almost everything else on the internet, and the "
                   "original specification from 1982 left too much to interpretation. "
                   "This is the third attempt at pinning it down, and it is the one "
                   "in force.",
        "operate": "The envelope is not the message. MAIL FROM and RCPT TO are the "
                   "envelope and are what SPF checks and what bounces are addressed "
                   "to; the From: header a recipient sees lives inside the message "
                   "and is what DMARC checks. Almost every confusing authentication "
                   "result comes from conflating those two. The reply codes in "
                   "section 4.2.3 are also the only ones that are standard: "
                   "everything else a provider tells you is free text.",
    },
    7504: {
        "what": "Adds reply codes 521 and 556 so a host can say plainly that it does "
                "not accept mail at all, rather than accepting and discarding it.",
        "problem": "A domain with no mail service had no way to refuse cleanly. "
                   "Senders retried for days against hosts that were never going to "
                   "take delivery.",
        "operate": "This is the RFC behind the null MX record. If a domain of yours "
                   "sends but never receives, publish a null MX and let senders fail "
                   "fast instead of queueing against you for a week.",
    },
    1870: {
        "what": "The SIZE extension, which lets a server advertise its maximum "
                "message size and lets a client declare the size up front.",
        "problem": "Without it a client transmits an entire message before "
                   "discovering it is too large, wasting the transfer on both sides.",
        "operate": "Worth honouring on both ends. A sender that ignores the "
                   "advertised SIZE burns bandwidth and connection slots on messages "
                   "that will be refused at the end of DATA, and on a busy queue that "
                   "is throughput you do not get back.",
    },
    2920: {
        "what": "Command pipelining: sending a group of SMTP commands without waiting "
                "for each reply.",
        "problem": "SMTP is a lockstep conversation, and over a long round trip the "
                   "waiting dominates. A transatlantic delivery spent most of its "
                   "time idle.",
        "operate": "This is most of the throughput difference between a tuned MTA and "
                   "an untuned one on high-latency routes. The rule that bites: you "
                   "may only pipeline commands whose failure does not change the "
                   "meaning of what follows, so the client must still stop and read "
                   "after DATA.",
    },
    6152: {
        "what": "The 8BITMIME extension, which lets a client send message bodies with "
                "the high bit set instead of encoding them into 7-bit ASCII.",
        "problem": "SMTP was specified for 7-bit transport. Anything else had to be "
                   "encoded, which inflated every non-English message.",
        "operate": "A 2011 republication of a 1994 document, and it states its "
                   "requirements in prose rather than in RFC 2119 keywords, which is "
                   "why this page lists no requirements for it. The operational point "
                   "is the downgrade path: if the next hop does not advertise "
                   "8BITMIME, something has to convert, and a converter that gets it "
                   "wrong breaks the DKIM signature over the body.",
    },
    3463: {
        "what": "Enhanced mail system status codes: the three-part numbers like "
                "5.1.1 that carry more meaning than a bare 550.",
        "problem": "A 550 tells you the delivery failed permanently and nothing "
                   "else. Automating on it means parsing free text that every "
                   "provider writes differently.",
        "operate": "The class says what to do and the subject says which subsystem "
                   "complained, so 5.1.1 is a recipient problem and 5.7.1 is a policy "
                   "one, and they call for completely different responses. Route your "
                   "bounce processing on the enhanced code where it exists and fall "
                   "back to the basic code only when it does not.",
    },
    3461: {
        "what": "Delivery Status Notifications: how a sender asks for a receipt, and "
                "how a receiver is required to answer.",
        "problem": "Before this there was no standard way to ask whether a message "
                   "arrived, or to ask a server not to send you a bounce.",
        "operate": "NOTIFY=NEVER is the useful one and it is badly underused. "
                   "Transactional mail that nobody reads the bounces for should "
                   "suppress them at the envelope rather than collecting them in a "
                   "mailbox nobody opens. ORCPT is the other half: it preserves the "
                   "original recipient through forwarding so a bounce is still "
                   "attributable.",
    },
    3464: {
        "what": "The report format a bounce actually uses: a multipart message with "
                "a machine-readable part carrying the status code, the reporting MTA "
                "and the failed recipient.",
        "problem": "A bounce written only as prose can be read by a person and by "
                   "nothing else. Suppression lists cannot be built from prose.",
        "operate": "This is what your bounce processor should be parsing. The "
                   "message/delivery-status part gives you Action, Status and "
                   "Diagnostic-Code without regular expressions over English. "
                   "Plenty of senders still scrape the human-readable part instead "
                   "and then wonder why a provider wording change broke suppression.",
    },

    # -------------------------------------------------------- message format
    5322: {
        "what": "The format of the message itself: headers, the blank line, the body, "
                "and the rules for folding, comments and addresses.",
        "problem": "The header block looks simple and is not. Folding, obsolete "
                   "syntax and comment nesting all have to be handled the same way "
                   "everywhere or messages mean different things to different readers.",
        "operate": "Two details cost real time. Headers can be folded across lines "
                   "and must be unfolded before parsing, so a naive line-by-line read "
                   "will lose half a Received chain. And a -0000 timezone means the "
                   "offset is unknown, not UTC, so computing a delay across one is "
                   "fabrication rather than measurement.",
    },
    2045: {
        "what": "The first MIME document: Content-Type, Content-Transfer-Encoding and "
                "the header fields that let a message carry something other than "
                "plain ASCII text.",
        "problem": "A message was a single block of 7-bit text. No attachments, no "
                   "character sets, no alternative representations.",
        "operate": "Content-Transfer-Encoding is where DKIM signatures die. Any hop "
                   "that re-encodes a body, quoted-printable to base64 or the reverse, "
                   "changes the bytes the signature covers. If DKIM fails only for "
                   "some recipients, look for a gateway doing conversion before you "
                   "look at your keys.",
    },
    2047: {
        "what": "Encoded-words: how to put non-ASCII text into a header, such as a "
                "subject line or a display name.",
        "problem": "Headers are ASCII. A subject in Estonian or Hindi had nowhere to "
                   "go.",
        "operate": "The encoding is per-word and has a 75-character limit per encoded "
                   "word, so long subjects are split into several. Decoders that "
                   "handle one word and not a sequence produce the mangled subject "
                   "lines you still see in bounce reports.",
    },

    # --------------------------------------------------------- authentication
    7208: {
        "what": "SPF: a DNS record listing which hosts may use a domain in the "
                "envelope sender, and how a receiver evaluates it.",
        "problem": "Anyone could put any domain in MAIL FROM. There was no way for a "
                   "domain to say which servers were actually its own.",
        "operate": "The ceiling is the thing that bites: ten DNS-querying mechanisms "
                   "per evaluation, counted across every include you expand, and "
                   "crossing it is a permerror rather than a soft failure, so SPF "
                   "stops authenticating entirely. Records break by accretion, one "
                   "vendor at a time, and the record still looks fine when it does. "
                   "Note also that SPF authenticates the envelope, which survives "
                   "nothing: forwarding breaks it by design, which is why DMARC needs "
                   "DKIM to be useful.",
    },
    6376: {
        "what": "DKIM: signing selected headers and the body with a key published in "
                "DNS, so a receiver can verify the message was not altered and came "
                "from a domain that holds the key.",
        "problem": "SPF authenticates the connecting host, not the message, and it "
                   "does not survive forwarding. Nothing tied the content to a domain.",
        "operate": "Signature tags are where the problems hide, and they are in the "
                   "message rather than in DNS, so a DNS-based checker structurally "
                   "cannot see them. l= limits how much of the body is signed and "
                   "lets anything below that point be appended without breaking the "
                   "signature. x= expires it. h= must cover From: or the signature "
                   "proves nothing that DMARC cares about. Rotate keys on a schedule "
                   "and keep the old selector published until the last signed message "
                   "has aged out.",
    },
    8301: {
        "what": "Retires SHA-1 and 1024-bit RSA as acceptable DKIM choices, raising "
                "the floor to SHA-256 and 2048-bit keys.",
        "problem": "The original DKIM specification allowed algorithms that had "
                   "stopped being defensible.",
        "operate": "If you inherited a sending platform, check the key length before "
                   "you check anything else. 1024-bit keys still verify at most "
                   "providers and are still a finding.",
    },
    8463: {
        "what": "Adds Ed25519 as a DKIM signing algorithm alongside RSA.",
        "problem": "RSA keys large enough to be safe are too large to publish "
                   "comfortably in a single DNS TXT record.",
        "operate": "A 32-byte key instead of 256, so no record splitting. The catch "
                   "is support: not every verifier implements it, so sign with both "
                   "and publish both selectors rather than switching outright. Tools "
                   "that estimate key strength from base64 length without reading k= "
                   "will report a valid Ed25519 key as far too short.",
    },
    9989: {
        "what": "DMARC: ties SPF and DKIM to the domain a recipient actually sees in "
                "From:, and lets that domain publish what a receiver should do when "
                "neither aligns.",
        "problem": "SPF and DKIM each authenticate something the reader never sees. "
                   "A message could pass both while showing any From: address at all.",
        "operate": "Alignment is the whole mechanism and it is what people skip. A "
                   "pass that is not aligned to the From: domain does nothing for "
                   "you. Two independent decisions matter: relaxed or strict "
                   "alignment, and the policy itself. Most domains that publish DMARC "
                   "never leave p=none, which means they did the work and get none of "
                   "the protection.",
        "note": "This replaced RFC 7489 in May 2026 and moved DMARC from "
                "Informational to the standards track. Plenty of documentation and "
                "tooling still cites 7489.",
    },
    9990: {
        "what": "The aggregate report: the daily XML a receiver sends back describing "
                "what it saw from your domain and what it decided.",
        "problem": "Publishing a policy without feedback means turning on enforcement "
                   "blind, with no way to find the legitimate sender you forgot.",
        "operate": "Read auth_results rather than policy_evaluated. The first is what "
                   "the receiver measured; the second is what it decided after "
                   "overrides, and an override can turn a total authentication "
                   "failure into something that reads like a pass. The other trap is "
                   "forwarding: a forwarded message fails SPF by design, so a source "
                   "showing SPF failures and DKIM passes is usually a mailing list "
                   "rather than an attacker.",
    },
    9991: {
        "what": "The failure report: a per-message report sent when authentication "
                "fails, carrying far more of the message than an aggregate report.",
        "problem": "Aggregate reports tell you a source failed. They do not tell you "
                   "what the message looked like.",
        "operate": "Useful for diagnosis and a privacy liability in volume, which is "
                   "why most large receivers do not send them at all. Do not build a "
                   "process that depends on receiving them.",
    },
    8617: {
        "what": "ARC: a chain of signatures that lets an intermediary record what "
                "authentication looked like before it modified a message.",
        "problem": "Mailing lists break DMARC. They alter the subject and the body, "
                   "which breaks DKIM, and they send from their own hosts, which "
                   "breaks SPF, so legitimate list traffic fails a p=reject domain.",
        "operate": "It only helps if the receiver trusts the intermediary that "
                   "sealed the chain, so it is not a general fix. It is a reason a "
                   "large receiver may deliver something that failed DMARC outright, "
                   "which is worth knowing before you conclude a report is wrong.",
    },
    8601: {
        "what": "The Authentication-Results header: how a receiver records what its "
                "own authentication checks concluded.",
        "problem": "Every implementation wrote its own format, so nothing downstream "
                   "could read the result reliably.",
        "operate": "This header is plain text and trivially forged. Only the one "
                   "written by your own boundary means anything, and from a pasted "
                   "message there is no way to tell which that is. The specification "
                   "requires a receiver to strip inbound headers carrying its own "
                   "authserv-id for exactly this reason. If yours does not, an "
                   "attacker can assert their own pass.",
    },
    8616: {
        "what": "How SPF, DKIM and DMARC behave when domains and local parts are "
                "internationalised.",
        "problem": "Authentication was specified for ASCII domains. Comparison and "
                   "alignment need defining once a domain can be written in another "
                   "script.",
        "operate": "Alignment compares A-labels, so normalise before you compare. "
                   "Getting this wrong means an internationalised domain that "
                   "authenticates correctly is reported as failing.",
    },
    7372: {
        "what": "Assigns enhanced status codes for authentication failures, so a "
                "rejection can say it was DMARC rather than something generic.",
        "problem": "A message refused for policy reasons came back as an ordinary "
                   "5.7.1, indistinguishable from any other block.",
        "operate": "5.7.26 means the message failed multiple authentication "
                   "mechanisms. It is a configuration problem, not a reputation one, "
                   "and retrying will never clear it.",
    },
    7960: {
        "what": "A survey of the ways indirect mail flows break DMARC, and what can "
                "and cannot be done about each.",
        "problem": "DMARC was deployed and legitimate mail started failing. This "
                   "documents why rather than prescribing a fix.",
        "operate": "Informational, and the most useful reading on this page if you "
                   "are about to move to enforcement. It is the catalogue of what "
                   "will break: mailing lists, forwarding, and any service that "
                   "resends on a user's behalf.",
    },

    # ------------------------------------------------------ transport security
    8461: {
        "what": "MTA-STS: a way for a receiving domain to publish, over HTTPS, that "
                "senders should require TLS and a valid certificate for its MX hosts.",
        "problem": "STARTTLS is opportunistic. An attacker who can strip the "
                   "advertisement gets plaintext, and the sender cannot tell the "
                   "difference between a server that does not support TLS and one "
                   "being downgraded.",
        "operate": "The DNS record is only a pointer. The policy lives at "
                   "https://mta-sts.<domain>/.well-known/mta-sts.txt and if that URL "
                   "does not serve, the whole mechanism is inert while the record "
                   "still advertises it. Two sharp edges: the id in the TXT record "
                   "must be bumped whenever the policy file changes or receivers keep "
                   "serving the cached copy until max_age expires, and mode: enforce "
                   "means changing mail provider requires updating the policy before "
                   "the MX record, not after.",
    },
    8460: {
        "what": "TLS-RPT: a DNS record asking receivers to report TLS negotiation "
                "failures they had while delivering to you.",
        "problem": "MTA-STS can silently break delivery. Without reporting, the first "
                   "sign is a user saying mail stopped arriving.",
        "operate": "Publish this before you set MTA-STS to enforce, not after. It is "
                   "the only feedback channel that tells you a sender could not "
                   "negotiate TLS to your MX, and it costs one TXT record.",
    },
    7672: {
        "what": "DANE for SMTP: using DNSSEC-signed TLSA records to state which "
                "certificate an MX host will present.",
        "problem": "The same downgrade problem MTA-STS addresses, solved through "
                   "DNSSEC rather than through HTTPS and a policy file.",
        "operate": "Stronger than MTA-STS because the trust comes from DNSSEC rather "
                   "than from a web PKI certificate, and harder because it requires "
                   "DNSSEC throughout. The two coexist: publish both if you can, and "
                   "expect a certificate renewal to break DANE unless the TLSA record "
                   "is rolled with it.",
    },
    8314: {
        "what": "Makes implicit TLS the default for message submission and retrieval, "
                "rather than starting in the clear and upgrading.",
        "problem": "STARTTLS on submission has the same downgrade weakness it has "
                   "everywhere else, and the ports were a historical accident.",
        "operate": "Port 465 with implicit TLS for submission, not 587 with STARTTLS, "
                   "wherever your clients allow it. This is also why 587 without "
                   "STARTTLS enforcement is a finding rather than a preference.",
    },

    # ------------------------------------------------- reporting and anti-abuse
    8058: {
        "what": "One-click unsubscribe: the List-Unsubscribe-Post header that lets a "
                "mail client unsubscribe without the user visiting a page.",
        "problem": "Unsubscribing meant a landing page, sometimes a login. Faced with "
                   "that, people press the spam button instead, and a complaint costs "
                   "the sender far more than an unsubscribe.",
        "operate": "Required by Gmail and Yahoo for bulk senders since 2024. Both "
                   "headers must be present, the POST must work without "
                   "authentication, and it must take effect within two days. A "
                   "List-Unsubscribe header with a mailto: alone does not satisfy it.",
    },
    5965: {
        "what": "The Abuse Reporting Format: the structure of a feedback loop report "
                "sent when a recipient marks a message as spam.",
        "problem": "Every provider invented its own complaint format, so each "
                   "feedback loop needed its own parser.",
        "operate": "This is what arrives from a feedback loop, and processing it is "
                   "not optional at volume: a complaint you do not suppress becomes "
                   "the next complaint. Note that most providers redact the "
                   "recipient, so you need your own identifier in the message to know "
                   "who complained.",
    },
    5782: {
        "what": "How a DNS blocklist must behave: the query format, the reply "
                "convention, and the test entries every conformant list has to carry.",
        "problem": "Blocklists are queried by software that cannot tell a list "
                   "saying 'not listed' from a list that has stopped existing. Both "
                   "look like NXDOMAIN.",
        "operate": "The test entries are the useful part. A conformant list must "
                   "contain 127.0.0.2 and must not contain 127.0.0.1, so you can "
                   "probe both before trusting an answer. Without that check a "
                   "decommissioned zone reports every address as clean, which is how "
                   "checkers kept giving SORBS results for years after it shut down.",
    },
    2142: {
        "what": "Reserves role mailboxes such as abuse@, postmaster@ and "
                "security@ for every domain that runs a service.",
        "problem": "There was no reliable way to reach whoever operates a domain when "
                   "its mail is misbehaving.",
        "operate": "postmaster@ and abuse@ must exist and must be read by a person. "
                   "Several providers and blocklists check that they accept mail "
                   "before considering a delisting request, and a bounce from abuse@ "
                   "is a bad look during an incident.",
    },

    # ---------------------------------------------------------- architecture
    5598: {
        "what": "A map of the whole email architecture and the vocabulary for it: "
                "MUA, MSA, MTA, MDA, and the boundaries between them.",
        "problem": "Every other document assumes the terms. Nothing defined them in "
                   "one place, so discussions talked past each other.",
        "operate": "Not a protocol and it has no requirements, which is why this page "
                   "lists none. It is the document to read first if the handoffs are "
                   "unclear, because most arguments about whose problem a failure is "
                   "come down to which boundary it crossed.",
    },
}
