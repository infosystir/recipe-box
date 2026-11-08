# Collect saved posts with Claude's browser

Use this to pull your saved Facebook and Instagram posts into Recipe Box.

## Before you start

The prompt itself is in **`BROWSER_PROMPT.txt`**: open it, copy all of it, and paste it. It works in either of these:

- **Claude in Chrome** (the extension's side panel in Chrome, where you're already logged in). It gives you the list in chat, in batches, for you to copy.
- **A Cowork task with a browser**, if your workspace has one. Connect the folder `~/gitstuff/infosystir/recipe-box` so it can save the list to `imports/saved-posts.json`.

**When it's done:** open Recipe Box → **Bulk import** → **Paste a list from a browser run**. Choose the saved file, or paste the batches one at a time; duplicates are skipped. The `imports/` folder is git-ignored, so your saved posts never end up in the public repo.

---

Please collect my saved Facebook and Instagram posts so I can import them into my recipe app. Use the browser where I'm already logged in to both sites.

**What to collect**

1. **Facebook:** go to https://www.facebook.com/saved and open each of these collections:
   - "recipes" → mark each post `"type": "recipe"`
   - "recipes with amanda" → mark each post `"type": "recipe"`
   - "restaurants" → mark each post `"type": "restaurant"`
2. **Instagram:** open my profile → Saved → **All posts**. Open each post. Mark it `"recipe"` if it's food to cook, `"restaurant"` if it's a restaurant, bar, cafe, bakery or food spot to visit, and `"unsure"` if you can't tell. Skip posts that are clearly neither, such as memes or non-food posts.

**For every post, record:**

- `url`: the post's permalink
- `platform`: "facebook" or "instagram"
- `collection`: the collection name (or "All posts")
- `type`: "recipe", "restaurant" or "unsure"
- `author`: the account or page that posted it (handle or page name)
- `title`: a short name for the dish or place, if obvious
- `caption`: the full caption text. Click "See more" or "more" to expand it first.
- `links`: any URLs in the caption, plus links the author put in their own comment. Creators often post the recipe link or the restaurant's handle in the first comment.
- `location`: the location tag, if the post has one (important for restaurants)

**Rules**

- **Read only.** Don't like, comment, react, share, follow, message, unsave or move anything. This includes "comment SOUP and I'll DM you" posts: just record the post, and my app will find the recipe on the web.
- **Never type a password.** If a login, checkpoint, captcha or "you're going too fast" warning appears, stop and tell me.
- **Go at a human pace.** Pause a couple of seconds between posts.
- **Save as you go.**
  - If you can write files and my `recipe-box` folder is connected, save the results to `imports/saved-posts.json` in that folder as one JSON array. Update the file at least every 20 posts so nothing is lost if you stop. If the file already exists, keep its entries and skip any URL already in it.
  - If you can't write files, give me the results in this chat as JSON code blocks of about 20 posts each, as you go, so I can copy them. If I paste a previous batch back to you, skip those URLs.
- **Don't fill in details.** Don't summarize or rewrite captions, and don't make up recipes or restaurant details; the app does that part.

**Format** (for the file or for each chat batch)

```json
[
  {
    "url": "https://www.instagram.com/p/XXXX/",
    "platform": "instagram",
    "collection": "All posts",
    "type": "restaurant",
    "author": "clevelandeats",
    "title": "Smash burgers at Example Diner",
    "caption": "full caption text…",
    "links": ["https://exampledinercle.com"],
    "location": "Example Diner, Cleveland, Ohio"
  }
]
```

When you're done, tell me how many posts you saved from each collection, how many were recipes, restaurants and unsure, and anything you skipped or couldn't open.
