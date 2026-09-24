// A Kiértékelő saját service workere. Szándékosan NEM tárol semmit.
// Minden saját fájlt "no-cache" módon kér: a böngésző mindig megkérdezi a szervert,
// van-e újabb változat, így egy GitHub-feltöltés után sima frissítés is elég.
// (A GitHub Pages egyébként 10 percig engedi a régi fájlt használni.)
// A Firebase-kérésekhez nem nyúl.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }));
});
