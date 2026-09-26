const SECTIONS = [
  { k: "mernoki", name: "Mérnöki", cls: "" },
  { k: "ingatlanpiaci", name: "Ingatlanpiaci", cls: "re" },
  { k: "maganeleti", name: "Magánéleti", cls: "me" },
  { k: "napivasarlas", name: "Napi vásárlás", cls: "sh" },
];
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M12 5v14M5 12h14"/></svg>';
const GRIP = '<svg viewBox="0 0 24 24"><path d="M7 8h10M7 12h10M7 16h10"/></svg>';

let items = [];            // minden rekord, a törölt is (jelölővel)
const showDone = {};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const setStatus = (t) => { $("#status").textContent = t; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const live = (k) => items.filter((i) => i.block === k && !i.deleted);
// Sorrend: kisebb "order" van feljebb. A régi, order nélküli tételeknél -updatedAt, így a
// megszokott "legújabb felül" sorrend marad, amíg át nem rendezed őket.
const orderKey = (i) => (i.order ?? -i.updatedAt);

function shell() {
  $("#blocks").innerHTML = SECTIONS.map((s) => `
    <section class="block ${s.cls}" id="blk-${s.k}">
      <div class="bhead"><h2>${s.name}</h2><span class="count" id="cnt-${s.k}"></span></div>
      <div class="list" id="list-${s.k}"></div>
      <div class="doneBar" id="done-${s.k}"></div>
      <form class="add" data-k="${s.k}">
        <input type="text" enterkeyhint="done" autocomplete="off" placeholder="Új tétel…" aria-label="Új tétel: ${s.name}">
        <button type="submit" aria-label="Hozzáadás: ${s.name}">${PLUS}</button>
      </form>
    </section>`).join("");
  document.querySelectorAll(".add").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("input", f), text = inp.value.trim();
    if (!text) return;
    const now = Date.now();
    save({ id: newId(), block: f.dataset.k, text, done: false, deleted: false, order: -now, updatedAt: now });
    inp.value = "";
    inp.focus();
  }));
}

function renderBlock(k) {
  const list = live(k);
  const open = list.filter((i) => !i.done).sort((a, b) => orderKey(a) - orderKey(b));
  const done = list.filter((i) => i.done).sort((a, b) => b.updatedAt - a.updatedAt);
  $("#cnt-" + k).textContent = open.length + " nyitott";
  const row = (i) => `
    <div class="item${i.done ? " done" : ""}" data-id="${i.id}">
      ${i.done ? '<span class="grip" aria-hidden="true"></span>' : `<button class="grip" aria-label="Áthelyezés (húzd, vagy fel/le nyíl)">${GRIP}</button>`}
      <button class="check" data-act="toggle" aria-label="Kész" aria-pressed="${i.done}"><span class="box">${CHECK}</span></button>
      <input class="txt" type="text" value="${esc(i.text)}" aria-label="Tétel szövege">
      <button class="del" data-act="del" aria-label="Törlés">${CROSS}</button>
    </div>`;
  $("#list-" + k).innerHTML = (open.length ? open.map(row).join("") : '<div class="empty">Nincs nyitott tétel.</div>') + (showDone[k] ? done.map(row).join("") : "");
  $("#done-" + k).innerHTML = done.length
    ? `<button data-act="showdone">${showDone[k] ? "Kész tételek elrejtése" : "Kész tételek (" + done.length + ")"}</button>` + (showDone[k] ? '<button class="clear" data-act="clear">Kész tételek törlése</button>' : "")
    : "";
}
const renderAll = () => SECTIONS.forEach((s) => renderBlock(s.k));

// Módosítás: memória + IndexedDB + (ha lehet) felhő. A syncPush hívás a szinkron csatlakozási helye.
function save(item) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) items[i] = item; else items.push(item);
  renderBlock(item.block);
  setStatus("Mentés…");
  Store.put(item).then(() => { setStatus("Mentve a telefonon"); syncPush(item); }).catch(() => setStatus("A mentés nem sikerült — próbáld újra."));
}

const hasSync = () => typeof Sync !== "undefined";
function syncPush(item) { try { if (hasSync()) Sync.push(item); } catch (e) {} }
function syncFlush() { try { if (hasSync()) Sync.syncAll(items.slice()); } catch (e) {} }

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const blk = b.closest(".block"); if (!blk) return;
  const k = blk.id.slice(4), act = b.dataset.act, row = b.closest(".item");
  const it = row && items.find((x) => x.id === row.dataset.id);
  // doneAt: mikor lett kész (a későbbi elemzéshez; az updatedAt egy későbbi módosítással felülíródhat).
  if (act === "toggle" && it) { const now = Date.now(); save({ ...it, done: !it.done, doneAt: it.done ? null : now, updatedAt: now }); }
  else if (act === "del" && it) save({ ...it, deleted: true, updatedAt: Date.now() });
  else if (act === "showdone") { showDone[k] = !showDone[k]; renderBlock(k); }
  else if (act === "clear") {
    if (!confirm("Törlöd a kész tételeket ebből a blokkból?")) return;
    const now = Date.now();
    const changed = live(k).filter((i) => i.done).map((i) => ({ ...i, deleted: true, updatedAt: now }));
    changed.forEach((c) => { items[items.findIndex((x) => x.id === c.id)] = c; });
    renderBlock(k);
    Store.putMany(changed).then(() => { setStatus("Mentve a telefonon"); changed.forEach(syncPush); }).catch(() => setStatus("A mentés nem sikerült — próbáld újra."));
  }
});

let editTimer = null;
document.addEventListener("input", (e) => {
  if (!e.target.classList.contains("txt")) return;
  const row = e.target.closest(".item");
  const it = items.find((x) => x.id === row.dataset.id);
  if (!it) return;
  const updated = { ...it, text: e.target.value, updatedAt: Date.now() };
  items[items.findIndex((x) => x.id === it.id)] = updated;
  setStatus("Mentés…");
  clearTimeout(editTimer);
  editTimer = setTimeout(() => Store.put(updated).then(() => { setStatus("Mentve a telefonon"); syncPush(updated); }).catch(() => setStatus("A mentés nem sikerült — próbáld újra.")), 400);
});

// --- Átrendezés: a fogantyút húzva (ujj, egér), vagy a fogantyún fel/le nyíllal ---
// Húzáskor a tétel az ujjat követi, a többi finoman félrecsúszik, elengedéskor a tétel a
// helyére siklik. Csak az áthelyezett tétel kap új "order" értéket (a két új szomszédja
// közé), így egyetlen mentés és egyetlen (titkosított) felküldés történik — a Kiértékelő
// Jegyzet füle ebből élőben frissül.
const SETTLE_MS = 180;
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ids: a nyitott tételek új sorrendje; id: az áthelyezett tétel.
function commitOrder(k, ids, id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const idx = ids.indexOf(id);
  const key = (x) => orderKey(items.find((i) => i.id === x));
  const prev = ids[idx - 1], next = ids[idx + 1], cur = orderKey(it);
  if ((!prev || key(prev) < cur) && (!next || cur < key(next))) { renderBlock(k); return; } // nem mozdult
  const order = prev && next ? (key(prev) + key(next)) / 2 : prev ? key(prev) + 1 : key(next) - 1;
  save({ ...it, order, updatedAt: Date.now() });
}

let drag = null;
document.addEventListener("pointerdown", (e) => {
  const h = e.target.closest("button.grip");
  if (!h || drag) return;
  e.preventDefault();
  try { h.setPointerCapture(e.pointerId); } catch (err) {}
  const row = h.closest(".item");
  const rows = [...row.parentElement.querySelectorAll(".item:not(.done)")];
  const rects = rows.map((r) => r.getBoundingClientRect());
  const from = rows.indexOf(row);
  const gap = rows.length > 1 ? rects[1].top - rects[0].bottom : 0;
  drag = { row, rows, rects, from, to: from, step: rects[from].height + gap, startY: e.clientY, dy: 0, k: row.closest(".block").id.slice(4) };
  row.classList.add("dragging");
  rows.forEach((r) => { if (r !== row) r.classList.add("shifting"); });
  document.body.classList.add("is-dragging");
});
document.addEventListener("pointermove", (e) => {
  if (!drag || drag.settling) return;
  const { row, rows, rects, from, step } = drag;
  // A tétel nem húzható ki a nyitott tételek listájából.
  const min = rects[0].top - rects[from].top, max = rects[rects.length - 1].bottom - rects[from].bottom;
  const dy = Math.max(min, Math.min(max, e.clientY - drag.startY));
  drag.dy = dy;
  row.style.transform = `translateY(${dy}px)`;
  const center = rects[from].top + rects[from].height / 2 + dy;
  let to = from;
  rects.forEach((r, i) => {
    const mid = r.top + r.height / 2;
    if (i < from && center <= mid + 2) to = Math.min(to, i); // +2 px tűrés: a sorok magassága pár tized pixelben eltérhet
    if (i > from && center >= mid - 2) to = Math.max(to, i);
  });
  drag.to = to;
  rows.forEach((r, i) => {
    if (i === from) return;
    const shift = from < i && i <= to ? -step : to <= i && i < from ? step : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
});
function endDrag() {
  if (!drag || drag.settling) return;
  const d = drag;
  d.settling = true;
  const { row, rows, rects, from, to, k } = d;
  const offset = to > from ? rects[to].bottom - rects[from].bottom : to < from ? rects[to].top - rects[from].top : 0;
  row.classList.add("settling");
  row.style.transform = offset ? `translateY(${offset}px)` : "";
  const finish = () => {
    drag = null;
    document.body.classList.remove("is-dragging");
    if (to === from) {
      rows.forEach((r) => { r.classList.remove("dragging", "shifting", "settling"); r.style.transform = ""; });
      if (Math.abs(d.dy) < 3) row.querySelector("button.grip").focus(); // csak koppintás volt: jöhetnek a nyilak
      return;
    }
    const ids = rows.map((r) => r.dataset.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    commitOrder(k, ids, row.dataset.id); // újrarajzol: a tételek már a végleges helyükön vannak
  };
  if (reduceMotion()) finish(); else setTimeout(finish, SETTLE_MS);
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

// Billentyű: a két tétel helyet cserél, rövid csúszó animációval.
document.addEventListener("keydown", (e) => {
  const h = e.target.closest && e.target.closest("button.grip");
  if (!h || drag || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const row = h.closest(".item"), k = row.closest(".block").id.slice(4);
  const rows = [...row.parentElement.querySelectorAll(".item:not(.done)")];
  const from = rows.indexOf(row), to = from + (e.key === "ArrowUp" ? -1 : 1);
  if (to < 0 || to >= rows.length) return;
  const before = new Map(rows.map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
  const ids = rows.map((r) => r.dataset.id);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const id = row.dataset.id;
  commitOrder(k, ids, id);
  const g = $(`#list-${k} .item[data-id="${id}"] button.grip`);
  if (g) g.focus();
  if (reduceMotion()) return;
  document.querySelectorAll(`#list-${k} .item:not(.done)`).forEach((r) => {
    const dy = before.get(r.dataset.id) - r.getBoundingClientRect().top;
    if (!dy) return;
    r.style.transform = `translateY(${dy}px)`;
    r.getBoundingClientRect(); // a kiinduló helyzet rögzítése, hogy az átmenet elinduljon
    r.classList.add("settling");
    r.style.transform = "";
    setTimeout(() => r.classList.remove("settling"), SETTLE_MS);
  });
});

shell();
renderAll();
Store.all().then((all) => { items = all.map((i) => (i.order == null ? { ...i, order: -i.updatedAt } : i)); renderAll(); syncFlush(); }).catch(() => setStatus("A helyi tár nem érhető el — a tételek nem maradnak meg."));
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// --- Szinkron: kicsi bejelentkezési sáv a fejléc alatt ---
let syncLoginOpen = false;
function renderSync(state) {
  const el = $("#sync");
  if (!hasSync()) { el.innerHTML = ""; return; }
  if (state && state.loggedIn) {
    syncLoginOpen = false;
    el.innerHTML = `Bejelentkezve: ${esc(state.email)} · <button data-sync="out">Kijelentkezés</button>`;
    return;
  }
  if (!syncLoginOpen) {
    el.innerHTML = `Csak ezen a telefonon tárolva · <a href="#" class="link" data-sync="open">Bejelentkezés a szinkronhoz</a>`;
    return;
  }
  el.innerHTML = `
    <form id="syncForm">
      <input type="email" name="email" placeholder="E-mail" autocomplete="username" required>
      <input type="password" name="password" placeholder="Jelszó" autocomplete="current-password" required>
      <button type="submit">Belépés</button>
    </form>`;
  $("#syncForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await Sync.login(f.get("email").trim(), f.get("password"));
      syncFlush();
    } catch (err) {
      const known = {
        "auth/invalid-credential": "Hibás e-mail vagy jelszó.",
        "auth/invalid-email": "Érvénytelen e-mail cím.",
        "auth/user-disabled": "Ez a fiók le van tiltva.",
        "auth/too-many-requests": "Túl sok próbálkozás — várj egy kicsit, és próbáld újra.",
        "auth/network-request-failed": "Nincs internetkapcsolat.",
      };
      $("#sync").insertAdjacentHTML("beforeend", `<div class="err">${esc(known[err.code] || "A bejelentkezés nem sikerült.")}</div>`);
    }
  });
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-sync]");
  if (!t) return;
  e.preventDefault();
  if (t.dataset.sync === "open") { syncLoginOpen = true; renderSync({ loggedIn: false }); }
  else if (t.dataset.sync === "out") { Sync.logout(); }
});
window.addEventListener("online", syncFlush);
try {
  if (hasSync()) {
    // Bejelentkezett állapotban (az app indulásakor is) felküldjük, ami még nincs fent.
    Sync.init((state) => {
      renderSync(state);
      if (state && state.loggedIn) syncFlush();
      if (typeof Napi !== "undefined") { Napi.render(); if (state && state.loggedIn) Napi.flush(); }
    });
    renderSync({ loggedIn: Sync.isLoggedIn(), email: Sync.email() });
  }
} catch (e) {}
