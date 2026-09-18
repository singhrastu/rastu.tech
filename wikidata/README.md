# Wikidata item for Rastu Singh

## How to apply this

1. Go to **https://quickstatements.toolforge.org/**
2. Click **Log in** (top right) and authorise with your Wikidata account
3. Click **New batch**, choose **Version 1** format
4. Paste the contents of `quickstatements.txt`
5. **Import**, then **Run**

QuickStatements creates the item and adds every statement with its reference in one
pass. Doing it by hand through the UI is the same result, about forty clicks slower.

## What each line does

| Property | Value | Why |
|---|---|---|
| `P31` instance of | Q5 (human) | required on every person item |
| `P21` sex or gender | Q6581097 (male) | commonly expected; remove if you would rather not state it |
| `P27` country of citizenship | Q668 (India) | |
| `P106` occupation | Q1709010 (software engineer) | closest existing item |
| `P101` field of work | Q9158 (email), Q3510521 (computer security) | the two that define the niche |
| `P496` ORCID iD | 0009-0002-0526-3005 | a persistent external identifier, strong signal |
| `P856` official website | rastu.tech | |
| `P2037` GitHub | singhrastu | |
| `P6634` LinkedIn | rastu | |
| `P108` employer | Q24054211 (Pipedrive) | update when this changes |
| `P937` work location | Q1770 (Tallinn) | |

Every claim that can carry one has a **reference URL** plus a retrieval date. Unsourced
statements are the usual reason an item gets challenged.

## Honest expectation

Wikidata notability for living people is strict. The relevant rule is criterion 2: the
item must refer to a *clearly identifiable entity described using serious and publicly
available references*. The case here rests on:

- a **DOI-bearing dataset** archived at CERN and registered "findable" in DataCite
- an **ORCID iD**, a persistent researcher identifier
- public **GitHub** repositories

That is a real but thin basis. The item may be challenged, and one dataset is not a
large body of work. If it is deleted, that is a setback rather than a disaster: more
published research strengthens a later attempt. Do not pad it with unsourced claims to
look more substantial, which is what actually gets items deleted.

## After it exists

- Record the Q-number here
- Add it to `PERSON["same_as"]` in `build/build_site.py` so the site links to it
- Add `P2860`-style links from future dataset versions
