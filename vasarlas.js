// Vásárlási lista a telefonon (a Napi kártya felett).
//
// A tételeket a laptop (Kiértékelő) és a telefon is írhatja. A users/{uid}/shop/{id} dokumentumok
// egy külön „lista-kulccsal” vannak titkosítva, amit a telefon egyszer, egy párosító kóddal kap meg.
// Ez a kulcs CSAK a vásárlási listát nyitja: a többi adatot a telefon továbbra sem tudja visszafejteni.
//
// Offline is működik: a lista a telefonon is megvan (localStorage), a pipák és új tételek
// várakoznak, és a net visszatérésekor felmennek. Tételenként mindig a legutolsó írás számít.
const Vasarlas = (() => {
  const CACHE = "hid-vasarlas-cache";     // { id: tétel } — a legutóbb látott lista
  const PENDING = "hid-vasarlas-pending"; // { id: változás } — még fel nem küldött módosítások
  const FIELDS = ["text", "price", "done", "doneAt", "order", "deleted"];
  const PLUS = '<svg viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M12 5v14M5 12h14"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
  const CROSS = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const kFmt = (n) => (Math.round(n * 10) / 10).toLocaleString("hu-HU") + "k";

  // A lista-kulcs: nem exportálható CryptoKey az IndexedDB-ben (a nyers kód nem marad meg).
  const KeyDB = {
    db() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("hid-vasarlas", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("k");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.db();
      return new Promise((res) => { const q = fn(db.transaction("k", mode).objectStore("k")); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); });
    },
    get() { return this.run("readonly", (s) => s.get("key")).catch(() => null); },
    set(v) { return this.run("readwrite", (s) => s.put(v, "key")).catch(() => null); },
    clear() { return this.run("readwrite", (s) => s.delete("key")).catch(() => null); },
  };

  let key = null, keyChecked = false, unsub = null, watching = null, pushing = false, msg = "";
  const logged = () => typeof Sync !== "undefined" && Sync.isLoggedIn();
  const shopRef = () => Sync.db().collection("users").doc(Sync.uid()).collection("shop");

  function list() {
    const live = Object.values(read(CACHE)).filter((w) => !w.deleted);
    return [
      ...live.filter((w) => !w.done).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      ...live.filter((w) => w.done).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0)), // a kész tételek alul
    ];
  }

  // Helyi módosítás: azonnal látszik, és felküldésre vár.
  function change(id, patch) {
    const all = read(CACHE);
    const base = all[id] || { id, text: "", price: null, done: false, doneAt: null, order: 0, deleted: false };
    all[id] = Object.assign({}, base, patch, { id, updatedAt: Date.now() });
    write(CACHE, all);
    const p = read(PENDING);
    p[id] = Object.assign({}, p[id], patch);
    write(PENDING, p);
    render();
    flush();
  }

  async function flush() {
    if (pushing || !key || !logged() || !navigator.onLine) return renderStatus();
    pushing = true;
    let failed = false;
    try {
      const sent = read(PENDING);
      for (const id of Object.keys(sent)) {
        const rec = read(CACHE)[id];
        if (rec) {
          const body = {};
          FIELDS.forEach((f) => { body[f] = rec[f] ?? null; });
          const now = Date.now();
          await shopRef().doc(id).set({ updatedAt: now, blob: await HidCrypto.sealObj(key, body) });
        }
        const cur = read(PENDING); // ha közben újra módosult, az a változás várakozik tovább
        if (JSON.stringify(cur[id]) === JSON.stringify(sent[id])) { delete cur[id]; write(PENDING, cur); }
      }
    } catch (e) { failed = true; }
    pushing = false;
    renderStatus();
    if (!failed && Object.keys(read(PENDING)).length) setTimeout(flush, 300);
  }

  function stop() { if (unsub) { unsub(); unsub = null; } watching = null; }
  function watch() {
    if (!key || !logged() || watching === Sync.uid()) return;
    stop();
    watching = Sync.uid();
    unsub = shopRef().onSnapshot(async (snap) => {
      const all = read(CACHE);
      for (const ch of snap.docChanges()) {
        const id = ch.doc.id;
        if (ch.type === "removed") { delete all[id]; continue; }
        if (ch.doc.metadata.hasPendingWrites) continue; // a saját, épp küldött írásunk
        try {
          const o = await HidCrypto.openObj(key, ch.doc.data().blob);
          all[id] = Object.assign({ id }, o, { updatedAt: ch.doc.data().updatedAt }, read(PENDING)[id] || {}); // a még el nem küldött helyi változás marad
        } catch (e) { /* sérült tétel: kihagyjuk */ }
      }
      write(CACHE, all);
      render();
    }, () => { watching = null; });
  }

  async function pair(code) {
    msg = "";
    if (!logged()) { msg = "Előbb jelentkezz be a szinkronhoz (fent)."; return render(); }
    let k;
    try { k = await HidCrypto.importListKey(HidCrypto.listBytes(code)); } catch (e) { msg = e.message; return render(); }
    try {
      const snap = await Sync.db().collection("users").doc(Sync.uid()).collection("meta").doc("listkey").get();
      if (!snap.exists) { msg = "A laptopon még nincs bekapcsolva: Kiértékelő → Utak → Vásárlási lista → Bekapcsolás."; return render(); }
      const ok = await HidCrypto.openObj(k, snap.data().check).catch(() => null);
      if (!ok || ok.ok !== "hid-vasarlas") { msg = "Hibás kód. Nézd meg újra a Kiértékelőben, és írd be pontosan."; return render(); }
    } catch (e) { msg = "Nem sikerült ellenőrizni (nincs internet?)."; return render(); }
    await KeyDB.set(k);
    key = k;
    render();
    watch();
  }
  async function unpair() {
    if (!confirm("Törlöd a párosítást ezen a telefonon? A lista a laptopon megmarad, ide később újra párosíthatod.")) return;
    stop();
    await KeyDB.clear();
    key = null;
    localStorage.removeItem(CACHE);
    localStorage.removeItem(PENDING);
    render();
  }

  function renderStatus() {
    const el = $("#shop-status");
    if (!el) return;
    const n = Object.keys(read(PENDING)).length;
    el.textContent = !logged() ? "Nincs bejelentkezés — a lista a legutóbbi állapotot mutatja."
      : !navigator.onLine ? "Offline — a változások a net visszatérésekor mennek fel."
      : n ? "Felküldésre vár…" : "Szinkronban a laptoppal.";
  }

  function render() {
    const el = $("#vasarlas");
    if (!el) return;
    if (!keyChecked) { el.innerHTML = ""; return; }
    if (!key) {
      el.innerHTML = `
        <section class="block shop">
          <div class="bhead"><h2>Vásárlási lista</h2></div>
          <form class="pair" id="shopPair">
            <p>Párosítsd a laptoppal: a Kiértékelőben (Utak → Vásárlási lista) kapcsold be, majd írd be ide a megjelenő kódot. Ezt csak egyszer kell.</p>
            <input type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-…" aria-label="Párosító kód">
            <button type="submit">Párosítás</button>
            ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
          </form>
        </section>`;
      $("#shopPair").addEventListener("submit", (e) => { e.preventDefault(); pair(e.target.querySelector("input").value); });
      return;
    }
    // Ha épp gépelsz az új tétel mezőben, egy távoli frissítés ne vigye el a szöveget.
    const prevForm = $("#shopAdd");
    const keep = prevForm && { t: prevForm.t.value, p: prevForm.p.value, focus: document.activeElement && prevForm.contains(document.activeElement) ? document.activeElement.name : null };
    const scroll = $(".shop-list") ? $(".shop-list").scrollTop : 0;
    const items = list();
    const open = items.filter((w) => !w.done);
    const sum = (arr) => arr.reduce((a, w) => a + (Number(w.price) || 0), 0);
    const left = sum(open), bought = sum(items.filter((w) => w.done)), all = left + bought;
    const row = (w) => `
      <div class="item${w.done ? " done" : ""}" data-shop="${w.id}">
        <button class="check" data-shop-act="toggle" aria-label="Megvettem" aria-pressed="${!!w.done}"><span class="box">${CHECK}</span></button>
        <span class="stxt">${esc(w.text)}</span>
        ${w.price != null && w.price !== "" ? `<span class="sprice">${kFmt(Number(w.price) || 0)}</span>` : ""}
        <button class="del" data-shop-act="del" aria-label="Törlés">${CROSS}</button>
      </div>`;
    el.innerHTML = `
      <section class="block shop">
        <div class="bhead"><h2>Vásárlási lista</h2><span class="count">${open.length} hátra</span></div>
        <div class="shop-list">${items.length ? items.map(row).join("") : '<div class="empty">Üres a lista.</div>'}</div>
        ${all ? `<div class="shop-total"><div><span>Még hátra: <b>${kFmt(left)}</b></span><span>megvéve ${kFmt(bought)} / ${kFmt(all)}</span></div><div class="bar"><i style="width:${(bought / all) * 100}%"></i></div></div>` : ""}
        <form class="add" id="shopAdd">
          <input type="text" name="t" enterkeyhint="done" autocomplete="off" placeholder="Új tétel…" aria-label="Új tétel: Vásárlási lista">
          <input type="number" name="p" inputmode="decimal" min="0" step="any" placeholder="k" aria-label="Összeg (ezer Ft)" class="kprice">
          <button type="submit" aria-label="Hozzáadás: Vásárlási lista">${PLUS}</button>
        </form>
        <div class="shop-foot"><span id="shop-status"></span><button data-shop-act="unpair">Párosítás törlése</button></div>
      </section>`;
    $(".shop-list").scrollTop = scroll;
    if (keep) {
      const f = $("#shopAdd");
      f.t.value = keep.t; f.p.value = keep.p;
      if (keep.focus) f[keep.focus].focus();
    }
    $("#shopAdd").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target, text = f.t.value.trim(), price = f.p.value;
      if (!text) return;
      f.t.value = ""; f.p.value = "";
      const max = Math.max(-1, ...open.map((w) => w.order ?? 0));
      change(newId(), { text, price: price === "" ? null : Math.max(0, Number(price)), done: false, doneAt: null, order: max + 1, deleted: false });
      const t = $("#shopAdd input[name=t]"); if (t) t.focus();
    });
    renderStatus();
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-shop-act]");
    if (!b) return;
    const act = b.dataset.shopAct, row = b.closest("[data-shop]"), id = row && row.dataset.shop;
    const w = id && read(CACHE)[id];
    if (act === "toggle" && w) change(id, { done: !w.done, doneAt: w.done ? null : Date.now() });
    else if (act === "del" && w) { if (confirm(`Törlöd: „${w.text}”?`)) change(id, { deleted: true }); }
    else if (act === "unpair") unpair();
  });
  window.addEventListener("online", () => { flush(); watch(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { flush(); watch(); } });

  KeyDB.get().then((k) => { key = k; keyChecked = true; render(); if (key) { watch(); flush(); } });

  // app.js hívja be- és kijelentkezéskor.
  function onAuth(state) {
    if (state && state.loggedIn) { watch(); flush(); } else stop();
    render();
  }
  return { onAuth, flush };
})();
