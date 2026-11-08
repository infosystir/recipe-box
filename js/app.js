/* UI: routing and views. */
(function () {
  'use strict';
  const RB = window.RB;
  const { h, store, settings, toast, norm, fmtDate, today, avgRating } = RB;

  const app = document.getElementById('app');
  const searchEl = document.getElementById('search');
  const syncEl = document.getElementById('sync');

  const SOURCE_LABEL = { web: 'Web', facebook: 'Facebook', instagram: 'Instagram', gdoc: 'Google Doc', email: 'Email', manual: 'Typed in', tiktok: 'TikTok', pinterest: 'Pinterest', youtube: 'YouTube' };
  const STATUS_OPTS = [
    ['all', 'All recipes'],
    ['fav', 'Favorites'],
    ['made', "We've made"],
    ['notmade', 'Not made yet'],
    ['want', 'Want to make'],
    ['needs', 'Needs recipe'],
  ];
  const SORT_OPTS = [
    ['recent', 'Recently added'],
    ['rating', 'Top rated'],
    ['lastmade', 'Recently made'],
    ['mostmade', 'Most made'],
    ['az', 'A–Z'],
  ];

  const ui = RB.storage.get('rb.ui', { status: 'all', sort: 'recent', cats: [], source: '' });
  const saveUi = () => RB.storage.set('rb.ui', ui);
  let query = '';
  let pendingImport = null; // recipes waiting for review after import

  const me = () => settings.load().me || 'Me';

  // ---------- helpers ----------
  function stars(value, onSet, label) {
    const wrap = h('span', { class: 'stars' + (onSet ? ' editable' : ''), role: onSet ? 'radiogroup' : 'img', 'aria-label': label || `${value || 0} of 5 stars` });
    for (let i = 1; i <= 5; i++) {
      const full = value >= i - 0.25;
      const half = !full && value >= i - 0.75;
      const s = h(onSet ? 'button' : 'span', { class: 'star' + (full ? ' on' : half ? ' half' : ''), type: onSet ? 'button' : undefined, 'aria-label': onSet ? `${i} star${i > 1 ? 's' : ''}` : undefined, title: onSet ? `${i}` : undefined }, '★');
      if (onSet) s.addEventListener('click', () => onSet(value === i ? 0 : i));
      wrap.appendChild(s);
    }
    return wrap;
  }

  function chip(text, opts = {}) {
    return h(opts.onclick ? 'button' : 'span', { class: 'chip' + (opts.active ? ' active' : '') + (opts.kind ? ' ' + opts.kind : ''), type: opts.onclick ? 'button' : undefined, onclick: opts.onclick }, text);
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function lastMade(r) {
    return (r.madeLog || []).reduce((a, m) => (m.date > a ? m.date : a), '');
  }

  function renderList(lines, ordered) {
    const list = h(ordered ? 'ol' : 'ul', { class: ordered ? 'steps' : 'ingredients' });
    let n = 0;
    for (const l of lines || []) {
      if (/^##\s*/.test(l)) {
        list.appendChild(h('li', { class: 'section' }, l.replace(/^##\s*/, '')));
      } else {
        n++;
        list.appendChild(h('li', { dataset: ordered ? { n } : undefined }, l));
      }
    }
    return list;
  }

  function setTitle(t) {
    document.title = t ? `${t} · Recipe Box` : 'Recipe Box';
  }

  // ---------- search & filter ----------
  function haystack(r) {
    return {
      title: norm(r.title),
      meta: norm([...(r.categories || []), ...(r.tags || []), r.cuisine, r.source?.author, r.source?.name].join(' ')),
      body: norm([...(r.ingredients || []), r.notes, r.description, ...(r.madeLog || []).map((m) => m.where + ' ' + m.notes)].join(' ')),
    };
  }
  function score(r, terms) {
    if (!terms.length) return 1;
    const hs = haystack(r);
    let total = 0;
    for (const t of terms) {
      const s = (hs.title.includes(t) ? 5 : 0) + (hs.meta.includes(t) ? 3 : 0) + (hs.body.includes(t) ? 1 : 0);
      if (!s) return 0; // every word must match somewhere
      total += s;
    }
    return total;
  }
  function filtered() {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    let list = store.recipes.map((r) => ({ r, s: score(r, terms) })).filter((x) => x.s > 0);
    list = list.filter(({ r }) => {
      const made = (r.madeLog || []).length > 0;
      switch (ui.status) {
        case 'fav': return r.favorite;
        case 'made': return made;
        case 'notmade': return !made && !r.needsRecipe;
        case 'want': return r.wantToMake;
        case 'needs': return r.needsRecipe;
        default: return true;
      }
    });
    if (ui.cats.length) list = list.filter(({ r }) => ui.cats.every((c) => (r.categories || []).includes(c)));
    if (ui.source) list = list.filter(({ r }) => (r.source?.type || 'manual') === ui.source);
    const by = {
      recent: (a, b) => (b.r.createdAt || '').localeCompare(a.r.createdAt || ''),
      rating: (a, b) => avgRating(b.r) - avgRating(a.r) || (b.r.madeLog?.length || 0) - (a.r.madeLog?.length || 0),
      lastmade: (a, b) => lastMade(b.r).localeCompare(lastMade(a.r)),
      mostmade: (a, b) => (b.r.madeLog?.length || 0) - (a.r.madeLog?.length || 0),
      az: (a, b) => a.r.title.localeCompare(b.r.title),
    }[ui.sort];
    list.sort((a, b) => (terms.length ? b.s - a.s : 0) || by(a, b));
    return list.map((x) => x.r);
  }

  // ---------- views ----------
  function viewLibrary() {
    setTitle('');
    const cats = store.categories();
    const sources = [...new Set(store.recipes.map((r) => r.source?.type || 'manual'))];
    const list = filtered();

    const controls = h(
      'div',
      { class: 'controls' },
      h('select', { 'aria-label': 'Show', onchange: (e) => { ui.status = e.target.value; saveUi(); render(); } }, STATUS_OPTS.map(([v, t]) => h('option', { value: v, selected: ui.status === v }, t))),
      h('select', { 'aria-label': 'Sort', onchange: (e) => { ui.sort = e.target.value; saveUi(); render(); } }, SORT_OPTS.map(([v, t]) => h('option', { value: v, selected: ui.sort === v }, t))),
      sources.length > 1
        ? h('select', { 'aria-label': 'Source', onchange: (e) => { ui.source = e.target.value; saveUi(); render(); } }, h('option', { value: '' }, 'Any source'), sources.map((s) => h('option', { value: s, selected: ui.source === s }, SOURCE_LABEL[s] || s)))
        : null
    );
    const catBar = cats.length
      ? h('div', { class: 'chips scroll' }, cats.map((c) => chip(c, { active: ui.cats.includes(c), onclick: () => { ui.cats = ui.cats.includes(c) ? ui.cats.filter((x) => x !== c) : [...ui.cats, c]; saveUi(); render(); } })), ui.cats.length ? chip('Clear', { kind: 'clear', onclick: () => { ui.cats = []; saveUi(); render(); } }) : null)
      : null;

    let body;
    if (!store.recipes.length) {
      body = h('div', { class: 'empty' },
        h('h2', null, 'Your recipe box is empty'),
        h('p', null, 'Paste a recipe link or a social post to add your first one, or bulk-import your saved Facebook and Instagram posts, Google Docs and emails.'),
        h('div', { class: 'row center' }, h('a', { href: '#/add', class: 'btn primary' }, 'Add a recipe'), h('a', { href: '#/bulk', class: 'btn' }, 'Bulk import')));
    } else if (!list.length) {
      body = h('div', { class: 'empty' }, h('p', null, 'No recipes match.'), h('button', { class: 'btn', type: 'button', onclick: () => { query = ''; searchEl.value = ''; ui.status = 'all'; ui.cats = []; ui.source = ''; saveUi(); render(); } }, 'Clear filters'));
    } else {
      body = h('div', { class: 'grid' }, list.map(card));
    }
    return h('section', null, controls, catBar, h('p', { class: 'count' }, `${list.length} of ${store.recipes.length} recipes`), body);
  }

  function card(r) {
    const avg = avgRating(r);
    const made = (r.madeLog || []).length;
    const img = RB.safeUrl(r.imageUrl);
    return h(
      'a',
      { class: 'card', href: '#/r/' + encodeURIComponent(r.id) },
      img
        ? h('img', { class: 'thumb', onerror: (e) => e.target.replaceWith(placeholder(r)), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', src: img })
        : placeholder(r),
      h('div', { class: 'card-body' },
        h('h3', null, r.favorite ? '♥ ' : '', r.title),
        h('div', { class: 'meta' }, avg ? stars(avg) : null, made ? h('span', { class: 'badge made' }, `Made ${made}×`) : null, r.needsRecipe ? h('span', { class: 'badge warn' }, 'Needs recipe') : null, r.wantToMake ? h('span', { class: 'badge' }, 'Want to make') : null),
        h('div', { class: 'meta small' }, (r.categories || []).join(' · '), r.source?.type && r.source.type !== 'manual' ? h('span', { class: 'src' }, SOURCE_LABEL[r.source.type] || r.source.type) : null)
      )
    );
  }
  function placeholder(r) {
    const hue = [...r.title].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const el = h('div', { class: 'thumb ph' }, (r.title.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase());
    el.style.setProperty('--hue', hue); // CSSOM, allowed by the CSP (inline style attributes aren't)
    return el;
  }

  function viewRecipe(id) {
    const r = store.get(id);
    if (!r) return notFound();
    setTitle(r.title);
    const update = (fn, msg) => {
      const copy = structuredClone(r);
      fn(copy);
      store.upsert(copy, msg || 'Update ' + copy.title).catch((e) => toast(e.message, 'error'));
      render();
    };
    const avg = avgRating(r);
    const raters = Object.entries(r.ratings || {}).filter(([, v]) => v > 0);
    const src = r.source || {};

    const head = h('div', { class: 'recipe-head' },
      RB.safeUrl(r.imageUrl) ? h('img', { class: 'hero', onerror: (e) => e.target.remove(), alt: '', referrerpolicy: 'no-referrer', src: r.imageUrl }) : null,
      h('div', null,
        h('h1', null, r.title),
        r.description ? h('p', { class: 'desc' }, r.description) : null,
        h('div', { class: 'source' },
          src.url ? h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.name || hostOf(src.url)) : h('span', null, SOURCE_LABEL[src.type] || 'Typed in'),
          src.author ? h('span', null, ' · by ' + src.author) : null,
          src.postUrl && src.postUrl !== src.url ? h('span', null, ' · ', h('a', { href: src.postUrl, target: '_blank', rel: 'noopener noreferrer' }, 'original post')) : null,
          r.addedBy ? h('span', { class: 'muted' }, ` · added by ${r.addedBy}`) : null),
        h('div', { class: 'chips' }, (r.categories || []).map((c) => chip(c, { onclick: () => { ui.cats = [c]; saveUi(); location.hash = '#/'; } })), (r.tags || []).map((t) => chip('#' + t, { kind: 'tag', onclick: () => { query = t; searchEl.value = t; location.hash = '#/'; } }))),
        h('div', { class: 'rating-row' },
          h('span', { class: 'label' }, `${me()}'s rating`),
          stars(r.ratings?.[me()] || 0, (v) => update((c) => { c.ratings = { ...(c.ratings || {}), [me()]: v }; }, 'Rate ' + r.title), 'Your rating'),
          raters.length > 1 || (raters.length === 1 && raters[0][0] !== me()) ? h('span', { class: 'muted' }, ' ', raters.map(([k, v]) => `${k} ${v}★`).join(' · '), ` (avg ${avg.toFixed(1)})`) : null),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn' + (r.favorite ? ' active' : ''), type: 'button', onclick: () => update((c) => (c.favorite = !c.favorite)) }, r.favorite ? '♥ Favorite' : '♡ Favorite'),
          h('button', { class: 'btn' + (r.wantToMake ? ' active' : ''), type: 'button', onclick: () => update((c) => (c.wantToMake = !c.wantToMake)) }, r.wantToMake ? '✓ Want to make' : 'Want to make'),
          r.steps?.length ? h('a', { class: 'btn', href: '#/cook/' + encodeURIComponent(r.id) }, 'Cook mode') : null,
          h('a', { class: 'btn', href: '#/edit/' + encodeURIComponent(r.id) }, 'Edit'))
      ));

    const times = [['Prep', r.prepTime], ['Cook', r.cookTime], ['Total', r.totalTime], ['Makes', r.yield]].filter(([, v]) => v);
    const needs = r.needsRecipe ? finishBox(r) : null;

    const madeForm = (() => {
      const date = h('input', { type: 'date', value: today(), required: true });
      const where = h('input', { type: 'text', placeholder: 'Home, camping, Mom’s…', list: 'where-list' });
      const notes = h('textarea', { rows: 2, placeholder: 'How did it go? Changes for next time?' });
      let rating = 0;
      const starHost = h('span');
      const drawStars = () => starHost.replaceChildren(stars(rating, (v) => { rating = v; drawStars(); }, 'Rating for this time'));
      drawStars();
      const wheres = [...new Set(store.recipes.flatMap((x) => (x.madeLog || []).map((m) => m.where)).filter(Boolean))];
      return h('form', { class: 'made-form', onsubmit: (e) => {
        e.preventDefault();
        update((c) => {
          c.madeLog = [...(c.madeLog || []), { id: RB.uid(), date: date.value, where: where.value.trim(), who: me(), rating, notes: notes.value.trim() }];
          if (rating) c.ratings = { ...(c.ratings || {}), [me()]: rating };
          c.wantToMake = false;
        }, 'Made ' + r.title);
        toast('Logged. Nice!');
      } },
        h('div', { class: 'row wrap' }, field('When', date), field('Where', where), field('Rating', starHost)),
        h('datalist', { id: 'where-list' }, wheres.map((w) => h('option', { value: w }))),
        field('Notes', notes),
        h('button', { class: 'btn primary', type: 'submit' }, 'We made this'));
    })();

    const log = (r.madeLog || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const notesBox = (() => {
      const ta = h('textarea', { rows: 4, value: r.notes || '', placeholder: 'Your tweaks: less salt, double the garlic, use the big pan…' });
      const btn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => update((c) => (c.notes = ta.value), 'Notes on ' + r.title) }, 'Save notes');
      ta.addEventListener('input', () => (btn.disabled = ta.value === (r.notes || '')));
      return h('div', { class: 'notes' }, ta, btn);
    })();

    return h('article', { class: 'recipe' },
      h('a', { href: '#/', class: 'back' }, '← All recipes'),
      head,
      needs,
      times.length ? h('div', { class: 'times' }, times.map(([k, v]) => h('div', null, h('span', { class: 'label' }, k), h('strong', null, v)))) : null,
      h('div', { class: 'columns' },
        h('section', null, h('h2', null, 'Ingredients'), r.ingredients?.length ? renderList(r.ingredients) : h('p', { class: 'muted' }, 'None yet.')),
        h('section', null, h('h2', null, 'Steps'), r.steps?.length ? renderList(r.steps, true) : h('p', { class: 'muted' }, 'None yet.'))),
      h('section', null, h('h2', null, 'Our notes'), notesBox),
      h('section', null,
        h('h2', null, 'Times we’ve made it', log.length ? h('span', { class: 'muted' }, ` (${log.length})`) : null),
        log.length
          ? h('ul', { class: 'made-log' }, log.map((m) => h('li', null,
              h('div', null, h('strong', null, fmtDate(m.date)), m.where ? ` · ${m.where}` : '', m.who ? h('span', { class: 'muted' }, ` · ${m.who}`) : null, m.rating ? h('span', null, ' ', stars(m.rating)) : null,
                h('button', { class: 'link danger', type: 'button', 'aria-label': 'Remove this entry', onclick: () => { if (confirm('Remove this entry?')) update((c) => (c.madeLog = c.madeLog.filter((x) => x.id !== m.id))); } }, '×')),
              m.notes ? h('p', null, m.notes) : null)))
          : h('p', { class: 'muted' }, 'Not yet.'),
        madeForm),
      r.originalText ? h('details', { class: 'original' }, h('summary', null, 'Original post / text'), h('pre', null, r.originalText)) : null,
      h('div', { class: 'row danger-zone' },
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (!confirm(`Delete "${r.title}"?`)) return; await store.remove(r.id).catch((e) => toast(e.message, 'error')); location.hash = '#/'; } }, 'Delete recipe')));
  }

  /** For stubs from bulk import: paste the caption or the real link to finish it. */
  function finishBox(r) {
    const ta = h('textarea', { rows: 4, placeholder: 'Paste the post caption, the recipe text, or a link to the recipe…' });
    const btn = h('button', { class: 'btn primary', type: 'button' }, 'Find the recipe');
    const status = h('p', { class: 'muted' });
    btn.addEventListener('click', async () => {
      const text = ta.value.trim() || r.source?.url || r.source?.postUrl;
      if (!text) return;
      btn.disabled = true;
      status.textContent = 'Working… this can take up to a minute when it has to search.';
      try {
        const res = await RB.claude.importAny({ text, hint: `Recipe titled "${r.title}"${r.source?.author ? ' by ' + r.source.author : ''}`, postUrl: r.source?.postUrl, sourceType: r.source?.type });
        const found = res.recipes.find((x) => !x.needsRecipe);
        if (!found) {
          status.textContent = res.message || 'Still not found.';
          btn.disabled = false;
          return;
        }
        const merged = { ...found, id: r.id, ratings: r.ratings, madeLog: r.madeLog, notes: [r.notes, found.notes].filter(Boolean).join('\n\n'), favorite: r.favorite, wantToMake: r.wantToMake, addedBy: r.addedBy, createdAt: r.createdAt, needsRecipe: false, originalText: [r.originalText, found.originalText].filter(Boolean).join('\n\n---\n\n') };
        merged.source = { ...found.source, postUrl: found.source.postUrl || r.source?.postUrl || '' };
        await store.upsert(merged, 'Finish ' + merged.title);
        toast('Recipe found and saved.');
        render();
      } catch (e) {
        status.textContent = e.message;
        btn.disabled = false;
      }
    });
    return h('div', { class: 'callout' },
      h('strong', null, 'This one still needs the actual recipe.'),
      h('p', null, 'The import saved the link but couldn’t find the recipe itself. Open the original post, copy its caption (or find the recipe link), and paste it here.'),
      ta, h('div', { class: 'row' }, btn), status);
  }

  function hostOf(u) {
    try {
      return new URL(u).host.replace(/^www\./, '');
    } catch {
      return u;
    }
  }

  function viewEdit(id, draft) {
    const original = id ? store.get(id) : null;
    if (id && !original) return notFound();
    const r = structuredClone(draft || original || RB.newRecipe({ addedBy: me() }));
    setTitle(id ? 'Edit ' + r.title : 'New recipe');
    const f = {
      title: h('input', { type: 'text', value: r.title, required: true }),
      description: h('textarea', { rows: 2, value: r.description }),
      ingredients: h('textarea', { rows: 10, value: (r.ingredients || []).join('\n'), class: 'mono' }),
      steps: h('textarea', { rows: 10, value: (r.steps || []).join('\n'), class: 'mono' }),
      yield: h('input', { type: 'text', value: r.yield, placeholder: '4 servings' }),
      prepTime: h('input', { type: 'text', value: r.prepTime, placeholder: '15 min' }),
      cookTime: h('input', { type: 'text', value: r.cookTime, placeholder: '30 min' }),
      totalTime: h('input', { type: 'text', value: r.totalTime, placeholder: '45 min' }),
      tags: h('input', { type: 'text', value: (r.tags || []).join(', '), placeholder: 'chicken, slow cooker, quick' }),
      cuisine: h('input', { type: 'text', value: r.cuisine, placeholder: 'Mexican' }),
      url: h('input', { type: 'url', value: r.source?.url || '' }),
      author: h('input', { type: 'text', value: r.source?.author || '' }),
      sourceName: h('input', { type: 'text', value: r.source?.name || '' }),
      type: h('select', null, Object.entries(SOURCE_LABEL).map(([k, v]) => h('option', { value: k, selected: (r.source?.type || 'manual') === k }, v))),
      imageUrl: h('input', { type: 'url', value: r.imageUrl }),
      notes: h('textarea', { rows: 4, value: r.notes }),
    };

    // Category picker: toggle existing ones or add new.
    let cats = [...(r.categories || [])];
    const catHost = h('div', { class: 'chips' });
    const newCat = h('input', { type: 'text', placeholder: 'New category', class: 'inline' });
    const drawCats = () => {
      const all = [...new Set([...store.categories(), ...cats, 'Dinner', 'Breakfast', 'Dessert', 'Side', 'Soup', 'Appetizer', 'Baking', 'Drinks'])];
      catHost.replaceChildren(...all.map((c) => chip(c, { active: cats.includes(c), onclick: () => { cats = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c]; drawCats(); } })));
    };
    drawCats();
    const addCat = () => {
      const v = newCat.value.trim();
      if (v && !cats.includes(v)) cats.push(v);
      newCat.value = '';
      drawCats();
    };
    newCat.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });

    const lines = (t) => t.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^(\d+[.)]|[-•*])\s+/, (m) => (/^##/.test(l) ? m : '')));
    const form = h('form', { class: 'edit', onsubmit: async (e) => {
      e.preventDefault();
      const out = {
        ...r,
        title: f.title.value.trim() || 'Untitled recipe',
        description: f.description.value.trim(),
        ingredients: lines(f.ingredients),
        steps: lines(f.steps),
        yield: f.yield.value.trim(),
        prepTime: f.prepTime.value.trim(),
        cookTime: f.cookTime.value.trim(),
        totalTime: f.totalTime.value.trim(),
        categories: cats,
        tags: f.tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
        cuisine: f.cuisine.value.trim(),
        imageUrl: f.imageUrl.value.trim(),
        notes: f.notes.value,
        source: { ...r.source, type: f.type.value, url: f.url.value.trim(), author: f.author.value.trim(), name: f.sourceName.value.trim() },
      };
      if (out.ingredients.length && out.steps.length) out.needsRecipe = false;
      try {
        const p = store.upsert(out, (id ? 'Edit ' : 'Add ') + out.title);
        if (draft) pendingImport = (pendingImport || []).filter((x) => x.id !== draft.id);
        location.hash = '#/r/' + encodeURIComponent(out.id);
        await p;
        toast('Saved.');
      } catch (err) {
        toast(err.message, 'error');
      }
    } },
      field('Title', f.title),
      field('Description', f.description),
      h('div', { class: 'columns' },
        field('Ingredients', f.ingredients, 'One per line. Start a line with ## for a section, e.g. "## Sauce".'),
        field('Steps', f.steps, 'One step per line.')),
      h('div', { class: 'row wrap' }, field('Makes', f.yield), field('Prep', f.prepTime), field('Cook', f.cookTime), field('Total', f.totalTime)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Categories'), catHost, h('div', { class: 'row' }, newCat, h('button', { class: 'btn small', type: 'button', onclick: addCat }, 'Add'))),
      h('div', { class: 'row wrap' }, field('Tags', f.tags, 'Comma separated'), field('Cuisine', f.cuisine)),
      h('details', { open: !id && !draft },
        h('summary', null, 'Source & photo'),
        h('div', { class: 'row wrap' }, field('Where it came from', f.type), field('Link', f.url), field('Site / account', f.sourceName), field('Creator', f.author)),
        field('Photo URL', f.imageUrl)),
      field('Our notes', f.notes),
      h('div', { class: 'row sticky-actions' },
        h('button', { class: 'btn primary', type: 'submit' }, draft ? 'Save to recipe box' : 'Save'),
        h('a', { class: 'btn', href: id ? '#/r/' + encodeURIComponent(id) : draft ? '#/add' : '#/', onclick: () => { if (draft && pendingImport && pendingImport.length === 1) pendingImport = null; } }, draft ? 'Discard' : 'Cancel')));

    return h('section', { class: 'narrow' }, h('h1', null, id ? 'Edit recipe' : draft ? 'Check it over' : 'New recipe'), form);
  }

  function viewAdd() {
    setTitle('Add a recipe');
    const s = settings.load();
    if (pendingImport && pendingImport.length) return viewReview();
    const ta = h('textarea', { rows: 8, placeholder: 'Paste a link to a recipe site, a Facebook or Instagram post (caption and all), or the recipe text itself.', autofocus: true });
    const hint = h('input', { type: 'text', placeholder: 'Optional: e.g. "the soup from @halfbakedharvest"' });
    const status = h('p', { class: 'muted', 'aria-live': 'polite' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Import');
    let ctrl;
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      const dup = RB.isUrlOnly(text) && store.findBySource(text);
      if (dup) {
        toast('Already in your recipe box.');
        location.hash = '#/r/' + encodeURIComponent(dup.id);
        return;
      }
      btn.disabled = true;
      ctrl = new AbortController();
      status.textContent = s.claudeKey ? 'Reading it… if the post hides the recipe, Claude will go find it (up to a minute).' : 'Reading it…';
      try {
        const res = await RB.claude.importAny({ text, hint: hint.value.trim() }, { signal: ctrl.signal });
        if (!res.recipes.length) {
          status.textContent = res.message || 'No recipe found in that.';
          btn.disabled = false;
          return;
        }
        res.recipes.forEach((r) => (r.addedBy = me()));
        pendingImport = res.recipes;
        pendingImport.message = res.message;
        pendingImport.status = res.status;
        if (res.recipes.length === 1) location.hash = '#/review/' + res.recipes[0].id;
        else render();
      } catch (err) {
        status.textContent = err.message;
        btn.disabled = false;
      }
    } },
      field('Link or post', ta),
      field('Anything that helps find it', hint),
      h('div', { class: 'row' }, btn, h('a', { class: 'btn', href: '#/new' }, 'Type it in myself')),
      status);
    return h('section', { class: 'narrow' },
      h('h1', null, 'Add a recipe'),
      !s.claudeKey ? h('div', { class: 'callout' }, 'Without a Claude API key, links only work through a proxy and posts are parsed by simple rules. ', h('a', { href: '#/settings' }, 'Add a key in Settings'), ' for the good stuff.') : null,
      form);
  }

  function viewReview() {
    const list = pendingImport || [];
    return h('section', { class: 'narrow' },
      h('h1', null, `Found ${list.length} recipes`),
      list.message ? h('p', { class: 'muted' }, list.message) : null,
      h('ul', { class: 'review-list' }, list.map((r) => h('li', null, h('a', { href: '#/review/' + r.id }, r.title), h('span', { class: 'muted' }, ` · ${r.ingredients.length} ingredients`), r.needsRecipe ? h('span', { class: 'badge warn' }, 'Needs recipe') : null))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const all = pendingImport;
          pendingImport = null;
          await store.upsert(all, `Add ${all.length} recipes`).catch((e) => toast(e.message, 'error'));
          toast(`Saved ${all.length} recipes.`);
          location.hash = '#/';
        } }, 'Save all'),
        h('button', { class: 'btn', type: 'button', onclick: () => { pendingImport = null; render(); } }, 'Discard')));
  }

  function viewReviewOne(id) {
    const r = (pendingImport || []).find((x) => x.id === id);
    if (!r) {
      location.hash = '#/add';
      return h('div');
    }
    const view = viewEdit(null, r);
    const msg = pendingImport.message;
    if (msg || r.needsRecipe) {
      view.insertBefore(h('div', { class: 'callout' + (r.needsRecipe ? ' warn' : '') }, msg || '', r.needsRecipe ? ' You can save it anyway and finish it later.' : ''), view.children[1]);
    }
    return view;
  }

  function viewCook(id) {
    const r = store.get(id);
    if (!r) return notFound();
    setTitle('Cooking ' + r.title);
    let lock = null;
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((l) => (lock = l)).catch(() => {});
    window.addEventListener('hashchange', () => lock && lock.release().catch(() => {}), { once: true });
    const ing = h('ul', { class: 'cook-ing' }, (r.ingredients || []).map((l) => /^##/.test(l) ? h('li', { class: 'section' }, l.replace(/^##\s*/, '')) : h('li', null, h('label', null, h('input', { type: 'checkbox' }), ' ', l))));
    let n = 0;
    const steps = h('ol', { class: 'cook-steps' }, (r.steps || []).map((l) => /^##/.test(l) ? h('li', { class: 'section' }, l.replace(/^##\s*/, '')) : h('li', { tabindex: 0, dataset: { n: ++n }, onclick: (e) => { steps.querySelectorAll('.current').forEach((x) => x.classList.remove('current')); e.currentTarget.classList.add('current'); e.currentTarget.classList.add('done'); } }, l)));
    return h('article', { class: 'cook' },
      h('div', { class: 'row between' }, h('a', { href: '#/r/' + encodeURIComponent(r.id), class: 'back' }, '← Done cooking'), h('span', { class: 'muted' }, 'Screen stays on while this is open')),
      h('h1', null, r.title),
      r.notes ? h('div', { class: 'callout' }, h('strong', null, 'Our notes: '), r.notes) : null,
      h('div', { class: 'columns' }, h('section', null, h('h2', null, 'Ingredients'), ing), h('section', null, h('h2', null, 'Steps'), h('p', { class: 'muted small' }, 'Tap a step to mark your place.'), steps)));
  }

  function viewBulk() {
    setTitle('Bulk import');
    const s = settings.load();
    let cands = [];
    const input = h('input', { type: 'file', multiple: true, accept: '.zip,.json,.docx,.txt,.md,.html,.htm,.rtf,.mbox,.eml' });
    const status = h('p', { class: 'muted', 'aria-live': 'polite' });
    const listHost = h('div');
    const filter = h('input', { type: 'search', placeholder: 'Filter this list…' });
    let runner = null;

    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      status.textContent = 'Reading files…';
      const res = await RB.bulk.gather([...input.files], (m) => (status.textContent = m));
      cands = cands.concat(res.candidates);
      status.textContent = `Found ${res.candidates.length} possible recipes.` + (res.notes.length ? ' ' + res.notes.join(' ') : '');
      drawList();
    });
    filter.addEventListener('input', RB.debounce(drawList, 150));

    function drawList() {
      const q = norm(filter.value);
      const shown = cands.filter((c) => !q || norm(c.title + ' ' + c.text + ' ' + c.url).includes(q));
      const selected = cands.filter((c) => c.selected).length;
      const rows = shown.slice(0, 500).map((c) => {
        const cb = h('input', { type: 'checkbox', checked: c.selected, disabled: c.existing, onchange: (e) => { c.selected = e.target.checked; drawList(); } });
        return h('li', { class: 'cand' + (c.state ? ' ' + c.state : ''), id: 'c-' + c.id },
          h('label', null, cb,
            h('span', { class: 'cand-body' },
              h('strong', null, c.title),
              h('span', { class: 'muted small' }, ' ', [SOURCE_LABEL[c.sourceType] || c.sourceType, c.date, c.existing ? 'already saved' : ''].filter(Boolean).join(' · ')),
              c.text ? h('span', { class: 'snippet' }, c.text.slice(0, 180)) : null,
              c.url ? h('span', { class: 'snippet url' }, c.url) : null,
              c.info ? h('span', { class: 'cand-info' }, c.info) : null)));
      });
      listHost.replaceChildren(
        cands.length
          ? h('div', null,
              h('div', { class: 'row wrap between' },
                h('strong', null, `${selected} selected of ${cands.length}`),
                h('div', { class: 'row' },
                  filter,
                  h('button', { class: 'btn small', type: 'button', onclick: () => { shown.forEach((c) => !c.existing && (c.selected = true)); drawList(); } }, 'Select shown'),
                  h('button', { class: 'btn small', type: 'button', onclick: () => { shown.forEach((c) => (c.selected = false)); drawList(); } }, 'Clear shown'))),
              h('ul', { class: 'cands' }, rows),
              shown.length > 500 ? h('p', { class: 'muted' }, `Showing first 500 of ${shown.length}. Use the filter to narrow down.`) : null,
              h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'keep-stubs', checked: true }), ' Save posts where the recipe can’t be found as “Needs recipe” so we can finish them later'),
              h('div', { class: 'row sticky-actions' },
                runner
                  ? h('button', { class: 'btn danger', type: 'button', onclick: () => { runner.stop(); runner = null; status.textContent = 'Stopping after the current items…'; } }, 'Stop')
                  : h('button', { class: 'btn primary', type: 'button', disabled: !selected || !s.claudeKey, onclick: start }, `Import ${selected} selected`),
                !s.claudeKey ? h('span', { class: 'muted' }, 'Bulk import needs a Claude API key. ', h('a', { href: '#/settings' }, 'Settings')) : h('span', { class: 'muted small' }, `Roughly 2–10¢ each with Sonnet, more when it has to search.`)))
          : null);
    }

    function start() {
      const todo = cands.filter((c) => c.selected && !c.state);
      if (!todo.length) return;
      const keep = document.getElementById('keep-stubs')?.checked !== false;
      let done = 0;
      status.textContent = `Importing 0 of ${todo.length}…`;
      runner = RB.bulk.runQueue(todo, { keepStubs: keep }, {
        onItem(c, state, info) {
          c.state = state;
          c.info = info || '';
          if (state !== 'working') {
            c.selected = false;
            done++;
            status.textContent = `Importing ${done} of ${todo.length}…`;
          }
          drawList();
        },
        onDone(sum, stopped) {
          runner = null;
          status.textContent = `${stopped ? 'Stopped. ' : 'Done. '}Added ${sum.added} recipes, ${sum.stubs} need the recipe filled in, ${sum.skipped} already saved, ${sum.failed} failed.`;
          drawList();
        },
      });
      drawList();
    }

    const help = (title, ...body) => h('details', { class: 'help' }, h('summary', null, title), ...body);
    return h('section', { class: 'narrow' },
      h('h1', null, 'Bulk import'),
      h('p', null, 'Drop in your exports. Nothing is imported until you pick which items to run.'),
      help('Facebook: saved posts and your posts',
        h('ol', null,
          h('li', null, 'Facebook → Settings & privacy → Settings → Accounts Center → Your information and permissions → Download your information.'),
          h('li', null, 'Choose “Specific types of information” and tick Saved items and collections, Posts and Groups.'),
          h('li', null, 'Format: JSON. Media quality: Low. Date range: All time. Create the file, then download the .zip when it’s ready.'),
          h('li', null, 'Select the .zip here (no need to unzip).')),
        h('p', { class: 'muted small' }, 'Exports only include posts you saved or posted yourself. For recipes in groups, tap “Save post” first, or paste them one at a time.')),
      help('Instagram: saved posts',
        h('ol', null,
          h('li', null, 'Instagram → Settings → Accounts Center → Your information and permissions → Download your information.'),
          h('li', null, 'Pick your Instagram account, “Specific types of information”, then Saved. Format JSON.'),
          h('li', null, 'Select the downloaded .zip here.')),
        h('p', { class: 'muted small' }, 'Instagram exports only include the link and the creator, not the caption. Claude searches for the recipe by creator; anything it can’t find is saved as “Needs recipe” so you can paste the caption later.')),
      help('Google Docs (personal account)',
        h('ol', null,
          h('li', null, 'Put your recipe docs in one Drive folder.'),
          h('li', null, 'Go to takeout.google.com → Deselect all → tick Drive → “All Drive data included” → choose just that folder. Under “Multiple formats”, set Documents to DOCX.'),
          h('li', null, 'Export, download the .zip, and select it here. You can also select .docx, .txt or .html files directly.')),
        h('p', { class: 'muted small' }, 'Docs holding many recipes are split up, and each recipe comes out separately.')),
      help('Gmail (personal account)',
        h('ol', null,
          h('li', null, 'In Gmail, search for your recipe emails and apply a label like “Recipes”.'),
          h('li', null, 'takeout.google.com → Deselect all → Mail → “All Mail data included” → only the Recipes label.'),
          h('li', null, 'Select the .zip (or the .mbox inside it) here.'))),
      field('Export files', input, '.zip, .json, .docx, .txt, .html, .mbox'),
      status,
      listHost);
  }

  function viewSettings() {
    setTitle('Settings');
    const s = settings.load();
    const f = {
      me: h('input', { type: 'text', value: s.me, placeholder: 'Mando', required: true }),
      mode: h('select', null, h('option', { value: 'github', selected: s.mode === 'github' }, 'Private GitHub repo (shared)'), h('option', { value: 'local', selected: s.mode === 'local' }, 'This browser only (trying it out)')),
      ghRepo: h('input', { type: 'text', value: s.ghRepo, placeholder: 'infosystir/recipe-box-data' }),
      ghToken: h('input', { type: 'password', value: s.ghToken, placeholder: 'github_pat_…', autocomplete: 'off' }),
      ghPath: h('input', { type: 'text', value: s.ghPath }),
      ghBranch: h('input', { type: 'text', value: s.ghBranch, placeholder: 'default branch' }),
      claudeKey: h('input', { type: 'password', value: s.claudeKey, placeholder: 'sk-ant-…', autocomplete: 'off' }),
      claudeModel: h('input', { type: 'text', value: s.claudeModel, list: 'model-list' }),
      useWebTools: h('input', { type: 'checkbox', checked: s.useWebTools }),
      proxyUrl: h('input', { type: 'url', value: s.proxyUrl, placeholder: 'https://recipe-proxy.you.workers.dev/?key=…&url=' }),
    };
    const modelList = h('datalist', { id: 'model-list' });
    const out = h('p', { class: 'muted', 'aria-live': 'polite' });
    const gh = h('div', null,
      field('Data repo', f.ghRepo, 'owner/name of the PRIVATE repo that holds recipes.json'),
      field('GitHub token', f.ghToken, 'Fine-grained token with Contents: Read and write on just that repo.'),
      h('details', null, h('summary', null, 'Advanced'), h('div', { class: 'row wrap' }, field('File path', f.ghPath), field('Branch', f.ghBranch))));
    const toggle = () => (gh.style.display = f.mode.value === 'github' ? '' : 'none');
    f.mode.addEventListener('change', toggle);
    toggle();

    const collect = () => ({
      ...s,
      me: f.me.value.trim(),
      mode: f.mode.value,
      ghRepo: f.ghRepo.value.trim(),
      ghToken: f.ghToken.value.trim(),
      ghPath: f.ghPath.value.trim() || 'recipes.json',
      ghBranch: f.ghBranch.value.trim(),
      claudeKey: f.claudeKey.value.trim(),
      claudeModel: f.claudeModel.value.trim() || 'claude-sonnet-4-5',
      useWebTools: f.useWebTools.checked,
      proxyUrl: f.proxyUrl.value.trim(),
    });

    const form = h('form', { class: 'settings', onsubmit: async (e) => {
      e.preventDefault();
      const n = collect();
      if (n.mode === 'github' && (!n.ghRepo || !n.ghToken)) {
        out.textContent = 'Add the repo and token, or switch to “This browser only”.';
        return;
      }
      settings.save(n);
      store.configure(n);
      out.textContent = 'Connecting…';
      try {
        const info = await store.backend.check();
        if (!info.canPush) throw new Error('That token can read the repo but not write to it.');
        await store.load();
        out.textContent = `Connected to ${info.name}${info.private === false ? '. Warning: this repo is PUBLIC, so anyone can read your recipes. Make it private on GitHub.' : '.'}`;
        toast('Settings saved.');
      } catch (err) {
        out.textContent = 'Saved, but couldn’t connect: ' + err.message;
      }
    } },
      field('Your name', f.me, 'Used for ratings and “who made it”. Each of you sets this on your own device.'),
      h('h2', null, 'Where recipes are stored'),
      field('Storage', f.mode),
      gh,
      h('h2', null, 'Importing'),
      field('Claude API key', f.claudeKey, 'From console.anthropic.com. Set a monthly spend limit there. Stored only in this browser.'),
      h('div', { class: 'row' }, field('Model', f.claudeModel), h('button', { class: 'btn small', type: 'button', onclick: async () => {
        try {
          const models = await RB.claude.listModels(f.claudeKey.value.trim());
          modelList.replaceChildren(...models.map((m) => h('option', { value: m.id }, m.name)));
          out.textContent = `Loaded ${models.length} models. Click the Model box to pick one.`;
        } catch (err) {
          out.textContent = err.message;
        }
      } }, 'Load models')),
      modelList,
      h('label', { class: 'check' }, f.useWebTools, ' Let Claude search the web and fetch pages (needed to find recipes that posts hide)'),
      h('details', null, h('summary', null, 'Optional: page-fetching proxy'),
        h('p', { class: 'muted small' }, 'A tiny Cloudflare Worker (see worker/ in the repo) lets the app read recipe cards on websites for free, without using Claude. Leave blank to have Claude fetch pages instead.'),
        field('Proxy URL prefix', f.proxyUrl, 'The page URL is appended to the end.')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save & connect')),
      out);

    const backup = h('div', { class: 'row wrap' },
      h('button', { class: 'btn', type: 'button', onclick: () => {
        const blob = new Blob([JSON.stringify(store.data, null, 1)], { type: 'application/json' });
        const a = h('a', { download: `recipes-${today()}.json` });
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Download backup'),
      (() => {
        const inp = h('input', { type: 'file', accept: '.json', class: 'visually-hidden', onchange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const data = JSON.parse(await file.text());
            if (!Array.isArray(data.recipes)) throw new Error('That file isn’t a recipe box backup.');
            if (!confirm(`Merge ${data.recipes.length} recipes from the backup into your box?`)) return;
            store.data = RB.merge(store.data, data);
            store.dirty = true;
            await store.save('Restore from backup');
            toast('Backup merged.');
          } catch (err) {
            toast(err.message, 'error');
          }
        } });
        return h('label', { class: 'btn' }, 'Restore backup…', inp);
      })());

    return h('section', { class: 'narrow' }, h('h1', null, 'Settings'),
      !settings.isConfigured ? h('div', { class: 'callout' }, h('strong', null, 'Welcome! '), 'Set your name and where recipes live. The README in the repo walks through creating the private data repo and tokens.') : null,
      form,
      h('h2', null, 'Backup'), backup,
      h('p', { class: 'muted small' }, 'Tokens and keys stay in this browser’s storage and are only sent to api.github.com and api.anthropic.com.'));
  }

  function notFound() {
    return h('div', { class: 'empty' }, h('p', null, 'That recipe isn’t here.'), h('a', { href: '#/', class: 'btn' }, 'Back to recipes'));
  }

  // ---------- routing ----------
  function render() {
    const hash = location.hash || '#/';
    const [, route, arg] = hash.match(/^#\/([^/]*)\/?(.*)$/) || [];
    const id = decodeURIComponent(arg || '');
    let view;
    if (!settings.isConfigured && route !== 'settings') {
      location.hash = '#/settings';
      return;
    }
    switch (route) {
      case '': view = viewLibrary(); break;
      case 'r': view = viewRecipe(id); break;
      case 'edit': view = viewEdit(id); break;
      case 'new': view = viewEdit(null); break;
      case 'add': view = viewAdd(); break;
      case 'review': view = viewReviewOne(id); break;
      case 'cook': view = viewCook(id); break;
      case 'bulk': view = viewBulk(); break;
      case 'settings': view = viewSettings(); break;
      default: view = notFound();
    }
    document.body.dataset.route = route || 'home';
    app.replaceChildren(view);
  }

  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });

  searchEl.addEventListener('input', RB.debounce(() => {
    query = searchEl.value;
    if ((location.hash || '#/') !== '#/') location.hash = '#/';
    else render();
  }, 120));

  // Re-render the library/recipe when data changes, but never under someone typing in a form.
  store.onChange(() => {
    drawSync();
    const route = document.body.dataset.route;
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement !== searchEl;
    if ((route === 'home' || route === 'r') && !typing) render();
  });

  function drawSync() {
    const map = { loading: 'Syncing…', saving: 'Saving…', saved: '', error: 'Couldn’t sync: ' + (store.lastError || ''), offline: 'Offline. Showing your last synced copy.' };
    syncEl.textContent = map[store.status] || '';
    syncEl.className = 'sync ' + store.status;
  }

  // Pick up the other person's changes when coming back to the tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && settings.isConfigured && store.status !== 'saving' && !store.dirty) store.load().catch(() => {});
  });

  // ---------- boot ----------
  async function boot() {
    if (settings.isConfigured) {
      store.configure(settings.load());
      render();
      try {
        await store.load();
      } catch (e) {
        toast(e.message, 'error');
      }
    } else {
      render();
    }
  }
  boot();
})();
