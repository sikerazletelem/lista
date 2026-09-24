// Offline-first: az app fájljait az első betöltéskor a telefon tárolja.
// Verziót emelve (CACHE) a régi fájlok lecserélődnek.
// v2: bekerült a szinkron (sync.js, hid-crypto.js, firebase-config.js). A nagy,
// online-hoz szükséges Firebase-fájlokat (vendor/) szándékosan nem előtöltjük itt —
// azok az első sikeres online látogatáskor kerülnek gyorsítótárba a lenti fetch-kezelővel,
// hogy egy hibás letöltés ne akassza meg a telepítést.
// v3: a sync.js minden még fel nem küldött tételt pótol (a szinkron előtti régieket is).
// v4: a tételek sorrendje a fogantyúval átrendezhető (order mező).
// v5: csak a lista saját fájljait tárolja (a Firebase-t és a Kiértékelőt nem).
const CACHE = "hid-lista-v5";
const FILES = ["./", "index.html", "style.css", "store.js", "hid-crypto.js", "sync.js", "firebase-config.js", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  // cache: "reload": a böngésző HTTP-gyorsítótárát megkerülve a friss fájlokat tölti le.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Csak a lista saját fájljai: a Firebase-kéréseket és a Kiértékelő mappáját nem tároljuk.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/kiertekelo/")) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("index.html")))
  );
});
