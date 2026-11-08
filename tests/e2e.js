// End-to-end test with GitHub and Claude APIs mocked.
// Run: python3 -m http.server 8765 (in the repo root), then: node tests/e2e.js
const { chromium, devices } = require('playwright');
const path = require('path');
const assert = require('assert');

const BASE = 'http://localhost:8765/';
const T = path.join(__dirname, 'fixtures') + '/';
const OUT = path.join(__dirname, 'out') + '/';
require('fs').mkdirSync(OUT, { recursive: true });

// ---- fake GitHub ----
let gh = { content: null, sha: null, n: 0, puts: 0, conflicts: 0 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function ghRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (url.pathname === '/repos/infosystir/recipe-box-data') return json(200, { full_name: 'infosystir/recipe-box-data', private: true, permissions: { push: true } });
  if (url.pathname === '/repos/infosystir/recipe-box-data/contents/recipes.json') {
    if (req.method() === 'GET') {
      if (!gh.content) return json(404, { message: 'Not Found' });
      return json(200, { sha: gh.sha, content: b64(gh.content), encoding: 'base64' });
    }
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData());
      if ((gh.sha || null) !== (body.sha || null)) {
        gh.conflicts++;
        return json(409, { message: 'is at ' + gh.sha + ' but expected ' + body.sha });
      }
      gh.content = Buffer.from(body.content, 'base64').toString('utf8');
      gh.sha = 'sha' + ++gh.n;
      gh.puts++;
      return json(200, { content: { sha: gh.sha } });
    }
  }
  return json(404, { message: 'unexpected ' + url.pathname });
}

// ---- fake Claude ----
const claudeCalls = [];
let pausedOnce = false;
function rec(o) {
  return Object.assign({ description: '', author: '', sourceUrl: '', sourceName: '', imageUrl: '', yield: '4', prepTime: '10 min', cookTime: '', totalTime: '', ingredients: ['1 thing'], steps: ['Do it'], categories: ['Dinner'], tags: ['easy'], cuisine: '' }, o);
}
function claudeRoute(route) {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (req.url().includes('/v1/models')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ data: [{ id: 'claude-test-1', display_name: 'Claude Test' }] }) });
  const body = JSON.parse(req.postData());
  const h = req.headers();
  claudeCalls.push({ body, headers: h });
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(h['x-api-key'], 'sk-ant-test');
  const prompt = typeof body.messages[0].content === 'string' ? body.messages[0].content : '';
  let out;
  const wantsPlaces = body.system.includes('RESTAURANTS (');
  const wantsRecipes = body.system.includes('RECIPES\n');
  if (body.system.startsWith('Classify')) out = { categories: ['Dinner'], tags: ['pasta', 'quick'] };
  else if (wantsPlaces && /birria|taco/i.test(prompt)) out = { status: 'found', message: 'Found 2 places.', recipes: [], restaurants: [
    { name: 'Birria Boss', cuisine: 'Mexican', priceRange: '$', city: 'Cleveland, OH', neighborhood: 'Clark-Fulton', address: '123 Fake St, Cleveland, OH', phone: '(216) 555-0100', links: { website: 'https://birriaboss.example', instagram: 'https://instagram.com/birriaboss', yelp: 'https://www.yelp.com/biz/birria-boss-cleveland', facebook: '' }, mustTry: ['Quesabirria tacos', 'Consomé'], tags: ['tacos', 'casual'] },
    { name: 'Taco Tuesday Truck', cuisine: 'Mexican', city: 'Cleveland, OH', links: {}, mustTry: [], tags: ['food truck'] }] };
  else if (wantsPlaces && /Smash burger/i.test(prompt)) out = { status: 'found', message: '', recipes: [], restaurants: [{ name: 'Example Diner', cuisine: 'Burgers', city: 'Columbus, OH', links: { instagram: 'https://instagram.com/examplediner' }, mustTry: ['Double smash'], tags: ['burgers'] }] };
  else if (wantsPlaces && /Lake Erie Lookup/i.test(prompt)) out = { status: 'found', message: '', recipes: [], restaurants: [{ name: 'Lake Erie Lookup', city: 'Sandusky, OH', links: { website: 'https://lakeerie.example', yelp: 'https://yelp.com/biz/lel', facebook: 'https://facebook.com/lel' }, address: '1 Shore Dr', mustTry: ['Perch sandwich'], tags: ['waterfront'] }] };
  else if (!wantsRecipes && wantsPlaces && !/birria|taco|burger|Lake Erie/i.test(prompt)) out = { status: 'neither', message: 'Not a food place.', recipes: [], restaurants: [] };
  else if (/tuscan/i.test(prompt)) {
    if (!pausedOnce) {
      pausedOnce = true;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'tuscan soup' } }] }) });
    }
    if (body.messages.length === 2) globalThis.continued = body.messages[1].role === 'assistant';
    out = { status: 'found', message: 'Found it on the creator’s blog.', recipes: [rec({ title: 'Creamy Tuscan Soup', author: 'somecreator', sourceUrl: 'https://creator.example/tuscan-soup', categories: ['Soup'], tags: ['sausage', 'kale'] })] };
  } else if (/ABC123/.test(prompt) && !/Lemon garlic/i.test(prompt)) out = { status: 'not_found', message: 'Couldn’t find the recipe for this post.', candidates: ['https://halfbakedharvest.com/maybe'], recipes: [rec({ title: 'Something from @halfbakedharvest', author: 'halfbakedharvest', ingredients: [], steps: [] })] };
  else if (/Banana/i.test(prompt)) out = { status: 'found', message: '', recipes: [rec({ title: "Grandma's Banana Bread", ingredients: ['3 ripe bananas', '1/3 cup melted butter'], steps: ['Mash bananas.', 'Bake at 350 for 60 min.'], categories: ['Baking'] })] };
  else if (/meatloaf/i.test(prompt)) out = { status: 'found', message: '', recipes: [rec({ title: "Mom's Meatloaf", ingredients: ['2 lb ground beef', '1 cup breadcrumbs', '1 egg'], categories: ['Dinner'], tags: ['beef'] })] };
  else if (/crockpot-chili/i.test(prompt)) out = { status: 'found', message: '', recipes: [rec({ title: 'The Best Crockpot Chili', sourceUrl: 'https://example-recipes.com/crockpot-chili', ingredients: ['1 lb beef', '1 can beans'], tags: ['beef', 'slow cooker'] })] };
  else if (/Lemon garlic chicken/i.test(prompt)) out = { status: 'found', message: '', recipes: [rec({ title: 'Lemon Garlic Chicken', ingredients: ['4 chicken thighs', '3 cloves garlic', '1 lemon'], steps: ['## Marinate', 'Mix everything.', '## Cook', 'Roast at 425 for 35 min.'], tags: ['chicken'] })] };
  else out = { status: 'not_found', message: 'No recipe here.', recipes: [] };
  return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here you go:\n```json\n' + JSON.stringify(out) + '\n```' }], usage: {} }) });
}

const PASTA_HTML = `<!doctype html><html><head><title>Pasta | Blog</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"Weeknight Garlic Pasta &amp; Greens","description":"So good.","image":["https://img.test/pasta.jpg"],"author":{"@type":"Person","name":"Jen"},"recipeYield":["4","4 servings"],"prepTime":"PT10M","cookTime":"PT20M","totalTime":"PT30M","recipeIngredient":["1 lb spaghetti","6 cloves garlic","<b>2 cups</b> spinach"],"recipeInstructions":[{"@type":"HowToSection","name":"Pasta","itemListElement":[{"@type":"HowToStep","text":"Boil pasta."}]},{"@type":"HowToStep","text":"Toss with garlic &amp; greens."}],"keywords":"pasta, garlic"}]}</script>
</head><body><p>Long life story…</p><script>window.PWNED=1</script></body></html>`;

function proxyRoute(route) {
  const u = new URL(route.request().url()).searchParams.get('url');
  if (u === 'https://jsonld-site.test/pasta') return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: PASTA_HTML });
  return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'no' });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function setup(ctx) {
    await ctx.route('https://api.github.com/**', ghRoute);
    await ctx.route('https://api.anthropic.com/**', claudeRoute);
    await ctx.route('https://proxy.test/**', proxyRoute);
    await ctx.route(/^https:\/\/(?!api\.|proxy\.test).*/, (r) => r.abort());
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await setup(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message, e.stack); errors.push('pageerror: ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  // 1. first run → settings
  await page.goto(BASE);
  await page.waitForURL(/#\/settings/);
  await page.fill('text=Your name >> xpath=.. >> input', 'Mando');
  await page.fill('input[placeholder="infosystir/recipe-box-data"]', 'infosystir/recipe-box-data');
  await page.fill('input[placeholder^="github_pat_"]', 'github_pat_test');
  await page.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await page.click('summary:has-text("proxy")');
  await page.fill('input[placeholder^="https://recipe-proxy"]', 'https://proxy.test/?url=');
  await page.click('button:has-text("Load models")');
  await page.waitForSelector('text=Loaded 1 models');
  await page.click('button:has-text("Save & connect")');
  await page.waitForSelector('text=Connected to infosystir/recipe-box-data');
  console.log('✓ settings + connect');

  // 2. URL with JSON-LD via proxy
  await page.goto(BASE + '#/add');
  await page.fill('textarea', 'https://jsonld-site.test/pasta');
  await page.click('button:has-text("Import")');
  await page.waitForURL(/#\/review\//);
  assert.equal(await page.inputValue('form.edit input[type=text] >> nth=0'), 'Weeknight Garlic Pasta & Greens');
  const ing = await page.inputValue('form.edit textarea.mono >> nth=0');
  assert.ok(ing.includes('2 cups spinach'), 'HTML in JSON-LD stripped: ' + ing);
  const steps = await page.inputValue('form.edit textarea.mono >> nth=1');
  assert.ok(steps.startsWith('## Pasta\nBoil pasta.'), steps);
  assert.equal(await page.evaluate(() => window.PWNED), undefined, 'page scripts must not run');
  await page.click('button:has-text("Save to recipe box")');
  await page.waitForSelector('h1:has-text("Weeknight Garlic Pasta")');
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  let data = JSON.parse(gh.content);
  assert.equal(data.recipes.length, 1);
  assert.deepEqual(data.recipes[0].categories, ['Dinner']);
  assert.equal(data.recipes[0].totalTime, '30 min');
  assert.equal(data.recipes[0].yield, '4 servings');
  console.log('✓ JSON-LD import via proxy + categorize, saved to GitHub');

  // 3. pasted social post (with pause_turn)
  await page.goto(BASE + '#/add');
  await page.fill('textarea', 'OMG this creamy tuscan soup 😍 Comment SOUP and I will DM you the recipe! #souprecipes');
  await page.click('button:has-text("Import")');
  await page.waitForURL(/#\/review\//);
  await page.waitForSelector('text=Found it on the creator');
  await page.click('button:has-text("Save to recipe box")');
  await page.waitForSelector('h1:has-text("Creamy Tuscan Soup")');
  const toolsSent = claudeCalls.find((c) => /tuscan/i.test(c.body.messages[0].content)).body.tools.map((t) => t.name);
  assert.deepEqual(toolsSent, ['web_search', 'web_fetch']);
  assert.ok(globalThis.continued, 'pause_turn continuation resent assistant content');
  console.log('✓ social post import with web tools + pause_turn');

  // 4. pasted recipe text with sections
  await page.goto(BASE + '#/add');
  await page.fill('textarea', 'Lemon garlic chicken\nIngredients\n4 chicken thighs\n...');
  await page.click('button:has-text("Import")');
  await page.waitForURL(/#\/review\//);
  await page.click('button:has-text("Save to recipe box")');
  await page.waitForSelector('h1:has-text("Lemon Garlic Chicken")');
  await page.waitForSelector('li.section:has-text("Marinate")');

  // rating, made log, notes
  await page.click('.rating-row .star >> nth=3');
  await page.fill('.made-form input[list=where-list]', 'Lake house');
  await page.fill('.made-form textarea', 'Kids loved it');
  await page.click('button:has-text("We made this")');
  await page.waitForSelector('.made-log li:has-text("Lake house")');
  await page.fill('.notes textarea', 'Use extra lemon');
  await page.click('button:has-text("Save notes")');
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  const chicken = data.recipes.find((r) => r.title === 'Lemon Garlic Chicken');
  assert.equal(chicken.ratings.Mando, 4);
  assert.equal(chicken.madeLog[0].where, 'Lake house');
  assert.equal(chicken.notes, 'Use extra lemon');
  console.log('✓ rating, made log, notes saved');

  // 5. edit
  await page.click('a:has-text("Edit")');
  await page.fill('form.edit input[type=text] >> nth=0', 'Lemon Garlic Chicken (ours)');
  await page.fill('input[placeholder="New category"]', 'Weeknight');
  await page.click('button:has-text("Add")');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('h1:has-text("(ours)")');
  await page.waitForSelector('.chip:has-text("Weeknight")');
  console.log('✓ edit + new category');

  // 6. search & filters
  await page.goto(BASE + '#/');
  await page.fill('#search', 'spinach');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  assert.ok((await page.textContent('.card')).includes('Garlic Pasta'));
  await page.fill('#search', 'lake house');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1 && document.querySelector('.card').textContent.includes('Chicken'));
  await page.fill('#search', '');
  await page.selectOption('select[aria-label=Show]', 'made');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  await page.selectOption('select[aria-label=Show]', 'all');
  await page.click('.chips .chip:has-text("Soup")');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  await page.click('.chip:has-text("Clear")');
  await page.selectOption('select[aria-label=Sort]', 'rating');
  assert.ok((await page.textContent('.card >> nth=0')).includes('Chicken'));
  console.log('✓ search, status filter, category filter, sort');

  // 7. conflict: husband saves from another device in between
  const theirs = JSON.parse(gh.content);
  theirs.recipes.push({ id: 'husband-1', title: 'Husband Hot Wings', ingredients: ['wings'], steps: ['fry'], categories: ['Appetizer'], tags: [], ratings: { Husband: 5 }, madeLog: [], source: { type: 'manual' }, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' });
  gh.content = JSON.stringify(theirs);
  gh.sha = 'sha-husband';
  await page.click('.card:has-text("Tuscan")');
  await page.click('button:has-text("Favorite")');
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  assert.ok(gh.conflicts >= 1, 'should have hit a conflict');
  assert.ok(data.recipes.find((r) => r.title === 'Husband Hot Wings'), 'their recipe kept');
  assert.ok(data.recipes.find((r) => r.title === 'Creamy Tuscan Soup').favorite, 'our change kept');
  console.log('✓ concurrent edit merged (conflicts=' + gh.conflicts + ')');

  // 8. cook mode
  await page.goto(BASE + '#/');
  await page.click('.card:has-text("Pasta")');
  await page.click('a:has-text("Cook mode")');
  await page.click('.cook-ing input >> nth=0');
  await page.click('.cook-steps li[data-n="1"]');
  assert.ok(await page.$('.cook-steps li.current'));
  await page.screenshot({ path: OUT + 'cook.png' });
  console.log('✓ cook mode');

  // 9. bulk import
  await page.goto(BASE + '#/bulk');
  await page.setInputFiles('input[type=file][multiple]', [T + 'facebook-export.zip', T + 'takeout.zip']);
  await page.waitForSelector('text=possible recipes');
  const candTitles = await page.$$eval('.cand strong', (els) => els.map((e) => e.textContent));
  console.log('  candidates:', candTitles);
  assert.ok(candTitles.some((t) => /Crockpot Chili/.test(t)));
  assert.ok(candTitles.some((t) => /I’ll send you|I'll send you/.test(t)), 'mojibake fixed');
  assert.ok(candTitles.some((t) => /halfbakedharvest/.test(t)));
  assert.ok(candTitles.some((t) => /banana/i.test(t)));
  assert.ok(candTitles.some((t) => /Mom's meatloaf recipe/.test(t)), 'encoded subject decoded');
  assert.ok(!candTitles.some((t) => /recipe chicken/.test(t)), 'messages skipped');
  const selected = await page.$$eval('.cand input:checked', (els) => els.length);
  console.log('  preselected:', selected, 'of', candTitles.length);
  // select everything and run
  await page.click('button:has-text("Select shown")');
  await page.screenshot({ path: OUT + 'bulk.png', fullPage: true });
  await page.click('button:has-text("Import")');
  await page.waitForSelector('text=/Done\\. Added/', { timeout: 30000 });
  const summary = await page.textContent('[aria-live=polite]');
  console.log('  ' + summary);
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  const titles = data.recipes.filter((r) => !r.deleted).map((r) => r.title);
  for (const t of ['The Best Crockpot Chili', "Grandma's Banana Bread", "Mom's Meatloaf", 'Something from @halfbakedharvest']) assert.ok(titles.includes(t), 'missing ' + t + ' in ' + titles);
  const stub = data.recipes.find((r) => r.title === 'Something from @halfbakedharvest');
  assert.ok(stub.needsRecipe && stub.source.postUrl.includes('ABC123'));
  const docxCall = claudeCalls.find((c) => /Banana/.test(c.body.messages[0].content));
  assert.ok(docxCall.body.messages[0].content.includes('• 3 ripe bananas'), 'docx text extracted');
  const mailCall = claudeCalls.find((c) => /meatloaf/i.test(c.body.messages[0].content));
  assert.ok(mailCall.body.messages[0].content.includes('Bake at 350 for an hour'), 'quoted-printable decoded');
  console.log('✓ bulk import (FB/IG zip, Takeout docx + mbox)');

  // 10. needs-recipe finish flow
  await page.goto(BASE + '#/');
  await page.selectOption('select[aria-label=Show]', 'needs');
  await page.click('.card:has-text("halfbakedharvest")');
  await page.fill('.callout textarea', 'Lemon garlic chicken caption from the post');
  await page.click('button:has-text("Find the recipe")');
  await page.waitForSelector('text=Recipe found and saved');
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  const finished = data.recipes.find((r) => r.id === stub.id);
  assert.equal(finished.needsRecipe, false);
  assert.ok(finished.source.postUrl.includes('ABC123'), 'kept original post link');
  console.log('✓ finish a needs-recipe stub');

  // 11. restaurants: add from a post (auto-detect), multiple places -> review list
  await page.goto(BASE + '#/add');
  await page.click('.seg button:has-text("Figure it out")');
  await page.fill('textarea', 'Best birria tacos in Cleveland 🌮 @birriaboss and the Taco Tuesday Truck!');
  await page.click('button:has-text("Import")');
  await page.waitForSelector('h1:has-text("Found 2 restaurants")');
  await page.click('button:has-text("Save all")');
  await page.waitForURL(/#\/places/);
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
  assert.ok(await page.$('#tab-places.on'), 'Restaurants tab active');
  await page.click('.card:has-text("Birria Boss")');
  await page.waitForSelector('a.btn:has-text("Yelp")');
  assert.ok(await page.$('a.btn:has-text("Google Maps")'));
  assert.ok(await page.$('a[href^="tel:"]'), 'phone link');
  await page.waitForSelector('li:has-text("Quesabirria")');
  await page.click('.rating-row .star >> nth=4');
  await page.fill('.made-form input[placeholder="What we ordered"]', 'Quesabirria x3');
  await page.click('button:has-text("We went")');
  await page.waitForSelector('.made-log li:has-text("Quesabirria x3")');
  await page.waitForSelector('.badge:has-text("Been 1×")');
  await page.screenshot({ path: OUT + 'place.png', fullPage: true });
  // edit
  await page.click('a:has-text("Edit")');
  await page.fill('input[placeholder="date night, patio, brunch"]', 'tacos, casual, kid friendly');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('.chip:has-text("#kid friendly")');
  // find links on the bare truck entry
  await page.goto(BASE + '#/places');
  await page.click('.card:has-text("Taco Tuesday Truck")');
  await page.click('button:has-text("Find links")');
  await page.waitForSelector('text=Filled in what it found');
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  assert.equal(data.restaurants.filter((r) => !r.deleted).length, 2);
  const boss = data.restaurants.find((r) => r.name === 'Birria Boss');
  assert.equal(boss.visits[0].ordered, 'Quesabirria x3');
  assert.equal(boss.ratings.Mando, 5);
  assert.ok(boss.tags.includes('kid friendly'));
  assert.ok(data.recipes.length > 3, 'recipes untouched');
  // filters & search in places
  await page.goto(BASE + '#/places');
  await page.selectOption('select[aria-label=Show]', 'been');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  await page.selectOption('select[aria-label=Show]', 'all');
  await page.fill('#search', 'kid friendly');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1 && location.hash === '#/places');
  await page.fill('#search', '');
  await page.screenshot({ path: OUT + 'places.png' });
  console.log('✓ restaurants: import, links, visits, edit, find links, filters');

  // 12. pasted list from a browser run (mixed types, location tag, existing skip)
  const pasted = 'Here is batch 1:\n```json\n' + JSON.stringify([
    { url: 'https://www.instagram.com/p/SMASH1/', platform: 'instagram', collection: 'All posts', type: 'restaurant', author: 'colsfood', title: 'Smash burgers', caption: 'Smash burger heaven [ok] "quoted"', location: 'Example Diner, Columbus', author_comments: ['Open til 2am, get the double'] },
    { url: 'https://www.instagram.com/p/MEME/', platform: 'instagram', collection: 'All posts', type: 'unsure', author: 'memes', caption: 'lol cats' },
  ]) + '\n```\nBatch 2:\n' + JSON.stringify([
    { url: 'https://www.facebook.com/x/posts/9', platform: 'facebook', collection: 'restaurants', author: 'LEL', caption: 'Lake Erie Lookup has the best perch', links: [] },
    { url: 'https://www.facebook.com/somecreator/posts/12345', platform: 'facebook', collection: 'recipes', caption: 'already imported one' },
  ]);
  await page.goto(BASE + '#/bulk');
  await page.fill('details.help textarea', pasted);
  await page.click('button:has-text("Add to list")');
  await page.waitForSelector('text=Added 4 items from the pasted list');
  const types = await page.$$eval('.cand select', (els) => els.map((e) => e.value));
  console.log('  pasted types:', types);
  assert.ok(types.includes('restaurant') && types.includes('auto'));
  const existingCount = await page.$$eval('.cand input[type=checkbox]:disabled', (els) => els.length);
  assert.equal(existingCount, 1, 'already-imported post is disabled');
  await page.click('button:has-text("Select shown")');
  await page.click('button:has-text("Import")');
  await page.waitForSelector('text=/Done\\. Added/', { timeout: 30000 });
  const sumText = await page.$eval('section [aria-live=polite]', (e) => e.textContent);
  console.log('  ' + sumText);
  assert.ok(/2 restaurants/.test(sumText), sumText);
  await page.waitForFunction(() => document.getElementById('sync').textContent === '');
  data = JSON.parse(gh.content);
  const diner = data.restaurants.find((r) => r.name === 'Example Diner');
  assert.ok(diner && diner.source.postUrl.includes('SMASH1'));
  const smashCall = claudeCalls.find((c) => /SMASH1/.test(c.body.messages[0].content));
  assert.ok(smashCall.body.messages[0].content.includes('Location tag: Example Diner, Columbus'));
  assert.ok(smashCall.body.messages[0].content.includes('Comment by the author: Open til 2am, get the double'));
  assert.ok(!smashCall.body.system.includes('RECIPES\n'), 'restaurant-only prompt');
  console.log('✓ pasted list import (mixed recipe/restaurant)');

  // screenshots
  await page.goto(BASE + '#/');
  await page.selectOption('select[aria-label=Show]', 'all');
  await page.screenshot({ path: OUT + 'library.png' });
  await page.click('.card:has-text("(ours)")');
  await page.screenshot({ path: OUT + 'recipe.png', fullPage: true });

  // mobile
  const m = await browser.newContext({ ...devices['iPhone 13'] });
  await setup(m);
  const mp = await m.newPage();
  mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await mp.goto(BASE);
  await mp.evaluate(() => localStorage.setItem('rb.settings', JSON.stringify({ me: 'Husband', mode: 'github', ghRepo: 'infosystir/recipe-box-data', ghToken: 'x', claudeKey: 'sk-ant-test' })));
  await mp.goto(BASE + '#/');
  await mp.reload();
  await mp.waitForSelector('.card');
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.ok(!overflow, 'no horizontal scroll on phone');
  await mp.screenshot({ path: OUT + 'mobile-library.png' });
  await mp.click('.card:has-text("(ours)")');
  await mp.screenshot({ path: OUT + 'mobile-recipe.png' });
  await mp.goto(BASE + '#/places');
  await mp.waitForSelector('.card');
  assert.ok(!(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on places');
  await mp.screenshot({ path: OUT + 'mobile-places.png' });
  console.log('✓ mobile layout');

  // local-only mode
  const l = await browser.newContext();
  const lp = await l.newPage();
  lp.on('pageerror', (e) => errors.push('local pageerror: ' + e.message));
  await lp.goto(BASE);
  await lp.waitForURL(/#\/settings/);
  await lp.fill('text=Your name >> xpath=.. >> input', 'Tester');
  await lp.selectOption('select', 'local');
  await lp.click('button:has-text("Save & connect")');
  await lp.waitForSelector('text=Connected to this browser');
  await lp.goto(BASE + '#/new');
  await lp.fill('form.edit input[type=text] >> nth=0', 'Toast');
  await lp.click('button:has-text("Save")');
  await lp.waitForSelector('h1:has-text("Toast")');
  await lp.reload();
  await lp.waitForSelector('h1:has-text("Toast")');
  console.log('✓ local-only mode persists');

  // heuristic parse without Claude key
  await lp.goto(BASE + '#/add');
  await lp.fill('textarea', 'Easy Pancakes\n\nIngredients:\n- 1 cup flour\n- 1 egg\n\nInstructions\n1. Mix.\n2. Cook.');
  await lp.click('button:has-text("Import")');
  await lp.waitForURL(/#\/review\//);
  assert.equal(await lp.inputValue('form.edit textarea.mono >> nth=0'), '1 cup flour\n1 egg');
  assert.equal(await lp.inputValue('form.edit textarea.mono >> nth=1'), 'Mix.\nCook.');
  console.log('✓ no-AI fallback parser');

  console.log('GitHub PUTs:', gh.puts, 'conflicts:', gh.conflicts, 'Claude calls:', claudeCalls.length);
  if (errors.length) {
    console.log('ERRORS:\n' + errors.join('\n'));
    process.exitCode = 1;
  } else console.log('No page errors.');
  await browser.close();
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
