// Híd Kiértékelő: a Híd artifact laptopos, titkosított utódja.
//
// Adatok (Firestore, minden titkosítva a HidCrypto-val):
//   users/{uid}/meta/keys       -> { publicKey, keyfile }   (kulcs-beallitas.html hozza létre)
//   users/{uid}/meta/hidstate   -> { updatedAt, blob }      (a Kiértékelő saját állapota, csak ez írja)
//   users/{uid}/items/{id}      -> { updatedAt, blob }      (a telefonos lista tételei, itt csak olvassuk)
//
// A privát kulcs és a visszafejtett adat alapból csak a memóriában él. Ha a feloldáskor
// bejelölöd a „ne kérje újra” opciót, a (nem exportálható) kulcs 30 napig ennek a
// böngészőnek az IndexedDB-jében marad; a Zárolás gomb ezt is törli.
(() => {
  const THRESHOLDS = { MIN: 500000, MID_LOW: 600000, MID_HIGH: 800000, BIG: 1000000 };
  const SCALE_MAX = 1300000;
  const REMINDER_DELAY_DAYS = 14;
  const RELATIONSHIP_SWITCH_DAYS = 70;
  const IDLE_MS = 15 * 60 * 1000;
  const REMEMBER_MS = 30 * 86400000;
  const TAB_KEY = "hid-kiert-tab";
  const SKODA_REMINDER =
    "Nézz meg egy Audi A7-et, nézd az elejét. Emlékezz: csak te vagy valójában. Semmi nem fix — társ, család, nem vagyunk egyformák, ha igen, az is csak időszakos. Valójában csak te vagy…";

  const DEFAULT_STATE = {
    identity: "",
    bigGoal: "",
    mediumGoal: "",
    mediumGoalStatus: { achieved: false, achievedDate: null },
    bigGoalsBreakdown: "",
    income: { mernoki: 0, ingatlanpiaci: 0 },
    restLogs: {},
    health: { items: [] },
    presence: { items: [] },
    relationships: { startDate: null, switchAfterDays: RELATIONSHIP_SWITCH_DAYS, mode: "weekly", switchDismissed: false, weekly: {}, daily: {} },
    ideas: [],
    wishlist: [],
  };

  const BLOCKS = [
    { k: "mernoki", label: "Mérnöki", c: "green" },
    { k: "ingatlanpiaci", label: "Ingatlanpiaci", c: "gold" },
    { k: "maganeleti", label: "Magánéleti", c: "blue" },
  ];

  // ---------- ikonok (a Híd kézzel rajzolt vonalas ikonjai) ----------
  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13 13l-4.5 2.5L11 11z"/>',
    pen: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 15v5Z"/>',
    route: '<circle cx="5" cy="6" r="2.3"/><circle cx="19" cy="18" r="2.3"/><path d="M7.3 6H15a3 3 0 0 1 3 3v.5a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3v.8"/>',
    heart: '<path d="M12 20s-7-4.35-9.3-8.8C1.2 8.1 2.9 5 6 5c1.9 0 3.3 1 4 2.3C10.7 6 12.1 5 14 5c3.1 0 4.8 3.1 3.3 6.2C15 15.65 12 20 12 20Z"/>',
    sun: '<circle cx="12" cy="14" r="4"/><path d="M12 3v2M4.2 8.2l1.4 1.4M19.8 8.2l-1.4 1.4M3 15h2M19 15h2M12 21v-2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2.5 19c0-3 3-5 6.5-5s6.5 2 6.5 5"/><circle cx="18" cy="8.5" r="2.3"/><path d="M15.5 14.3c2.7.4 4.7 2.2 4.7 4.7"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.9v.2h5v-.2c0-.8.4-1.5 1-1.9A6 6 0 0 0 12 3Z"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.1"/>',
    bell: '<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/>',
    party: '<path d="M4 20 14 8M12 3l1 2M18 6l2 1M18 15l2 .5"/><path d="M8.5 12.5 4 20l7.5-4.5-2-3Z"/>',
    sparkle: '<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6Z"/>',
    battery: '<rect x="2" y="8" width="16" height="8" rx="2"/><path d="M20 10.5v3"/><path d="M6 12h6"/>',
    batteryLow: '<rect x="2" y="8" width="16" height="8" rx="2"/><path d="M20 10.5v3"/><path d="M6 12h1.5"/>',
    briefcase: '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5M3 12.5h18"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    grip: '<path d="M7 8h10M7 12h10M7 16h10"/>',
  };
  const icon = (n, cls = "icon") => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[n]}</svg>`;

  const DOMAIN = {
    mernoki: { label: "Mérnöki pálya", c: "green", icon: "route" },
    ingatlanpiaci: { label: "Ingatlanpiaci pálya", c: "gold", icon: "sparkle" },
    health: { label: "Test & egészség", c: "red", icon: "heart" },
    presence: { label: "Jelenlét & élmény", c: "blue", icon: "sun" },
    relationships: { label: "Kapcsolatok", c: "purple", icon: "users" },
  };

  const REST = {
    pihenes: { c: "green", icon: "battery", label: "Feltöltődtem" },
    dolgoztam: { c: "gold", icon: "briefcase", label: "Dolgoztam" },
    menekules: { c: "danger", icon: "batteryLow", label: "Csak menekültem" },
  };

  const TABS = [
    { k: "overview", label: "Áttekintés", icon: "grid" },
    { k: "identity", label: "Ki vagyok", icon: "compass" },
    { k: "log", label: "Napi napló", icon: "pen" },
    { k: "paths", label: "Utak", icon: "route" },
    { k: "balance", label: "Egyensúly", icon: "heart" },
    { k: "ideas", label: "Ötletek", icon: "bulb" },
    { k: "notes", label: "Jegyzet", icon: "list" },
  ];

  // ---------- segédfüggvények ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (node, t, cls = "") => { node.className = "out " + cls; node.textContent = t; };
  const ms = (t0) => Math.round(performance.now() - t0) + " ms";
  const clamp = (v) => Math.max(1, Math.min(5, v));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Helyi dátum (nem UTC), hogy éjfél és hajnali 2 között se a tegnapi napra írjon.
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = () => ymd(new Date());
  const fmtDate = (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("hu-HU", { year: "numeric", month: "2-digit", day: "2-digit" }) : "");
  const fmtStamp = (t) => (t ? new Date(t).toLocaleString("hu-HU", { dateStyle: "short", timeStyle: "short" }) : "");
  const fmtHUF = (n) => (Number(n) || 0).toLocaleString("hu-HU") + " Ft";
  const daysSince = (s) => (s ? Math.round((new Date(todayStr() + "T00:00:00") - new Date(s + "T00:00:00")) / 86400000) : null);
  const pct = (v) => Math.min(100, Math.max(0, (v / SCALE_MAX) * 100));
  function weekKey(d = new Date()) {
    const m = new Date(d);
    m.setDate(d.getDate() + ((d.getDay() === 0 ? -6 : 1) - d.getDay()));
    return ymd(m);
  }
  function deepMerge(base, extra) {
    const out = { ...base };
    for (const k of Object.keys(extra || {})) {
      const a = base[k], b = extra[k];
      out[k] = b && typeof b === "object" && !Array.isArray(b) && a && typeof a === "object" && !Array.isArray(a) ? deepMerge(a, b) : b;
    }
    return out;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- megjegyzett kulcs (IndexedDB, opcionális) ----------
  const KeyStore = {
    db() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("hid-kiertekelo", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("k");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.db();
      return new Promise((res) => {
        const req = fn(db.transaction("k", mode).objectStore("k"));
        req.onsuccess = () => res(req.result ?? null);
        req.onerror = () => res(null);
      });
    },
    get() { return this.run("readonly", (s) => s.get("key")).catch(() => null); },
    set(v) { return this.run("readwrite", (s) => s.put(v, "key")).catch(() => null); },
    clear() { return this.run("readwrite", (s) => s.delete("key")).catch(() => null); },
  };

  // ---------- futási állapot ----------
  const DEMO = location.hostname === "localhost" && location.hash === "#demo"; // csak helyi felülettesztre
  let auth = null, db = null;
  if (!DEMO) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
  }

  let user = null, publicKey = null, keyfile = null, privateKey = null, remembered = false;
  let state = null, items = new Map();
  let unsubItems = null, unsubState = null, idleTimer = null, saveTimer = null, lastSavedAt = 0, savePromise = null;
  let tab = "overview", jegyzetDone = false;
  const timing = {};
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.some((x) => x.k === t)) tab = t; } catch {}

  const userRef = () => db.collection("users").doc(user.uid);

  function show(which) {
    $("#loginGate").hidden = which !== "login";
    $("#lockGate").hidden = which !== "lock";
    $("#app").hidden = which !== "app";
    if (which !== "app") document.body.style.backgroundColor = "";
  }

  // ---------- bejelentkezés ----------
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    say($("#loginOut"), "Belépés…");
    try { await auth.signInWithEmailAndPassword($("#email").value.trim(), $("#pw").value); $("#pw").value = ""; }
    catch { say($("#loginOut"), "Hibás e-mail vagy jelszó (vagy nincs internet).", "bad"); }
  };
  $("#logoutBtn").onclick = async () => { await lock(true); auth.signOut(); };

  if (auth) auth.onAuthStateChanged(async (u) => {
    await lock(false);
    user = u; keyfile = null; publicKey = null;
    if (!u) return show("login");
    show("lock");
    $("#lockWho").textContent = "Bejelentkezve: " + u.email;
    say($("#unlockOut"), "Kulcs betöltése…");
    try {
      const snap = await userRef().collection("meta").doc("keys").get();
      if (!snap.exists || !snap.data().keyfile) return say($("#unlockOut"), "Ehhez a fiókhoz még nincs kulcs. Előbb a kulcs-beallitas.html oldalon hozd létre.", "bad");
      keyfile = snap.data().keyfile;
      publicKey = await HidCrypto.importPublicKey(snap.data().publicKey);
    } catch (err) { return say($("#unlockOut"), "Nem sikerült elérni az adatbázist: " + err.message, "bad"); }
    const saved = await KeyStore.get();
    if (saved && saved.uid === u.uid && saved.exp > Date.now() && saved.key) {
      privateKey = saved.key; remembered = true;
      timing.unlock = "megjegyzett kulcs";
      say($("#unlockOut"), "");
      return openApp();
    }
    say($("#unlockOut"), "");
    $("#encPw").focus();
  });

  // ---------- feloldás / zárolás ----------
  async function unlock(fn, input) {
    if (!keyfile) return;
    say($("#unlockOut"), "Feloldás… (a jelszó ellenőrzése szándékosan lassú, pár másodperc is lehet)");
    const t0 = performance.now();
    try {
      privateKey = await fn(keyfile, input.value);
      input.value = "";
      timing.unlock = ms(t0);
      remembered = $("#remember").checked;
      if (remembered) await KeyStore.set({ key: privateKey, uid: user.uid, exp: Date.now() + REMEMBER_MS });
      say($("#unlockOut"), "");
      openApp();
    } catch (err) { say($("#unlockOut"), err.message, "bad"); }
  }
  $("#unlockForm").onsubmit = (e) => { e.preventDefault(); unlock(HidCrypto.unlockWithPassword, $("#encPw")); };
  $("#recForm").onsubmit = (e) => { e.preventDefault(); unlock(HidCrypto.unlockWithRecovery, $("#recKey")); };

  // forget=true: a gépen megjegyzett kulcsot is törli (Zárolás gomb, kijelentkezés).
  async function lock(forget) {
    await flushSave();
    if (unsubItems) { unsubItems(); unsubItems = null; }
    if (unsubState) { unsubState(); unsubState = null; }
    clearTimeout(idleTimer);
    privateKey = null; state = null; items = new Map(); remembered = false;
    Object.keys(timing).forEach((k) => delete timing[k]);
    $("#view").replaceChildren();
    if (forget) await KeyStore.clear();
    if (user) { show("lock"); $("#encPw").focus(); }
  }
  $("#lockBtn").onclick = () => lock(true);

  function bumpIdle() {
    if (!privateKey || remembered) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => { await lock(false); say($("#unlockOut"), "15 perc tétlenség után automatikusan zárolva."); }, IDLE_MS);
  }
  ["pointerdown", "keydown", "wheel"].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));

  // ---------- betöltés, élő frissítés ----------
  function openApp() {
    show("app");
    bumpIdle();
    $("#today").textContent = fmtDate(todayStr());
    setSaveStatus("Betöltés…");
    const key = privateKey;
    const t0 = performance.now();

    unsubState = userRef().collection("meta").doc("hidstate").onSnapshot(async (snap) => {
      if (key !== privateKey || snap.metadata.hasPendingWrites) return;
      if (!snap.exists) {
        if (state) return;
        state = clone(DEFAULT_STATE);
        state.relationships.startDate = todayStr();
        timing.state = "új, üres állapot";
        render(); scheduleSave();
        return;
      }
      const d = snap.data();
      if (state && (d.updatedAt === lastSavedAt || saveTimer)) return; // a saját mentésünk, vagy épp gépelsz
      try {
        const tDec = performance.now();
        const obj = await HidCrypto.decryptItem(key, d.blob);
        if (key !== privateKey) return;
        if (!timing.state) timing.state = ms(tDec);
        state = deepMerge(clone(DEFAULT_STATE), obj);
        lastSavedAt = d.updatedAt;
        setSaveStatus("Mentve: " + fmtStamp(d.updatedAt));
        render();
      } catch { setSaveStatus("A mentett állapot nem fejthető vissza.", true); }
    }, (err) => setSaveStatus("Olvasási hiba: " + err.message, true));

    let first = true;
    unsubItems = userRef().collection("items").onSnapshot(async (snap) => {
      if (key !== privateKey) return;
      const tDec = performance.now();
      const changes = snap.docChanges();
      await Promise.all(changes.map(async (ch) => {
        const id = ch.doc.id;
        if (ch.type === "removed") return items.delete(id);
        const d = ch.doc.data();
        try {
          const o = await HidCrypto.decryptItem(key, d.blob);
          items.set(id, { id, block: o.block, text: o.text, done: !!o.done, deleted: !!o.deleted, order: o.order, updatedAt: d.updatedAt });
        } catch { items.set(id, { id, error: true, updatedAt: d.updatedAt }); }
      }));
      if (key !== privateKey) return;
      if (first) { timing.items = `${changes.length} tétel: ${ms(t0)} (ebből visszafejtés ${ms(tDec)})`; first = false; }
      if (state && (tab === "overview" || tab === "notes")) render();
      renderTiming();
    }, () => {});
  }

  // ---------- mentés (titkosítva, kis késleltetéssel) ----------
  function setSaveStatus(t, bad) { const n = $("#saveStatus"); n.textContent = t; n.classList.toggle("bad", !!bad); }
  function scheduleSave() {
    if (DEMO) return setSaveStatus("Demó: nincs mentés");
    clearTimeout(saveTimer);
    setSaveStatus("Mentés…");
    saveTimer = setTimeout(doSave, 700);
  }
  async function doSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!state || !publicKey || !user) return;
    const snapshot = clone(state);
    const run = (async () => {
      try {
        const blob = await HidCrypto.encryptItem(publicKey, snapshot);
        const updatedAt = Date.now();
        lastSavedAt = updatedAt;
        await userRef().collection("meta").doc("hidstate").set({ updatedAt, blob });
        setSaveStatus("Mentve: " + fmtStamp(updatedAt));
      } catch (e) { setSaveStatus("A mentés nem sikerült — próbáld újra.", true); }
    })();
    savePromise = run;
    await run;
  }
  async function flushSave() {
    if (saveTimer) await doSave();
    else if (savePromise) await savePromise;
  }
  window.addEventListener("beforeunload", (e) => { if (saveTimer) { doSave(); e.preventDefault(); e.returnValue = ""; } });

  function mutate(fn, rerender = true) {
    fn(state);
    scheduleSave();
    if (rerender) render();
  }

  let flashTimer = null;
  function flash(msg, dur = 2200) {
    const f = $("#flash");
    f.innerHTML = icon("info", "icon icon-sm") + " " + esc(msg);
    f.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { f.hidden = true; }, dur);
  }

  // ---------- egyszeri átvétel a régi Híd artifactból (hid-atvetel.json) ----------
  // A fájl csak a laptopon van; itt titkosítva kerül a Firestore-ba. A Jegyzet-tételeket
  // (todos) nem veszi át — azok a telefonon élnek —, csak jelzi, melyik hiányzik onnan.
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !state) return;
    let src;
    try {
      const obj = JSON.parse(await file.text());
      src = obj && obj.format === "hid-state" ? obj.state : obj;
      if (!src || typeof src !== "object" || !("identity" in src || "bigGoal" in src)) throw new Error();
    } catch { return flash("Ez a fájl nem a Híd mentése.", 5000); }
    if (!confirm("A régi Híd tartalma felülírja a Kiértékelő mostani tartalmát. Folytatod?")) return;
    const { todos, ...rest } = src;
    state = deepMerge(clone(DEFAULT_STATE), rest);
    state.importedAt = Date.now();
    tab = "overview";
    scheduleSave();
    render();
    const onPhone = new Set([...items.values()].filter((i) => !i.error && !i.deleted).map((i) => i.text.trim().toLowerCase()));
    const missing = Object.values(todos || {}).flat().filter((t) => t && !t.done && !onPhone.has(String(t.text).trim().toLowerCase())).map((t) => t.text);
    flash(missing.length ? `Átvéve. A régi Híd Jegyzetéből ezek még nincsenek a telefonon, ott vedd fel őket: ${missing.join(", ")}` : "Átvéve, minden adat a helyén.", 15000);
  };

  // ---------- számítások (a Híd képletei) ----------
  function todoSummary(k) {
    const list = [...items.values()].filter((i) => !i.error && !i.deleted && i.block === k);
    const open = list.filter((i) => !i.done);
    const editedThisWeek = list.filter((i) => i.updatedAt && Date.now() - i.updatedAt <= 7 * 86400000).length;
    return { open, total: list.length, doneCount: list.length - open.length, editedThisWeek };
  }
  function notionScore(s) {
    const n = s.open.length;
    let v = n === 0 ? 1 : n <= 2 ? 2 : n <= 4 ? 3 : n <= 7 ? 4 : 5;
    if (n > 0 && s.editedThisWeek === 0) v += 1;
    return clamp(v);
  }
  function derived() {
    const rel = state.relationships;
    const wk = weekKey(), today = todayStr();
    const relWeek = rel.weekly[wk] || { tars: false, uzlettars: false };
    const relToday = rel.daily[today] || { tars: false, uzlettars: false };
    const relDays = daysSince(rel.startDate) ?? 0;
    const relSuggest = rel.mode === "weekly" && relDays >= rel.switchAfterDays;
    const relEntry = rel.mode === "weekly" ? relWeek : relToday;
    const relChecked = (relEntry.tars ? 1 : 0) + (relEntry.uzlettars ? 1 : 0);
    const mern = todoSummary("mernoki"), ingat = todoSummary("ingatlanpiaci");
    const healthOpen = state.health.items.filter((i) => !i.lastAddressed || daysSince(i.lastAddressed) >= 30).length;
    const restDates = Object.keys(state.restLogs);
    const sinceRest = restDates.length ? Math.min(...restDates.map(daysSince)) : 999;
    const scores = {
      mernoki: notionScore(mern),
      ingatlanpiaci: notionScore(ingat),
      health: healthOpen === 0 ? 1 : clamp(healthOpen + 1),
      presence: sinceRest >= 5 ? 5 : sinceRest >= 2 ? 3 : 2,
      relationships: (() => { let s = relChecked === 0 ? 5 : relChecked === 1 ? 3 : 1; if (relSuggest) s = Math.min(5, s + 1); return s; })(),
    };
    const statuses = {
      mernoki: `${mern.open.length} nyitva`,
      ingatlanpiaci: `${ingat.open.length} nyitva`,
      health: `${state.health.items.length} nyitott terület`,
      presence: "szem előtt tartva",
      relationships: rel.mode === "weekly" ? `${relChecked}/2 e héten` : `${relChecked}/2 ma`,
    };
    const goTab = { mernoki: "notes", ingatlanpiaci: "notes", health: "balance", presence: "balance", relationships: "balance" };
    const mgs = state.mediumGoalStatus;
    const mgDays = mgs.achieved ? daysSince(mgs.achievedDate) : null;
    return { rel, relWeek, relToday, relEntry, relDays, relSuggest, relChecked, mern, ingat, scores, statuses, goTab, mgs, mgDays,
      restToday: state.restLogs[today],
      totalIncome: (Number(state.income.mernoki) || 0) + (Number(state.income.ingatlanpiaci) || 0) };
  }

  // ---------- nézetek ----------
  const eyebrow = (text, c = "green") => `<div class="eyebrow" style="color:var(--c-${c})"><span class="rule" style="background:var(--c-${c})"></span>${text}</div>`;
  const card = (inner, accent, extra = "") => `<div class="card" ${extra}>${accent ? `<div class="accent-bar" style="background:var(--c-${accent})"></div>` : ""}${inner}</div>`;
  const addRow = (list, placeholder, c) => `<div class="add-row"><input class="field-input" data-add-input="${list}" placeholder="${esc(placeholder)}"><button class="btn" style="background:var(--c-${c});color:#fff" data-act="add" data-list="${list}" aria-label="Hozzáadás">${icon("plus", "icon icon-sm")}</button></div>`;

  function wheelSvg(D) {
    const keys = Object.keys(DOMAIN);
    const cx = 400, cy = 300, innerR = 58, maxR = 196, gap = 5, step = 360 / keys.length;
    const rFor = (s) => innerR + (maxR - innerR) * (clamp(s) / 5);
    const pt = (r, a) => { const rad = (a * Math.PI) / 180; return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }; };
    const wedge = (r, a1, a2) => {
      const p1 = pt(innerR, a1), p2 = pt(r, a1), p3 = pt(r, a2), p4 = pt(innerR, a2);
      return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${r} ${r} 0 0 1 ${p3.x} ${p3.y} L ${p4.x} ${p4.y} A ${innerR} ${innerR} 0 0 0 ${p1.x} ${p1.y} Z`;
    };
    let s = `<svg class="wheel" viewBox="0 0 800 600" role="img" aria-label="Élet-kerék">`;
    [1, 2, 3, 4, 5].forEach((l) => { s += `<circle cx="${cx}" cy="${cy}" r="${rFor(l)}" fill="none" stroke="var(--border-strong)"/>`; });
    keys.forEach((k, i) => {
      const d = DOMAIN[k], sc = D.scores[k], a = -90 + i * step, r = rFor(sc);
      const bp = pt(Math.max(r - 18, innerR + 10), a), ip = pt(innerR + 24, a), lp = pt(maxR + 30, a);
      const cos = Math.cos((a * Math.PI) / 180);
      const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
      const ly = lp.y + (Math.abs(cos) < 0.2 ? (lp.y < cy ? -14 : 6) : -6);
      s += `<g class="wedge" data-act="go" data-v="${D.goTab[k]}">
        <path d="${wedge(r, a - step / 2 + gap / 2, a + step / 2 - gap / 2)}" fill="var(--c-${d.c}-tint)" stroke="var(--c-${d.c})" stroke-width="1.8"/>
        <circle cx="${ip.x}" cy="${ip.y}" r="16" fill="var(--c-${d.c}-tint)"/>
        <svg x="${ip.x - 8}" y="${ip.y - 8}" width="16" height="16" viewBox="0 0 24 24" class="icon" style="color:var(--c-${d.c})">${ICONS[d.icon]}</svg>
        <circle cx="${bp.x}" cy="${bp.y}" r="11" fill="var(--c-${d.c})"/>
        <text x="${bp.x}" y="${bp.y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" class="font-data">${sc}</text>
        <text x="${lp.x}" y="${ly}" text-anchor="${anchor}" class="wl">${esc(d.label)}</text>
        <text x="${lp.x}" y="${ly + 21}" text-anchor="${anchor}" class="ws" style="fill:var(--c-${d.c})">${esc(D.statuses[k])}</text>
      </g>`;
    });
    s += `<circle cx="${cx}" cy="${cy}" r="${innerR - 6}" fill="var(--ink)"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="19" fill="var(--bg)" font-style="italic" class="font-display">Ma</text>
      <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--faint)" class="font-data">${fmtDate(todayStr())}</text></svg>`;
    return s;
  }

  function restDisplay(k) {
    if (!k) return `<div class="empty">Még nincs mai bejegyzés — a Napi napló fülön tudod jelölni.</div>`;
    const r = REST[k];
    return `<div class="rest-display" style="--c:var(--c-${r.c});--t:var(--c-${r.c}-tint);--x:var(--c-${r.c}-text)">${icon(r.icon)} ${r.label}</div>`;
  }

  // Vásárlási lista összesítő: ami még hátra van, ami megvan, és egy sáv az arányukról.
  // Az összegek ezer forintban ("k") értendők: 25 = 25 000 Ft.
  function wishTotalHtml() {
    const sum = (arr) => arr.reduce((a, w) => a + (Number(w.price) || 0), 0);
    const left = sum(state.wishlist.filter((w) => !w.done)), bought = sum(state.wishlist.filter((w) => w.done)), all = left + bought;
    if (!all) return "";
    const k = (n) => (Math.round(n * 10) / 10).toLocaleString("hu-HU") + "k";
    return `<div class="wish-total">
      <div class="between"><span>Még hátra: <b class="font-data">${k(left)}</b></span><span class="small font-data">megvéve ${k(bought)} / ${k(all)}</span></div>
      <div class="wish-bar"><i style="width:${(bought / all) * 100}%"></i></div>
    </div>`;
  }

  const VIEWS = {
    overview(D) {
      const weekly = [["Mérnöki", D.mern, "green"], ["Ingatlanpiaci", D.ingat, "gold"]].map(([l, s, c]) => `
        <div class="mini" style="background:var(--c-${c}-tint);border-color:color-mix(in srgb, var(--c-${c}) 30%, var(--border))">
          <div class="mini-l">${l}</div>
          <div class="font-display mini-n">${s.open.length} nyitott</div>
          <div class="mini-s">${s.editedThisWeek} frissült e héten</div>
        </div>`).join("");
      return `<div class="stack">
        <div>${eyebrow("Élet-kerék — mai fókusz")}<div class="card wheel-card">${wheelSvg(D)}</div></div>
        ${card(eyebrow("Ezen a héten — teendők", "gold") + `<div class="two">${weekly}</div>`, "gold")}
        ${card(`${eyebrow("Havi bevétel a küszöbökhöz képest")}
          <div class="incbar">
            <div style="left:${pct(THRESHOLDS.MID_LOW)}%;width:${pct(THRESHOLDS.MID_HIGH) - pct(THRESHOLDS.MID_LOW)}%;background:var(--c-gold-tint)"></div>
            <div style="left:0;width:${pct(D.totalIncome)}%;background:var(--c-green);opacity:.85"></div>
            <div style="left:${pct(THRESHOLDS.MIN)}%;width:2px;background:var(--c-danger)"></div>
            <div style="left:${pct(THRESHOLDS.BIG)}%;width:2px;background:var(--ink)"></div>
          </div>
          <div class="inc-legend font-data"><span>0</span><span>min. ${fmtHUF(THRESHOLDS.MIN)}</span><span>köztes ${fmtHUF(THRESHOLDS.MID_LOW)}–${fmtHUF(THRESHOLDS.MID_HIGH)}</span><span>nagy cél ${fmtHUF(THRESHOLDS.BIG)}</span></div>
          <div class="inc-total">Jelenlegi összeg: ${fmtHUF(D.totalIncome)}</div>`)}
        ${card(eyebrow("Mai állapot") + restDisplay(D.restToday))}
        ${D.mgs.achieved && D.mgDays !== null && D.mgDays < REMINDER_DELAY_DAYS ? card(`<div class="celebrate">${icon("party")} Ezt megcsináltad, élvezd ki.</div>`, null, 'style="background:var(--c-gold-tint);border-color:var(--c-gold)"') : ""}
        ${D.mgs.achieved && D.mgDays !== null && D.mgDays >= REMINDER_DELAY_DAYS ? card(`<p class="reminder">${esc(SKODA_REMINDER)}</p>`, null, 'style="background:var(--c-gold-tint);border-color:var(--c-gold)"') : ""}
      </div>`;
    },

    identity(D) {
      const ta = (f, rows, ph) => `<textarea class="bare-textarea" rows="${rows}" data-field="${f}" placeholder="${esc(ph)}">${esc(state[f])}</textarea>`;
      return `<div class="stack">
        ${card(eyebrow(icon("sparkle", "icon icon-sm") + " Döntés — nem cél, hanem állapot") + ta("identity", 3, "Az az ember vagyok, aki…"))}
        ${card(eyebrow("Nagy cél") + ta("bigGoal", 5, "A nagy cél leírása…"))}
        ${card(eyebrow("Köztes cél", "gold") + ta("mediumGoal", 4, "A köztes cél leírása…") + `
          <div class="card-foot">${!D.mgs.achieved
            ? `<button class="btn btn-gold" data-act="mgDone">${icon("check", "icon icon-sm")} Elértem a köztes célt</button>`
            : `<div class="between"><span class="small">Elérve: ${fmtDate(D.mgs.achievedDate)} (${D.mgDays} napja)</span><button class="link" data-act="mgUndo">Visszavonás</button></div>`}
          </div>`)}
      </div>`;
    },

    log(D) {
      const picker = Object.entries(REST).map(([k, r]) => `
        <button class="rest-btn${D.restToday === k ? " active" : ""}" data-act="rest" data-v="${k}" style="--c:var(--c-${r.c});--t:var(--c-${r.c}-tint);--x:var(--c-${r.c}-text)">${icon(r.icon, "icon icon-sm")} ${r.label}</button>`).join("");
      // Kiértékelő-kiegészítés: az elmúlt 4 hét egy pillantásra.
      const days = [];
      for (let i = 27; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(ymd(d)); }
      const counts = { pihenes: 0, dolgoztam: 0, menekules: 0 };
      const dots = days.map((d) => {
        const v = state.restLogs[d]; if (v) counts[v]++;
        return `<span class="dot" title="${fmtDate(d)}${v ? " — " + REST[v].label : ""}" style="background:${v ? `var(--c-${REST[v].c})` : "var(--surface-2)"}"></span>`;
      }).join("");
      const legend = Object.entries(REST).map(([k, r]) => `<span><i style="background:var(--c-${r.c})"></i>${r.label}: <b class="font-data">${counts[k]}</b></span>`).join("");
      return `<div class="stack">
        ${card(eyebrow("Ma pihentél, dolgoztál, vagy csak menekültél?", "gold") + `<div class="rest-row">${picker}</div>`)}
        ${card(eyebrow("Az elmúlt 4 hét") + `<div class="dots">${dots}</div><div class="legend">${legend}</div>`)}
      </div>`;
    },

    paths() {
      const wishes = state.wishlist.length ? state.wishlist.map((w) => `
        <div class="wish${w.done ? " done" : ""}" data-id="${w.id}">
          <button class="grip" data-drag="wish" aria-label="Áthelyezés (húzd, vagy fel/le nyíl)">${icon("grip", "icon")}</button>
          <button class="box" data-act="wishToggle" data-id="${w.id}" aria-label="Kész" aria-pressed="${w.done}">${w.done ? icon("check", "icon icon-sm") : ""}</button>
          <input value="${esc(w.text)}" data-wish="${w.id}" aria-label="Tétel szövege">
          <label class="price"><input type="number" inputmode="decimal" min="0" step="any" class="font-data" data-wish-price="${w.id}" value="${w.price ?? ""}" placeholder="0" aria-label="Összeg (ezer Ft)"><span>k</span></label>
          <button class="icon-btn" data-act="wishDel" data-id="${w.id}" aria-label="Törlés">${icon("trash", "icon icon-sm")}</button>
        </div>`).join("") : `<div class="empty">Még nincs tétel a listán.</div>`;
      return `<div class="stack">
        ${card(eyebrow("Vásárlási lista", "blue") + `<p class="desc">Ruhák, cipők, asztal, csuklótáska… nem sürgős, de a terv része. Pipálható és szerkeszthető, máshoz nem kapcsolódik.</p>
          <div class="stack tight wish-list">${wishes}</div><div id="wishTotal">${wishTotalHtml()}</div>${addRow("wish", "új tétel… (pl. téli cipő)", "blue")}`, "blue")}
        ${card(eyebrow("Nagyobb célok lebontása", "purple") + `<p class="desc">Ide írd le, hogyan bontod le a nagy és köztes célt konkrét, sorban követhető lépésekre.</p>
          <textarea class="field-input" rows="6" data-field="bigGoalsBreakdown" placeholder="pl. 1) diploma megszerzése → 2) projektvezetői váltás → 3) …">${esc(state.bigGoalsBreakdown)}</textarea>`, "purple")}
        ${card(eyebrow("Havi bevétel bevitele") + `<div class="two">
          <label class="lbl">Mérnöki (Ft)<input type="number" class="field-input font-data" data-field="income.mernoki" value="${esc(state.income.mernoki)}"></label>
          <label class="lbl">Ingatlanpiaci (Ft)<input type="number" class="field-input font-data" data-field="income.ingatlanpiaci" value="${esc(state.income.ingatlanpiaci)}"></label></div>`)}
      </div>`;
    },

    balance(D) {
      const health = state.health.items.map((it) => `
        <div class="tile" style="--c:var(--c-red);--t:var(--c-red-tint);--x:var(--c-red-text)">
          <div class="between top"><div class="tile-text">${esc(it.label)}</div><button class="icon-btn" data-act="healthDel" data-id="${it.id}" aria-label="Törlés">${icon("trash", "icon icon-sm")}</button></div>
          <div class="between tile-foot"><span class="small">${it.lastAddressed ? `Utoljára foglalkoztál vele: ${fmtDate(it.lastAddressed)} (${daysSince(it.lastAddressed)} napja)` : "Még nincs jelölve, hogy foglalkoztál vele"}</span>
          <button class="chip" data-act="healthDone" data-id="${it.id}">Most foglalkoztam vele</button></div>
        </div>`).join("");
      const presence = state.presence.items.map((it) => `
        <div class="tile row" style="--c:var(--c-blue);--t:var(--c-blue-tint);--x:var(--c-blue-text)">
          <span class="bullet"></span><div class="tile-text">${esc(it.label)}</div>
          <button class="icon-btn" data-act="presDel" data-id="${it.id}" aria-label="Törlés">${icon("trash", "icon icon-sm")}</button>
        </div>`).join("");
      const rel = [["tars", "Társ — tettem valamit, ami közelebb visz egy olyan körhöz, ahol találhatok"], ["uzlettars", "Üzlettárs — tettem valamit, ami közelebb visz egy motiváló, húzó társhoz"]]
        .map(([k, l]) => `<button class="relbtn${D.relEntry[k] ? " on" : ""}" data-act="rel" data-v="${k}"><span class="radio">${D.relEntry[k] ? icon("check", "icon icon-sm") : ""}</span><span>${l}</span></button>`).join("");
      const suggest = D.relSuggest ? `<div class="tile" style="--c:var(--c-purple);--t:var(--c-purple-tint);--x:var(--c-purple-text);margin-bottom:14px">
          <div class="suggest-h">${icon("bell", "icon icon-sm")} Itt az idő a napi követésre váltani</div>
          <p class="tile-text">${D.relDays} napja heti szinten követed ezt — a korábban jelzett 2-3 hónap letelt. Válts napira, vagy halaszd el még 2 hétre.</p>
          <div class="add-row"><button class="btn" style="background:var(--c-purple);color:#fff" data-act="relSwitch">Váltás napira</button><button class="btn btn-ghost" data-act="relSnooze">Még 2 hetet</button></div>
        </div>` : "";
      return `<div class="stack">
        ${card(eyebrow(icon("heart", "icon icon-sm") + " Test & egészség", "red") + `<p class="desc">Nem ütemezett feladatok — csak addig maradnak itt, amíg foglalkozol velük. Nincs határidő, csak nyitva-tartás.</p>
          <div class="stack tight">${health || `<div class="empty">Még nincs terület.</div>`}</div>${addRow("health", "új terület hozzáadása…", "red")}`, "red")}
        ${card(eyebrow(icon("sun", "icon icon-sm") + " Jelenlét & élmény", "blue") + `<p class="desc">Ezeket nem lehet ütemezni vagy kipipálni — csak szem előtt kell tartani. Nincs „kész” állapotuk.</p>
          <div class="stack tight">${presence || `<div class="empty">Még nincs elv.</div>`}</div>${addRow("presence", "új elv/emlékeztető hozzáadása…", "blue")}`, "blue")}
        ${card(eyebrow(icon("users", "icon icon-sm") + " Kapcsolatok — környezet-alakítás", "purple") + `<p class="desc">Nem a végeredmény (lesz-e kapcsolat), hanem a bemenet trackelhető: tettél-e valamit, ami olyan körbe visz, ahol nagyobb eséllyel találsz társat vagy üzlettársat.</p>
          ${suggest}<div class="kicker">${D.rel.mode === "weekly" ? "Ezen a héten" : "Ma"}</div><div class="stack tight">${rel}</div>
          <div class="small" style="margin-top:12px">Jelenlegi mód: ${D.rel.mode === "weekly" ? "heti" : "napi"} követés · ${D.relDays} napja fut</div>`, "purple")}
      </div>`;
    },

    ideas() {
      const st = [["parkolva", "Parkolva"], ["kovetem", "Követem"], ["elengedve", "Elengedve"]];
      const list = state.ideas.length ? state.ideas.map((i) => `
        <div class="tile" style="--c:var(--c-gold);--t:var(--c-gold-tint);--x:var(--ink)">
          <div class="between top"><div class="tile-text">${esc(i.text)}</div><button class="icon-btn" data-act="ideaDel" data-id="${i.id}" aria-label="Törlés">${icon("trash", "icon icon-sm")}</button></div>
          <div class="between tile-foot"><span class="small font-data">${fmtDate(i.date)}</span>
          <div class="pills">${st.map(([v, l]) => `<button class="pill${i.status === v ? " on" : ""}" data-act="ideaStatus" data-id="${i.id}" data-v="${v}">${l}</button>`).join("")}</div></div>
        </div>`).join("") : `<div class="empty">Még nincs rögzített ötlet.</div>`;
      return `<div class="stack">${card(eyebrow(icon("bulb", "icon icon-sm") + " Ötletláda — parkoló", "gold") + `<p class="desc">Ide kerül minden mellékirányú ötlet, amit még nem kell eldönteni — csak rögzíteni, dátummal. Később, elég adat vagy tapasztalat birtokában visszanézhető és értékelhető. Ez a védelmi funkció az irányváltogatós minta ellen: az impulzus ne azonnal új irányba vigyen, hanem ide, parkolóba.</p>
        ${addRow("idea", "új ötlet rögzítése… (pl. BIM/Revit-edukáció kiszervezése)", "gold")}<div class="stack tight" style="margin-top:16px">${list}</div>`, "gold")}</div>`;
    },

    notes() {
      const all = [...items.values()];
      const bad = all.filter((i) => i.error).length;
      const cols = BLOCKS.map((b) => {
        const live = all.filter((i) => !i.error && !i.deleted && i.block === b.k);
        const key = (i) => i.order ?? -i.updatedAt; // ugyanaz a sorrend, mint a telefonon
        const open = live.filter((i) => !i.done).sort((x, y) => key(x) - key(y));
        const done = live.filter((i) => i.done).sort((x, y) => y.updatedAt - x.updatedAt);
        const row = (i) => `<div class="note-row${i.done ? " done" : ""}"><span class="box">${i.done ? icon("check", "icon icon-sm") : ""}</span><span class="note-t">${esc(i.text)}</span><time class="font-data">${fmtStamp(i.updatedAt)}</time></div>`;
        return `<div class="block" style="--c:var(--c-${b.c});--t:var(--c-${b.c}-tint)">
          <div class="block-h"><span>${b.label}</span><span class="font-data">${open.length} nyitott</span></div>
          <div class="block-b">${open.length ? open.map(row).join("") : `<div class="empty">Nincs nyitott tétel.</div>`}${jegyzetDone ? done.map(row).join("") : ""}</div>
        </div>`;
      }).join("");
      return `<div class="stack">
        <p class="desc">A telefonos lista tételei, visszafejtve. Itt csak olvashatók — szerkeszteni a telefonon lehet. Élőben frissül.</p>
        <label class="chk"><input type="checkbox" data-act="toggleDone" ${jegyzetDone ? "checked" : ""}> Kész tételek mutatása</label>
        ${bad ? `<p class="bad">${bad} tételt nem sikerült visszafejteni.</p>` : ""}
        ${cols}
      </div>`;
    },
  };

  function render() {
    if (!state) return;
    const D = derived();
    const bg = D.restToday === "pihenes" ? "var(--bg-rest)" : D.restToday === "dolgoztam" ? "var(--bg-work)" : D.restToday === "menekules" ? "var(--bg-flee)" : "";
    document.body.style.backgroundColor = bg;
    $("#tabs").innerHTML = TABS.map((t) => `<button class="tab-btn${tab === t.k ? " active" : ""}" data-act="go" data-v="${t.k}">${icon(t.icon, "icon icon-sm")} ${t.label}</button>`).join("");
    const active = document.activeElement;
    const focusKey = active && (active.dataset.field || active.dataset.addInput || active.dataset.wish);
    const pos = focusKey && active.selectionStart;
    $("#view").innerHTML = VIEWS[tab](D);
    $("#importBtn").parentElement.hidden = !!state.importedAt; // egyszeri: átvétel után eltűnik
    if (focusKey) {
      const n = $(`[data-field="${focusKey}"],[data-add-input="${focusKey}"],[data-wish="${focusKey}"]`);
      if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
    }
    renderTiming();
  }
  function renderTiming() {
    const p = [];
    if (timing.unlock) p.push("Feloldás: " + timing.unlock);
    if (timing.state) p.push("Állapot: " + timing.state);
    if (timing.items) p.push("Jegyzet: " + timing.items);
    $("#timing").textContent = p.join(" · ");
  }

  // ---------- események (egy helyen, delegálva) ----------
  function addTo(list, text) {
    const v = text.trim();
    if (!v) return;
    mutate((s) => {
      if (list === "wish") s.wishlist.push({ id: newId(), text: v, done: false });
      if (list === "health") s.health.items.push({ id: newId(), label: v, lastAddressed: null });
      if (list === "presence") s.presence.items.push({ id: newId(), label: v });
      if (list === "idea") s.ideas.unshift({ id: newId(), text: v, date: todayStr(), status: "parkolva" });
    });
    const n = $(`[data-add-input="${list}"]`); if (n) n.focus();
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !state) return;
    const { act, v, id } = b.dataset;
    const byId = (arr) => arr.find((x) => x.id === id);
    switch (act) {
      case "go": tab = v; try { localStorage.setItem(TAB_KEY, v); } catch {} render(); window.scrollTo(0, 0); break;
      case "toggleDone": jegyzetDone = b.checked; render(); break;
      case "add": addTo(b.dataset.list, $(`[data-add-input="${b.dataset.list}"]`).value); break;
      case "rest": mutate((s) => { s.restLogs[todayStr()] = v; }); break;
      case "mgDone": mutate((s) => { s.mediumGoalStatus = { achieved: true, achievedDate: todayStr() }; }); break;
      case "mgUndo": mutate((s) => { s.mediumGoalStatus = { achieved: false, achievedDate: null }; }); break;
      case "wishToggle": mutate((s) => { const w = byId(s.wishlist); w.done = !w.done; }); break;
      case "wishDel": mutate((s) => { s.wishlist = s.wishlist.filter((x) => x.id !== id); }); break;
      case "healthDone": mutate((s) => { byId(s.health.items).lastAddressed = todayStr(); }); break;
      case "healthDel": if (confirm("Törlöd ezt a területet?")) mutate((s) => { s.health.items = s.health.items.filter((x) => x.id !== id); }); break;
      case "presDel": if (confirm("Törlöd ezt az elvet?")) mutate((s) => { s.presence.items = s.presence.items.filter((x) => x.id !== id); }); break;
      case "ideaStatus": mutate((s) => { byId(s.ideas).status = v; }); break;
      case "ideaDel": if (confirm("Törlöd ezt az ötletet?")) mutate((s) => { s.ideas = s.ideas.filter((x) => x.id !== id); }); break;
      case "rel": mutate((s) => {
        const r = s.relationships, bucket = r.mode === "weekly" ? r.weekly : r.daily, k = r.mode === "weekly" ? weekKey() : todayStr();
        const entry = bucket[k] || { tars: false, uzlettars: false };
        bucket[k] = { ...entry, [v]: !entry[v] };
      }); break;
      case "relSwitch": mutate((s) => { s.relationships.mode = "daily"; }); flash("Átváltva napi check-inre."); break;
      case "relSnooze": mutate((s) => { s.relationships.switchAfterDays += 14; }); flash("Elhalasztva még 2 hétre."); break;
    }
  });

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!state) return;
    if (t.dataset.field) {
      const path = t.dataset.field.split(".");
      mutate((s) => {
        let cur = s;
        for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
        cur[path.at(-1)] = t.type === "number" ? (t.value === "" ? 0 : Number(t.value)) : t.value;
      }, false);
    } else if (t.dataset.wish) {
      mutate((s) => { const w = s.wishlist.find((x) => x.id === t.dataset.wish); if (w) w.text = t.value; }, false);
    } else if (t.dataset.wishPrice) {
      mutate((s) => { const w = s.wishlist.find((x) => x.id === t.dataset.wishPrice); if (w) w.price = t.value === "" ? null : Math.max(0, Number(t.value)); }, false);
      $("#wishTotal").innerHTML = wishTotalHtml();
    }
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && t.dataset && t.dataset.addInput) { e.preventDefault(); addTo(t.dataset.addInput, t.value); }
  });

  // ---------- átrendezés (vásárlási lista) ----------
  // Húzáskor a kártya az egeret/ujjat követi, a többi kártya finoman félrecsúszik a helyéről,
  // elengedéskor a kártya a helyére siklik, és csak utána mentünk. Billentyűvel: fogantyú + ↑/↓.
  const SETTLE_MS = 180;
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function saveWishOrder(ids, focusId) {
    mutate((s) => { const byId = new Map(s.wishlist.map((w) => [w.id, w])); s.wishlist = ids.map((id) => byId.get(id)).filter(Boolean); });
    const g = $(`.wish[data-id="${focusId}"] .grip`); if (g) g.focus();
  }

  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    const h = e.target.closest("[data-drag]");
    if (!h || !state || drag) return;
    e.preventDefault();
    try { h.setPointerCapture(e.pointerId); } catch {}
    const row = h.closest(".wish");
    const rows = [...row.parentElement.querySelectorAll(".wish")];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const from = rows.indexOf(row);
    const gap = rows.length > 1 ? rects[1].top - rects[0].bottom : 0;
    drag = { row, rows, rects, from, to: from, step: rects[from].height + gap, startY: e.clientY, dy: 0 };
    row.classList.add("dragging");
    rows.forEach((r) => { if (r !== row) r.classList.add("shifting"); });
    document.body.classList.add("is-dragging");
  });

  document.addEventListener("pointermove", (e) => {
    if (!drag || drag.settling) return;
    const { row, rows, rects, from, step } = drag;
    // A kártya nem húzható ki a lista tetejénél/aljánál messzebbre.
    const min = rects[0].top - rects[from].top, max = rects.at(-1).bottom - rects[from].bottom;
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
    const { row, rows, rects, from, to } = d;
    const offset = to > from ? rects[to].bottom - rects[from].bottom : to < from ? rects[to].top - rects[from].top : 0;
    row.classList.add("settling");
    row.style.transform = offset ? `translateY(${offset}px)` : "";
    const finish = () => {
      drag = null;
      document.body.classList.remove("is-dragging");
      if (to === from) {
        rows.forEach((r) => { r.classList.remove("dragging", "shifting", "settling"); r.style.transform = ""; });
        if (Math.abs(d.dy) < 3) row.querySelector(".grip").focus(); // csak kattintás volt: jöhetnek a nyilak
        return;
      }
      const ids = rows.map((r) => r.dataset.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      saveWishOrder(ids, row.dataset.id); // újrarajzol: a kártyák már a végleges helyükön vannak
    };
    if (reduceMotion()) finish(); else setTimeout(finish, SETTLE_MS);
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // Billentyű: a két kártya helyet cserél, egy rövid csúszó animációval.
  document.addEventListener("keydown", (e) => {
    const h = e.target.closest && e.target.closest("[data-drag]");
    if (!h || drag || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const rows = [...h.closest(".wish-list").querySelectorAll(".wish")];
    const row = h.closest(".wish"), from = rows.indexOf(row), to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= rows.length) return;
    const before = new Map(rows.map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
    const ids = rows.map((r) => r.dataset.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    saveWishOrder(ids, row.dataset.id);
    if (reduceMotion()) return;
    document.querySelectorAll(".wish-list .wish").forEach((r) => {
      const d = before.get(r.dataset.id) - r.getBoundingClientRect().top;
      if (!d) return;
      r.style.transform = `translateY(${d}px)`;
      r.getBoundingClientRect(); // a kiinduló helyzet rögzítése, hogy az átmenet elinduljon
      r.classList.add("settling");
      r.style.transform = "";
      setTimeout(() => r.classList.remove("settling"), SETTLE_MS);
    });
  });

  // ---------- helyi demó (csak localhost/#demo; nincs Firebase, nincs mentés) ----------
  if (DEMO) {
    state = clone(DEFAULT_STATE);
    state.relationships.startDate = todayStr();
    state.health.items = [{ id: "h1", label: "Térd — felülvizsgálat", lastAddressed: null }, { id: "h2", label: "Rendszeres testmozgás", lastAddressed: todayStr() }];
    state.presence.items = [{ id: "p1", label: "A pillanatok tényleges megélése" }];
    state.ideas = [{ id: "i1", text: "Példa ötlet", date: todayStr(), status: "parkolva" }];
    state.income = { mernoki: 450000, ingatlanpiaci: 120000 };
    state.wishlist = [{ id: "w1", text: "Első", done: false, price: 12 }, { id: "w2", text: "Második", done: true, price: 8 }, { id: "w3", text: "Harmadik", done: false }];
    const now = Date.now();
    [["mernoki", "Árajánlat", false], ["mernoki", "Terv átnézése", false], ["mernoki", "Kész dolog", true], ["ingatlanpiaci", "Hirdetés", false], ["maganeleti", "Bevásárlás", false]]
      .forEach(([block, text, done], i) => items.set("d" + i, { id: "d" + i, block, text, done, deleted: false, updatedAt: now - i * 3600000 }));
    show("app");
    $("#today").textContent = fmtDate(todayStr());
    setSaveStatus("Demó: nincs mentés");
    render();
    return;
  }

  // Asztali appként telepíthető (saját, gyorsítótár nélküli service worker).
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
