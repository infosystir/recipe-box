/* Recipe storage: a single recipes.json in a private GitHub repo (or this browser only). */
(function () {
  'use strict';
  const RB = window.RB;
  const { storage, nowIso } = RB;

  // ---------- base64 <-> UTF-8 ----------
  function b64ToText(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function textToB64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // ---------- GitHub contents API ----------
  class GitHubBackend {
    constructor({ ghToken, ghRepo, ghBranch, ghPath }) {
      this.token = ghToken.trim();
      this.repo = ghRepo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      this.branch = (ghBranch || '').trim();
      this.path = (ghPath || 'recipes.json').trim().replace(/^\//, '');
    }
    async req(method, url, body) {
      const res = await fetch('https://api.github.com' + url, {
        method,
        headers: {
          Authorization: 'Bearer ' + this.token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          msg = (await res.json()).message || msg;
        } catch {
          /* non-JSON error body; keep statusText */
        }
        throw new HttpError(res.status, `GitHub ${res.status}: ${msg}`);
      }
      return res.status === 204 ? null : res.json();
    }
    contentsUrl() {
      const p = this.path.split('/').map(encodeURIComponent).join('/');
      return `/repos/${this.repo}/contents/${p}` + (this.branch ? `?ref=${encodeURIComponent(this.branch)}` : '');
    }
    /** Returns {data, sha}; data is null when the file doesn't exist yet. */
    async load() {
      let meta;
      try {
        meta = await this.req('GET', this.contentsUrl());
      } catch (e) {
        if (e.status === 404) {
          // Distinguish "no file yet" from "no access to repo".
          await this.req('GET', `/repos/${this.repo}`);
          return { data: null, sha: null };
        }
        throw e;
      }
      let text;
      if (meta.content && meta.encoding === 'base64') {
        text = b64ToText(meta.content);
      } else {
        // Files over 1 MB come back without content; fetch the blob instead.
        const blob = await this.req('GET', `/repos/${this.repo}/git/blobs/${meta.sha}`);
        text = b64ToText(blob.content);
      }
      return { data: JSON.parse(text), sha: meta.sha };
    }
    /** Returns new sha. Throws HttpError 409/422 when someone else saved first. */
    async save(data, sha, message) {
      const body = {
        message: message || 'Update recipes',
        content: textToB64(JSON.stringify(data, null, 1) + '\n'),
      };
      if (sha) body.sha = sha;
      if (this.branch) body.branch = this.branch;
      const p = this.path.split('/').map(encodeURIComponent).join('/');
      const out = await this.req('PUT', `/repos/${this.repo}/contents/${p}`, body);
      return out.content.sha;
    }
    async check() {
      const repo = await this.req('GET', `/repos/${this.repo}`);
      return {
        private: repo.private,
        canPush: !!(repo.permissions && repo.permissions.push),
        name: repo.full_name,
      };
    }
  }

  // ---------- This-browser-only backend ----------
  class LocalBackend {
    async load() {
      return { data: storage.get('rb.localdata', null), sha: 'local' };
    }
    async save(data) {
      if (!storage.set('rb.localdata', data)) throw new Error('Browser storage is full or blocked.');
      return 'local';
    }
    async check() {
      return { private: true, canPush: true, name: 'this browser' };
    }
  }

  // ---------- Merge (two people editing at once) ----------
  /** Per-recipe last-write-wins by updatedAt. Deleted recipes are kept as tombstones. */
  function merge(a, b) {
    const map = new Map();
    for (const r of [...(a?.recipes || []), ...(b?.recipes || [])]) {
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || '') > (cur.updatedAt || '')) map.set(r.id, r);
    }
    return { version: 1, recipes: [...map.values()], updatedAt: nowIso() };
  }

  // ---------- Store ----------
  const listeners = new Set();
  const store = {
    data: { version: 1, recipes: [] },
    sha: null,
    backend: null,
    status: 'idle', // idle | loading | saving | saved | error | offline
    lastError: null,
    dirty: false,
    _saving: null,

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      listeners.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      });
    },
    setStatus(s, err) {
      this.status = s;
      this.lastError = err || null;
      this.emit();
    },

    configure(settings) {
      this.backend = settings.mode === 'local' ? new LocalBackend() : new GitHubBackend(settings);
    },

    async load() {
      // Show the cached copy instantly, then refresh from GitHub.
      const cached = storage.get('rb.cache', null);
      if (cached && cached.data) {
        this.data = cached.data;
        this.sha = cached.sha;
        this.emit();
      }
      this.setStatus('loading');
      try {
        const { data, sha } = await this.backend.load();
        if (data) {
          // Keep any unsaved local edits made while offline.
          this.data = this.dirty ? merge(data, this.data) : data;
        }
        this.sha = sha;
        this.cache();
        this.setStatus('saved');
        if (this.dirty) this.save('Sync offline edits');
      } catch (e) {
        console.error(e);
        this.setStatus(cached ? 'offline' : 'error', e.message);
        throw e;
      }
    },

    cache() {
      storage.set('rb.cache', { data: this.data, sha: this.sha });
    },

    get recipes() {
      return this.data.recipes.filter((r) => !r.deleted);
    },
    get(id) {
      return this.data.recipes.find((r) => r.id === id && !r.deleted);
    },
    findBySource(url) {
      if (!url) return null;
      const key = normalizeUrl(url);
      return this.recipes.find((r) => r.source && r.source.url && normalizeUrl(r.source.url) === key) || null;
    },
    categories() {
      const c = new Map();
      for (const r of this.recipes) for (const x of r.categories || []) c.set(x, (c.get(x) || 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    },
    tags() {
      const s = new Set();
      for (const r of this.recipes) for (const t of r.tags || []) s.add(t);
      return [...s].sort();
    },

    /** Insert or update one or more recipes, then save. */
    upsert(recipes, message, { defer } = {}) {
      const list = Array.isArray(recipes) ? recipes : [recipes];
      const t = nowIso();
      for (const r of list) {
        r.updatedAt = t;
        if (!r.createdAt) r.createdAt = t;
        const i = this.data.recipes.findIndex((x) => x.id === r.id);
        if (i >= 0) this.data.recipes[i] = r;
        else this.data.recipes.push(r);
      }
      this.dirty = true;
      this.cache();
      this.emit();
      if (!defer) return this.save(message);
      return Promise.resolve();
    },
    remove(id) {
      const i = this.data.recipes.findIndex((x) => x.id === id);
      if (i < 0) return Promise.resolve();
      const title = this.data.recipes[i].title;
      this.data.recipes[i] = { id, deleted: true, updatedAt: nowIso() };
      this.dirty = true;
      this.cache();
      this.emit();
      return this.save('Delete ' + (title || 'recipe'));
    },

    /** Saves are serialized; conflicting writes are merged and retried. */
    save(message) {
      const run = async () => {
        if (!this.dirty) return;
        this.setStatus('saving');
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            this.dirty = false;
            this.data.updatedAt = nowIso();
            this.sha = await this.backend.save(this.data, this.sha, message);
            this.cache();
            this.setStatus('saved');
            return;
          } catch (e) {
            this.dirty = true;
            if (e.status === 409 || e.status === 422) {
              // Someone else saved first: pull theirs, merge ours on top, retry.
              const remote = await this.backend.load();
              this.data = merge(remote.data, this.data);
              this.sha = remote.sha;
              this.emit();
              continue;
            }
            console.error(e);
            this.setStatus('error', e.message);
            throw e;
          }
        }
        this.setStatus('error', 'Could not save after several retries.');
      };
      this._saving = (this._saving || Promise.resolve()).then(run, run);
      return this._saving;
    },
  };

  function normalizeUrl(u) {
    try {
      const x = new URL(u);
      x.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'igshid', 'igsh', 'mibextid'].forEach((k) => x.searchParams.delete(k));
      return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search).toLowerCase();
    } catch {
      return String(u).trim().toLowerCase();
    }
  }

  /** Shape every recipe the same way, whatever produced it. */
  function newRecipe(partial) {
    const p = partial || {};
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);
    return {
      id: p.id || RB.uid(),
      title: String(p.title || 'Untitled recipe').trim(),
      description: p.description || '',
      imageUrl: p.imageUrl || '',
      source: {
        type: p.source?.type || 'manual', // web | facebook | instagram | gdoc | email | manual
        url: p.source?.url || '',
        name: p.source?.name || '',
        author: p.source?.author || '',
        postUrl: p.source?.postUrl || '', // the social post that pointed us at the recipe
      },
      yield: p.yield || '',
      prepTime: p.prepTime || '',
      cookTime: p.cookTime || '',
      totalTime: p.totalTime || '',
      ingredients: arr(p.ingredients),
      steps: arr(p.steps),
      categories: arr(p.categories),
      tags: arr(p.tags).map((t) => t.toLowerCase()),
      cuisine: p.cuisine || '',
      ratings: p.ratings || {}, // { "Mando": 5, "Husband": 4 }
      favorite: !!p.favorite,
      wantToMake: !!p.wantToMake,
      needsRecipe: !!p.needsRecipe, // imported but the actual recipe wasn't found yet
      madeLog: p.madeLog || [], // [{id, date, where, who, rating, notes}]
      notes: p.notes || '',
      originalText: p.originalText || '',
      addedBy: p.addedBy || '',
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt || '',
    };
  }

  function avgRating(r) {
    const v = Object.values(r.ratings || {}).filter((x) => x > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  }

  Object.assign(RB, { store, newRecipe, avgRating, merge, normalizeUrl, GitHubBackend, LocalBackend, b64ToText, textToB64 });
})();
