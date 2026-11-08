/* Importing a recipe from a link, a pasted social post, a doc or an email. */
(function () {
  'use strict';
  const RB = window.RB;

  const API = 'https://api.anthropic.com/v1';
  const WEB_TOOLS = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 30000 },
  ];
  let webToolsUnavailable = false;

  function headers(apiKey, withWebTools) {
    const h = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the API straight from a browser. The key stays in this
      // browser's storage and is only ever sent to api.anthropic.com.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (withWebTools) h['anthropic-beta'] = 'web-fetch-2025-09-10';
    return h;
  }

  async function listModels(apiKey) {
    const res = await fetch(API + '/models?limit=100', { headers: headers(apiKey) });
    if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + (await errText(res)));
    const j = await res.json();
    return (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }

  async function errText(res) {
    try {
      const j = await res.json();
      return j.error?.message || JSON.stringify(j);
    } catch {
      return res.statusText;
    }
  }

  /** One Messages call, continuing automatically when server tools pause the turn. */
  async function run({ apiKey, model, system, prompt, useWebTools, maxTokens, signal }) {
    const tools = useWebTools && !webToolsUnavailable ? WEB_TOOLS : null;
    const messages = [{ role: 'user', content: prompt }];
    let final = null;
    for (let i = 0; i < 6; i++) {
      const body = { model, max_tokens: maxTokens || 8000, system, messages };
      if (tools) body.tools = tools;
      const res = await fetch(API + '/messages', { method: 'POST', headers: headers(apiKey, !!tools), body: JSON.stringify(body), signal });
      if (!res.ok) {
        const msg = await errText(res);
        if (tools && res.status === 400 && /tool|beta|web_(fetch|search)/i.test(msg)) {
          // Web tools not enabled for this key/org: fall back to plain extraction.
          webToolsUnavailable = true;
          return run({ apiKey, model, system, prompt, useWebTools: false, maxTokens, signal });
        }
        const e = new Error('Claude API ' + res.status + ': ' + msg);
        e.status = res.status;
        throw e;
      }
      final = await res.json();
      if (final.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: final.content });
        continue;
      }
      break;
    }
    const text = (final?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { text, usage: final?.usage, truncated: final?.stop_reason === 'max_tokens' };
  }

  function extractJson(text) {
    const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
    const candidates = [...fences.reverse(), text];
    for (const c of candidates) {
      const start = c.indexOf('{');
      const end = c.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  const RECIPE_RULES = `RECIPES
- Copy ingredient quantities and steps faithfully. Tidy formatting only. Never invent, guess or "fill in" quantities, ingredients or steps.
- If a list has sections (e.g. "For the sauce"), put the section name on its own line starting with "## ".
- Social posts often withhold the recipe ("comment SOUP and I'll DM it", "link in bio", "full recipe on my site"). When that happens and web tools are available, search for the dish name together with the creator's name or handle, prefer the creator's own website or blog, then fetch that page and extract the full recipe from it. Report the page you used as sourceUrl.
- Recipe websites bury the recipe under stories and ads. Ignore everything except the recipe itself.
- If you cannot find the real recipe, set status "not_found" and return one recipe with your best-guess title, the author and any link, empty ingredients and steps, and list likely pages in "candidates".
- A document or email may hold several recipes: return each one separately.
- categories: 1 to 3 meal-type or course categories. Reuse the household's existing categories whenever one fits; otherwise use short Title Case names such as Dinner, Breakfast, Dessert, Soup, Side, Appetizer, Snack, Drinks, Baking, Sauce.
- tags: 2 to 6 short lowercase descriptors (main protein, method such as "slow cooker" or "air fryer", diet such as "vegetarian", or "quick").
- Times look like "30 min" or "1 hr 15 min".`;

  const RESTAURANT_RULES = `RESTAURANTS (restaurants, bars, cafes, bakeries, food trucks, breweries: places to go eat or drink)
- One entry per place. A "top 5 tacos in town" post becomes five entries.
- When web tools are available, search for each place to confirm its name and city and to find its official website, Instagram, Facebook, Yelp page, TikTok, menu and reservation links, address, phone, cuisine and price range. Only include a link you actually saw in the post or in search/fetch results; never construct or guess a URL.
- city is "City, ST" for the US (e.g. "Cleveland, OH"), otherwise "City, Country". neighborhood if known.
- priceRange is "$" to "$$$$" when the post, Yelp or Google shows it.
- mustTry: specific dishes or drinks the post or reviews rave about.
- tags: 2 to 6 short lowercase descriptors such as "date night", "brunch", "patio", "kid friendly", "pizza", "cocktails", "bakery".
- If you can't tell which real place the post is about, set status "not_found" and return one entry with your best guess and what you know.`;

  function systemFor(want) {
    const intro = 'You turn messy sources (websites, social media posts and captions, Google Docs, emails) into clean records for a private household app that tracks recipes to cook and restaurants to try.';
    const decide =
      want === 'recipe'
        ? 'The user says this is a RECIPE. Return recipes only.'
        : want === 'restaurant'
        ? 'The user says this is about a RESTAURANT or other place to eat or drink. Return restaurants only.'
        : 'First decide what this is: a recipe to cook at home, a restaurant or other place to go eat or drink, or neither (set status "neither" and return empty arrays). A post can occasionally contain both.';
    return `${intro}

${decide}

${want !== 'restaurant' ? RECIPE_RULES + '\n\n' : ''}${want !== 'recipe' ? RESTAURANT_RULES + '\n\n' : ''}GENERAL
- Leave unknown fields as "". imageUrl only if you saw a real image URL; otherwise "".
- Respond with ONLY one JSON object, no other prose:
{"status":"found"|"partial"|"not_found"|"neither","message":"one short sentence for the user","candidates":[],"recipes":[{"title":"","description":"","author":"","sourceUrl":"","sourceName":"","imageUrl":"","yield":"","prepTime":"","cookTime":"","totalTime":"","ingredients":[],"steps":[],"categories":[],"tags":[],"cuisine":""}],"restaurants":[{"name":"","description":"","cuisine":"","priceRange":"","address":"","neighborhood":"","city":"","phone":"","links":{"website":"","instagram":"","facebook":"","yelp":"","tiktok":"","menu":"","reservations":""},"mustTry":[],"tags":[]}]}`;
  }
  const SYSTEM = systemFor('recipe');

  /**
   * Import from anything. input = {text, url, hint, sourceType, postUrl, kind, want}
   * kind: 'link' | 'post' | 'doc' | 'email'; want: 'recipe' | 'restaurant' | 'auto'
   * Returns {status, message, recipes:[], restaurants:[], candidates:[]}
   */
  async function importAny(input, opts = {}) {
    const s = RB.settings.load();
    const want = input.want || 'recipe';
    const text = String(input.text || '').trim();
    let url = input.url || (RB.isUrlOnly(text) ? text : '');
    const urlsInText = RB.findUrls(text);
    if (!url && urlsInText.length === 1 && text.length < 600) {
      // A short post with one link usually points to the real page.
      url = urlsInText[0];
    }
    const sourceType = input.sourceType || RB.sourceTypeFor(input.postUrl || url, 'manual');
    const kind = input.kind || (RB.isUrlOnly(text) ? 'link' : 'post');
    const isSocialUrl = url && RB.SOCIAL.has(RB.sourceTypeFor(url));
    const postUrl = input.postUrl || (isSocialUrl ? url : '');
    const original = text && !RB.isUrlOnly(text) ? text.slice(0, 20000) : '';

    // 1) Free path for recipe sites: read the page's structured recipe card through your proxy.
    let pageText = '';
    let pageHtml = '';
    if (url && !isSocialUrl) {
      pageHtml = await fetchPage(url, s).catch(() => '');
      if (pageHtml && want !== 'restaurant') {
        const ld = RB.fromJsonLd(pageHtml, url);
        if (ld && ld.ingredients.length && ld.steps.length) {
          if (postUrl) ld.source.postUrl = postUrl;
          if (original) ld.originalText = original;
          let rec = RB.newRecipe(ld);
          if (s.claudeKey && opts.categorize !== false) rec = await categorize(rec, s).catch(() => rec);
          return { status: 'found', message: 'Read the recipe card on ' + (ld.source.name || 'the page') + '.', recipes: [rec], restaurants: [], candidates: [] };
        }
      }
      if (pageHtml) pageText = RB.htmlToText(pageHtml);
    }

    // 2) No Claude key: best-effort local parsing.
    if (!s.claudeKey) {
      if (want === 'restaurant') {
        const name = (text.split('\n').find((l) => l.trim() && !/^https?:/.test(l.trim())) || input.hint || 'Unnamed place').slice(0, 80);
        return { status: 'partial', message: 'Saved without AI. Fill in the details.', recipes: [], restaurants: [RB.newRestaurant({ name, originalText: original, source: { type: sourceType, url, postUrl } })], candidates: [] };
      }
      if (url && !pageHtml && kind === 'link') {
        throw new Error("Can't read that site from the browser. Add a Claude API key (or a proxy) in Settings, or paste the recipe text instead.");
      }
      const rec = RB.newRecipe(heuristicParse(pageText || text, { url, sourceType, postUrl, hint: input.hint }));
      return {
        status: rec.ingredients.length ? 'partial' : 'not_found',
        message: rec.ingredients.length ? 'Parsed without AI. Check it over before saving.' : "Couldn't find ingredients. Add a Claude key in Settings for smarter importing, or fill it in by hand.",
        recipes: [rec],
        restaurants: [],
        candidates: [],
      };
    }

    // 3) Claude.
    const cats = RB.store.categories();
    const parts = [];
    const label = { link: 'A link', post: 'A social media post', doc: 'A document', email: 'An email' }[kind] || 'Some content';
    parts.push(`Source: ${label}${sourceType !== 'manual' ? ' (' + sourceType + ')' : ''}.`);
    if (input.hint) parts.push('Context: ' + input.hint);
    if (url) parts.push('URL: ' + url);
    if (postUrl && postUrl !== url) parts.push('Original post: ' + postUrl);
    if (original) parts.push('Content:\n"""\n' + text.slice(0, 120000) + '\n"""');
    if (pageText) parts.push('Text of the page at the URL (already fetched for you):\n"""\n' + pageText + '\n"""');
    else if (url && !isSocialUrl) parts.push('Fetch the URL with web_fetch to read it.');
    if (isSocialUrl && !original) {
      parts.push("This is a social media link; those pages usually can't be fetched. Try fetching it once; if that fails, use whatever the URL and context reveal (creator handle, slug, title) to search.");
    }
    if (want !== 'restaurant') parts.push('Existing recipe categories: ' + (cats.length ? cats.join(', ') : '(none yet)'));

    const out = await run({
      apiKey: s.claudeKey,
      model: s.claudeModel,
      system: systemFor(want),
      prompt: parts.join('\n\n'),
      useWebTools: s.useWebTools,
      maxTokens: kind === 'doc' || kind === 'email' ? 16000 : 8000,
      signal: opts.signal,
    });
    const j = extractJson(out.text);
    if (!j) throw new Error("Claude's reply wasn't readable. Try again, or paste the text.");
    const notFound = j.status === 'not_found';
    const candNote = notFound && j.candidates?.length ? 'Possible sources:\n' + j.candidates.join('\n') : '';
    const recipes = (want === 'restaurant' ? [] : j.recipes || []).map((r) =>
      RB.newRecipe({
        ...r,
        needsRecipe: notFound || !(r.ingredients && r.ingredients.length),
        source: {
          type: r.sourceUrl ? RB.sourceTypeFor(r.sourceUrl, sourceType) : sourceType,
          url: r.sourceUrl || url || '',
          name: r.sourceName || '',
          author: r.author || '',
          postUrl,
        },
        originalText: original,
        notes: candNote,
      })
    );
    const restaurants = (want === 'recipe' ? [] : j.restaurants || []).map((r) =>
      RB.newRestaurant({
        ...r,
        source: { type: sourceType, url: url || '', postUrl, author: input.author || '' },
        originalText: original,
        notes: candNote,
      })
    );
    return {
      status: j.status || 'found',
      message: (j.message || '') + (out.truncated ? ' (Reply was cut off; some items may be missing.)' : ''),
      recipes,
      restaurants,
      candidates: j.candidates || [],
    };
  }

  /** Ask Claude only for categories/tags (used when the page's recipe card was read for free). */
  async function categorize(rec, s) {
    const out = await run({
      apiKey: s.claudeKey,
      model: s.claudeModel,
      system: 'Classify recipes. Respond with only JSON: {"categories":[],"tags":[]}. categories: 1-3 Title Case course/meal types, reusing existing ones when they fit. tags: 2-6 short lowercase descriptors.',
      prompt: `Existing categories: ${RB.store.categories().join(', ') || '(none)'}\nRecipe: ${rec.title}\nIngredients: ${rec.ingredients.slice(0, 25).join('; ')}\nSite tags: ${rec.tags.join(', ')}`,
      useWebTools: false,
      maxTokens: 300,
    });
    const j = extractJson(out.text);
    if (j) {
      rec.categories = (j.categories || []).slice(0, 3);
      rec.tags = [...new Set([...(j.tags || []), ...rec.tags].map((t) => String(t).toLowerCase()))].slice(0, 8);
    }
    return rec;
  }

  async function fetchPage(url, s) {
    const tries = [];
    if (s.proxyUrl) tries.push(s.proxyUrl + encodeURIComponent(url));
    tries.push(url); // works for the rare site that allows cross-origin reads
    for (const u of tries) {
      try {
        const res = await fetch(u, { credentials: 'omit' });
        if (res.ok) {
          const t = await res.text();
          if (t && t.length > 200) return t;
        }
      } catch {
        /* blocked by CORS or network; try the next route */
      }
    }
    return '';
  }

  /** No-AI fallback: look for Ingredients / Directions headings in plain text. */
  function heuristicParse(text, { url, sourceType, postUrl, hint }) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let mode = '';
    const ing = [];
    const steps = [];
    let title = '';
    for (const l of lines) {
      const low = l.toLowerCase().replace(/[:\s]+$/, '');
      if (/^(ingredients?|what you('ll)? need|you('ll)? need)$/.test(low)) {
        mode = 'i';
        continue;
      }
      if (/^(directions|instructions|method|steps|how to make( it)?|preparation)$/.test(low)) {
        mode = 's';
        continue;
      }
      if (!title && !mode && l.length < 90 && !/^https?:/.test(l)) title = l.replace(/^#+\s*/, '');
      const item = l.replace(/^([-•*▢◻☐✔︎✅]|\d+[.)])\s*/, '');
      if (mode === 'i') ing.push(item);
      else if (mode === 's') steps.push(item);
    }
    return {
      title: title || hint || 'Untitled recipe',
      ingredients: ing,
      steps,
      originalText: text,
      needsRecipe: !ing.length,
      source: { type: sourceType, url: url || '', postUrl: postUrl || '' },
    };
  }

  Object.assign(RB, { claude: { run, listModels, extractJson, importAny, heuristicParse, SYSTEM, systemFor } });
})();
