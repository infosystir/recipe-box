# Recipe Box

A private recipe box and restaurant list for two.

- **Recipes:** paste a recipe link or a Facebook/Instagram post and it pulls out just the recipe: no life story, no ads, no "comment SOUP and I'll DM you". Search, sort into categories, rate, log when and where you made it, and keep your own notes and edits.
- **Restaurants:** paste a post about a place and it finds the website, Instagram, Facebook, Yelp, menu and reservation links, address, price and what to order. Track want-to-go vs. been, log visits and what you ordered, rate, filter by city, and keep notes.

- **The app** is a static site (plain HTML/JS, no build step) hosted free on GitHub Pages.
- **Your recipes** live in one `recipes.json` file in a **private** GitHub repo. Every change is a commit, so you get full history and can undo.
- **Importing** uses the Claude API. If a post hides the recipe, Claude searches for the creator's site and fetches it, the same way you'd Google it yourself.

```
Phone / laptop browser ──► GitHub Pages (this repo, public code only)
        │
        ├──► api.github.com    → infosystir/recipe-box-data (PRIVATE) / recipes.json
        └──► api.anthropic.com → Claude reads posts and pages, searches for hidden recipes
```

No secrets or recipes are stored in this repo. Your tokens and keys stay in each browser's local storage.

---

## Setup (about 15 minutes)

### 1. Create the two repos

| Repo | Visibility | Holds |
|---|---|---|
| `infosystir/recipe-box` | Public (required for free GitHub Pages) | This code |
| `infosystir/recipe-box-data` | **Private** | `recipes.json` (created automatically) |

When you create `recipe-box-data`, tick **Add a README** so the repo isn't empty.

> With GitHub Pro you can make `recipe-box` private too. Or skip Pages and run it locally: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

### 2. Push this code and turn on Pages

```bash
cd recipe-box
git remote add origin https://github.com/infosystir/recipe-box.git
git push -u origin main
```

Then go to **recipe-box → Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)` → Save**. After a minute the app is at **https://infosystir.github.io/recipe-box/**.

### 3. Make a GitHub token for each device

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

- **Resource owner:** infosystir
- **Repository access:** Only select repositories → `recipe-box-data`
- **Permissions → Repository → Contents:** Read and write (Metadata: Read is added automatically)
- **Expiration:** up to a year; put a calendar reminder to renew it

**For your husband:** generate a second token the same way, named for his phone. He can only touch the recipe repo, and you can revoke his token without affecting yours. (If he'd rather use his own GitHub account, add him as a collaborator on `recipe-box-data` and have him create a *classic* token with `repo` scope. Fine-grained tokens can't reach a repo owned by another personal account.)

### 4. Get a Claude API key (optional)

Only needed for importing: pulling recipes and places out of links and posts. Without a key, a device can still browse, search, add by hand, rate and log. One key on the device that does the importing is enough.

1. Go to [console.anthropic.com](https://console.anthropic.com) and create a key under **API Keys**.
2. Under **Billing → Limits**, set a monthly spend limit (e.g. $10).
3. Make sure **web search** and **web fetch** are enabled for the org (Console → Settings → Privacy/Features). Without them the app still works, but it can't go find recipes that posts hide.

Expect roughly 1 to 10 cents per recipe with Sonnet. It costs more when Claude has to search.

### 5. Open the app and fill in Settings

On each device, open the Pages URL, then:

- **Your name:** "Mando" on yours, his name on his. Ratings and "we made this" entries are tagged by name.
- **Data repo:** `infosystir/recipe-box-data`
- **GitHub token:** that device's token
- **Claude API key (optional):** leave blank on devices that won't import. Use **Load models** to pick from the models your key can use; the default is `claude-sonnet-4-5`.

Tap **Save & connect**. It will warn you if the data repo is accidentally public.

To install it like an app on a phone: Safari → Share → **Add to Home Screen**.

---

## Using it

- **+ Add:** paste a recipe URL, a whole social post (caption and all), or plain recipe text. Check the result, tweak it, and save.
- **Search:** matches titles, ingredients, tags, notes, and where you made it ("lake house").
- **Filter:** Favorites, We've made, Not made yet, Want to make, Needs recipe. You can also filter by category and source, and sort by rating, recently made, or most made.
- **Recipe page:**
  - Rate it (each person rates separately; the list shows the average).
  - Mark it Favorite or Want to make.
  - **We made this:** log the date, where, a rating for that time, and notes.
  - **Our notes:** your standing tweaks.
  - **Edit:** change anything.
- **Cook mode:** big text, check off ingredients, tap a step to mark your place. The screen stays on.
- **Needs recipe:** posts where the importer couldn't find the actual recipe. Open the original post, copy the caption or recipe link, paste it into the box on the recipe page, and it fills in.
- **Restaurants tab:**
  - Filter by Want to go / We've been / Favorites, city and cuisine. Search covers dishes, tags and notes.
  - Each place page has buttons for its links (Google Maps is always there), plus must-try dishes, notes, ratings, and a **We went** log with what you ordered.
  - **Find links** fills in whatever links are missing.
- **+ Add** works for both. Choose Recipe, Restaurant, or **Figure it out** and it sorts the item into the right section. A post listing several places becomes one entry per place.
- **Settings → Download backup:** everything as one JSON file.

### Both editing at once

Saves are per-recipe. If you both save at the same moment, the app pulls the other person's version, merges it with yours, and saves again. Each recipe keeps whichever edit is newest, so neither of you loses work. The app also refreshes when you switch back to its tab.

---

## Pulling in your saved posts with Claude's browser

**`BROWSER_PROMPT.txt`** is a ready-to-paste prompt. Paste it into Claude in Chrome (or a Cowork task with a browser) while you're logged in to Facebook and Instagram. It walks your saved collections, read-only, and gives you a list of captions and links. Paste that list into **Bulk import → Paste a list from a browser run**. See [`browser-collect-prompt.md`](browser-collect-prompt.md) for details.

## The first big import from exports

In the app, open **Bulk import**. It lists everything it found in your exports, pre-checks the ones that look like recipes, and imports only what you approve. The steps below are also shown in the app.

**Facebook** (saved posts and your own posts)
1. Settings & privacy → Settings → **Accounts Center → Your information and permissions → Download your information**.
2. Choose **Specific types of information**, then tick **Saved items and collections**, **Posts** and **Groups**.
3. Format **JSON**, media quality **Low**, date range **All time**. Download the .zip.

The export only includes posts you **saved** or **posted yourself**. For recipes other people posted in groups, tap *Save post* on them first, or paste them one at a time.

**Instagram** (saved posts)
- Same Accounts Center flow → your Instagram account → **Saved** → JSON.
- Instagram's export contains only the post link and the creator's handle, not the caption. Claude searches by creator. Anything it can't find becomes a **Needs recipe** entry.

**Google Docs** (personal account)
1. Put the recipe docs in one Drive folder.
2. Go to [takeout.google.com](https://takeout.google.com) → *Deselect all* → **Drive** → pick that folder → under *Multiple formats*, set Documents to **DOCX**.
3. Docs with many recipes are split up, and each recipe comes out separately.

**Gmail** (personal account)
1. In Gmail, put a label such as **Recipes** on your recipe emails.
2. In Takeout, choose **Mail** and include only that label.
3. Upload the .zip or the .mbox inside it.

Drop the .zip files straight in; there's no need to unzip them. Large Facebook exports are fine because the app only reads the parts it needs.

---

## Optional: free page reading with a Cloudflare Worker

Most recipe sites embed a structured recipe card (schema.org). Browsers can't read other sites directly, so by default Claude fetches the page. If you add a tiny proxy, the app reads the recipe card itself for free and only uses Claude to pick categories.

To set it up, follow the comments in [`worker/cors-proxy.js`](worker/cors-proxy.js). Then put `https://<worker>.workers.dev/?key=<secret>&url=` in **Settings → Optional: page-fetching proxy**.

---

## Security notes

- **Recipe data:** stays in the private repo. The app repo contains only code.
- **Tokens and keys:** kept in each browser's `localStorage` and sent only to `api.github.com` and `api.anthropic.com` (plus your proxy, if you set one). A strict Content-Security-Policy blocks third-party scripts, and there are no dependencies or CDNs.
- **Shared storage on GitHub Pages:** every GitHub Pages site under `infosystir.github.io` shares one browser storage origin. If you host other Pages sites there that run untrusted scripts, use a custom domain for this one.
- **Imported content:** always rendered as text, never as HTML, so a malicious recipe page can't run code in the app.
- **Token scope:** the GitHub token can only touch `recipe-box-data`. If a device is lost, revoke its token on GitHub. The Claude key's damage is capped by your spend limit.

## Data format

`recipes.json`:

```json
{ "version": 1, "updatedAt": "…", "restaurants": [ /* see newRestaurant() in js/store.js */ ], "recipes": [ {
  "id": "…", "title": "…", "description": "", "imageUrl": "",
  "source": { "type": "web|facebook|instagram|gdoc|email|manual", "url": "", "name": "", "author": "", "postUrl": "" },
  "yield": "", "prepTime": "", "cookTime": "", "totalTime": "",
  "ingredients": ["## Sauce", "1 cup …"], "steps": ["…"],
  "categories": ["Dinner"], "tags": ["chicken"], "cuisine": "",
  "ratings": { "Mando": 5 }, "favorite": false, "wantToMake": false, "needsRecipe": false,
  "madeLog": [ { "id": "…", "date": "2026-11-08", "where": "Home", "who": "Mando", "rating": 5, "notes": "" } ],
  "notes": "", "originalText": "", "addedBy": "Mando", "createdAt": "…", "updatedAt": "…"
} ] }
```

Deleted items stay in the file as `{ "id", "deleted": true }` markers so the merge doesn't bring them back.

## Development

There's no build step: edit the files and reload. The tests drive the real UI in Chromium, with GitHub and Claude mocked:

```bash
python3 -m http.server 8765 &
npm i -D playwright && npx playwright install chromium   # first time only
node tests/e2e.js
```

```
index.html        page shell + CSP
css/app.css       styles (light/dark, phone layout)
js/util.js        DOM builder, settings, helpers
js/store.js       GitHub storage, merge-on-conflict, recipe model
js/parse.js       schema.org recipe-card reader, HTML→text
js/claude.js      Claude import (web search/fetch), no-AI fallback
js/zip.js         dependency-free zip + .docx reader
js/bulk.js        Facebook/Instagram/Takeout/mbox bulk import
js/app.js         views and routing
worker/           optional Cloudflare Worker proxy
```
