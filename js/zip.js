/* Minimal ZIP reader (no dependencies). Reads only the entries you ask for, so a
   multi-GB Facebook export doesn't have to fit in memory. Also extracts .docx text. */
(function () {
  'use strict';
  const RB = window.RB;

  async function readBytes(blob, start, len) {
    return new DataView(await blob.slice(start, start + len).arrayBuffer());
  }
  const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

  /** Returns [{name, size, compSize, method, offset, isDir}] */
  async function listZip(blob) {
    const tailLen = Math.min(blob.size, 65557 + 20);
    const tail = await readBytes(blob, blob.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file (or it is damaged).');
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    // ZIP64
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const z64off = u64(tail, loc + 8);
        const z64 = await readBytes(blob, z64off, 56);
        count = u64(z64, 32);
        cdSize = u64(z64, 40);
        cdOffset = u64(z64, 48);
      }
    }
    const cd = await readBytes(blob, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    const dec = new TextDecoder();
    for (let i = 0; i < count && p < cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true);
      let compSize = cd.getUint32(p + 20, true);
      let size = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      // ZIP64 extra field
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.getUint16(e, true);
        const sz = cd.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
          if (compSize === 0xffffffff) (compSize = u64(cd, q)), (q += 8);
          if (offset === 0xffffffff) offset = u64(cd, q);
        }
        e += 4 + sz;
      }
      entries.push({ name, size, compSize, method, offset, isDir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(blob, entry) {
    const lh = await readBytes(blob, entry.offset, 30);
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Bad zip entry: ' + entry.name);
    const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const data = blob.slice(start, start + entry.compSize);
    if (entry.method === 0) return new Uint8Array(await data.arrayBuffer());
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip files. Unzip it first and select the files inside.');
      const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('Unsupported compression in ' + entry.name);
  }

  async function readEntryText(blob, entry) {
    return new TextDecoder().decode(await readEntry(blob, entry));
  }

  /** Plain text from a .docx (paragraphs → lines, list items keep a bullet). */
  async function docxText(blob) {
    const entries = await listZip(blob);
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('Not a Word document.');
    const xml = await readEntryText(blob, doc);
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const lines = [];
    for (const p of dom.getElementsByTagNameNS(W, 'p')) {
      let t = '';
      for (const n of p.getElementsByTagNameNS(W, '*')) {
        if (n.localName === 't') t += n.textContent;
        else if (n.localName === 'tab') t += '\t';
        else if (n.localName === 'br') t += '\n';
      }
      const isList = p.getElementsByTagNameNS(W, 'numPr').length > 0;
      lines.push((isList && t.trim() ? '• ' : '') + t);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  RB.zip = { listZip, readEntry, readEntryText, docxText };
})();
