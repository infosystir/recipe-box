/* Parsing helpers: schema.org Recipe extraction, HTML → readable text, source detection. */
(function () {
  'use strict';
  const RB = window.RB;
  const { decodeEntities } = RB;

  const clean = (s) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();

  /** PT1H30M → "1 hr 30 min" */
  function isoDuration(d) {
    if (!d || typeof d !== 'string') return '';
    const m = d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!m) return clean(d);
    const days = +m[1] || 0;
    let hrs = +m[2] || 0;
    let mins = +m[3] || 0;
    hrs += days * 24;
    if (mins >= 60) {
      hrs += Math.floor(mins / 60);
      mins %= 60;
    }
    const parts = [];
    if (hrs) parts.push(hrs + ' hr');
    if (mins) parts.push(mins + ' min');
    return parts.join(' ');
  }

  const isRecipeType = (t) => (Array.isArray(t) ? t : [t]).some((x) => String(x).toLowerCase() === 'recipe');

  function findRecipeNodes(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach((n) => findRecipeNodes(n, out));
      return out;
    }
    if (isRecipeType(node['@type'])) out.push(node);
    for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
      if (node[k] && typeof node[k] === 'object') findRecipeNodes(node[k], out);
    }
    return out;
  }

  function textOf(x) {
    if (!x) return '';
    if (typeof x === 'string') return clean(x);
    if (Array.isArray(x)) return x.map(textOf).filter(Boolean).join(', ');
    return clean(x.name || x.text || x['@value'] || '');
  }

  function imageOf(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return imageOf(x[0]);
    return x.url || x.contentUrl || '';
  }

  /** Flatten HowToStep / HowToSection into lines; section names become "## Name". */
  function instructions(x, out = []) {
    if (!x) return out;
    if (typeof x === 'string') {
      // Some sites stuff all steps into one string.
      const t = decodeEntities(x);
      t.split(/\n+|(?<=\.)\s{2,}/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).forEach((s) => out.push(s));
      return out;
    }
    if (Array.isArray(x)) {
      x.forEach((s) => instructions(s, out));
      return out;
    }
    const type = String(x['@type'] || '').toLowerCase();
    if (type === 'howtosection' || x.itemListElement) {
      if (x.name) out.push('## ' + clean(x.name));
      instructions(x.itemListElement, out);
      return out;
    }
    const t = clean(x.text || x.name || '');
    if (t) out.push(t);
    return out;
  }

  /** Returns a partial recipe from <script type="application/ld+json">, or null. */
  function fromJsonLd(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nodes = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        findRecipeNodes(JSON.parse(s.textContent), nodes);
      } catch {
        /* sites often ship broken JSON-LD; skip that block */
      }
    });
    const r = nodes.find((n) => n.recipeIngredient || n.ingredients) || nodes[0];
    if (!r) return null;
    const ingredients = (r.recipeIngredient || r.ingredients || []);
    const yieldVal = Array.isArray(r.recipeYield) ? r.recipeYield.map(String).sort((a, b) => b.length - a.length)[0] : r.recipeYield;
    const kw = typeof r.keywords === 'string' ? r.keywords.split(',') : Array.isArray(r.keywords) ? r.keywords : [];
    let host = '';
    try {
      host = new URL(pageUrl).host.replace(/^www\./, '');
    } catch {
      /* no URL; leave host blank */
    }
    return {
      title: clean(r.name) || clean(doc.title),
      description: clean(r.description),
      imageUrl: imageOf(r.image),
      yield: clean(yieldVal),
      prepTime: isoDuration(r.prepTime),
      cookTime: isoDuration(r.cookTime),
      totalTime: isoDuration(r.totalTime),
      ingredients: (Array.isArray(ingredients) ? ingredients : [ingredients]).map(clean).filter(Boolean),
      steps: instructions(r.recipeInstructions),
      categories: [],
      tags: [
        ...(Array.isArray(r.recipeCategory) ? r.recipeCategory : r.recipeCategory ? [r.recipeCategory] : []),
        ...kw,
      ].map(clean).filter((t) => t && t.length < 30).slice(0, 8),
      cuisine: textOf(r.recipeCuisine),
      source: { type: 'web', url: pageUrl, name: clean(r.publisher?.name) || host, author: textOf(r.author) },
    };
  }

  /** Strip a web page down to readable text to keep Claude calls small and cheap. */
  function htmlToText(html, maxChars = 60000) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header,aside,form,[aria-hidden="true"],.ad,.ads,.advertisement,[class*="sidebar"],[class*="comment"]').forEach((n) => n.remove());
    const main = doc.querySelector('[class*="recipe-card"],[class*="wprm-recipe"],[class*="tasty-recipe"],article,main') || doc.body;
    // Detached documents have no layout, so add line breaks after block elements ourselves.
    main.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,div,br,tr,section,blockquote').forEach((n) => n.after(doc.createTextNode('\n')));
    main.querySelectorAll('li').forEach((n) => n.prepend(doc.createTextNode('• ')));
    const text = (main.textContent || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.slice(0, maxChars);
  }

  const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
  function findUrls(text) {
    return [...new Set((String(text || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  }
  function isUrlOnly(text) {
    const t = String(text || '').trim();
    return /^https?:\/\/\S+$/i.test(t);
  }

  function sourceTypeFor(url, fallback) {
    const u = String(url || '').toLowerCase();
    if (/(^|\.)facebook\.com|fb\.watch|fb\.com/.test(u)) return 'facebook';
    if (/instagram\.com/.test(u)) return 'instagram';
    if (/docs\.google\.com|drive\.google\.com/.test(u)) return 'gdoc';
    if (/mail\.google\.com/.test(u)) return 'email';
    if (/tiktok\.com/.test(u)) return 'tiktok';
    if (/pinterest\./.test(u)) return 'pinterest';
    if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
    return u ? 'web' : fallback || 'manual';
  }
  const SOCIAL = new Set(['facebook', 'instagram', 'tiktok', 'pinterest', 'youtube']);

  /** Cheap "is this probably a recipe?" score used to pre-select bulk-import candidates. */
  const RECIPE_WORDS = /\b(recipe|recipes|ingredients?|tbsp|tsp|tablespoons?|teaspoons?|cups?|oz|ounces?|grams?|bake|baked|baking|oven|preheat|simmer|saut[eé]|stir|whisk|marinade|dinner|lunch|breakfast|dessert|cookies?|cake|soup|casserole|chicken|beef|pork|pasta|salad|sauce|crockpot|slow cooker|instant pot|air ?fryer|sheet pan|meal prep|dip|appetizer|bread|muffins?|smoothie)\b/gi;
  function recipeScore(text) {
    const m = String(text || '').match(RECIPE_WORDS);
    return m ? m.length : 0;
  }

  Object.assign(RB, { fromJsonLd, htmlToText, isoDuration, findUrls, isUrlOnly, sourceTypeFor, SOCIAL, recipeScore });
})();
