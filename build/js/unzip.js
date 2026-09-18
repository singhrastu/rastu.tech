/* A minimal ZIP reader, because DMARC aggregate reports arrive as .zip and there
 * is no library on this site.
 *
 * The important design choice: read the End of Central Directory backwards from
 * the tail and walk the central directory, rather than parsing forward from local
 * file headers. Streaming producers - which is exactly how a mail system generates
 * a report attachment on the fly - set general-purpose bit 3, which zeroes the
 * sizes in the local header and puts the real ones in a data descriptor AFTER the
 * compressed data. You cannot find that descriptor without already knowing the
 * length, so forward parsing is circular. The central directory always carries
 * authoritative sizes regardless of bit 3.
 *
 * Everything it cannot handle is an explicit refusal naming the reason. A partial
 * read presented as a complete one is the failure mode worth avoiding here.
 */
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD64_LOC = 0x07064b50;

export class ZipError extends Error {
  constructor(msg) { super(msg); this.name = 'ZipError'; }
}

/* deflate-raw is the real browser support floor for this path (Safari 16.4,
   Firefox 113, Chrome 103). Feature-test it; never sniff a version. */
export function canInflate() {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
}

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Entries in a ZIP, as { name, bytes }. Throws ZipError with a readable reason. */
export async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;

  // The EOCD is at the very end unless there is a trailing comment, which is
  // capped at 64 KB. Scan backwards for the signature.
  const from = Math.max(0, len - 65557);
  let eocd = -1;
  for (let i = len - 22; i >= from; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new ZipError('This does not look like a ZIP file: no end-of-archive record '
      + 'in the last 64 KB.');
  }

  for (let i = eocd - 20; i >= from; i--) {
    if (view.getUint32(i, true) === SIG_EOCD64_LOC) {
      throw new ZipError('This is a ZIP64 archive. DMARC reports are never this large, '
        + 'so something else is going on; unzip it locally and upload the XML.');
    }
  }

  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new ZipError('This is a multi-disk ZIP archive, which is not supported. '
      + 'Unzip it locally and upload the XML.');
  }

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > len || view.getUint32(p, true) !== SIG_CD) {
      throw new ZipError('The ZIP central directory is malformed, so the archive '
        + 'cannot be read reliably.');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'utf-8')
      .decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (flags & 0x1) {
      throw new ZipError(`"${name}" is encrypted. Decrypt it locally and upload the XML.`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`"${name}" uses compression method ${method}, which the browser `
        + 'cannot decompress. Only stored and deflate are supported.');
    }

    // The local header's own name and extra lengths differ from the central
    // directory's, so the data offset has to be computed from the local header.
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);

    if (!name.endsWith('/')) {
      out.push({
        name,
        bytes: method === 0 ? raw.slice() : await inflateRaw(raw),
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (!out.length) throw new ZipError('The ZIP archive contains no files.');
  return out;
}

/** gzip, zip or plain XML, decided by magic bytes rather than the filename: mail
 *  clients rename attachments constantly and the extension lies. */
export async function extractXml(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);

  if (b[0] === 0x1f && b[1] === 0x8b) {
    if (!canInflate()) {
      throw new ZipError('This browser cannot decompress the file. Decompress it '
        + 'locally and paste or upload the XML.');
    }
    try {
      const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return [{ name: file.name.replace(/\.gz$/i, ''),
                text: await new Response(s).text() }];
    } catch (e) {
      // The spec allows only one gzip member and the TypeError message differs in
      // every engine, so the message is never branched on.
      throw new ZipError('The gzip file could not be decompressed. If it contains '
        + 'more than one compressed member, browsers reject it by design.');
    }
  }

  if (b[0] === 0x50 && b[1] === 0x4b) {
    if (!canInflate()) {
      throw new ZipError('This browser cannot open ZIP archives. Unzip it locally '
        + 'and upload the XML.');
    }
    const entries = await unzip(buf);
    const xml = entries.filter(x => /\.xml$/i.test(x.name));
    const use = xml.length ? xml : entries;
    return use.map(x => ({ name: x.name, text: new TextDecoder().decode(x.bytes) }));
  }

  return [{ name: file.name, text: new TextDecoder().decode(b) }];
}
