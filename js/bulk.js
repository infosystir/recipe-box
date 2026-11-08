/* Bulk import: turn Facebook/Instagram exports, Google Takeout docs and Gmail .mbox
   files into a list of candidates, then run the selected ones through the importer. */
(function () {
  'use strict';
  const RB = window.RB;
  const { fixMojibake, recipeScore } = RB;

  const DOC_EXT = /\.(docx|txt|md|markdown|html?|rtf)$/i;
  const META_JSON_KEEP = /(saved|collection|your_posts|posts?_|group_posts|groups\/|reels)/i;
  const META_JSON_SKIP = /(messages\/|inbox|comments?\.json|likes_and_reactions|reactions|ads_information|security_and_login|logged_information|preferences|apps_and_websites|notifications|search_history|friends|followers|following)/i;
  const IGNORE_URL = /(fbcdn\.net|cdninstagram\.com|scontent[.-]|\/photo\.php|\/photos?\/|facebook\.com\/?$|instagram\.com\/?$|static\.xx\.fbcdn)/i;
  const TEXT_KEYS = new Set(['title', 'name', 'text', 'post', 'description', 'caption', 'content', 'value', 'source']);
  const GENERIC_TITLE = /^(.{0,60}\b(saved|shared|posted|updated|wrote|added|was|is)\b.{0,60})$/i;

  // ---------- Facebook / Instagram JSON ----------
  function metaCandidates(json, path) {
    const isIG = /instagram/i.test(path) || JSON.stringify(json).slice(0, 5000).includes('instagram.com');
    const records = [];
    (function findRecords(node, depth) {
      if (depth > 3 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          records.push(...node);
          return;
        }
        node.forEach((x) => findRecords(x, depth + 1));
        return;
      }
      Object.values(node).forEach((v) => findRecords(v, depth + 1));
    })(json, 0);

    const out = [];
    for (const rec of records) {
      const urls = [];
      const texts = [];
      let ts = 0;
      let owner = '';
      (function walk(n, key) {
        if (n === null || n === undefined) return;
        if (typeof n === 'string') {
          const s = fixMojibake(n).trim();
          if (!s) return;
          if (/^https?:\/\//i.test(s)) {
            if (!IGNORE_URL.test(s) || /instagram\.com\/(p|reel)\//i.test(s) || /facebook\.com\/.+\/posts\//i.test(s)) urls.push(s);
          } else if (TEXT_KEYS.has(key) || s.length > 40) {
            texts.push({ key, s });
          }
          return;
        }
        if (typeof n === 'number') {
          if (/timestamp/i.test(key) && n > 1e9) ts = Math.max(ts, n);
          return;
        }
        if (Array.isArray(n)) return n.forEach((x) => walk(x, key));
        if (typeof n === 'object') {
          // Instagram: {"title":"someuser","string_map_data":{"Saved on":{"href":...}}}
          if (typeof n.title === 'string' && n.string_map_data) owner = fixMojibake(n.title);
          for (const [k, v] of Object.entries(n)) walk(v, k);
        }
      })(rec, '');

      const uniqUrls = [...new Set(urls)];
      const body = [...new Set(texts.map((t) => t.s))].filter((s) => s !== owner);
      const named = texts.find((t) => t.key === 'name' && t.s.length < 120);
      const meaningful = body.filter((s) => !GENERIC_TITLE.test(s) || s.length > 120);
      if (!uniqUrls.length && meaningful.join(' ').length < 40) continue;

      let title = named?.s || meaningful.find((s) => s.length < 100) || '';
      if (!title && owner) title = (isIG ? '@' : '') + owner + "'s post";
      if (!title) title = (meaningful[0] || uniqUrls[0] || 'Saved item').slice(0, 90);

      const text = meaningful.join('\n\n');
      const url = uniqUrls[0] || '';
      const src = RB.sourceTypeFor(url, isIG ? 'instagram' : 'facebook');
      const hintParts = [];
      hintParts.push(`${/saved|collection/i.test(path) ? 'Saved' : 'Shared'} on ${isIG ? 'Instagram' : 'Facebook'}`);
      if (owner) hintParts.push(`by ${isIG ? '@' : ''}${owner}`);
      if (named) hintParts.push(`titled "${named.s}"`);
      out.push({
        kind: text.length > 80 ? 'post' : 'link',
        sourceType: RB.SOCIAL.has(src) ? src : isIG ? 'instagram' : 'facebook',
        title,
        text,
        url,
        postUrl: RB.SOCIAL.has(src) ? url : '',
        hint: hintParts.join(' '),
        date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '',
        file: path,
        score: recipeScore(title + ' ' + text + ' ' + url) + (/saved|collection/i.test(path) ? 1 : 0),
      });
    }
    return out;
  }

  // ---------- Gmail .mbox / .eml ----------
  function decodeWords(s) {
    return String(s || '').replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
      try {
        const bytes =
          enc.toUpperCase() === 'B'
            ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
            : qpBytes(data.replace(/_/g, ' '));
        return new TextDecoder(cs.toLowerCase()).decode(bytes);
      } catch {
        return data;
      }
    });
  }
  function qpBytes(s) {
    const out = [];
    const t = s.replace(/=\r?\n/g, '');
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) {
        out.push(parseInt(t.substr(i + 1, 2), 16));
        i += 2;
      } else out.push(t.charCodeAt(i) & 0xff);
    }
    return new Uint8Array(out);
  }
  function parseHeaders(raw) {
    const hdr = {};
    raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((l) => {
      const i = l.indexOf(':');
      if (i > 0) hdr[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    });
    return hdr;
  }
  function splitHead(part) {
    const m = part.match(/\r?\n\r?\n/);
    if (!m) return [part, ''];
    return [part.slice(0, m.index), part.slice(m.index + m[0].length)];
  }
  function decodeBody(body, hdr) {
    const enc = (hdr['content-transfer-encoding'] || '').toLowerCase();
    const cs = ((hdr['content-type'] || '').match(/charset="?([^";]+)/i) || [])[1] || 'utf-8';
    let bytes;
    if (enc === 'base64') {
      try {
        bytes = Uint8Array.from(atob(body.replace(/\s/g, '')), (c) => c.charCodeAt(0));
      } catch {
        return body;
      }
    } else if (enc === 'quoted-printable') bytes = qpBytes(body);
    else return body;
    try {
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
  /** Best text body of one MIME entity (prefers text/plain, falls back to stripped HTML). */
  function bodyText(raw, depth = 0) {
    const [head, body] = splitHead(raw);
    const hdr = parseHeaders(head);
    const ct = (hdr['content-type'] || 'text/plain').toLowerCase();
    if (ct.startsWith('multipart/') && depth < 5) {
      const b = (hdr['content-type'].match(/boundary="?([^";]+)"?/i) || [])[1];
      if (!b) return '';
      const parts = body.split('--' + b).slice(1).filter((p) => !p.startsWith('--'));
      const texts = parts.map((p) => ({ ct: (parseHeaders(splitHead(p.replace(/^\r?\n/, ''))[0])['content-type'] || '').toLowerCase(), t: () => bodyText(p.replace(/^\r?\n/, ''), depth + 1) }));
      const plain = texts.find((x) => x.ct.startsWith('text/plain') || x.ct.startsWith('multipart/'));
      const html = texts.find((x) => x.ct.startsWith('text/html'));
      return (plain && plain.t()) || (html && html.t()) || '';
    }
    if (ct.startsWith('text/html')) return RB.htmlToText(decodeBody(body, hdr), 100000);
    if (ct.startsWith('text/')) return decodeBody(body, hdr);
    return '';
  }
  function emailCandidates(text, path) {
    const msgs = /^From /.test(text) ? text.split(/\r?\nFrom (?=\S+ .*\d{4}\r?\n)/) : [text];
    const out = [];
    for (let m of msgs) {
      m = m.replace(/^From [^\n]*\n/, '');
      const [head] = splitHead(m);
      const hdr = parseHeaders(head);
      const subject = decodeWords(hdr.subject || '(no subject)');
      let body = bodyText(m).replace(/^>.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!body && !subject) continue;
      body = body.slice(0, 60000);
      const from = decodeWords(hdr.from || '');
      let date = '';
      const d = new Date(hdr.date);
      if (!isNaN(d)) date = d.toISOString().slice(0, 10);
      out.push({
        kind: 'email',
        sourceType: 'email',
        title: subject,
        text: `Subject: ${subject}\nFrom: ${from}\n\n${body}`,
        url: '',
        hint: `Email from ${from}${date ? ' on ' + date : ''}`,
        date,
        file: path,
        score: recipeScore(subject + ' ' + subject + ' ' + body.slice(0, 5000)),
      });
    }
    return out;
  }

  // ---------- Docs (Google Takeout: docx / html / txt) ----------
  async function docCandidate(name, getBlob) {
    const base = name.split('/').pop().replace(/\.[^.]+$/, '');
    let text = '';
    const blob = await getBlob();
    if (/\.docx$/i.test(name)) text = await RB.zip.docxText(blob);
    else if (/\.html?$/i.test(name)) text = RB.htmlToText(await blob.text(), 200000);
    else if (/\.rtf$/i.test(name)) text = (await blob.text()).replace(/\\par[d]?/g, '\n').replace(/\{\*?\\[^{}]+}|[{}]|\\\S+\s?/g, '');
    else text = await blob.text();
    text = text.trim();
    if (!text) return [];
    // Long docs with many recipes get split into chunks Claude can handle in one reply.
    const chunks = chunkText(text, 25000);
    return chunks.map((t, i) => ({
      kind: 'doc',
      sourceType: 'gdoc',
      title: base + (chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''),
      text: t,
      url: '',
      hint: `Google Doc "${base}"`,
      date: '',
      file: name,
      score: recipeScore(base + ' ' + t.slice(0, 5000)) + 1,
    }));
  }
  function chunkText(t, max) {
    if (t.length <= max) return [t];
    const out = [];
    let cur = '';
    for (const para of t.split(/\n{2,}/)) {
      if (cur && cur.length + para.length > max) {
        out.push(cur);
        cur = '';
      }
      cur += (cur ? '\n\n' : '') + para;
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Read whatever the user dropped in. onStatus(msg) for progress text. */
  async function gather(files, onStatus) {
    const all = [];
    const notes = [];
    for (const f of files) {
      const name = f.name;
      try {
        if (/\.zip$/i.test(name)) {
          onStatus && onStatus('Reading ' + name + '…');
          const entries = await RB.zip.listZip(f);
          for (const e of entries) {
            if (e.isDir || /(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
            const inner = name + ' › ' + e.name;
            if (/\.json$/i.test(e.name) && META_JSON_KEEP.test(e.name) && !META_JSON_SKIP.test(e.name) && e.size < 50e6) {
              const json = JSON.parse(await RB.zip.readEntryText(f, e));
              all.push(...metaCandidates(json, inner));
            } else if (DOC_EXT.test(e.name) && e.size < 20e6) {
              all.push(...(await docCandidate(e.name, async () => new Blob([await RB.zip.readEntry(f, e)]))));
            } else if (/\.(mbox|eml)$/i.test(e.name)) {
              if (e.size > 300e6) {
                notes.push(`${e.name} is ${(e.size / 1e6) | 0} MB. Export just a "Recipes" label from Gmail to keep it small.`);
                continue;
              }
              onStatus && onStatus('Reading emails in ' + e.name + '…');
              all.push(...emailCandidates(await RB.zip.readEntryText(f, e), inner));
            }
          }
        } else if (/\.json$/i.test(name)) {
          all.push(...metaCandidates(JSON.parse(await f.text()), name));
        } else if (/\.(mbox|eml)$/i.test(name)) {
          if (f.size > 300e6) {
            notes.push(`${name} is ${(f.size / 1e6) | 0} MB. Export just a "Recipes" label from Gmail to keep it small.`);
            continue;
          }
          onStatus && onStatus('Reading emails in ' + name + '…');
          all.push(...emailCandidates(await f.text(), name));
        } else if (DOC_EXT.test(name)) {
          all.push(...(await docCandidate(name, async () => f)));
        } else {
          notes.push(`Skipped ${name} (unsupported file type).`);
        }
      } catch (e) {
        console.error(e);
        notes.push(`Couldn't read ${name}: ${e.message}`);
      }
    }
    // Dedupe by URL (or title+text for docs/emails) and flag ones already in the box.
    const seen = new Set();
    const out = [];
    for (const c of all) {
      const key = c.url ? RB.normalizeUrl(c.url) : RB.norm(c.title + '|' + c.text.slice(0, 200));
      if (seen.has(key)) continue;
      seen.add(key);
      c.id = RB.uid();
      c.existing = !!(c.url && RB.store.findBySource(c.url)) || RB.store.recipes.some((r) => r.source?.postUrl && c.url && RB.normalizeUrl(r.source.postUrl) === RB.normalizeUrl(c.url));
      c.selected = !c.existing && c.score > 0;
      out.push(c);
    }
    out.sort((a, b) => b.score - a.score);
    return { candidates: out, notes };
  }

  /**
   * Run candidates through the importer.
   * cb: {onItem(c, state, info), onDone(summary)}; returns a controller with stop().
   */
  function runQueue(cands, { keepStubs = true, concurrency = 2 }, cb) {
    const ctrl = new AbortController();
    const summary = { added: 0, stubs: 0, failed: 0, skipped: 0 };
    const me = RB.settings.load().me;
    let idx = 0;
    let sinceSave = 0;

    async function one(c) {
      if (c.existing || (c.url && RB.store.findBySource(c.url))) {
        summary.skipped++;
        cb.onItem(c, 'skipped', 'Already in your recipe box');
        return;
      }
      cb.onItem(c, 'working');
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await RB.claude.importAny(
            { text: c.text, url: c.url, hint: [c.hint, c.title && c.kind !== 'doc' ? 'Title: ' + c.title : ''].filter(Boolean).join('. '), sourceType: c.sourceType, postUrl: c.postUrl, kind: c.kind },
            { signal: ctrl.signal }
          );
          let recs = res.recipes.filter((r) => !r.needsRecipe);
          const stubs = res.recipes.filter((r) => r.needsRecipe);
          if (keepStubs && !recs.length && stubs.length && c.kind !== 'doc') recs = stubs.slice(0, 1);
          recs.forEach((r) => {
            r.addedBy = me;
            if (c.date && !r.notes) r.notes = '';
          });
          if (recs.length) {
            await RB.store.upsert(recs, 'Bulk import', { defer: true });
            sinceSave += recs.length;
            if (sinceSave >= 5) {
              sinceSave = 0;
              RB.store.save('Bulk import').catch(() => {});
            }
          }
          const found = recs.filter((r) => !r.needsRecipe).length;
          summary.added += found;
          summary.stubs += recs.length - found;
          cb.onItem(c, found ? 'done' : recs.length ? 'stub' : 'none', found ? `Added ${recs.map((r) => r.title).join(', ')}` : res.message || 'No recipe found');
          return;
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (e.status === 401 || e.status === 403) {
            ctrl.abort();
            summary.failed++;
            cb.onItem(c, 'error', 'Claude rejected the API key. Check Settings.');
            return;
          }
          if ((e.status === 429 || e.status === 529 || e.status >= 500) && attempt < 3) {
            cb.onItem(c, 'working', 'Busy, retrying…');
            await RB.sleep(5000 * (attempt + 1));
            continue;
          }
          summary.failed++;
          cb.onItem(c, 'error', e.message);
          return;
        }
      }
    }

    async function worker() {
      while (!ctrl.signal.aborted && idx < cands.length) {
        const c = cands[idx++];
        await one(c);
      }
    }

    Promise.all(Array.from({ length: concurrency }, worker)).then(async () => {
      try {
        await RB.store.save('Bulk import');
      } catch {
        /* status bar already shows the save error */
      }
      cb.onDone(summary, ctrl.signal.aborted);
    });
    return { stop: () => ctrl.abort() };
  }

  RB.bulk = { gather, runQueue, metaCandidates, emailCandidates, chunkText };
})();
