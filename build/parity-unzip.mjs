/* Tests for the ZIP and gzip reader.
 *
 *     node build/parity-unzip.mjs
 *
 * This module reads bytes at offsets the file itself supplies, from a file
 * somebody was emailed. So most of these tests are about refusing cleanly rather
 * than about reading correctly: a malformed archive must produce a sentence a
 * person can act on, never a raw engine error about DataView bounds.
 */
import { unzip, extractXml, canInflate, ZipError } from './js/unzip.js';

let pass = 0;
const fails = [];
const is = (n, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${n}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`);
};
const rejects = async (n, fn, needle) => {
  try {
    await fn();
    fails.push(`${n}: did not throw`);
  } catch (e) {
    if (!(e instanceof ZipError)) fails.push(`${n}: threw ${e.name} not ZipError: ${e.message}`);
    else if (!e.message.includes(needle)) fails.push(`${n}: wrong message: ${e.message}`);
    else pass++;
  }
};

is('deflate-raw is available in this runtime', canInflate(), true);

/* A stored (uncompressed) ZIP, built by hand so the fixtures are exact and the
   mutations below can corrupt one field at a time. */
function zip(files, mutate) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of files) {
    const n = enc.encode(name);
    const b = enc.encode(body);
    const lh = new Uint8Array(30 + n.length + b.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);                       // method: stored
    lv.setUint32(18, b.length, true);
    lv.setUint32(22, b.length, true);
    lv.setUint16(26, n.length, true);
    lh.set(n, 30);
    lh.set(b, 30 + n.length);
    locals.push(lh);

    const ch = new Uint8Array(46 + n.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, b.length, true);
    cv.setUint32(24, b.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    ch.set(n, 46);
    central.push(ch);
    offset += lh.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...central, eocd];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return mutate ? mutate(out) : out;
}

/** Offset of the central directory, read back out of the EOCD. */
const cdOffset = (b) => new DataView(b.buffer).getUint32(b.length - 22 + 16, true);

const XML = '<?xml version="1.0"?><feedback><report_metadata/></feedback>';

// --------------------------------------------------------------- happy path
{
  const entries = await unzip(zip([['report.xml', XML]]).buffer);
  is('reads a stored member', entries.length, 1);
  is('and keeps its name', entries[0].name, 'report.xml');
  is('and its bytes survive intact', new TextDecoder().decode(entries[0].bytes), XML);
}
{
  const entries = await unzip(zip([['a.xml', XML], ['b.xml', XML]]).buffer);
  is('reads several members in order', entries.map(e => e.name), ['a.xml', 'b.xml']);
}

// The regression this suite was written for. The ZIP64 locator sits at exactly
// eocd-20; scanning the whole tail for its signature matched compressed data and
// refused valid archives with a confidently wrong explanation.
{
  const entries = await unzip(zip([['report.xml', XML + ' PK padding']]).buffer);
  is('a ZIP64 signature inside member data does not refuse the archive', entries.length, 1);
}

// ---------------------------------------------------------------- refusals
await rejects('a file that is not a ZIP at all',
  () => unzip(new Uint8Array(40).buffer), 'no end-of-archive record');

await rejects('an encrypted member', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint16(cdOffset(b) + 8, 0x1, true);   // gp bit 0
  return b;
}).buffer), 'encrypted');

await rejects('an unsupported compression method', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint16(cdOffset(b) + 10, 99, true);
  return b;
}).buffer), 'compression method 99');

// Without the bounds check this surfaced "Offset is outside the bounds of the
// DataView", which is a stack trace wearing a sentence.
await rejects('a member offset past the end of the file', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint32(cdOffset(b) + 42, 0xFFFFF0, true);
  return b;
}).buffer), 'past the end');

await rejects('a truncated member', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint32(cdOffset(b) + 20, 0xFFFF, true);   // compSize
  return b;
}).buffer), 'past the end');

await rejects('a multi-disk archive', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint16(b.length - 22 + 4, 1, true);
  return b;
}).buffer), 'multi-disk');

await rejects('a malformed central directory', () => unzip(zip([['a.xml', XML]], b => {
  new DataView(b.buffer).setUint32(cdOffset(b), 0xDEADBEEF, true);
  return b;
}).buffer), 'central directory is malformed');

// Handing a PDF to the XML parser produces "this is not valid XML", which is
// true and the wrong diagnosis.
await rejects('an archive holding no XML',
  () => extractXml(new File([zip([['notes.txt', 'hello']])], 'x.zip')),
  'contains no XML file');

// ------------------------------------------------- magic bytes, not filenames
// Mail clients rename attachments constantly, so the extension cannot be trusted.
{
  const out = await extractXml(new File([XML], 'report.zip'));
  is('a plain XML file named .zip is still read as XML', out[0].text, XML);
}
{
  const gz = new Blob([XML]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  const out = await extractXml(new File([bytes], 'report.bin'));
  is('a gzip file named .bin is still decompressed', out[0].text, XML);
}
{
  const bytes = zip([['report.xml', XML]]);
  const out = await extractXml(new File([bytes], 'report.dat'));
  is('a zip named .dat is still unzipped', out[0].text, XML);
}

if (fails.length) {
  console.error('\nzip reader failures:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`  zip reader ok (${pass} assertions)`);
