const SECTIONS = [
  { k: "mernoki", name: "Mérnöki", cls: "" },
  { k: "ingatlanpiaci", name: "Ingatlanpiaci", cls: "re" },
  { k: "maganeleti", name: "Magánéleti", cls: "me" },
];
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M12 5v14M5 12h14"/></svg>';

let items = [];            // minden rekord, a törölt is (jelölővel)
const showDone = {};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const setStatus = (t) => { $("#status").textContent = t; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const live = (k) => items.filter((i) => i.block === k && !i.deleted);

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
    save({ id: newId(), block: f.dataset.k, text, done: false, deleted: false, updatedAt: Date.now() });
    inp.value = "";
    inp.focus();
  }));
}

function renderBlock(k) {
  const list = live(k).sort((a, b) => b.updatedAt - a.updatedAt);
  const open = list.filter((i) => !i.done), done = list.filter((i) => i.done);
  $("#cnt-" + k).textContent = open.length + " nyitott";
  const row = (i) => `
    <div class="item${i.done ? " done" : ""}" data-id="${i.id}">
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

// Módosítás: memória + IndexedDB. A `push` pont a jövőbeli szinkron csatlakozási helye.
function save(item) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) items[i] = item; else items.push(item);
  renderBlock(item.block);
  setStatus("Mentés…");
  Store.put(item).then(() => setStatus("Mentve a telefonon")).catch(() => setStatus("A mentés nem sikerült — próbáld újra."));
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const blk = b.closest(".block"); if (!blk) return;
  const k = blk.id.slice(4), act = b.dataset.act, row = b.closest(".item");
  const it = row && items.find((x) => x.id === row.dataset.id);
  if (act === "toggle" && it) save({ ...it, done: !it.done, updatedAt: Date.now() });
  else if (act === "del" && it) save({ ...it, deleted: true, updatedAt: Date.now() });
  else if (act === "showdone") { showDone[k] = !showDone[k]; renderBlock(k); }
  else if (act === "clear") {
    if (!confirm("Törlöd a kész tételeket ebből a blokkból?")) return;
    const now = Date.now();
    const changed = live(k).filter((i) => i.done).map((i) => ({ ...i, deleted: true, updatedAt: now }));
    changed.forEach((c) => { items[items.findIndex((x) => x.id === c.id)] = c; });
    renderBlock(k);
    Store.putMany(changed).then(() => setStatus("Mentve a telefonon")).catch(() => setStatus("A mentés nem sikerült — próbáld újra."));
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
  editTimer = setTimeout(() => Store.put(updated).then(() => setStatus("Mentve a telefonon")).catch(() => setStatus("A mentés nem sikerült — próbáld újra.")), 400);
});

shell();
renderAll();
Store.all().then((all) => { items = all; renderAll(); }).catch(() => setStatus("A helyi tár nem érhető el — a tételek nem maradnak meg."));
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
