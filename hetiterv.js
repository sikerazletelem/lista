// A heti terv a telefonon (legfelül): csak a mai sor, az egész hét egy koppintásra nyílik.
//
// A Kiértékelő (laptop) írja a users/{uid}/sched dokumentumokat a vásárlási listáéval azonos
// lista-kulccsal titkosítva: {hétfő} = { week, rows: [7 × { blokk, kimenet }] }, vaz = { vaz, note }.
// Itt csak olvassuk. A kulcsot a vasarlas.js adja át (setKey), a fő kulcs nem kerül a telefonra.
// Offline is látszik: a legutóbb látott terv a localStorage-ban marad.
const HetiTerv = (() => {
  const CACHE = "hid-hetiterv-cache"; // { hétfő|vaz: visszafejtett tartalom }
  const DAYS = ["Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat", "Vasárnap"];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const read = () => { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch (e) { return {}; } };
  const write = (v) => { try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) {} };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dow = (d) => (d.getDay() + 6) % 7; // 0 = hétfő
  const monday = (d) => { const m = new Date(d); m.setDate(d.getDate() - dow(d)); return ymd(m); };
  const short = (s, i) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + i); return d.toLocaleDateString("hu-HU", { month: "short", day: "numeric" }); };

  let key = null, unsub = null, watching = null;
  let weekOpen = false; // az „Egész hét” csak addig marad nyitva, amíg az app előtérben van
  const logged = () => typeof Sync !== "undefined" && Sync.isLoggedIn();

  // Az e heti sorok; ha erre a hétre nincs dokumentum, a vázból.
  function rows(all, w) {
    if (all[w] && Array.isArray(all[w].rows)) return all[w].rows;
    if (all.vaz && all.vaz.vaz) return DAYS.map((_, i) => ({ blokk: all.vaz.vaz[i + 1] || "", kimenet: "" }));
    return null;
  }

  function render() {
    const el = $("#ma");
    if (!el) return;
    const all = read(), now = new Date(), w = monday(now), r = key ? rows(all, w) : null;
    if (!r) { el.innerHTML = ""; return; }
    const t = dow(now), today = r[t] || {};
    const week = r.map((x, i) => `<tr${i === t ? ' class="on"' : ""}><th>${DAYS[i]}<span>${short(w, i)}</span></th><td>${esc(x.blokk) || "–"}</td><td>${esc(x.kimenet) || "–"}</td></tr>`).join("");
    el.innerHTML = `
      <section class="ma">
        <div class="ma-l">Ma · ${DAYS[t].toLowerCase()}</div>
        <div class="ma-b">${esc(today.blokk) || "Nincs megadva blokk."}</div>
        ${today.kimenet ? `<div class="ma-k"><span>Kimenet:</span> ${esc(today.kimenet)}</div>` : ""}
        <details class="ma-het"${weekOpen ? " open" : ""}><summary>Egész hét</summary>
          <table><thead><tr><th>Nap</th><th>Blokk</th><th>Kimenet</th></tr></thead><tbody>${week}</tbody></table>
          ${all.vaz && all.vaz.note ? `<p>${esc(all.vaz.note)}</p>` : ""}
        </details>
      </section>`;
  }

  function stop() { if (unsub) { unsub(); unsub = null; } watching = null; }
  function watch() {
    if (!key || !logged() || watching === Sync.uid()) return;
    stop();
    watching = Sync.uid();
    unsub = Sync.db().collection("users").doc(Sync.uid()).collection("sched").onSnapshot(async (snap) => {
      const all = read();
      for (const ch of snap.docChanges()) {
        const id = ch.doc.id;
        if (ch.type === "removed") { delete all[id]; continue; }
        try { all[id] = await HidCrypto.openObj(key, ch.doc.data().blob); } catch (e) { /* sérült: kihagyjuk */ }
      }
      // A régi hetek nem kellenek a telefonon.
      const cur = monday(new Date());
      Object.keys(all).forEach((k) => { if (k !== "vaz" && k < cur) delete all[k]; });
      write(all);
      render();
    }, () => { watching = null; });
  }

  // vasarlas.js hívja: a lista-kulcs betöltésekor, párosításkor (k) és a párosítás törlésekor (null).
  function setKey(k) {
    key = k;
    if (!k) { stop(); localStorage.removeItem(CACHE); }
    else watch();
    render();
  }
  function onAuth(state) { if (state && state.loggedIn) watch(); else stop(); render(); }

  window.addEventListener("online", watch);
  document.addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("ma-het")) weekOpen = e.target.open; }, true);
  // Visszatéréskor (és napváltáskor) a „Ma” sor frissül, a heti tábla pedig újra zárva indul.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { weekOpen = false; watch(); render(); } });

  return { setKey, onAuth, render };
})();
