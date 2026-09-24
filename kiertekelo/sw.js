// A Kiértékelő saját service workere. Szándékosan NEM tárol semmit:
// csak azért van, hogy a mappa ne a telefonos lista (../sw.js) gyorsítótárán
// keresztül töltődjön, és hogy a böngésző asztali appként telepíthesse.
// Minden kérés közvetlenül a hálózatra megy.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
