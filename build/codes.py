# -*- coding: utf-8 -*-
"""SMTP response reference data.

One entry per response an operator actually sees in a mail log. The categories and
actions line up with smtpsift (github.com/singhrastu/smtpsift) so the reference and
the classifier never drift apart.

FIELDS
  code      what you search for
  provider  who emits it, or None for RFC-generic
  title     page title, phrased as the question someone types
  answer    the direct answer, first paragraph. Kept short on purpose: ChatGPT and
            friends weight the opening 200-500 words, and a person at 2am wants the
            answer before the essay.
  category  smtpsift category
  action    what to actually do
  seen_as   verbatim examples from real logs
  causes    why it happens
  fix       ordered remediation steps
  related   other codes worth reading next

EVERYTHING HERE NEEDS RASTU'S REVIEW BEFORE PUBLISHING. It is drawn from his own
classifier and his own operational experience, but he is the one who has to defend it.
"""

CODES = [
    # ---------------------------------------------------------------- Gmail
    {
        "code": "4.7.28",
        "summary": 'A throttle, not a block. Slow down for Gmail specifically and the mail still goes.',
        "provider": "Gmail",
        "title": "Gmail 4.7.28: unusual rate, deferred not blocked",
        "answer": (
            "Gmail 4.7.28 is a rate limit, not a block. Gmail is telling you it has seen an "
            "unusual volume of mail from your IP or domain and is deferring rather than "
            "refusing it. The mail is still deliverable. Slow down and retry, and it will go "
            "through."
        ),
        "category": "rate_limited",
        "action": "throttle",
        "seen_as": [
            "421-4.7.28 Our system has detected an unusual rate of unsolicited mail "
            "originating from your IP address.",
            "450-4.7.28 Gmail has detected an unusual rate of mail originating from your "
            "IP address.",
        ],
        "causes": [
            "Sending volume ramped faster than the IP's reputation supports, usually during warm-up.",
            "A new IP or a range with no established sending history at Gmail.",
            "A spike relative to your own baseline. Gmail reacts to the change more than the absolute number.",
            "Complaint rate climbing, which tightens the rate Gmail is willing to accept.",
        ],
        "fix": [
            "Reduce concurrency and messages per connection for Gmail specifically, not globally.",
            "Let the retry schedule work. This is a 4xx and the message is still queued.",
            "Check Google Postmaster Tools for the same period. If the spam rate is climbing, the rate limit is a symptom and the complaint rate is the problem.",
            "If you are mid warm-up, hold the current daily volume rather than continuing to ramp.",
        ],
        "related": ["5.7.1", "4.7.0", "5.7.26"],
        "note": (
            "Worth being precise here, because it is the single most common misclassification "
            "in bounce handling. Gmail uses similar wording for two different outcomes: "
            "\"unusual rate\" with 4.7.28 is a deferral, while \"likely unsolicited\" with "
            "5.7.1 is a block. Treating the deferral as a block means you stop sending when "
            "you only needed to slow down. Treating the block as a deferral means you keep "
            "retrying into a wall and make the reputation worse."
        ),
    },
    {
        "code": "5.7.26",
        "summary": 'Authentication failed. SPF or DKIM has to pass and align, and retrying will not help.',
        "provider": "Gmail",
        "title": "Gmail 5.7.26: unauthenticated mail rejected",
        "answer": (
            "Gmail 5.7.26 means the message failed authentication. Gmail requires bulk senders "
            "to pass SPF or DKIM with domain alignment, and this message did neither. Retrying "
            "will not help. Fix the authentication and resend."
        ),
        "category": "auth_failure",
        "action": "fix_config",
        "seen_as": [
            "550-5.7.26 This message does not have authentication information or fails to "
            "pass authentication checks.",
            "550-5.7.26 Unauthenticated email from <domain> is not accepted due to domain's "
            "DMARC policy.",
        ],
        "causes": [
            "No SPF record, or the sending IP is not authorised by it.",
            "DKIM not signing, or signing with a selector whose public key is missing or malformed.",
            "SPF and DKIM pass but neither aligns with the From domain, so DMARC still fails.",
            "The domain publishes a DMARC policy of quarantine or reject and the message did not satisfy it.",
        ],
        "fix": [
            "Confirm the sending IP is covered by SPF, and that the record stays inside the 10 DNS-lookup limit.",
            "Confirm DKIM signing is on and the selector resolves with a valid public key.",
            "Check alignment: the domain that passes SPF or DKIM has to match the From domain, relaxed or strict as the policy requires.",
            "Read your DMARC aggregate reports for the sending source rather than guessing which leg is failing.",
        ],
        "related": ["5.7.1", "4.7.28"],
    },
    {
        "code": "5.7.1",
        "summary": 'A hard reputation block. Stop sending from this IP or domain and remediate.',
        "provider": "Gmail",
        "title": "Gmail 5.7.1: message blocked for reputation",
        "answer": (
            "Gmail 5.7.1 is a hard block. Unlike 4.7.28, this is Gmail refusing the message "
            "outright, usually on content or on the reputation of the sending IP or domain. "
            "Retrying makes it worse. Stop sending to Gmail from that source and find the cause."
        ),
        "category": "reputation_block",
        "action": "pause",
        "seen_as": [
            "550-5.7.1 Our system has detected that this message is likely unsolicited mail.",
            "550-5.7.1 The IP you're using to send mail is not authorized to send email directly to our servers.",
            "550-5.7.1 This message has been blocked because it is likely unsolicited.",
        ],
        "causes": [
            "IP or domain reputation has degraded, most often after a complaint-rate rise.",
            "Content or a linked domain is being scored as spam, including URLs you do not control.",
            "Sending from an IP Gmail treats as residential or dynamic.",
            "A shared IP damaged by another tenant on the same range.",
        ],
        "fix": [
            "Stop sending to Gmail from that IP or domain. Continued retries deepen the problem.",
            "Check Google Postmaster Tools for domain and IP reputation and for the spam rate. Under 0.3% is the threshold that matters.",
            "Separate the variables: if only one range is affected, it is reputation. If every range is affected, it is content or authentication.",
            "Clean the list before resuming. Reputation recovers through good sending, not through appeals.",
        ],
        "related": ["4.7.28", "5.7.26", "spamhaus"],
    },

    # ------------------------------------------------------------ Microsoft
    {
        "code": "5.7.606",
        "summary": "Your sending IP is on Outlook's block list. Delist, then fix what caused it.",
        "provider": "Microsoft / Outlook",
        "title": "Microsoft 5.7.606: access denied, banned sending IP",
        "answer": (
            "Microsoft 5.7.606 means your sending IP is on Outlook's block list. It is a "
            "reputation block, not a content or authentication problem, and it will not clear "
            "on its own. You need to request delisting through Microsoft and fix whatever "
            "caused the listing."
        ),
        "category": "reputation_block",
        "action": "pause",
        "seen_as": [
            "550 5.7.606 Access denied, banned sending IP [x.x.x.x]",
            "550 5.7.606 Access denied, banned sending IP [x.x.x.x]; To request removal from "
            "this list please visit https://sender.office.com/ and follow the directions.",
        ],
        "causes": [
            "Complaints from Outlook, Hotmail or Live recipients.",
            "Hitting spam traps in a Microsoft-operated domain.",
            "A sharp volume increase from an IP with no history at Microsoft.",
            "Inheriting a range that was abused before you had it.",
        ],
        "fix": [
            "Submit a delisting request through the Microsoft sender support form. Do this once, not repeatedly.",
            "Register the IPs for SNDS and JMRP first, so you can see complaint data and receive feedback.",
            "Fix the cause before requesting removal. Microsoft relists quickly, and repeat listings are harder to clear.",
            "Route Microsoft traffic off the affected range while you work the delisting.",
        ],
        "related": ["S3140", "4.7.500", "5.7.1"],
        "note": (
            "Microsoft is the slowest of the major providers to forgive and the least "
            "communicative about why. Assume recovery is measured in weeks, and that "
            "consistent low-complaint sending is the only lever that actually moves it."
        ),
    },
    {
        "code": "S3140",
        "summary": "Microsoft's internal reason code on a block. It points at IP reputation.",
        "provider": "Microsoft / Outlook",
        "title": "Microsoft S3140: sending IP reputation block",
        "answer": (
            "S3140 is Microsoft's internal reason code attached to a block, and it points at "
            "the reputation of the sending IP. You will normally see it alongside a 550 5.7.x "
            "response. Treat it the same as any Outlook reputation block: stop sending from "
            "that IP and work the delisting."
        ),
        "category": "reputation_block",
        "action": "pause",
        "seen_as": [
            "550 5.7.1 Unfortunately, messages from [x.x.x.x] weren't sent. Please contact "
            "your Internet service provider. You can tell them that Outlook refused to accept "
            "your message. [S3140]",
        ],
        "causes": [
            "Poor IP reputation at Outlook, usually complaint-driven.",
            "Little or no sending history from this IP to Microsoft domains.",
            "Volume out of proportion to the IP's established reputation.",
        ],
        "fix": [
            "Enrol the IPs in SNDS so you can see the complaint and trap data behind the block.",
            "Join JMRP so Outlook complaints reach your suppression pipeline.",
            "Request delisting once, with the cause already fixed.",
            "Warm the IP back up slowly rather than resuming at previous volume.",
        ],
        "related": ["5.7.606", "S3150", "4.7.500"],
    },
    {
        "code": "4.7.500",
        "summary": 'Throttling. Deferred rather than refused, so back off per-provider and retry.',
        "provider": "Microsoft / Outlook",
        "title": "Microsoft 4.7.500: server busy, throttled",
        "answer": (
            "Microsoft 4.7.500 is throttling. The message has not been rejected, it has been "
            "deferred because Microsoft is limiting how much it will take from you right now. "
            "Reduce concurrency for Microsoft destinations and let the retries run."
        ),
        "category": "rate_limited",
        "action": "throttle",
        "seen_as": [
            "451 4.7.500 Server busy. Please try again later from [x.x.x.x].",
            "421 4.7.500 Server busy, please try again later.",
        ],
        "causes": [
            "Too many simultaneous connections to Microsoft MX hosts.",
            "Sustained volume above what your IP reputation supports at Microsoft.",
            "Reputation degradation showing up as tightening limits before it becomes an outright block.",
        ],
        "fix": [
            "Cut per-destination concurrency and connection rate for Microsoft, not for everything.",
            "Spread delivery over a longer window rather than bursting.",
            "Check SNDS. Persistent throttling is usually an early warning of a reputation problem, not a capacity issue on their side.",
        ],
        "related": ["5.7.606", "S3140", "4.7.650"],
    },

    # ---------------------------------------------------------------- Yahoo
    {
        "code": "TS03",
        "summary": 'A 4xx that behaves like a block. Retrying on schedule will not clear it.',
        "provider": "Yahoo",
        "title": "Yahoo TS03: deferred for policy reasons",
        "answer": (
            "Yahoo's [TS03] tag marks a deferral for policy or reputation reasons. It arrives "
            "as a 4xx, so the message is still queued, but it is a reputation signal rather "
            "than a capacity one. Back off and look at your complaint rate."
        ),
        "category": "reputation_block",
        "action": "pause",
        "seen_as": [
            "421 4.7.0 [TS03] All messages from x.x.x.x will be permanently deferred; "
            "Retrying will NOT succeed.",
            "421 4.7.0 [TSS04] Messages from x.x.x.x temporarily deferred.",
        ],
        "causes": [
            "Complaint rate above what Yahoo tolerates.",
            "Spam trap hits on Yahoo-operated domains.",
            "A volume pattern Yahoo reads as unestablished or abusive.",
        ],
        "fix": [
            "Read the text, not just the code. \"Will be permanently deferred; retrying will NOT succeed\" means stop, despite the 4xx.",
            "Enrol in Yahoo's complaint feedback loop and make sure complaints reach suppression.",
            "Reduce volume to Yahoo domains and rebuild with engaged recipients only.",
        ],
        "related": ["5.7.1", "4.7.28"],
        "note": (
            "A good example of why status-code class alone is a poor guide. This is a 4xx, "
            "which normally means retry, but the message text explicitly says retrying will "
            "fail. Bounce classification has to read the text."
        ),
    },

    # -------------------------------------------------------------- generic
    {
        "code": "5.1.1",
        "summary": 'The mailbox does not exist. Permanent. Suppress it, because retrying costs reputation.',
        "provider": None,
        "title": "SMTP 5.1.1: recipient address does not exist",
        "answer": (
            "5.1.1 means the mailbox does not exist at the receiving domain. It is permanent. "
            "Suppress the address immediately. Continuing to send to addresses that return "
            "5.1.1 is one of the fastest ways to damage sender reputation."
        ),
        "category": "invalid_recipient",
        "action": "suppress",
        "seen_as": [
            "550 5.1.1 <user@example.com>: Recipient address rejected: User unknown in virtual mailbox table",
            "550 5.1.1 The email account that you tried to reach does not exist.",
            "550 5.1.1 unknown or illegal alias",
        ],
        "causes": [
            "The address was mistyped at collection.",
            "The mailbox was deleted, commonly after someone leaves an organisation.",
            "The address was never real, which points at list quality or a lack of confirmed opt-in.",
        ],
        "fix": [
            "Suppress permanently on the first occurrence. There is no reason to retry.",
            "If the hard bounce rate is above about 2%, the problem is list acquisition, not delivery.",
            "Validate at the point of capture rather than discovering invalid addresses at send time.",
        ],
        "related": ["5.1.2", "5.2.1", "4.2.2"],
    },
    {
        "code": "4.2.2",
        "summary": 'The mailbox is over quota. Temporary, and the address is still good. Retry with backoff.',
        "provider": None,
        "title": "SMTP 4.2.2: recipient mailbox is full",
        "answer": (
            "4.2.2 means the recipient's mailbox is over quota. It is temporary and the address "
            "is still valid, so retry. If it persists for several days the mailbox is likely "
            "abandoned and should be suppressed."
        ),
        "category": "mailbox_full",
        "action": "retry",
        "seen_as": [
            "452 4.2.2 The email account that you tried to reach is over quota.",
            "452 4.2.2 Mailbox full",
            "552 5.2.2 Over quota",
        ],
        "causes": [
            "The recipient is not reading or clearing their mail.",
            "An abandoned mailbox that is still accepting connections.",
        ],
        "fix": [
            "Retry on the normal backoff schedule for a few days.",
            "Suppress after a sustained period. A permanently full mailbox is an unengaged recipient and often becomes a spam trap.",
            "Note the 5.2.2 variant is permanent: same meaning, different verdict.",
        ],
        "related": ["5.1.1", "5.2.1"],
    },
    {
        "code": "5.2.1",
        "summary": 'The mailbox exists but is disabled. Suppress it, these turn into spam traps.',
        "provider": None,
        "title": "SMTP 5.2.1: mailbox disabled or inactive",
        "answer": (
            "5.2.1 means the mailbox exists but is disabled, suspended or not accepting mail. "
            "It is permanent. Suppress it, and treat these addresses with more care than an "
            "ordinary hard bounce, because dormant mailboxes are frequently recycled into spam "
            "traps."
        ),
        "category": "mailbox_inactive",
        "action": "suppress",
        "seen_as": [
            "550 5.2.1 The user's account has been disabled.",
            "550 5.2.1 mailbox disabled, not accepting messages",
        ],
        "causes": [
            "The account was suspended or closed by the provider or the organisation.",
            "The mailbox is dormant and has been switched off rather than deleted.",
        ],
        "fix": [
            "Suppress permanently.",
            "Treat a rise in 5.2.1 as a list-age signal. These addresses are prime candidates for recycled spam traps.",
            "Apply a sunset policy so unengaged addresses stop being mailed before they become traps.",
        ],
        "related": ["5.1.1", "4.2.2"],
    },
    {
        "code": "5.7.1",
        "summary": 'A deliberate policy rejection by the receiver, usually not about your reputation.',
        "provider": None,
        "title": "SMTP 5.7.1: delivery not authorized, message refused",
        "answer": (
            "5.7.1 is a policy rejection. The receiving server understood the message and "
            "refused it on purpose. The cause sits in the accompanying text, which is where "
            "the actual diagnosis lives: reputation, content, relaying, or authentication."
        ),
        "category": "policy_block",
        "action": "review",
        "seen_as": [
            "550 5.7.1 Relay access denied",
            "550 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using Spamhaus",
            "550 5.7.1 Message rejected due to content restrictions",
        ],
        "causes": [
            "The receiver considers you unauthorised to relay through it.",
            "A blocklist listing named in the response text.",
            "Content or a URL in the message triggering a filter.",
            "A recipient-side rule that has nothing to do with your reputation.",
        ],
        "fix": [
            "Read the text after the code. 5.7.1 on its own is not a diagnosis.",
            "If a blocklist is named, work that listing specifically.",
            "If it says relay access denied and you are the sender, check that you are connecting to the right host and authenticating.",
        ],
        "related": ["5.7.26", "5.7.606", "spamhaus"],
    },
    {
        "code": "spamhaus",
        "summary": 'The receiver queried Spamhaus and found your IP listed. Delist before sending again.',
        "label": 'Spamhaus listing',
        "badge": 'Blocklist',
        "provider": None,
        "title": "Blocked using Spamhaus: how to diagnose and get delisted",
        "answer": (
            "This means the receiving server queried Spamhaus, found your sending IP listed, "
            "and refused the connection. Delisting is straightforward and usually fast, but it "
            "is pointless until the source is fixed, because Spamhaus will relist you."
        ),
        "category": "blocklist",
        "action": "pause",
        "seen_as": [
            "550 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using Spamhaus; "
            "https://www.spamhaus.org/query/ip/x.x.x.x",
            "554 5.7.1 Service unavailable; Client host [x.x.x.x] blocked using zen.spamhaus.org",
        ],
        "causes": [
            "Spam traps hit, which usually means old or purchased addresses in the list.",
            "A compromised account or script sending through your infrastructure.",
            "An open relay or a misconfigured form that lets third parties send through you.",
            "The listing is on an IP range you inherited rather than on your own sending.",
        ],
        "fix": [
            "Look up the IP on Spamhaus and read which list it is on. SBL, CSS, XBL and PBL mean very different things.",
            "Find the emitting source before requesting removal. Check for compromised credentials, scripts, and unexpected traffic in the MTA logs.",
            "Request delisting once, describing what you fixed. Repeated requests without a fix damage your standing with them.",
            "Move production traffic off the listed range while you work it, so delivery continues.",
        ],
        "related": ["5.7.1", "5.7.606"],
        "note": (
            "A CSS listing usually points at snowshoe-style patterns or poor list hygiene "
            "rather than outright abuse, and PBL simply means the IP is in a range the owner "
            "has declared should not be sending mail directly. Reading which list you are on "
            "tells you most of what you need to know before you touch the removal form."
        ),
    },
    {
        "code": "4.4.1",
        "summary": 'A transport failure, not a mail failure. Retry, but investigate if it sticks to one route.',
        "provider": None,
        "title": "SMTP 4.4.1: connection timed out or refused",
        "answer": (
            "4.4.1 means your server could not complete a connection to the receiving host. It "
            "is a transport problem rather than a policy one. Retry, but investigate if it is "
            "concentrated on one route or one destination."
        ),
        "category": "connection",
        "action": "retry",
        "seen_as": [
            "421 4.4.1 Connection timed out",
            "451 4.4.1 Connection refused",
        ],
        "causes": [
            "The receiving host is down or overloaded.",
            "A firewall between you and them is dropping the connection, sometimes silently.",
            "Your IP is being tarpitted, which is a reputation signal wearing a network costume.",
            "MX resolves to a host with no working A record.",
        ],
        "fix": [
            "Retry on normal backoff. Most occurrences are genuinely transient.",
            "If it is one destination only, test from a different egress IP. If that works, it is reputation, not networking.",
            "If it is every destination, the problem is on your side: routing, firewall or DNS.",
        ],
        "related": ["4.4.2", "tls-handshake"],
    },
    {
        "code": "tls-handshake",
        "summary": 'The connection opened but encryption could not be negotiated. Usually cipher or certificate.',
        "label": 'TLS handshake',
        "badge": 'Transport',
        "provider": None,
        "title": "TLS handshake failures on outbound SMTP",
        "answer": (
            "A TLS handshake failure means the connection opened but encryption could not be "
            "negotiated. Occasional failures are normal. A failure rate concentrated on one "
            "destination or one IP range is almost never a certificate problem, it is a "
            "reputation problem being expressed at the transport layer."
        ),
        "category": "connection",
        "action": "retry",
        "seen_as": [
            "TLS handshake failed",
            "Cannot start TLS: handshake failure",
            "SSL routines: ssl3_read_bytes: sslv3 alert handshake failure",
        ],
        "causes": [
            "A genuine mismatch in protocol versions or cipher suites, which is increasingly rare.",
            "An expired or misconfigured certificate on either end.",
            "Middleboxes interfering with STARTTLS.",
            "The receiver declining the connection at handshake time because of the source IP.",
        ],
        "fix": [
            "Compare handshake outcomes across different egress paths to the same destination. If one range fails and another succeeds, the range is the problem, not the configuration.",
            "Confirm your own certificate and protocol support before assuming the receiver is at fault.",
            "If TLS-RPT is published for the destination, read the reports rather than inferring.",
        ],
        "related": ["4.4.1", "5.7.606"],
        "note": (
            "This one is worth internalising. A near-total TLS failure rate against a single "
            "provider from a single IP range looks exactly like a configuration bug and is "
            "usually reputation damage. The diagnostic that separates them is comparing "
            "separated egress paths to the same destination, which is only possible if the "
            "estate was built with that separation in the first place."
        ),
    },
]


def by_code():
    out = {}
    for c in CODES:
        key = f"{c['code']}-{c['provider']}" if c.get("provider") else c["code"]
        out[key] = c
    return out
