// Songs (MIDI bytes) live in IndexedDB on this device; settings + progress in localStorage.
const DB = 'piano-coach', ST = 'songs';
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(ST, mode);
    const req = fn(t.objectStore(ST));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
export const listSongs = async () => ((await tx('readonly', s => s.getAll())) || [])
  .map(({ id, name, addedAt }) => ({ id, name, addedAt })).sort((a, b) => b.addedAt - a.addedAt);
export const getSong = id => tx('readonly', s => s.get(id));
export const putSong = rec => tx('readwrite', s => s.put(rec));
export const deleteSong = id => tx('readwrite', s => s.delete(id));

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const DEFAULT_PREFS = {
  hands: 'R', mode: 'wait', speed: 0.5, guide: 'full', lh: 'chords', rh: 'written',
  phraseBars: 4, loop: true, chain: false, otherHand: true, sound: 'piano', lastSong: 'demo', phraseBySong: {},
};
export const loadPrefs = () => ({ ...DEFAULT_PREFS, ...read('pc.prefs', {}) });
export const savePrefs = p => write('pc.prefs', p);
export const loadProgress = () => read('pc.progress', {});
export const saveProgress = p => write('pc.progress', p);
