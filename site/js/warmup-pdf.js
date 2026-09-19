/* Write a warm-up plan as a PDF, with no dependencies.
 *
 * Pure: takes a plan and a date string, returns bytes. No DOM, no network, no
 * clock, so the whole thing is testable from node.
 *
 * Nothing here is a library choice. The page ships under a policy that allows
 * scripts only from this origin, so a PDF library from a CDN cannot load; a
 * vendored one would then be walked by every build gate the repository has;
 * and images are restricted to this origin too, which rules out the canvas
 * route those libraries usually take. What is left is writing the file, and a
 * PDF that uses only the fourteen fonts every reader already has is a few
 * hundred lines rather than a megabyte.
 *
 * So: PDF 1.4, Helvetica and Courier, vector rules, no images, no compression.
 * A plan comes out around 20 KB.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = { left: 48, right: 48, top: 52, bottom: 56 };

/* Advance widths per 1000 units for the two faces used. Real metrics rather
   than an average, because a wrapped paragraph that assumes every glyph is the
   same width either overflows the margin or stops short of it, and both look
   like a bug to anybody holding the page. Index is codepoint minus 32. */
const W_REG = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
const W_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

const FONTS = {
  reg: { res: 'F1', widths: W_REG, mono: false },
  bold: { res: 'F2', widths: W_BOLD, mono: false },
  mono: { res: 'F3', widths: null, mono: true },  // Courier, 600 for every glyph
};

/** Width of a string at a size, in points. */
export function widthOf(str, font, size) {
  const f = FONTS[font] || FONTS.reg;
  const s = ascii(str);
  if (f.mono) return s.length * 0.6 * size;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 32;
    total += (c >= 0 && c < f.widths.length ? f.widths[c] : 556);
  }
  return total * size / 1000;
}

/* The base fourteen fonts are encoded in a single-byte set, so anything outside
   it has to be folded rather than emitted raw. Curly quotes and dashes are what
   actually turn up in copy, so they are mapped rather than dropped. */
function ascii(s) {
  // Written as escapes rather than as the characters themselves: a literal em
  // dash in this file is indistinguishable, to anything scanning the source,
  // from an em dash used in prose.
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\x20-\x7e]/g, '');
}

/** Escape for a PDF literal string. */
function lit(s) {
  return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Greedy wrap to a width, in points. */
export function wrap(text, font, size, maxWidth) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (line && widthOf(test, font, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/* ------------------------------------------------------------- the writer */

function Doc() {
  const pages = [];
  let cur = null;
  let y = 0;

  const newPage = () => {
    cur = [];
    pages.push(cur);
    y = A4.h - M.top;
  };
  newPage();

  const api = {
    get y() { return y; },
    set y(v) { y = v; },
    get pageCount() { return pages.length; },
    pages,

    room(need) {
      if (y - need < M.bottom) { newPage(); return true; }
      return false;
    },
    page() { newPage(); },

    text(x, yy, s, font, size, grey) {
      const f = FONTS[font] || FONTS.reg;
      const g = grey === undefined ? 0 : grey;
      cur.push(`BT ${g} g /${f.res} ${size} Tf 1 0 0 1 ${r(x)} ${r(yy)} Tm `
             + `(${lit(s)}) Tj ET`);
    },

    line(x1, y1, x2, y2, grey, w) {
      cur.push(`${grey === undefined ? 0.8 : grey} G ${w || 0.5} w `
             + `${r(x1)} ${r(y1)} m ${r(x2)} ${r(y2)} l S`);
    },

    box(x, yy, w, h, grey) {
      cur.push(`${grey} g ${r(x)} ${r(yy)} ${r(w)} ${r(h)} re f`);
    },

    para(s, font, size, lead, grey) {
      const width = A4.w - M.left - M.right;
      for (const ln of wrap(s, font, size, width)) {
        api.room(lead);
        api.text(M.left, y, ln, font, size, grey);
        y -= lead;
      }
    },
  };
  return api;
}

const r = (n) => Math.round(n * 100) / 100;

/** Assemble the objects into a file. */
function serialise(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  const catalog = add(null);          // 1, filled below
  const pagesObj = add(null);         // 2
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
               + '/Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold '
               + '/Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier '
               + '/Encoding /WinAnsiEncoding >>');

  const kids = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R `
      + `/MediaBox [0 0 ${r(A4.w)} ${r(A4.h)}] `
      + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> `
      + `/Contents ${content} 0 R >>`);
    kids.push(`${page} 0 R`);
  }

  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] `
                     + `/Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\n`
       + `startxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/* --------------------------------------------------------------- the plan */

const fmt = (n) => Number(n).toLocaleString('en-US');

function stages(p) {
  const rows = [];
  for (const d of p.days) {
    const last = rows[rows.length - 1];
    if (last && last.total === d.total && last.stage === d.stage) last.to = d.day;
    else rows.push({ from: d.day, to: d.day, ...d });
  }
  return rows;
}

function heading(doc, s) {
  doc.room(34);
  doc.y -= 8;
  doc.text(M.left, doc.y, s, 'bold', 12.5);
  doc.y -= 6;
  doc.line(M.left, doc.y, A4.w - M.right, doc.y, 0.75);
  doc.y -= 14;
}

/**
 * @param {object} p      a plan from warmup.js
 * @param {object} meta   { brand, domain, date } all optional strings
 * @returns {Uint8Array}
 */
export function planPdf(p, meta = {}) {
  if (!p || !Array.isArray(p.days) || !p.days.length) {
    throw new Error('a PDF needs a plan with at least one day');
  }
  const doc = Doc();
  const brand = ascii(meta.brand || '').trim();
  const domain = ascii(meta.domain || '').trim();
  const date = ascii(meta.date || '').trim();
  const right = A4.w - M.right;

  // ------------------------------------------------------------ the header
  doc.text(M.left, doc.y, 'Warm-up plan', 'bold', 22);
  doc.y -= 22;
  const who = [brand, domain].filter(Boolean).join('  ');
  if (who) { doc.text(M.left, doc.y, who, 'reg', 11, 0.25); doc.y -= 15; }
  doc.text(M.left, doc.y,
    `${p.pace.name} ramp to ${fmt(p.target)} a day over ${p.summary.days} days`,
    'reg', 11, 0.25);
  doc.y -= 10;
  doc.line(M.left, doc.y, right, doc.y, 0.6, 1);
  doc.y -= 20;

  // ------------------------------------------------------------ the summary
  const cells = [
    ['Days', String(p.summary.days)],
    ['Day one', fmt(p.summary.firstDay)],
    ['At the end', fmt(p.summary.finalDay)],
    ['Sent getting there', fmt(p.summary.totalMessages)],
  ];
  const cw = (right - M.left) / cells.length;
  cells.forEach((c, i) => {
    const x = M.left + i * cw;
    doc.text(x, doc.y, c[1], 'bold', 15);
    doc.text(x, doc.y - 13, c[0].toUpperCase(), 'reg', 7.5, 0.45);
  });
  doc.y -= 34;

  // ------------------------------------------------------- what this is not
  heading(doc, 'How this ramp is built');
  doc.para(`${p.pace.shape} ${p.pace.note} The volumes are a route to the target, `
    + `not a quota: what decides whether you get to keep them is the set of `
    + `figures further down, which are the receivers' and are not negotiable.`,
    'reg', 9.5, 13, 0.15);
  doc.y -= 4;

  for (const a of p.assumptions) {
    doc.room(13);
    doc.text(M.left, doc.y, '-', 'reg', 9.5, 0.4);
    for (const [i, ln] of wrap(a, 'reg', 9.5,
        right - M.left - 12).entries()) {
      if (i) doc.room(12);
      doc.text(M.left + 12, doc.y, ln, 'reg', 9.5, 0.2);
      doc.y -= 12;
    }
  }

  // -------------------------------------------------------------- warnings
  if (p.warnings.length) {
    doc.y -= 6;
    for (const w of p.warnings) {
      const lines = wrap(w.text, 'reg', 9.5, right - M.left - 14);
      doc.room(lines.length * 12 + 8);
      // A rule down the left edge, which is what marks this as a warning
      // without needing a colour a monochrome printer would lose.
      doc.box(M.left, doc.y - lines.length * 12 + 6, 2.5,
              lines.length * 12 + 3, 0.55);
      for (const ln of lines) {
        doc.text(M.left + 12, doc.y, ln, 'reg', 9.5, 0.2);
        doc.y -= 12;
      }
      doc.y -= 6;
    }
  }

  // ----------------------------------------------------------- the schedule
  heading(doc, 'The schedule');
  scheduleTable(doc, p);

  // --------------------------------------------------------------- the gate
  heading(doc, 'What has to hold before each step');
  const gates = [
    ['Gmail reported spam', 'under 0.30%, measured against mail delivered to '
      + 'the inbox of engaged recipients'],
    ['Yahoo reported spam', 'under 0.30%, measured against all mail delivered '
      + 'to the inbox'],
    ['Hard bounces', 'under 2%. A sending platform usually acts on this before '
      + 'any mailbox provider does'],
    ['Deferrals', 'no new 4xx from a provider you are ramping. Microsoft '
      + 'returns 421 RP-001 to RP-003 for exactly this'],
  ];
  for (const [k, v] of gates) {
    const lines = wrap(v, 'reg', 9.5, right - M.left - 132);
    doc.room(lines.length * 12 + 2);
    doc.text(M.left, doc.y, k, 'bold', 9.5, 0.1);
    lines.forEach((ln, i) => {
      doc.text(M.left + 130, doc.y - i * 12, ln, 'reg', 9.5, 0.2);
    });
    doc.y -= lines.length * 12 + 3;
  }
  doc.y -= 4;
  doc.para('Those two percentages are not the same measurement and cannot be '
    + 'averaged into one figure. Microsoft and Apple publish no complaint '
    + 'threshold at all, so none is claimed for them here. The green, yellow '
    + 'and red bands in SNDS report how much of the mail from an address was '
    + 'classified as spam, not how often it was reported.',
    'reg', 9.5, 13, 0.3);

  const blind = p.days.filter(d => d.gate.blind).length;
  if (blind) {
    doc.y -= 4;
    doc.para(`For roughly the first ${blind} ${blind === 1 ? 'day' : 'days'} the `
      + `provider dashboards will show little or nothing. Neither Google nor `
      + `Yahoo reports at low volume, and neither publishes the volume at which `
      + `reporting starts. Until then your own SMTP responses are the signal.`,
      'reg', 9.5, 13, 0.3);
  }

  // ----------------------------------------------------------- the recovery
  heading(doc, 'If it goes wrong');
  doc.para('No platform publishes how far to go back after a bad day. "Reduce '
    + 'volume" is the whole of the published guidance, so the rule below is '
    + 'worked out rather than quoted, and is offered as a starting point.',
    'reg', 9.5, 13, 0.3);
  doc.y -= 4;
  const steps = [
    ['Stop increasing', 'Hold the current volume. Do not step up to prove the '
      + 'problem was a blip.'],
    ['Go back', 'Return to the last stage at or below half the volume where the '
      + 'trouble started.'],
    ['Hold three days', 'Reputation signals at the providers lag sending by a '
      + 'day or two, so a shorter hold tells you nothing.'],
    ['Narrow the audience', 'Send only to people who opened something recently '
      + 'while you recover.'],
    ['Resume carefully', 'Start again at the careful pace whatever you were on '
      + 'before.'],
  ];
  steps.forEach(([k, v], i) => {
    const lines = wrap(v, 'reg', 9.5, right - M.left - 132);
    doc.room(lines.length * 12 + 4);
    doc.text(M.left, doc.y, `${i + 1}. ${k}`, 'bold', 9.5, 0.1);
    lines.forEach((ln, j) => {
      doc.text(M.left + 130, doc.y - j * 12, ln, 'reg', 9.5, 0.2);
    });
    doc.y -= lines.length * 12 + 4;
  });
  doc.y -= 2;
  doc.para('Gmail publishes one number for this: once a domain is over the '
    + 'limit, mitigation becomes available after seven consecutive days below '
    + '0.3%. Seven days, not seven sends.', 'reg', 9.5, 13, 0.3);

  // ------------------------------------------------------------- the source
  heading(doc, 'What each receiver asks for');
  const sources = [
    ['Gmail', 'Reported spam under 0.30%. Above 5,000 a day to personal '
      + 'accounts you are a bulk sender, counted across the whole primary '
      + 'domain with subdomains included, and that does not lapse.'],
    ['Yahoo and AOL', 'Reported spam under 0.30%, and a working one-click '
      + 'unsubscribe honoured within two days.'],
    ['Microsoft', 'No complaint threshold published. Above 5,000 a day, SPF, '
      + 'DKIM and DMARC must all pass or mail is refused outright.'],
    ['Apple', 'No thresholds and no feedback loop, so the SMTP response is the '
      + 'only signal you get.'],
    ['All four', 'SPF, DKIM and an aligned DMARC record before the first send, '
      + 'not as an improvement to make later.'],
  ];
  for (const [k, v] of sources) {
    const lines = wrap(v, 'reg', 8.5, right - M.left - 112);
    doc.room(lines.length * 11 + 2);
    doc.text(M.left, doc.y, k, 'bold', 8.5, 0.15);
    lines.forEach((ln, i) => {
      doc.text(M.left + 110, doc.y - i * 11, ln, 'reg', 8.5, 0.35);
    });
    doc.y -= lines.length * 11 + 2;
  }

  stamp(doc, date);
  return serialise(doc.pages);
}

function scheduleTable(doc, p) {
  const right = A4.w - M.right;
  const keys = (p.providers || ['gmail', 'microsoft', 'yahoo', 'apple', 'other'])
    .filter(k => (p.mix[k] || 0) > 0);
  const labels = { gmail: 'Gmail', microsoft: 'Microsoft', yahoo: 'Yahoo',
                   apple: 'Apple', other: 'Other' };
  const showPerIp = p.level === 'ip' && p.ips > 1;

  const cols = [
    { h: 'Days', w: 46, get: (r) => r.from === r.to ? String(r.from)
        : `${r.from}-${r.to}` },
    { h: 'A day', w: 62, bold: true, get: (r) => fmt(r.total) },
    ...keys.map(k => ({ h: labels[k] || k, w: 58,
                        get: (r) => fmt(r.perProvider[k] || 0) })),
  ];
  if (showPerIp) {
    cols.push({ h: 'Per addr', w: 58, get: (r) => fmt(r.perIp) });
  }
  cols.push({ h: 'Gmail/hr', w: 52, get: (r) => fmt(r.hourly.gmail || 0) });

  const total = cols.reduce((a, c) => a + c.w, 0);
  const scale = (right - M.left) / total;
  cols.forEach(c => { c.w *= scale; });

  const header = () => {
    doc.room(26);
    let x = M.left;
    for (const c of cols) {
      doc.text(x, doc.y, c.h.toUpperCase(), 'reg', 7, 0.45);
      x += c.w;
    }
    doc.y -= 5;
    doc.line(M.left, doc.y, right, doc.y, 0.7);
    doc.y -= 12;
  };
  header();

  for (const row of stages(p)) {
    if (doc.room(16)) header();
    let x = M.left;
    for (const c of cols) {
      doc.text(x, doc.y, c.get(row), c.bold ? 'bold' : 'mono',
               c.bold ? 9 : 8.5, c.bold ? 0 : 0.2);
      x += c.w;
    }
    doc.y -= 4;
    doc.line(M.left, doc.y, right, doc.y, 0.9, 0.3);
    doc.y -= 11;
  }
}

/* A footer on every page, added at the end because the page count is not known
   until the content stops. */
function stamp(doc, date) {
  const right = A4.w - M.right;
  doc.pages.forEach((ops, i) => {
    const label = `rastu.tech/warmup${date ? '   ' + date : ''}`;
    const num = `${i + 1} of ${doc.pages.length}`;
    ops.push(`0.75 G 0.5 w ${r(M.left)} ${r(M.bottom - 14)} m `
           + `${r(right)} ${r(M.bottom - 14)} l S`);
    ops.push(`BT 0.45 g /F1 8 Tf 1 0 0 1 ${r(M.left)} ${r(M.bottom - 26)} Tm `
           + `(${lit(label)}) Tj ET`);
    const w = widthOf(num, 'reg', 8);
    ops.push(`BT 0.45 g /F1 8 Tf 1 0 0 1 ${r(right - w)} ${r(M.bottom - 26)} Tm `
           + `(${lit(num)}) Tj ET`);
  });
}
