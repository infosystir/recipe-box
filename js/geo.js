/* Where restaurants are, and how far they are from home. Uses OpenStreetMap's free Nominatim lookup. */
(function () {
  const RB = window.RB;
  const API = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&';

  /** {lat, lon}, null when nothing matched; throws on network trouble. */
  async function lookup(params) {
    const res = await fetch(API + new URLSearchParams(params), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Location lookup failed: ' + res.status);
    const [hit] = await res.json();
    return hit ? { lat: +hit.lat, lon: +hit.lon } : null;
  }

  /** What to look up for a place, most specific first. */
  function queries(p) {
    const q = [];
    const town = (p.city || '').split(',')[0].trim();
    if (p.address) q.push(town && !p.address.includes(town) ? `${p.address}, ${p.city}` : p.address);
    if (p.city) q.push(`${p.name}, ${p.city}`, p.city);
    return [...new Set(q)];
  }
  const key = (p) => queries(p)[0] || '';

  let home = null;
  async function homePoint() {
    const zip = String(RB.settings.load().homeZip || '').trim();
    if (!zip) return null;
    if (home && home.zip === zip) return home;
    const cached = RB.storage.get('rb.home', null);
    if (cached && cached.zip === zip) return (home = cached);
    const pt = await lookup({ postalcode: zip, countrycodes: 'us' });
    if (!pt) return null;
    home = { zip, ...pt };
    RB.storage.set('rb.home', home);
    return home;
  }

  /** Straight-line miles between two {lat, lon}. */
  function miles(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(x));
  }

  /** Miles from home, or null when either end is unknown. */
  function distance(p, from) {
    return from && p.geo && typeof p.geo.lat === 'number' ? miles(from, p.geo) : null;
  }

  let running = false;
  /**
   * Find the position of every place that doesn't have one for its current address, one lookup a
   * second (OpenStreetMap's limit). Results are saved, so each place is only looked up once.
   */
  async function locateAll(onProgress) {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
      const todo = RB.store.restaurants.filter((p) => key(p) && (!p.geo || p.geo.q !== key(p)));
      for (const p of todo) {
        let pt = null;
        for (const q of queries(p)) {
          pt = await lookup({ q }).catch(() => undefined);
          await RB.sleep(1100);
          if (pt !== null) break; // found it, or the network is down
        }
        if (pt === undefined) break; // offline or blocked; try again next visit
        const cur = RB.store.get(p.id, 'restaurants');
        if (!cur) continue;
        await RB.store.upsert({ ...cur, geo: { q: key(cur), lat: pt ? pt.lat : null, lon: pt ? pt.lon : null } }, '', { defer: true, coll: 'restaurants' });
        n++;
        if (onProgress) onProgress(n, todo.length);
      }
      if (n) await RB.store.save(`Locate ${n} places`);
    } finally {
      running = false;
    }
    return n;
  }

  RB.geo = { homePoint, miles, distance, locateAll, key, queries };
})();
