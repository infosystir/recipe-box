/* Small shared helpers. Everything hangs off window.RB. */
(function () {
  'use strict';
  const RB = (window.RB = window.RB || {});

  /**
   * Element builder. Text is always set via textContent, never innerHTML,
   * so imported recipe content can't inject markup or scripts.
   *   h('a', {href: url, class: 'x', onclick: fn}, 'text', childEl, [more])
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'class') {
          el.className = v;
        } else if (k === 'href' || k === 'src') {
          const safe = safeUrl(v);
          if (safe) el.setAttribute(k, safe);
        } else if (k === 'value') {
          el.value = v;
        } else if (k === 'checked' || k === 'selected' || k === 'disabled') {
          el[k] = !!v;
        } else if (k === 'dataset') {
          Object.assign(el.dataset, v);
        } else {
          el.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c === undefined || c === null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }

  /** Allow only http(s), in-app hash links, and relative paths. */
  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    const s = u.trim();
    if (s.startsWith('#') || s.startsWith('/') || s.startsWith('./')) return s;
    try {
      const p = new URL(s);
      return p.protocol === 'http:' || p.protocol === 'https:' || p.protocol === 'tel:' ? p.href : null;
    } catch {
      return null;
    }
  }

  function uid() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Date.now().toString(36) + '-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
  }

  const nowIso = () => new Date().toISOString();
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function fmtDate(s) {
    if (!s) return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** Lowercase + strip accents for searching. */
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /** localStorage wrapped so private windows / blocked storage don't break the app. */
  const storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false; // quota or blocked; the app still works from memory
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage unavailable; nothing to remove */
      }
    },
  };

  const DEFAULT_SETTINGS = {
    me: '',
    mode: 'github', // 'github' | 'local'
    ghToken: '',
    ghRepo: '', // owner/name
    ghBranch: '',
    ghPath: 'recipes.json',
    claudeKey: '',
    claudeModel: 'claude-sonnet-4-5',
    useWebTools: true,
    homeZip: '43440', // restaurants show how far away they are from here
    proxyUrl: '', // optional, e.g. https://recipe-proxy.you.workers.dev/?key=SECRET&url=
  };
  const settings = {
    load() {
      return Object.assign({}, DEFAULT_SETTINGS, storage.get('rb.settings', {}));
    },
    save(s) {
      storage.set('rb.settings', s);
    },
    get isConfigured() {
      const s = settings.load();
      return s.mode === 'local' || (s.ghToken && s.ghRepo);
    },
  };

  let toastTimer;
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 6000 : 3000);
  }

  /** Meta's exports double-encode UTF-8 ("cafÃ©"). Repair when it looks like that. */
  function fixMojibake(s) {
    if (typeof s !== 'string' || !/[Â-ô][\u0080-¿]/.test(s)) return s;
    try {
      const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
      if ([...s].some((c) => c.charCodeAt(0) > 0xff)) return s;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return s;
    }
  }

  /** Decode HTML entities without executing anything (DOMParser never runs scripts). */
  function decodeEntities(s) {
    if (typeof s !== 'string' || !/[&<]/.test(s)) return s;
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + s, 'text/html');
    return doc.body.textContent || '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  Object.assign(RB, { h, safeUrl, uid, nowIso, today, fmtDate, norm, debounce, storage, settings, toast, fixMojibake, decodeEntities, sleep });
})();
