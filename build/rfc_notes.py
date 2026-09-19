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
    # ------------------------------------------------------ batch two
    7505: {
        "what": "The null MX record: a single MX pointing at \".\" to say a domain "
                "accepts no mail at all.",
        "problem": "A domain with no mail service either had no MX, which makes "
                   "senders fall back to the A record, or pointed somewhere that "
                   "discarded mail silently.",
        "operate": "Publish this on every domain you own that does not receive, "
                   "including parked and redirect-only domains. It stops senders "
                   "queueing against you for days and it removes a spoofing surface, "
                   "because a domain that obviously accepts no mail is a poorer "
                   "choice for a forger.",
    },
    3207: {
        "what": "STARTTLS: the SMTP extension that upgrades a plaintext session to "
                "TLS after the connection is open.",
        "problem": "SMTP was specified in the clear. Everything on the wire, "
                   "including credentials on submission, was readable in transit.",
        "operate": "Opportunistic by design, which is its weakness: an attacker who "
                   "can strip the EHLO advertisement gets plaintext, and the sender "
                   "cannot distinguish that from a server that genuinely does not "
                   "support TLS. MTA-STS and DANE exist to close that gap. On "
                   "submission the fix is different: use implicit TLS on 465 rather "
                   "than starting in the clear at all.",
    },
    8689: {
        "what": "REQUIRETLS: lets a sender mark an individual message as one that "
                "must not be delivered without TLS, even if that means bouncing it.",
        "problem": "MTA-STS is a receiver policy and applies to everything. There was "
                   "no way for a sender to say that one particular message must never "
                   "travel in the clear.",
        "operate": "Rarely deployed, worth knowing for regulated traffic. The "
                   "trade-off is explicit and should be a deliberate choice: a "
                   "message marked this way bounces rather than downgrades.",
    },
    8997: {
        "what": "Deprecates TLS 1.0 and 1.1 for mail submission and access, leaving "
                "1.2 as the floor.",
        "problem": "Old TLS versions stayed enabled long after they stopped being "
                   "defensible, because turning them off breaks old clients.",
        "operate": "Check what your submission service still accepts. This is the "
                   "document to cite when somebody asks why an old device stopped "
                   "connecting.",
    },
    6409: {
        "what": "Message submission: why mail from a user's client goes to port 587 "
                "under authentication, separately from server-to-server relay on 25.",
        "problem": "Submission and relay were the same port with the same rules, so "
                   "a server could not apply different policy to a user sending mail "
                   "and a foreign server delivering it.",
        "operate": "The split is what lets a submission service authenticate, rewrite, "
                   "add a Message-ID and enforce rate limits per user, while port 25 "
                   "stays open for inbound delivery. A network blocking outbound 25 "
                   "and allowing 587 is relying on this. If your users are submitting "
                   "on 25, you have no per-user accountability.",
    },
    4954: {
        "what": "The AUTH extension: how a client authenticates to a submission "
                "server, and which mechanisms are offered.",
        "problem": "There was no standard way to say who was sending, so submission "
                   "was authorised by IP address alone.",
        "operate": "AUTH must only be offered over TLS, because PLAIN and LOGIN put "
                   "the password on the wire. The operational value is "
                   "accountability: an authenticated submission is attributable to an "
                   "account, which is what makes a compromised account containable "
                   "rather than a mystery.",
    },
    5068: {
        "what": "Operational guidance on submission: what a network, a provider and a "
                "sender should each do so that mail is accountable.",
        "problem": "Compromised machines sent directly to port 25 worldwide, and "
                   "nothing in the protocol made that hard.",
        "operate": "This is the reasoning behind residential port 25 blocking and "
                   "behind requiring authentication on submission. Best Current "
                   "Practice, so it carries operational weight rather than protocol "
                   "weight.",
    },
    6531: {
        "what": "SMTPUTF8: the extension that allows non-ASCII addresses in the "
                "envelope.",
        "problem": "Mail addresses were ASCII. Most of the world does not write its "
                   "name in ASCII.",
        "operate": "It is end to end or it is nothing: every hop has to support it, "
                   "and a hop that does not must reject rather than mangle. Test your "
                   "bounce processing against internationalised addresses before you "
                   "accept them, because a suppression list that cannot represent an "
                   "address cannot suppress it.",
    },
    6530: {
        "what": "The framework for internationalised email: what has to change across "
                "the whole stack for non-ASCII addresses to work.",
        "problem": "Internationalisation touches the envelope, the headers, delivery "
                   "notifications and every retrieval protocol. Changing one in "
                   "isolation produces mail nobody can reply to.",
        "operate": "Read this before the individual documents. It is the map of which "
                   "other RFCs you need and why they cannot be adopted one at a time.",
    },
    6532: {
        "what": "Allows UTF-8 directly in message headers, rather than encoded into "
                "ASCII with RFC 2047 encoded-words.",
        "problem": "Encoded-words are ugly, size-limited and frequently mishandled.",
        "operate": "Only valid in a session that negotiated SMTPUTF8. A message with "
                   "raw UTF-8 headers handed to a hop that did not negotiate it is a "
                   "protocol violation, and the usual symptom is mojibake in the "
                   "subject rather than a clean failure.",
    },
    6522: {
        "what": "The multipart/report media type: the container every delivery "
                "notification and abuse report is built from.",
        "problem": "Reports needed a structure a machine could read and a person "
                   "could also open.",
        "operate": "Three parts: a human-readable explanation, a machine-readable "
                   "status part, and the original message or its headers. Parse the "
                   "middle part. The first one is prose and changes whenever a "
                   "provider edits its wording.",
    },
    2034: {
        "what": "The ENHANCEDSTATUSCODES extension, by which a server advertises "
                "that its replies carry RFC 3463 codes.",
        "problem": "Enhanced codes are only useful if a client knows to expect them.",
        "operate": "If a server advertises this and its replies do not carry enhanced "
                   "codes, that is a bug worth reporting. If it does not advertise "
                   "it, do not assume the numbers you find in the text are enhanced "
                   "codes.",
    },
    3030: {
        "what": "CHUNKING and BDAT: transferring a message as sized chunks instead of "
                "as dot-terminated text.",
        "problem": "The dot-stuffing convention means scanning and rewriting every "
                   "line of every message, which is pure overhead on large messages.",
        "operate": "Faster for large messages and worth enabling where both ends "
                   "support it. Be aware that some filtering appliances handle BDAT "
                   "badly, so it is a reasonable thing to suspect when large messages "
                   "fail and small ones do not.",
    },
    2369: {
        "what": "The List-Help, List-Unsubscribe, List-Post and related headers that "
                "let a mail client offer list commands directly.",
        "problem": "Unsubscribing meant reading the footer and following instructions "
                   "written differently by every sender.",
        "operate": "List-Unsubscribe is the one that matters commercially. Publish "
                   "both a mailto: and an https: form, and pair it with RFC 8058 "
                   "one-click, which the mailbox providers require of bulk senders.",
    },
    2919: {
        "what": "List-Id: a stable identifier for a mailing list that survives the "
                "list changing address.",
        "problem": "Filtering on the posting address breaks the moment a list moves.",
        "operate": "Useful for filing and for diagnosis: it is the reliable way to "
                   "tell that a DMARC failure came through a list rather than from a "
                   "forger.",
    },
    6591: {
        "what": "How to report an authentication failure using the abuse reporting "
                "format, as distinct from reporting spam.",
        "problem": "A DMARC failure report and a spam complaint are different events "
                   "and were being carried in the same shape.",
        "operate": "This is the format behind DMARC failure reports. Most large "
                   "receivers do not send them, for privacy reasons, so do not build "
                   "a process that depends on them arriving.",
    },
    6650: {
        "what": "How feedback loops should be created and consumed: who subscribes, "
                "what is redacted, and what a sender is expected to do.",
        "problem": "Feedback loops grew provider by provider with no shared "
                   "expectations on either side.",
        "operate": "The obligation is the part senders skip: a complaint must result "
                   "in suppression, quickly. A feedback loop you receive and do not "
                   "act on is worse than not having one, because the provider can see "
                   "you were told.",
    },
    6449: {
        "what": "Operational recommendations for running and consuming complaint "
                "feedback loops at scale.",
        "problem": "Senders and providers had no common ground on volume, format or "
                   "response time.",
        "operate": "Informational and written by the industry rather than by the "
                   "IETF, so it states no RFC 2119 requirements, which is why this "
                   "page lists none. Useful as the shared vocabulary in a conversation "
                   "with a provider.",
    },
    6647: {
        "what": "Greylisting: temporarily rejecting a first delivery attempt from an "
                "unknown sender and accepting the retry.",
        "problem": "A great deal of abuse came from software that never retried, so a "
                   "temporary failure separated real MTAs from the rest cheaply.",
        "operate": "Less effective than it was, and it costs every legitimate sender "
                   "a delay measured in minutes on first contact. From the sending "
                   "side it is a common and benign cause of 4xx on first attempt: "
                   "retry on the normal schedule and do not treat it as a reputation "
                   "signal.",
    },
    6471: {
        "what": "How a DNS blocklist should be operated: listing criteria, delisting, "
                "transparency and how to shut one down.",
        "problem": "Lists were run to wildly different standards and some "
                   "disappeared without warning, leaving queries answering into "
                   "nothing.",
        "operate": "The shutdown guidance is the operationally important part, and it "
                   "is why RFC 5782's test entries matter: a list that stops "
                   "existing looks identical to a list saying you are clean.",
    },
    6377: {
        "what": "What mailing lists do to DKIM signatures, and which list behaviours "
                "preserve a signature.",
        "problem": "Lists modify messages by design, and every modification risks "
                   "breaking the signature that authenticates them.",
        "operate": "Sign with a relaxed canonicalisation and a minimal header set if "
                   "your mail goes through lists, and do not use l=. The broader "
                   "answer is ARC, but this documents what actually survives.",
    },
    5863: {
        "what": "Deployment guidance for DKIM: key management, selector strategy, "
                "and what to sign.",
        "problem": "The protocol specification says how to sign. It does not say how "
                   "to run signing as an ongoing operation.",
        "operate": "The rotation advice is the useful part. Use a dated selector, "
                   "keep the previous key published until the last message signed "
                   "with it has aged out, and remember that removing a selector "
                   "retroactively invalidates every message it signed.",
    },
    8553: {
        "what": "Cleans up the convention of putting underscores in DNS names, such "
                "as _dmarc and _domainkey, and registers them properly.",
        "problem": "Underscore-prefixed names grew ad hoc across many specifications "
                   "with no registry, so collisions were possible.",
        "operate": "Mostly housekeeping. It matters if you run DNS tooling that "
                   "validates hostnames, because underscore labels are legal here and "
                   "some validators reject them.",
    },
    1939: {
        "what": "POP3: downloading mail from a server, usually deleting it as it goes.",
        "problem": "Users needed to read mail on a machine that is not the server and "
                   "is not always connected.",
        "operate": "Still current, still widely deployed, and the source of the "
                   "recurring support case where mail vanishes from the server "
                   "because a client is configured to delete on retrieval. IMAP is "
                   "the answer for anyone with more than one device.",
    },
    9051: {
        "what": "IMAP version 4rev2: reading and managing mail that stays on the "
                "server, across multiple clients.",
        "problem": "POP3 assumes one device and one copy. That stopped matching how "
                   "anybody reads mail.",
        "operate": "By far the largest document in this index, with over four hundred "
                   "normative requirements, which is why partial IMAP implementations "
                   "are common and interoperate badly. If a client misbehaves against "
                   "your server, the answer is usually in here.",
    },
    6186: {
        "what": "SRV records that tell a mail client where to find submission and "
                "access services for a domain.",
        "problem": "Every client asked the user for hostnames and ports, and every "
                   "user got them wrong.",
        "operate": "Publish these and autoconfiguration works in clients that look "
                   "for them. Cheap to do and it removes a category of support "
                   "ticket. Note that the major providers largely use their own "
                   "autodiscovery instead.",
    },
    2046: {
        "what": "The MIME media types: text, image, audio, multipart and the rules "
                "for each.",
        "problem": "A message needed a way to carry more than one thing, and to say "
                   "what each thing was.",
        "operate": "multipart/alternative is the one that matters for senders: the "
                   "plain text part is not decoration. Filters read it, some clients "
                   "render it, and an empty or auto-generated one is a content signal "
                   "that works against you.",
    },
    2183: {
        "what": "Content-Disposition: whether a part should be shown inline or "
                "offered as an attachment, and what to call it.",
        "problem": "A client could not tell an embedded image apart from a file the "
                   "user is meant to save.",
        "operate": "Filename handling is the sharp edge. Filenames with non-ASCII "
                   "characters need RFC 2231 encoding, and getting it wrong produces "
                   "either a mangled name or, in older clients, a security problem.",
    },
    8098: {
        "what": "Message Disposition Notifications: the read receipt, and the rules "
                "for asking for one and answering.",
        "problem": "Senders wanted to know a message had been opened, and there was "
                   "no interoperable way to ask.",
        "operate": "A request, never a guarantee: a client may refuse and most do, "
                   "usually by asking the user. Do not build reporting that treats "
                   "an absent MDN as evidence of anything.",
    },
    9057: {
        "what": "An Author header field, distinguishing who wrote a message from who "
                "sent it.",
        "problem": "DMARC alignment forces mailing lists to rewrite From:, which "
                   "loses the original author.",
        "operate": "Experimental, so treat it as a direction rather than something to "
                   "deploy. Worth knowing because it is one of the answers being "
                   "explored for the From: rewriting that DMARC enforcement forces on "
                   "lists.",
    },
    1123: {
        "what": "The 1989 host requirements document, which includes the mail "
                "section that much later practice still rests on.",
        "problem": "Specifications said what a protocol was. They did not say what an "
                   "implementation had to do to interoperate.",
        "operate": "Old, still cited, and still amended: retry intervals, the "
                   "expectation that a server accepts mail for postmaster, and much "
                   "of the queueing behaviour people treat as folklore is written "
                   "down here.",
    },
    5248: {
        "what": "The IANA registry of enhanced mail system status codes, and the "
                "process for adding one.",
        "problem": "RFC 3463 defined the shape of the codes. Something had to hold "
                   "the authoritative list as it grew.",
        "operate": "This registry is the source of the enhanced codes in the SMTP "
                   "reference on this site. If a code you are looking at is not in "
                   "it, it is a provider's private extension, and you should read the "
                   "provider's documentation rather than infer meaning from the "
                   "number.",
    },
    7817: {
        "what": "Updated rules for checking the certificate a mail server presents: "
                "which names count as a match and which no longer do.",
        "problem": "Certificate identity checking for mail grew out of web practice "
                   "and was applied inconsistently, including reliance on the "
                   "deprecated common name field.",
        "operate": "This is the check MTA-STS and DANE depend on. A certificate that "
                   "carries the hostname only in the common name and not in a subject "
                   "alternative name fails modern verification, which is a common "
                   "cause of enforcement breaking after a renewal.",
    },
    6533: {
        "what": "Delivery status notifications for internationalised mail, so a "
                "bounce can carry a non-ASCII address.",
        "problem": "A bounce format that cannot represent the address that failed is "
                   "useless for any address outside ASCII.",
        "operate": "Directly relevant to bounce processing. If you accept "
                   "internationalised addresses and your suppression list cannot "
                   "store what comes back, you will keep sending to an address that "
                   "has already failed.",
    },
    6854: {
        "what": "Amends RFC 5322 to allow group syntax in the From: and Sender: "
                "header fields.",
        "problem": "Group syntax, such as an empty group used to hide recipients, "
                   "was legal in To: and Cc: but not in From:, and real messages used "
                   "it anyway.",
        "operate": "A small amendment with a real consequence for parsers: a From: "
                   "field may legally contain a group construct, so a parser assuming "
                   "a single mailbox can fail on valid mail. It is also an example of "
                   "why the amendment list on an RFC matters: RFC 5322 is current and "
                   "this changed part of it.",
    },
}
