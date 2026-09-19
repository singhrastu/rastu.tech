# rastu.tech

Tools for running email infrastructure, and a reference for the parts of it that
are hard to find written down properly.

Live at **[rastu.tech](https://rastu.tech)**. Everything runs in the visitor's
browser: nothing you paste or upload is sent anywhere, and there is no account to
make.

## The tools

| | |
|---|---|
| [Domain check](https://rastu.tech/check/) | SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI for a domain, including whether an MTA-STS policy really exists behind the record that promises one |
| [Bounce classifier](https://rastu.tech/bounce/) | Paste a mail log and get the action each response calls for: retry, throttle, suppress, pause, review or fix the configuration |
| [SPF lookup counter](https://rastu.tech/spf/) | The RFC 7208 ten-lookup count with the include tree expanded, counting qualified mechanisms and CIDR forms that most checkers miss |
| [DMARC report reader](https://rastu.tech/dmarc/) | Aggregate reports read locally, with alignment computed from the reported authentication results rather than trusted from the reporter's own verdict |
| [Header analyser](https://rastu.tech/headers/) | Raw headers in, ranked findings out, each one saying whether it is the sender's problem, the receiver's or an intermediary's |
| [SMTP responses](https://rastu.tech/smtp/) | 272 responses, searchable from any fragment of one |
| [RFC decoded](https://rastu.tech/rfc/) | 99 current email RFCs: what each one is for, what amends it, and its normative requirements section by section |

## The data

Two datasets are generated here from authoritative sources and published as JSON.
Both are also available on their own:

- **[smtp-responses](https://github.com/singhrastu/smtp-responses)** parses RFC
  5321 section 4.2.3, the IANA enhanced status code registry and Microsoft's NDR
  reference into one searchable set, with documented ranges such as `5.7.606-649`
  resolving to every code inside them.
- **[email-rfcs](https://github.com/singhrastu/email-rfcs)** indexes every current
  email RFC with its obsoletion chain, the documents that amend it, and every
  normative RFC 2119 sentence with the section it came from.

## Two command-line tools behind the hosted ones

- **[smtpsift](https://github.com/singhrastu/smtpsift)** classifies SMTP
  rejections and deferrals. It is the engine behind the bounce classifier.
- **[dmarcsight](https://github.com/singhrastu/dmarcsight)** audits a domain's
  authentication posture end to end. It is the engine behind the domain check and
  the SPF counter.

The hosted versions are JavaScript ports of those two, and the build replays 37
scenarios through both implementations and fails on any difference. That is what
stops the browser answer and the command-line answer drifting apart.

## How it is built

No framework, no bundler, no runtime dependencies. Hand-written ES modules, a
Python generator that emits static HTML, and a small Worker for the two lookups a
browser is not allowed to make for itself. All DNS resolution happens in the
visitor's browser over DNS-over-HTTPS.

```
python3 build/build_site.py        # generate site/, run every gate
npx wrangler deploy                # publish
```

The build refuses to produce a site that fails any of these:

| Gate | What it blocks |
|---|---|
| parity | the JS port disagreeing with the Python original, across 37 scenarios and 379 findings |
| unit suites | 279 assertions across the findings layer, the ZIP reader, the DMARC reader, the header analyser, the response lookup and the RFC index |
| `node --check` | a syntax error reaching a shipped script |
| copy | a navigation label that does not resolve to a page |
| voice | machine register, and a claim about experience written in the third person |
| html | an anchor inside an anchor, a class that exists in no stylesheet and no script, a favicon Google cannot crawl |
| nav | a current-page marker that changes a link's width and shifts the bar |
| links | a broken internal link or a tool whose name does not match its destination |

## Keeping itself current

An RFC being replaced is not an event anybody gets told about. DMARC moved from
RFC 7489 to 9989, 9990 and 9991 in May 2026 and nothing announced it. So the RFC
index rebuilds weekly from the RFC Editor's own index, follows the obsoletion
edges forward, and commits what changed with a summary naming it.

## Licence

Code MIT. The generated datasets and the written research are CC BY 4.0: reuse
them, and a citation is appreciated.

Built and maintained by [Rastu Singh](https://rastu.tech/about/).
