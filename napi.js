// Napi „Ma” kártya a telefonon, a Jegyzet blokkjai alatt.
//
// A válaszok a telefonon maradnak (localStorage, az utolsó 14 nap), és titkosítva felmennek a
// users/{uid}/days/{nap} dokumentumba. Visszaolvasni a telefon nem tudja (nincs privát kulcsa):
// a Kiértékelő fésüli össze a laptopon beírtakkal, kérdésenként mindig a később módosított számít
// (at: { mező: időbélyeg }).
const Napi = (() => {
  const KEY = "hid-napi", PENDING = "hid-napi-pending", HIDE = "hid-napi-heti-rejtve", KEEP_DAYS = 14;
  const PLAN = [["igen", "igen"], ["reszben", "részben"], ["nem", "nem"]];
  const TOOK = [["tarsas", "társas"], ["faradtsag", "fáradtság"], ["tuloras", "túlóra"], ["egyeb", "egyéb"]];
  const ENERGY = [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]];
  const AREAS = [["mernoki", "Mérnöki"], ["ingatlanpiaci", "Ingatlan"], ["sport", "Sport"], ["nyelv", "Nyelv"], ["jelenlet", "Jelenlét"], ["tarsas", "Társas"]];
  const REST = [["pihenes", "Feltöltődtem"], ["dolgoztam", "Dolgoztam"], ["menekules", "Csak menekültem"]];
  const IRANY = [["igen", "igen, az irányomba"], ["jolesett", "csak jólesett"]];
  const COST = [["ido", "idő"], ["penz", "pénz"], ["fokusz", "fókusz"]];
  const MULTI = ["took", "areas", "cost"];
  const REPORT_HOUR = 16; // vasárnap ettől kész a heti anyag a Kiértékelőben

  const $ = (s) => document.querySelector(s);
  // Helyi dátum (nem UTC), hogy éjfél után se a tegnapi napra írjon.
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => ymd(new Date());
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };
  const short = (s) => new Date(s + "T00:00:00").toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
  let yest = false; // a „Tegnap” fül van kiválasztva
  const curDay = () => (yest ? yesterday() : today());

  const read = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) || def; } catch (e) { return def; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  function saveAll(all) {
    const cut = new Date(); cut.setDate(cut.getDate() - KEEP_DAYS);
    const cutoff = ymd(cut);
    Object.keys(all).forEach((d) => { if (d < cutoff) delete all[d]; });
    write(KEY, all);
  }
  const pending = () => read(PENDING, []);
  const setPending = (list) => write(PENDING, Array.from(new Set(list)));

  function set(f, raw) {
    const d = curDay(), all = read(KEY, {});
    const e = all[d] || { at: {} };
    const v = f === "energy" ? Number(raw) : raw;
    if (MULTI.includes(f)) { const cur = e[f] || []; e[f] = cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat([v]); }
    else e[f] = e[f] === v ? null : v; // újra koppintva törlődik
    e.at = Object.assign({}, e.at, { [f]: Date.now() });
    all[d] = e;
    saveAll(all);
    setPending(pending().concat([d]));
    render();
    schedule(d);
  }

  // Felküldés: kis késleltetéssel (több gyors koppintás egy írás), sorban egymás után,
  // hogy egy régebbi állapot ne írhassa felül az újabbat.
  const timers = {};
  let chain = Promise.resolve();
  function schedule(d) {
    clearTimeout(timers[d]);
    timers[d] = setTimeout(() => { chain = chain.then(() => pushNow(d)); }, 800);
  }
  async function pushNow(d) {
    if (typeof Sync === "undefined") return renderStatus();
    const e = read(KEY, {})[d];
    if (!e) { setPending(pending().filter((x) => x !== d)); return renderStatus(); }
    const ts = Math.max(0, ...Object.values(e.at || {}));
    const ok = await Sync.putEncrypted("days", d, Object.assign({ date: d }, e), ts).catch(() => false);
    const now = read(KEY, {})[d];
    const unchanged = now && Math.max(0, ...Object.values(now.at || {})) === ts;
    if (ok && unchanged) setPending(pending().filter((x) => x !== d));
    renderStatus();
  }
  function flush() { pending().forEach((d) => { chain = chain.then(() => pushNow(d)); }); }

  function renderStatus() {
    const el = $("#napi-status");
    if (!el) return;
    const logged = typeof Sync !== "undefined" && Sync.isLoggedIn();
    const n = pending().length;
    el.textContent = !logged ? "Csak a telefonon — a Kiértékelőbe bejelentkezés után kerül át."
      : n ? "Felküldésre vár…" : "Felküldve, titkosítva.";
  }

  function heti() {
    const el = $("#heti");
    if (!el) return;
    const now = new Date(), dow = now.getDay();
    const sunday = dow === 0 ? today() : dow === 1 ? yesterday() : null; // vasárnap 16:00-tól hétfő estig
    const show = sunday && (dow === 1 || now.getHours() >= REPORT_HOUR) && read(HIDE, null) !== sunday;
    el.innerHTML = show
      ? `<div class="heti"><span>Kész a heti kiértékelés.</span><a href="kiertekelo/">Megnyitás</a><button data-napi-hide="${sunday}" aria-label="Elrejtés">×</button></div>`
      : "";
  }

  function render() {
    const el = $("#napi");
    if (!el) return;
    const d = curDay(), e = read(KEY, {})[d] || {};
    const has = (f, v) => (e[f] || []).includes(v);
    const opts = (f, list, isOn) => `<div class="opts">${list.map(([v, l]) => {
      const on = isOn(v);
      return `<button class="opt${on ? " on" : ""}" data-napi="${f}" data-v="${v}" aria-pressed="${on}">${l}</button>`;
    }).join("")}</div>`;
    const one = (f) => (v) => e[f] === v, many = (f) => (v) => has(f, v);
    const q = (label, body) => `<div class="q"><div class="q-l">${label}</div>${body}</div>`;
    const miss = e.plan === "reszben" || e.plan === "nem";
    el.innerHTML = `
      <section class="block napi">
        <div class="bhead"><h2>Napi kártya</h2>
          <div class="daypick">${[[false, "Ma", today()], [true, "Tegnap", yesterday()]].map(([y, l, dd]) =>
            `<button class="${yest === y ? "on" : ""}" data-napi-day="${y ? 1 : 0}">${l} · ${short(dd)}</button>`).join("")}</div></div>
        <div class="napi-b">
          ${q("Ment a terv szerint az este?", opts("plan", PLAN, one("plan")))}
          ${miss ? q("Mi vitte el?", opts("took", TOOK, many("took"))) : ""}
          ${q("Energia ma <span>(1 = kimerült, 5 = tele)</span>", opts("energy", ENERGY, (v) => e.energy === v))}
          ${q("Mire ment érdemi idő?", opts("areas", AREAS, many("areas")))}
          ${q("Napi állapot", opts("rest", REST, one("rest")))}
          ${has("areas", "tarsas") ? `<div class="q-sub">
            ${q("Társas: visz valamerre?", opts("irany", IRANY, one("irany")))}
            ${q("Mit vitt el sokat? <span>(nem kötelező)</span>", opts("cost", COST, many("cost")))}</div>` : ""}
          <div class="napi-status" id="napi-status"></div>
        </div>
      </section>`;
    renderStatus();
  }

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-napi],[data-napi-day],[data-napi-hide]");
    if (!b) return;
    if (b.dataset.napiHide) { write(HIDE, b.dataset.napiHide); heti(); return; }
    if (b.dataset.napiDay != null) { yest = b.dataset.napiDay === "1"; render(); return; }
    set(b.dataset.napi, b.dataset.v);
  });
  // Ha az app egész nap nyitva marad, éjfél után a „Ma” már a következő nap legyen.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); heti(); } });
  window.addEventListener("online", flush);

  return { render, heti, flush };
})();
Napi.render();
Napi.heti();
