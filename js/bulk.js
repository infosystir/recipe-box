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
        want: /restaurant/i.test(path + ' ' + text.slice(0, 200)) ? 'restaurant' : 'auto',
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
        want: 'recipe',
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
      want: 'recipe',
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

  /**
   * A pasted list, e.g. from a Claude in Chrome run over saved collections.
   * Accepts one or more JSON arrays (batches) of
   *   {type: "recipe"|"restaurant"|"unsure", platform, collection, url, author, title, caption, links:[], author_comments:[]}
   * or, failing that, plain text with one post per block separated by blank lines.
   */
  function listCandidates(text) {
    const items = [];
    const blocks = topLevelArrays(String(text));
    for (const b of blocks) {
      try {
        const v = JSON.parse(b);
        if (Array.isArray(v)) items.push(...v.filter((x) => x && typeof x === 'object'));
      } catch {
        /* not a JSON block; ignore */
      }
    }
    if (!items.length) {
      try {
        const v = JSON.parse(text);
        if (Array.isArray(v)) items.push(...v);
        else if (v && Array.isArray(v.items)) items.push(...v.items);
      } catch {
        String(text).split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).forEach((t) => items.push({ caption: t, url: RB.findUrls(t)[0] || '' }));
      }
    }
    return items.map((it) => {
      const type = String(it.type || it.want || '').toLowerCase();
      const coll = String(it.collection || '');
      const want = /restaurant/.test(type) || /restaurant/i.test(coll) ? 'restaurant' : /recipe/.test(type) || /recipe/i.test(coll) ? 'recipe' : 'auto';
      const url = it.url || it.postUrl || it.link || '';
      // Creators often put the recipe itself in their own first comment.
      const own = (Array.isArray(it.author_comments) ? it.author_comments : []).filter(Boolean).map((c) => 'Comment by the author: ' + c);
      const caption = [it.caption || it.text || '', ...own, it.location ? 'Location tag: ' + it.location : '', ...(Array.isArray(it.links) ? it.links : [])].filter(Boolean).join('\n').trim();
      const platform = String(it.platform || '').toLowerCase();
      const src = RB.sourceTypeFor(url, platform.includes('insta') ? 'instagram' : platform.includes('face') ? 'facebook' : 'manual');
      const author = it.author || it.creator || '';
      const title = it.title || (caption.split('\n')[0] || '').slice(0, 90) || (author ? author + "'s post" : url);
      return {
        want,
        kind: caption.length > 40 ? 'post' : 'link',
        sourceType: src,
        title,
        text: caption,
        url,
        postUrl: RB.SOCIAL.has(src) ? url : '',
        author,
        hint: [platform && `Saved on ${platform}`, coll && `in the "${coll}" collection`, author && `by ${author}`].filter(Boolean).join(' '),
        date: it.date || '',
        image: typeof it.image === 'string' ? it.image : '',
        place: { address: String(it.address || ''), city: String(it.city || ''), neighborhood: String(it.neighborhood || '') },
        file: 'pasted list',
        score: 1 + recipeScore(title + ' ' + caption),
      };
    });
  }

  /** Find every top-level [...] in text (bracket matching that respects JSON strings). */
  function topLevelArrays(t) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"' && depth > 0) inStr = true;
      else if (ch === '[') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === ']' && depth > 0) {
        depth--;
        if (depth === 0) out.push(t.slice(start, i + 1));
      }
    }
    return out;
  }

  /** Mark duplicates/already-imported and pick defaults. */
  function finalize(all) {
    const seen = new Set();
    const out = [];
    for (const c of all) {
      const key = c.url ? RB.normalizeUrl(c.url) : RB.norm(c.title + '|' + c.text.slice(0, 200));
      if (seen.has(key)) continue;
      seen.add(key);
      c.id = RB.uid();
      c.existing = !!(c.url && (RB.store.findBySource(c.url) || RB.store.hasPost(c.url)));
      c.selected = !c.existing && (c.score > 0 || c.want === 'restaurant');
      out.push(c);
    }
    out.sort((a, b) => b.score - a.score);
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
    return { candidates: finalize(all), notes };
  }

  /**
   * Run candidates through the importer.
   * cb: {onItem(c, state, info), onDone(summary)}; returns a controller with stop().
   */
  function runQueue(cands, { keepStubs = true, concurrency = 2 }, cb) {
    const ctrl = new AbortController();
    const summary = { added: 0, places: 0, stubs: 0, neither: 0, failed: 0, skipped: 0 };
    const me = RB.settings.load().me;
    let idx = 0;
    let sinceSave = 0;

    async function one(c) {
      if (c.existing || (c.url && (RB.store.findBySource(c.url) || RB.store.hasPost(c.url)))) {
        summary.skipped++;
        cb.onItem(c, 'skipped', 'Already in your recipe box');
        return;
      }
      cb.onItem(c, 'working');
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await RB.claude.importAny(
            { text: c.text, url: c.url, hint: [c.hint, c.title && c.kind !== 'doc' ? 'Title: ' + c.title : ''].filter(Boolean).join('. '), sourceType: c.sourceType, postUrl: c.postUrl, kind: c.kind, want: c.want || 'recipe', author: c.author },
            { signal: ctrl.signal }
          );
          let recs = res.recipes.filter((r) => !r.needsRecipe);
          const stubs = res.recipes.filter((r) => r.needsRecipe);
          if (keepStubs && !recs.length && stubs.length && c.kind !== 'doc') recs = stubs.slice(0, 1);
          recs.forEach((r) => {
            r.addedBy = me;
            if (c.date && !r.notes) r.notes = '';
          });
          // Restaurants: skip ones already saved under the same name and city.
          const places = (res.restaurants || []).filter((p) => !RB.store.findRestaurant(p.name, p.city));
          places.forEach((p) => (p.addedBy = me));
          if (places.length) await RB.store.upsert(places, 'Bulk import', { defer: true, coll: 'restaurants' });
          summary.places += places.length;
          if (recs.length || places.length) {
            if (recs.length) await RB.store.upsert(recs, 'Bulk import', { defer: true });
            sinceSave += recs.length + places.length;
            if (sinceSave >= 5) {
              sinceSave = 0;
              RB.store.save('Bulk import').catch(() => {});
            }
          }
          const found = recs.filter((r) => !r.needsRecipe).length;
          summary.added += found;
          summary.stubs += recs.length - found;
          if (!recs.length && !places.length) summary.neither++;
          const names = [...recs.filter((r) => !r.needsRecipe).map((r) => r.title), ...places.map((p) => 'Place: ' + p.name)];
          cb.onItem(c, names.length ? 'done' : recs.length ? 'stub' : 'none', names.length ? `Added ${names.join(', ')}` : res.message || 'Nothing found');
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

  const SAVED_POSTS = 'imports/saved-posts.json';

  /** Stable id per post, so two devices syncing at once can't create duplicates and deletions stick. */
  function postId(url) {
    let x = 0x811c9dc5;
    for (const ch of RB.normalizeUrl(url)) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return 'sp-' + x.toString(36);
  }

  /**
   * Add every post in the data repo's imports/saved-posts.json that isn't in the box yet,
   * as a "needs recipe" stub (no Claude, no cost). Returns how many were added.
   */
  async function syncSavedPosts() {
    const backend = RB.store.backend;
    if (!backend || !backend.readText) return 0;
    let text;
    try {
      ({ text } = await backend.readText(SAVED_POSTS));
    } catch (e) {
      if (e.status === 404) return 0;
      throw e;
    }
    const d = RB.store.data;
    const seen = new Set([...d.recipes, ...d.restaurants].map((r) => r.id)); // includes deleted markers
    const recs = [];
    const places = [];
    const photos = [];
    for (const c of listCandidates(text)) {
      if (!c.url) continue;
      const id = postId(c.url);
      const imageUrl = /^images\/[\w.-]+$/.test(c.image) ? 'repo:' + c.image : '';
      const where = Object.fromEntries(Object.entries(c.place).filter(([, v]) => v));
      if (seen.has(id)) {
        // Photos and locations can be added to the file after the post was synced; fill them in.
        const coll = RB.store.get(id) ? 'recipes' : 'restaurants';
        const old = RB.store.get(id, coll);
        if (!old) continue;
        const patch = {};
        if (imageUrl && !old.imageUrl) patch.imageUrl = imageUrl;
        if (coll === 'restaurants' && !old.city && !old.address) Object.assign(patch, where);
        if (Object.keys(patch).length) photos.push([{ ...old, ...patch }, coll]);
        continue;
      }
      if (RB.store.hasPost(c.url)) continue;
      seen.add(id);
      const source = { type: c.sourceType, url: '', author: c.author, postUrl: c.url };
      if (c.want === 'restaurant') places.push(RB.newRestaurant({ id, imageUrl, ...where, name: c.title, source, originalText: c.text, tags: ['saved post'] }));
      else recs.push(RB.newRecipe({ id, imageUrl, title: c.title, source, originalText: c.text, needsRecipe: true, tags: c.want === 'auto' ? ['saved post', 'check type'] : ['saved post'] }));
    }
    if (places.length) await RB.store.upsert(places, '', { defer: true, coll: 'restaurants' });
    if (recs.length) await RB.store.upsert(recs, '', { defer: true });
    for (const [r, coll] of photos) await RB.store.upsert(r, '', { defer: true, coll });
    if (recs.length || places.length || photos.length) await RB.store.save(recs.length + places.length ? `Add ${recs.length + places.length} saved posts` : `Update ${photos.length} saved posts`);
    return recs.length + places.length;
  }

  RB.bulk = { gather, runQueue, listCandidates, finalize, metaCandidates, emailCandidates, chunkText, syncSavedPosts, postId, SAVED_POSTS };
})();
