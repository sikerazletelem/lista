// Híd Kiértékelő: a Híd artifact laptopos, titkosított utódja.
//
// Adatok (Firestore, minden titkosítva a HidCrypto-val):
//   users/{uid}/meta/keys       -> { publicKey, keyfile }   (kulcs-beallitas.html hozza létre)
//   users/{uid}/meta/hidstate   -> { updatedAt, blob }      (a Kiértékelő saját állapota, csak ez írja)
//   users/{uid}/items/{id}      -> { updatedAt, blob }      (a telefonos lista tételei, itt csak olvassuk)
//   users/{uid}/days/{nap}      -> { updatedAt, blob }      (a telefonos napi „Ma” kártya, itt csak olvassuk)
//
// A napi kártya a laptopon is kitölthető (state.checkins). A kettőt kérdésenként
// összefésüljük: mindig a később módosított válasz számít (at: { mező: időbélyeg }).
//
// A privát kulcs és a visszafejtett adat alapból csak a memóriában él. Ha a feloldáskor
// bejelölöd a „ne kérje újra” opciót, a (nem exportálható) kulcs 30 napig ennek a
// böngészőnek az IndexedDB-jében marad; a Zárolás gomb ezt is törli.
(() => {
  const THRESHOLDS = { MIN: 500000, MID_LOW: 600000, MID_HIGH: 800000, BIG: 1000000 };
  const SCALE_MAX = 1300000;
  const REMINDER_DELAY_DAYS = 14;
  const RELATIONSHIP_SWITCH_DAYS = 70;
  // Telefonon (a böngészőben megnyitva) rövidebb a tétlenségi zár, és nincs „30 napig” megjegyzés.
  const IS_PHONE = window.matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 768;
  const IDLE_MIN = IS_PHONE ? 8 : 15;
  const IDLE_MS = IDLE_MIN * 60 * 1000;
  const REMEMBER_MS = 30 * 86400000;
  const TAB_KEY = "hid-kiert-tab";
  const INCOME_RESET_DAY = 5; // ekkor nullázódik a havi bevétel; az addigi összeg az előző hónapé
  const REPORT_DAY = 0, REPORT_HOUR = 16; // vasárnap 16:00
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
    // --- életirány-követés (2026-09) ---
    trackingStart: null,     // az első nap, amitől a heti anyagok készülnek
    incomeMonth: null,       // "ÉÉÉÉ-HH": melyik hónaphoz tartozik a mostani income
    incomeHistory: {},       // { "ÉÉÉÉ-HH": { mernoki, ingatlanpiaci } }
    plans: [],               // heti tervek, változásonként: [{ from, days, targets, socialDays }]
    checkins: {},            // laptopon kitöltött napi kártyák: { nap: { mező: érték, at: { mező: idő } } }
    reports: {},             // heti anyagok: { hétfő: { final, generatedAt, ... } }
    reportSeen: null,
    alerts: { healthDays: 30, idleWeeks: 2, relWeeks: 2 },
  };

  // A heti terv (a felhasználó megadása szerint, a Kiértékelőben átírható).
  const PLAN_DEFAULT = {
    days: {
      1: "Mérnöki / egyetem",
      2: "Street workout + tandem nyelv",
      3: "Ingatlanpiac",
      4: "Edzés + könnyed nyelv / pihenés",
      5: "Mérnöki vagy társas",
      6: "Kb. 6 óra projekt (diploma / mérnöki / ingatlan), este pihenés, társas",
      7: "Pihenés, társas",
    },
    targets: { mernoki: 2, ingatlanpiaci: 1, sport: 2, nyelv: 2, jelenlet: 2, tarsas: 2 },
    socialDays: [5, 6, 7],
  };
  const WEEKDAYS = { 1: "Hétfő", 2: "Kedd", 3: "Szerda", 4: "Csütörtök", 5: "Péntek", 6: "Szombat", 7: "Vasárnap" };

  // A kerék 6 szelete = a napi kártya terület-gombjai.
  const AREAS = {
    mernoki: { label: "Mérnöki", c: "green", icon: "route" },
    ingatlanpiaci: { label: "Ingatlan", c: "gold", icon: "sparkle" },
    sport: { label: "Sport", c: "red", icon: "dumbbell" },
    nyelv: { label: "Nyelv", c: "indigo", icon: "chat" },
    jelenlet: { label: "Jelenlét", c: "blue", icon: "sun" },
    tarsas: { label: "Társas", c: "purple", icon: "users" },
  };
  const PLAN_ANS = { igen: "igen", reszben: "részben", nem: "nem" };
  const TOOK = { tarsas: "társas", faradtsag: "fáradtság", tuloras: "túlóra", egyeb: "egyéb" };
  const IRANY = { igen: "igen, az irányomba", jolesett: "csak jólesett" };
  const COST = { ido: "idő", penz: "pénz", fokusz: "fókusz" };
  const CHECK_FIELDS = ["plan", "took", "energy", "areas", "rest", "irany", "cost"];

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
    dumbbell: '<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
    chat: '<path d="M4 5h16v11H10l-5 4v-4H4z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4.5M12 17v.1"/>',
    print: '<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6H7z"/>',
  };
  const icon = (n, cls = "icon") => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[n]}</svg>`;

  const REST = {
    pihenes: { c: "green", icon: "battery", label: "Feltöltődtem" },
    dolgoztam: { c: "gold", icon: "briefcase", label: "Dolgoztam" },
    menekules: { c: "danger", icon: "batteryLow", label: "Csak menekültem" },
  };

  const TABS = [
    { k: "overview", label: "Áttekintés", icon: "grid" },
    { k: "identity", label: "Ki vagyok", icon: "compass" },
    { k: "log", label: "Napi napló", icon: "pen" },
    { k: "weekly", label: "Heti", icon: "calendar" },
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
  const parseDay = (s) => new Date(s + "T00:00:00");
  const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); };
  const isoDow = (s) => { const g = parseDay(s).getDay(); return g === 0 ? 7 : g; }; // 1 = hétfő … 7 = vasárnap
  const weekDays = (monday) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
  const fmtShort = (s) => parseDay(s).toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
  // A bevétel hónapja: 5-e előtt még az előző hónaphoz folyik be.
  function incomeMonthKey(d = new Date()) {
    const m = new Date(d.getFullYear(), d.getMonth() - (d.getDate() < INCOME_RESET_DAY ? 1 : 0), 1);
    return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
  }
  const fmtMonth = (k) => new Date(k + "-01T00:00:00").toLocaleDateString("hu-HU", { year: "numeric", month: "long" });
  const round1 = (n) => Math.round(n * 10) / 10;
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
  let state = null, items = new Map(), phoneDays = new Map();
  let itemsLoaded = false, daysLoaded = false, logDay = null, reportWeek = null, planOpen = false;
  let unsubItems = null, unsubState = null, unsubDays = null, idleTimer = null, saveTimer = null, lastSavedAt = 0, savePromise = null;
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
    if (unsubDays) { unsubDays(); unsubDays = null; }
    clearTimeout(idleTimer);
    privateKey = null; state = null; items = new Map(); phoneDays = new Map(); remembered = false;
    itemsLoaded = false; daysLoaded = false;
    Object.keys(timing).forEach((k) => delete timing[k]);
    $("#view").replaceChildren();
    if (forget) await KeyStore.clear();
    if (user) { show("lock"); $("#encPw").focus(); }
  }
  $("#lockBtn").onclick = () => lock(true);

  function bumpIdle() {
    if (!privateKey || remembered) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => { await lock(false); say($("#unlockOut"), `${IDLE_MIN} perc tétlenség után automatikusan zárolva.`); }, IDLE_MS);
  }
  if (IS_PHONE) { $("#remember").checked = false; $("#remember").parentElement.hidden = true; }
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
        prepareState();
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
        if (prepareState()) scheduleSave();
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
      if (first) { timing.items = `${changes.length} tétel: ${ms(t0)} (ebből visszafejtés ${ms(tDec)})`; first = false; itemsLoaded = true; }
      if (state && !isTyping() && (tab === "overview" || tab === "notes" || tab === "weekly")) render();
      renderTiming();
    }, () => {});

    // A telefonos napi kártyák (csak olvassuk; a telefon írja őket).
    unsubDays = userRef().collection("days").onSnapshot(async (snap) => {
      if (key !== privateKey) return;
      await Promise.all(snap.docChanges().map(async (ch) => {
        const id = ch.doc.id;
        if (ch.type === "removed") return phoneDays.delete(id);
        try { phoneDays.set(id, await HidCrypto.decryptItem(key, ch.doc.data().blob)); } catch { /* sérült bejegyzés: kihagyjuk */ }
      }));
      if (key !== privateKey) return;
      daysLoaded = true;
      if (state && !isTyping()) render();
    }, () => { daysLoaded = true; });
  }
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox")); };

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
  // ---------- előkészítés: új mezők, bevétel-hónap váltás ----------
  // Igazat ad vissza, ha változtatott valamin (akkor menteni kell).
  function prepareState() {
    let changed = false;
    if (!state.trackingStart) { state.trackingStart = todayStr(); changed = true; }
    if (!state.plans.length) { state.plans = [{ from: weekKey(parseDay(state.trackingStart)), ...clone(PLAN_DEFAULT) }]; changed = true; }
    const m = incomeMonthKey();
    if (!state.incomeMonth) { state.incomeMonth = m; changed = true; }
    else if (state.incomeMonth !== m) {
      // Hónapváltás (5-én): az eddigi összeg az előző hónaphoz kerül, a mező nullázódik.
      state.incomeHistory[state.incomeMonth] = { mernoki: Number(state.income.mernoki) || 0, ingatlanpiaci: Number(state.income.ingatlanpiaci) || 0 };
      state.income = { mernoki: 0, ingatlanpiaci: 0 };
      state.incomeMonth = m;
      changed = true;
    }
    return changed;
  }

  // ---------- napi kártya: a telefonos és a laptopos bejegyzés összefésülése ----------
  function planFor(day) {
    let p = state.plans[0];
    for (const x of state.plans) if (x.from <= day) p = x;
    return p || { from: day, ...PLAN_DEFAULT };
  }
  function checkin(day) {
    const out = {}, at = {};
    const lap = state.checkins[day], ph = phoneDays.get(day);
    for (const f of CHECK_FIELDS) {
      const lt = lap && lap.at && lap.at[f] != null ? lap.at[f] : -1;
      const pt = ph && ph.at && ph.at[f] != null ? ph.at[f] : -1;
      if (lt < 0 && pt < 0) continue;
      out[f] = (pt > lt ? ph : lap)[f];
      at[f] = Math.max(lt, pt);
    }
    if (at.rest == null && state.restLogs[day]) out.rest = state.restLogs[day]; // a régi Napi napló bejegyzései
    return out;
  }
  const isFilled = (ci) => CHECK_FIELDS.some((f) => ci[f] != null && !(Array.isArray(ci[f]) && !ci[f].length));
  function dayAreas(ci) {
    const s = new Set(ci.areas || []);
    if (ci.rest === "pihenes") s.add("jelenlet"); // a feltöltődős nap a Jelenlétbe számít
    return s;
  }
  const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

  function statsFor(days) {
    const areas = Object.fromEntries(Object.keys(AREAS).map((k) => [k, 0]));
    const plan = { igen: 0, reszben: 0, nem: 0 }, took = [], rest = { pihenes: 0, dolgoztam: 0, menekules: 0 }, energy = [];
    const social = { n: 0, offPlan: 0, irany: { igen: 0, jolesett: 0 }, cost: { ido: 0, penz: 0, fokusz: 0 } };
    let filled = 0;
    for (const d of days) {
      const ci = checkin(d);
      if (isFilled(ci)) filled++;
      dayAreas(ci).forEach((k) => { if (k in areas) areas[k]++; });
      if (ci.plan in plan) plan[ci.plan]++;
      if (ci.plan === "reszben" || ci.plan === "nem") took.push({ day: d, plan: ci.plan, reasons: ci.took || [] });
      if (ci.rest in rest) rest[ci.rest]++;
      energy.push(typeof ci.energy === "number" ? ci.energy : null);
      if ((ci.areas || []).includes("tarsas")) {
        social.n++;
        if (!planFor(d).socialDays.includes(isoDow(d))) social.offPlan++;
        if (ci.irany in social.irany) social.irany[ci.irany]++;
        (ci.cost || []).forEach((c) => { if (c in social.cost) social.cost[c]++; });
      }
    }
    const ev = energy.filter((x) => x != null);
    return { areas, plan, took, rest, energy, energyAvg: ev.length ? ev.reduce((a, b) => a + b, 0) / ev.length : null, social, filled };
  }

  // ---------- heti anyag ----------
  // Egy hét anyaga vasárnap 16:00-tól „előzetes” (éjfélig frissül), hétfőtől végleges.
  function reportDue(monday) {
    const sunday = addDays(monday, 6), today = todayStr();
    if (today > sunday) return "final";
    if (today === sunday && new Date().getHours() >= REPORT_HOUR) return "draft";
    return null;
  }
  function ensureReports() {
    if (!state || !state.trackingStart || !daysLoaded || !itemsLoaded) return false;
    let changed = false;
    const cur = weekKey();
    let w = weekKey(parseDay(state.trackingStart));
    for (let guard = 0; w <= cur && guard < 200; guard++, w = addDays(w, 7)) {
      const due = reportDue(w), old = state.reports[w];
      if (!due || (old && old.final)) continue;
      const nr = buildReport(w, due === "final");
      if (!old || JSON.stringify({ ...old, generatedAt: 0 }) !== JSON.stringify({ ...nr, generatedAt: 0 })) { state.reports[w] = nr; changed = true; }
    }
    return changed;
  }
  function buildReport(monday, final) {
    const days = weekDays(monday), sunday = days[6];
    const plan = planFor(monday);
    const A = Object.fromEntries(Object.entries(state.alerts).map(([k, v]) => [k, Math.max(1, Number(v) || 1)]));
    const st = statsFor(days);
    const prev = [1, 2, 3].map((i) => addDays(monday, -7 * i)).filter((w) => addDays(w, 6) >= state.trackingStart)
      .map((w) => statsFor(weekDays(w)).energyAvg).filter((x) => x != null);
    const energyPrev = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const alerts = [], ok = [];

    // A hat terület a heti tervhez képest (és ha hetek óta semmi nem jutott rá).
    const span = A.idleWeeks * 7;
    const idleWindow = Array.from({ length: span }, (_, i) => addDays(sunday, -i));
    const idleKnown = idleWindow.every((d) => d >= state.trackingStart);
    for (const [k, a] of Object.entries(AREAS)) {
      const n = st.areas[k], t = plan.targets[k] || 0;
      if (!t) continue;
      if (idleKnown && idleWindow.every((d) => !dayAreas(checkin(d)).has(k))) alerts.push(`${a.label}: ${A.idleWeeks} hete nem jutott rá idő.`);
      else if (n < t) alerts.push(`${a.label}: ${n} alkalom, a terv ${t}.`);
      else ok.push(a.label);
    }
    // Egészség: régóta nem foglalkoztál vele.
    for (const h of state.health.items) {
      if (!h.lastAddressed) alerts.push(`Egészség, „${h.label}”: még nincs jelölve, hogy foglalkoztál vele.`);
      else if (daysBetween(h.lastAddressed, sunday) >= A.healthDays) alerts.push(`Egészség, „${h.label}”: ${daysBetween(h.lastAddressed, sunday)} napja nem foglalkoztál vele.`);
    }
    // Telefonos listák: nyitott tételek, amikhez hetek óta nem nyúltál.
    for (const b of BLOCKS.filter((x) => x.k !== "maganeleti")) {
      const list = [...items.values()].filter((i) => !i.error && !i.deleted && i.block === b.k);
      const open = list.filter((i) => !i.done).length, last = Math.max(0, ...list.map((i) => i.updatedAt || 0));
      if (open && Date.now() - last >= span * 86400000) alerts.push(`${b.label} lista: ${open} nyitott tétel, ${A.idleWeeks} hete egyikhez sem nyúltál.`);
    }
    // Kapcsolatok: lépés a társ vagy üzlettárs felé.
    const rel = state.relationships;
    let lastStep = null;
    const note = (d, e) => { if (e && (e.tars || e.uzlettars) && (!lastStep || d > lastStep)) lastStep = d; };
    Object.entries(rel.weekly).forEach(([wk, e]) => note(wk, e));
    Object.entries(rel.daily).forEach(([d, e]) => note(d, e));
    const relSpan = A.relWeeks * 7;
    if (daysBetween(rel.startDate || state.trackingStart, sunday) >= relSpan && (!lastStep || daysBetween(lastStep, sunday) >= relSpan))
      alerts.push(`Kapcsolatok: ${A.relWeeks} hete nem volt lépés a társ vagy üzlettárs felé.`);
    // Energia és napi állapot.
    if (st.energyAvg != null && energyPrev != null && energyPrev - st.energyAvg >= 0.5)
      alerts.push(`Energia: csökken (az előző hetek átlaga ${round1(energyPrev)}, most ${round1(st.energyAvg)}).`);
    if (st.rest.menekules >= 3) alerts.push(`Napi állapot: ${st.rest.menekules} napon „csak menekültem”.`);

    const month = incomeMonthKey(parseDay(sunday));
    const inc = month === state.incomeMonth ? state.income : state.incomeHistory[month];
    const income = { month, open: month === state.incomeMonth, total: inc ? (Number(inc.mernoki) || 0) + (Number(inc.ingatlanpiaci) || 0) : null };
    return { final, generatedAt: Date.now(), week: monday, planDays: plan.days, targets: plan.targets, ...st, energyPrev, income, alerts, ok };
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
    // A kerék: az elmúlt 7 nap a mai terv céljaihoz képest.
    const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
    const week7 = statsFor(last7);
    const mgs = state.mediumGoalStatus;
    const mgDays = mgs.achieved ? daysSince(mgs.achievedDate) : null;
    return { rel, relWeek, relToday, relEntry, relDays, relSuggest, relChecked, mern, ingat, mgs, mgDays,
      week7, targets: planFor(today).targets,
      restToday: checkin(today).rest,
      totalIncome: (Number(state.income.mernoki) || 0) + (Number(state.income.ingatlanpiaci) || 0) };
  }

  // ---------- nézetek ----------
  const eyebrow = (text, c = "green") => `<div class="eyebrow" style="color:var(--c-${c})"><span class="rule" style="background:var(--c-${c})"></span>${text}</div>`;
  const card = (inner, accent, extra = "") => `<div class="card" ${extra}>${accent ? `<div class="accent-bar" style="background:var(--c-${accent})"></div>` : ""}${inner}</div>`;
  const addRow = (list, placeholder, c) => `<div class="add-row"><input class="field-input" data-add-input="${list}" placeholder="${esc(placeholder)}"><button class="btn" style="background:var(--c-${c});color:#fff" data-act="add" data-list="${list}" aria-label="Hozzáadás">${icon("plus", "icon icon-sm")}</button></div>`;

  // Minél nagyobb a szelet, annál többet kapott a terület az elmúlt 7 napban. A szaggatott kör a
  // heti terv (100%); ami azon túllóg, az több a tervezettnél (másik árnyalat, legfeljebb 150%).
  function wheelSvg(D) {
    const keys = Object.keys(AREAS);
    const cx = 400, cy = 300, innerR = 58, targetR = 150, gap = 5, step = 360 / keys.length;
    const rFor = (ratio) => innerR + (targetR - innerR) * Math.min(ratio, 1.5);
    const maxR = rFor(1.5);
    const pt = (r, a) => { const rad = (a * Math.PI) / 180; return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }; };
    const wedge = (r0, r, a1, a2) => {
      const p1 = pt(r0, a1), p2 = pt(r, a1), p3 = pt(r, a2), p4 = pt(r0, a2);
      return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${r} ${r} 0 0 1 ${p3.x} ${p3.y} L ${p4.x} ${p4.y} A ${r0} ${r0} 0 0 0 ${p1.x} ${p1.y} Z`;
    };
    let s = `<svg class="wheel" viewBox="0 0 800 600" role="img" aria-label="Élet-kerék: az elmúlt 7 nap a heti tervhez képest">`;
    s += `<circle cx="${cx}" cy="${cy}" r="${rFor(0.5)}" fill="none" stroke="var(--border)"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="${maxR}" fill="none" stroke="var(--border)"/>`;
    keys.forEach((k, i) => {
      const d = AREAS[k], n = D.week7.areas[k], t = D.targets[k] || 0;
      const ratio = t ? n / t : n ? 1 + 0.25 * n : 0;
      const a = -90 + i * step, a1 = a - step / 2 + gap / 2, a2 = a + step / 2 - gap / 2;
      const r = rFor(ratio), ip = pt(innerR + 24, a), lp = pt(maxR + 30, a);
      const cos = Math.cos((a * Math.PI) / 180);
      const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
      const ly = lp.y + (Math.abs(cos) < 0.2 ? (lp.y < cy ? -14 : 6) : -6);
      s += `<g class="wedge" data-act="go" data-v="log">
        <path d="${wedge(innerR, targetR, a1, a2)}" fill="none" stroke="var(--c-${d.c})" stroke-opacity=".35" stroke-dasharray="3 4"/>
        ${n ? `<path d="${wedge(innerR, Math.min(r, targetR), a1, a2)}" fill="var(--c-${d.c}-tint)" stroke="var(--c-${d.c})" stroke-width="1.8"/>` : ""}
        ${r > targetR ? `<path d="${wedge(targetR, r, a1, a2)}" fill="var(--c-${d.c})" fill-opacity=".45" stroke="var(--c-${d.c})" stroke-width="1.8"/>` : ""}
        <circle cx="${ip.x}" cy="${ip.y}" r="16" fill="var(--c-${d.c}-tint)"/>
        <svg x="${ip.x - 8}" y="${ip.y - 8}" width="16" height="16" viewBox="0 0 24 24" class="icon" style="color:var(--c-${d.c})">${ICONS[d.icon]}</svg>
        <text x="${lp.x}" y="${ly}" text-anchor="${anchor}" class="wl">${esc(d.label)}</text>
        <text x="${lp.x}" y="${ly + 21}" text-anchor="${anchor}" class="ws font-data" style="fill:var(--c-${d.c})">${n} / ${t}</text>
      </g>`;
    });
    s += `<circle cx="${cx}" cy="${cy}" r="${targetR}" fill="none" stroke="var(--ink)" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="6 5" pointer-events="none"/>
      <circle cx="${cx}" cy="${cy}" r="${innerR - 6}" fill="var(--ink)"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="17" fill="var(--bg)" font-style="italic" class="font-display">7 nap</text>
      <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--faint)" class="font-data">${addDays(todayStr(), -6).slice(5).replace("-", ".")}–${todayStr().slice(5).replace("-", ".")}</text></svg>`;
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

  function incomeHistoryHtml() {
    const rows = Object.entries(state.incomeHistory).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    if (!rows.length) return "";
    return `<div class="kicker" style="margin-top:16px">Korábbi hónapok</div><div class="inc-hist">${rows.map(([m, v]) => {
      const t = (Number(v.mernoki) || 0) + (Number(v.ingatlanpiaci) || 0);
      return `<div class="between"><span>${fmtMonth(m)}</span><span class="font-data">${fmtHUF(t)} <span class="small">(mérnöki ${fmtHUF(v.mernoki)} · ingatlan ${fmtHUF(v.ingatlanpiaci)})</span></span></div>`;
    }).join("")}</div>`;
  }

  const weekRange = (monday) => `${fmtShort(monday)} – ${fmtShort(addDays(monday, 6))}`;
  const latestReport = () => Object.values(state.reports).sort((a, b) => (a.week < b.week ? 1 : -1))[0] || null;
  function incomeLevel(n) {
    if (n < THRESHOLDS.MIN) return `a minimum (${fmtHUF(THRESHOLDS.MIN)}) alatt`;
    if (n < THRESHOLDS.MID_LOW) return "a minimum felett, a köztes sáv alatt";
    if (n <= THRESHOLDS.MID_HIGH) return "a köztes sávban";
    if (n < THRESHOLDS.BIG) return "a köztes sáv felett";
    return "elérte a nagy célt";
  }

  function reportHtml(r) {
    const sec = (title, body, c = "green") => `<section class="r-sec">${eyebrow(title, c)}${body}</section>`;
    const areaRows = Object.entries(AREAS).map(([k, a]) => {
      const n = r.areas[k] || 0, t = r.targets[k] || 0;
      const w = t ? (Math.min(n / t, 1.5) / 1.5) * 100 : n ? 100 : 0;
      return `<div class="r-area"><span class="r-al">${a.label}</span><span class="r-bar"><i style="width:${w}%;background:var(--c-${a.c})"></i><b style="left:${100 / 1.5}%"></b></span><span class="font-data r-n">${n} / ${t}</span></div>`;
    }).join("");
    const p = r.plan, s = r.social;
    const took = r.took.length
      ? `<ul class="r-list">${r.took.map((x) => `<li>${WEEKDAYS[isoDow(x.day)]}: ${PLAN_ANS[x.plan]}${x.reasons.length ? " — " + x.reasons.map((k) => TOOK[k]).join(", ") : ""}</li>`).join("")}</ul>` : "";
    const dayLetters = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
    const ebars = r.energy.map((e, i) => `<div class="r-eday"><span class="ebar big"><i style="height:${(e || 0) * 20}%"></i></span><span class="small font-data">${e ?? "–"}</span><span class="small">${dayLetters[i]}</span></div>`).join("");
    const inc = r.income;
    return `<article class="card report" id="report">
      <header class="r-head"><div class="kicker">Heti kiértékelés</div><h2 class="font-display">${weekRange(r.week)}</h2>
        <div class="small">${r.final ? "Végleges" : "Előzetes — vasárnap éjfélig frissül"} · kitöltött napok: ${r.filled} / 7 · készült: ${fmtStamp(r.generatedAt)}</div></header>
      ${sec("Hová ment a hét (nap / terv)", `<div class="r-areas">${areaRows}</div><p class="small">A függőleges vonal a heti terv; ami túlmegy rajta, az több a tervezettnél.</p>`)}
      ${sec("Terv szerint ment az este?", `<div class="r-kv"><span>igen <b class="font-data">${p.igen}</b></span><span>részben <b class="font-data">${p.reszben}</b></span><span>nem <b class="font-data">${p.nem}</b></span></div>${took}`, "gold")}
      ${sec("Energia", `<div class="r-energy">${ebars}</div><p class="small">Átlag: <b class="font-data">${r.energyAvg != null ? round1(r.energyAvg) : "–"}</b>${r.energyPrev != null ? ` · az előző hetek átlaga: <b class="font-data">${round1(r.energyPrev)}</b>` : ""}</p>`, "blue")}
      ${sec("Napi állapot", `<div class="r-kv">${Object.entries(REST).map(([k, x]) => `<span><i style="background:var(--c-${x.c})"></i>${x.label} <b class="font-data">${r.rest[k]}</b></span>`).join("")}</div>`, "gold")}
      ${sec("Társas idő", s.n
        ? `<div class="r-kv"><span>alkalom <b class="font-data">${s.n}</b></span><span>terven kívül <b class="font-data">${s.offPlan}</b></span><span>az irányomba vitt <b class="font-data">${s.irany.igen}</b></span><span>csak jólesett <b class="font-data">${s.irany.jolesett}</b></span></div>
           <p class="small">Sokat vitt el: idő ${s.cost.ido} · pénz ${s.cost.penz} · fókusz ${s.cost.fokusz} alkalommal</p>`
        : `<p class="small">Ezen a héten nem volt jelölt társas alkalom.</p>`, "purple")}
      ${sec(`Bevétel · ${fmtMonth(inc.month)}`, inc.total == null ? `<p class="small">Nincs adat erre a hónapra.</p>` : `<p><b class="font-data">${fmtHUF(inc.total)}</b> — ${incomeLevel(inc.total)}${inc.open ? " (a hónap még tartott, amikor ez készült)" : ""}.</p>`)}
      ${sec("Figyelmet kér", r.alerts.length ? `<ul class="r-list r-alerts">${r.alerts.map((a) => `<li>${icon("alert", "icon icon-sm")} ${esc(a)}</li>`).join("")}</ul>` : `<p class="small">Nincs jelzés ezen a héten.</p>`, "danger")}
      ${r.ok.length ? sec("Rendben", `<p>${icon("check", "icon icon-sm")} ${r.ok.join(", ")}</p>`) : ""}
    </article>`;
  }

  function planEditorHtml() {
    const p = planFor(todayStr()), A = state.alerts;
    const days = Object.entries(WEEKDAYS).map(([n, l]) => `<label class="lbl">${l}<input class="field-input" data-plan-day="${n}" value="${esc(p.days[n] || "")}"></label>`).join("");
    const targets = Object.entries(AREAS).map(([k, a]) => `<label class="lbl">${a.label}<input type="number" min="0" max="7" class="field-input font-data" data-plan-target="${k}" value="${p.targets[k] ?? 0}"></label>`).join("");
    const social = Object.entries(WEEKDAYS).map(([n, l]) => `<button class="opt${p.socialDays.includes(+n) ? " on" : ""}" data-act="planSocial" data-v="${n}">${l}</button>`).join("");
    const al = [["healthDays", "Egészség: ennyi nap után jelez"], ["idleWeeks", "Terület vagy lista: ennyi hét érintetlenség után jelez"], ["relWeeks", "Kapcsolatok: ennyi hét lépés nélkül jelez"]]
      .map(([k, l]) => `<label class="lbl">${l}<input type="number" min="1" class="field-input font-data" data-field="alerts.${k}" value="${A[k]}"></label>`).join("");
    return `<details class="card no-print plan-ed"${planOpen ? " open" : ""}><summary>${eyebrow("Heti terv és jelzések beállítása", "purple")}</summary>
      <p class="desc">A változtatás ettől a héttől érvényes, a korábbi hetek a saját akkori tervükhöz mérődnek. Ez a terv ${fmtDate(p.from)} óta érvényes.</p>
      <div class="kicker">Esték, napok</div><div class="stack tight">${days}</div>
      <div class="kicker" style="margin-top:18px">Heti cél: hány napon jusson rá idő</div><div class="grid3">${targets}</div>
      <div class="kicker" style="margin-top:18px">Tervezett társas napok</div><div class="opts">${social}</div>
      <div class="kicker" style="margin-top:18px">Jelzések</div><div class="stack tight">${al}</div>
    </details>`;
  }

  const VIEWS = {
    overview(D) {
      const weekly = [["Mérnöki", D.mern, "green"], ["Ingatlanpiaci", D.ingat, "gold"]].map(([l, s, c]) => `
        <div class="mini" style="background:var(--c-${c}-tint);border-color:color-mix(in srgb, var(--c-${c}) 30%, var(--border))">
          <div class="mini-l">${l}</div>
          <div class="font-display mini-n">${s.open.length} nyitott</div>
          <div class="mini-s">${s.editedThisWeek} frissült e héten</div>
        </div>`).join("");
      const latest = latestReport();
      const fresh = latest && state.reportSeen !== latest.week
        ? card(`<div class="between"><div class="celebrate">${icon("calendar")} Elkészült a heti kiértékelés (${weekRange(latest.week)})</div>
            <button class="btn btn-dark" data-act="go" data-v="weekly">Megnyitás</button></div>`, null, 'style="background:var(--c-green-tint);border-color:var(--c-green)"')
        : "";
      const noData = !D.week7.filled;
      return `<div class="stack">
        ${fresh}
        <div>${eyebrow("Élet-kerék — hová ment az elmúlt 7 nap")}<div class="card wheel-card">${wheelSvg(D)}
          <p class="wheel-note">${noData ? "Még nincs napi bejegyzés. A telefonon (Jegyzet alatt) vagy itt, a Napi napló fülön töltheted ki. " : ""}Minél nagyobb a szelet, annál több jutott rá. A szaggatott kör a heti terved; ami túllóg rajta, az több a tervezettnél.</p></div></div>
        ${card(eyebrow("Ezen a héten — teendők", "gold") + `<div class="two">${weekly}</div>`, "gold")}
        ${card(`${eyebrow(`Havi bevétel a küszöbökhöz képest · ${fmtMonth(state.incomeMonth)}`)}
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

    log() {
      const today = todayStr(), yest = addDays(today, -1);
      const day = logDay === yest ? yest : today;
      const ci = checkin(day);
      const btn = (f, v, label, on, extra = "") => `<button class="opt${on ? " on" : ""}" data-act="ci" data-f="${f}" data-v="${v}" aria-pressed="${on}" ${extra}>${label}</button>`;
      const has = (f, v) => (ci[f] || []).includes(v);
      const q = (label, body) => `<div class="q"><div class="q-l">${label}</div><div class="opts">${body}</div></div>`;
      const tarsas = has("areas", "tarsas");
      const form = `
        <div class="daypick">${[[today, "Ma"], [yest, "Tegnap"]].map(([d, l]) => `<button class="opt${d === day ? " on" : ""}" data-act="logDay" data-v="${d}">${l} · ${fmtShort(d)}</button>`).join("")}</div>
        <p class="desc">Terv (${WEEKDAYS[isoDow(day)].toLowerCase()}): ${esc(planFor(day).days[isoDow(day)] || "—")}</p>
        ${q("Ment a terv szerint az este?", Object.entries(PLAN_ANS).map(([v, l]) => btn("plan", v, l, ci.plan === v)).join(""))}
        ${ci.plan === "reszben" || ci.plan === "nem" ? q("Mi vitte el?", Object.entries(TOOK).map(([v, l]) => btn("took", v, l, has("took", v))).join("")) : ""}
        ${q("Energia ma <span class=\"small\">(1 = kimerült, 5 = tele)</span>", [1, 2, 3, 4, 5].map((v) => btn("energy", v, v, ci.energy === v, 'style="min-width:44px"')).join(""))}
        ${q("Mire ment érdemi idő?", Object.entries(AREAS).map(([v, a]) => btn("areas", v, a.label, has("areas", v), `style="--c:var(--c-${a.c})"`)).join(""))}
        ${q("Napi állapot", Object.entries(REST).map(([v, r]) => btn("rest", v, r.label, ci.rest === v, `style="--c:var(--c-${r.c})"`)).join(""))}
        ${tarsas ? `<div class="q-sub">${q("Társas: visz valamerre?", Object.entries(IRANY).map(([v, l]) => btn("irany", v, l, ci.irany === v)).join(""))}
          ${q("Mit vitt el sokat? <span class=\"small\">(nem kötelező)</span>", Object.entries(COST).map(([v, l]) => btn("cost", v, l, has("cost", v))).join(""))}
          ${!planFor(day).socialDays.includes(isoDow(day)) ? `<p class="small">Ez terven kívüli társas este (a terved szerint ${planFor(day).socialDays.map((n) => WEEKDAYS[n].toLowerCase()).join(", ")} a társas nap).</p>` : ""}</div>` : ""}`;
      // Az elmúlt 4 hét egy pillantásra: napi állapot és energia.
      const days = Array.from({ length: 28 }, (_, i) => addDays(today, i - 27));
      const counts = { pihenes: 0, dolgoztam: 0, menekules: 0 };
      const cis = days.map((d) => [d, checkin(d)]);
      const dots = cis.map(([d, c]) => {
        const v = c.rest; if (v) counts[v]++;
        return `<span class="dot" title="${fmtDate(d)}${v ? " — " + REST[v].label : ""}" style="background:${v ? `var(--c-${REST[v].c})` : "var(--surface-2)"}"></span>`;
      }).join("");
      const bars = cis.map(([d, c]) => `<span class="ebar" title="${fmtDate(d)}${c.energy ? " — energia " + c.energy : ""}"><i style="height:${(c.energy || 0) * 20}%"></i></span>`).join("");
      const legend = Object.entries(REST).map(([k, r]) => `<span><i style="background:var(--c-${r.c})"></i>${r.label}: <b class="font-data">${counts[k]}</b></span>`).join("");
      return `<div class="stack">
        ${card(eyebrow("Napi kártya", "gold") + form, "gold")}
        ${card(eyebrow("Az elmúlt 4 hét") + `<div class="dots">${dots}</div><div class="legend">${legend}</div>
          <div class="kicker" style="margin-top:16px">Energia</div><div class="ebars">${bars}</div>`)}
      </div>`;
    },

    weekly() {
      const list = Object.values(state.reports).sort((a, b) => (a.week < b.week ? 1 : -1));
      const r = list.find((x) => x.week === reportWeek) || list[0];
      const next = (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return ymd(d); })();
      const top = r
        ? `<div class="between no-print"><select class="field-input sel" data-report-week aria-label="Melyik hét">${list.map((x) => `<option value="${x.week}"${x.week === r.week ? " selected" : ""}>${weekRange(x.week)}${x.final ? "" : " (előzetes)"}</option>`).join("")}</select>
            <button class="btn btn-dark" data-act="print">${icon("print", "icon icon-sm")} PDF mentése</button></div>
          ${reportHtml(r)}`
        : card(`${eyebrow("Heti kiértékelés")}<p class="desc">Az első heti anyag ${fmtDate(next)} (vasárnap) 16:00-kor készül el, a napi kártyák alapján. Addig érdemes minden este kitölteni a napi kártyát a telefonon vagy a Napi napló fülön.</p>`);
      return `<div class="stack">${top}${planEditorHtml()}</div>`;
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
          <label class="lbl">Ingatlanpiaci (Ft)<input type="number" class="field-input font-data" data-field="income.ingatlanpiaci" value="${esc(state.income.ingatlanpiaci)}"></label></div>
          <p class="small" style="margin:10px 0 0">Ez a(z) ${fmtMonth(state.incomeMonth)} bevétele. Minden hónap ${INCOME_RESET_DAY}-én nullázódik, az addigi összeg az előző hónaphoz mentődik.</p>
          ${incomeHistoryHtml()}`)}
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
    if (ensureReports()) scheduleSave();
    const latest = latestReport();
    if (tab === "weekly" && latest && state.reportSeen !== latest.week && (!reportWeek || reportWeek === latest.week)) { state.reportSeen = latest.week; scheduleSave(); }
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

  // Napi kártya a laptopon: egy koppintás egy választ állít (vagy újra koppintva töröl).
  // Az időbélyeg alapján fésüljük össze a telefonos bejegyzéssel.
  const MULTI = ["took", "areas", "cost"];
  function setCheck(f, raw) {
    const day = logDay === addDays(todayStr(), -1) ? logDay : todayStr();
    const cur = checkin(day)[f];
    const v = f === "energy" ? Number(raw) : raw;
    const val = MULTI.includes(f)
      ? ((cur || []).includes(v) ? cur.filter((x) => x !== v) : [...(cur || []), v])
      : cur === v ? null : v;
    mutate((s) => {
      const c = s.checkins[day] || (s.checkins[day] = { at: {} });
      c[f] = val;
      c.at = { ...(c.at || {}), [f]: Date.now() };
      if (f === "rest") { if (val) s.restLogs[day] = val; else delete s.restLogs[day]; } // a régi napló is kövesse
    });
  }
  // A terv módosítása ettől a héttől érvényes: ha a mostani terv korábbi hétről való, új változat készül.
  function editPlan(fn, rerender = true) {
    mutate((s) => {
      const cur = weekKey();
      let p = s.plans[s.plans.length - 1];
      if (p.from < cur) { p = { ...clone(p), from: cur }; s.plans.push(p); }
      fn(p);
    }, rerender);
  }
  document.addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("plan-ed")) planOpen = e.target.open; }, true);
  document.addEventListener("change", (e) => {
    if (e.target.dataset && "reportWeek" in e.target.dataset) { reportWeek = e.target.value; render(); }
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !state) return;
    const { act, v, id } = b.dataset;
    const byId = (arr) => arr.find((x) => x.id === id);
    switch (act) {
      case "go": tab = v; try { localStorage.setItem(TAB_KEY, v); } catch {} render(); window.scrollTo(0, 0); break;
      case "toggleDone": jegyzetDone = b.checked; render(); break;
      case "add": addTo(b.dataset.list, $(`[data-add-input="${b.dataset.list}"]`).value); break;
      case "ci": setCheck(b.dataset.f, v); break;
      case "logDay": logDay = v; render(); break;
      case "planSocial": editPlan((p) => { const n = Number(v); p.socialDays = p.socialDays.includes(n) ? p.socialDays.filter((x) => x !== n) : [...p.socialDays, n].sort(); }); break;
      case "print": window.print(); break;
      case "mgDone": mutate((s) => { s.mediumGoalStatus = { achieved: true, achievedDate: todayStr() }; }); break;
      case "mgUndo": mutate((s) => { s.mediumGoalStatus = { achieved: false, achievedDate: null }; }); break;
      case "wishToggle": mutate((s) => { const w = byId(s.wishlist); w.done = !w.done; w.doneAt = w.done ? todayStr() : null; }); break;
      case "wishDel": mutate((s) => { s.wishlist = s.wishlist.filter((x) => x.id !== id); }); break;
      case "healthDone": mutate((s) => { const h = byId(s.health.items), t = todayStr(); h.lastAddressed = t; h.log = [...new Set([...(h.log || []), t])]; }); break;
      case "healthDel": if (confirm("Törlöd ezt a területet?")) mutate((s) => { s.health.items = s.health.items.filter((x) => x.id !== id); }); break;
      case "presDel": if (confirm("Törlöd ezt az elvet?")) mutate((s) => { s.presence.items = s.presence.items.filter((x) => x.id !== id); }); break;
      case "ideaStatus": mutate((s) => { const i = byId(s.ideas); if (i.status === v) return; i.status = v; i.history = [...(i.history || []), { status: v, date: todayStr() }]; }); break;
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
    } else if (t.dataset.planDay) {
      editPlan((p) => { p.days = { ...p.days, [t.dataset.planDay]: t.value }; }, false);
    } else if (t.dataset.planTarget) {
      editPlan((p) => { p.targets = { ...p.targets, [t.dataset.planTarget]: Math.max(0, Math.min(7, Number(t.value) || 0)) }; }, false);
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
    // Kitalált napi kártyák az elmúlt 4 hétre (mintha a telefonról jöttek volna).
    const today = todayStr();
    state.trackingStart = addDays(weekKey(), -21);
    state.incomeMonth = "2026-08"; // a demó a hónapváltást is megmutatja
    state.health.items[0].lastAddressed = addDays(today, -40);
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const byDow = { 1: ["mernoki"], 2: ["sport", "nyelv"], 3: ["ingatlanpiaci"], 4: ["sport", "nyelv"], 5: ["mernoki", "tarsas"], 6: ["mernoki", "tarsas"], 7: ["jelenlet", "tarsas"] };
    for (let i = 27; i >= 1; i--) {
      const d = addDays(today, -i);
      if (d < state.trackingStart || rnd() < 0.12) continue;
      const ok = rnd() > 0.3;
      const areas = ok ? byDow[isoDow(d)] : rnd() > 0.5 ? ["tarsas"] : [];
      const e = { plan: ok ? "igen" : rnd() > 0.5 ? "reszben" : "nem", took: ok ? [] : [rnd() > 0.5 ? "tarsas" : "faradtsag"], energy: 2 + Math.floor(rnd() * 4),
        areas, rest: ["pihenes", "dolgoztam", "dolgoztam", "menekules"][Math.floor(rnd() * 4)], irany: areas.includes("tarsas") ? (rnd() > 0.5 ? "igen" : "jolesett") : null,
        cost: areas.includes("tarsas") && rnd() > 0.5 ? ["penz", "ido"] : [] };
      e.at = Object.fromEntries(Object.keys(e).map((k) => [k, now - i * 86400000]));
      phoneDays.set(d, e);
    }
    itemsLoaded = true; daysLoaded = true;
    prepareState();
    show("app");
    $("#today").textContent = fmtDate(todayStr());
    setSaveStatus("Demó: nincs mentés");
    render();
    return;
  }

  // Asztali appként telepíthető (saját, gyorsítótár nélküli service worker).
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
