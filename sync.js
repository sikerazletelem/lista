// Szinkron a Firebasehez. Az app offline is teljesen működik: ez a réteg csak
// akkor próbál a felhővel beszélni, ha van bejelentkezés és internet.
//
// A telefon SOHA nem kapja meg a privát kulcsot — csak a nyilvános kulcsot,
// amit a Firestore-ból tölt le (users/{uid}/meta/keys). Ezért egy tételt csak
// titkosítva tud felküldeni, visszafejteni soha nem tud. A kulcsot egy külön
// laptopos eszköz (kulcs-beallitas.html, később a Kiértékelő) hozza létre.
//
// Firestore-adatszerkezet:
//   users/{uid}/meta/keys        -> { publicKey, keyfile, createdAt }
//   users/{uid}/items/{itemId}   -> { updatedAt, blob }   (blob = HidCrypto.encryptItem eredménye)
//   users/{uid}/days/{nap}       -> { updatedAt, blob }   (a napi „Ma” kártya, napi.js)
const Sync = (() => {
  const PENDING_KEY = "hid-sync-pending";
  const PUBKEY_KEY = "hid-sync-pubkey";
  const SYNCED_KEY = "hid-sync-synced"; // { id: updatedAt } — mi van már fent a felhőben, milyen állapotban
  let app = null, auth = null, db = null;
  let user = null, publicKey = null, publicKeyChecked = false;
  let onStatus = () => {};

  function ensureFirebase() {
    if (app) return true;
    if (typeof firebase === "undefined" || !window.FIREBASE_CONFIG) return false;
    app = firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    auth.onAuthStateChanged((u) => {
      user = u;
      publicKey = null; publicKeyChecked = false;
      if (!u) { localStorage.removeItem(PUBKEY_KEY); }
      onStatus(u ? { loggedIn: true, email: u.email } : { loggedIn: false });
    });
    return true;
  }

  function pending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; } }
  function setPending(ids) { localStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(new Set(ids)))); }
  function markPending(id) { setPending(pending().concat([id])); }
  function clearPendingOne(id) { setPending(pending().filter((x) => x !== id)); }
  function synced() { try { return JSON.parse(localStorage.getItem(SYNCED_KEY) || "{}"); } catch { return {}; } }
  function markSynced(item) { const s = synced(); s[item.id] = item.updatedAt; localStorage.setItem(SYNCED_KEY, JSON.stringify(s)); }

  async function loadPublicKey() {
    if (publicKey) return publicKey;
    const cached = localStorage.getItem(PUBKEY_KEY);
    if (cached) { publicKey = await HidCrypto.importPublicKey(cached); return publicKey; }
    if (!user) return null;
    publicKeyChecked = true;
    const snap = await db.collection("users").doc(user.uid).collection("meta").doc("keys").get();
    if (!snap.exists || !snap.data().publicKey) return null;
    const spki = snap.data().publicKey;
    localStorage.setItem(PUBKEY_KEY, spki);
    publicKey = await HidCrypto.importPublicKey(spki);
    return publicKey;
  }

  async function pushOne(item) {
    if (!user) { markPending(item.id); return false; }
    const pub = await loadPublicKey().catch(() => null);
    if (!pub) { markPending(item.id); return false; }
    try {
      const blob = await HidCrypto.encryptItem(pub, { block: item.block, text: item.text, done: item.done, doneAt: item.doneAt ?? null, deleted: item.deleted, order: item.order });
      await db.collection("users").doc(user.uid).collection("items").doc(item.id).set({ updatedAt: item.updatedAt, blob });
      clearPendingOne(item.id);
      markSynced(item);
      return true;
    } catch (e) { markPending(item.id); return false; }
  }

  return {
    // statusCb({loggedIn, email}) — hívódik be- és kijelentkezéskor.
    init(statusCb) {
      if (statusCb) onStatus = statusCb;
      try { ensureFirebase(); } catch (e) { /* offline vagy a fájlok még nincsenek betöltve */ }
    },
    ready: () => !!(app && auth),
    isLoggedIn: () => !!user,
    uid: () => (user ? user.uid : null),
    db: () => db, // a vásárlási listának (vasarlas.js), ami saját kulccsal olvas és ír
    email: () => (user ? user.email : null),
    async login(email, password) {
      if (!ensureFirebase()) throw new Error("A szinkron most nem érhető el (nincs internet?).");
      await auth.signInWithEmailAndPassword(email, password);
    },
    async logout() { if (auth) await auth.signOut(); },
    // Egy tétel felküldése. Ha nincs net/bejelentkezés/kulcs, csak megjegyzi, hogy még várakozik.
    push(item) {
      if (!navigator.onLine) { markPending(item.id); return; }
      pushOne(item);
    },
    // Minden várakozó tétel újraküldése (induláskor és online-ra váltáskor hívjuk).
    async flushPending(getById) {
      if (!navigator.onLine || !user) return;
      for (const id of pending()) {
        const item = getById(id);
        if (item) await pushOne(item);
        else clearPendingOne(id);
      }
    },
    // Minden olyan tétel felküldése, ami még nincs fent, vagy azóta változott. Ez pótolja
    // a szinkron bevezetése előtt felvett tételeket is. Induláskor, bejelentkezéskor és
    // online-ra váltáskor hívjuk; ami már fent van, azt nem küldi újra.
    async syncAll(all) {
      if (!navigator.onLine || !user) return;
      const s = synced();
      for (const item of all) {
        if (s[item.id] !== item.updatedAt) await pushOne(item);
      }
    },
    pendingCount: () => pending().length,
    // Egy tetszőleges objektum titkosított felküldése (pl. days/{nap}). Igazat ad, ha sikerült;
    // ha nincs net, bejelentkezés vagy kulcs, hamisat — a hívó később újrapróbálja.
    async putEncrypted(col, id, obj, updatedAt) {
      if (!navigator.onLine || !user) return false;
      const pub = await loadPublicKey().catch(() => null);
      if (!pub) return false;
      try {
        const blob = await HidCrypto.encryptItem(pub, obj);
        await db.collection("users").doc(user.uid).collection(col).doc(id).set({ updatedAt, blob });
        return true;
      } catch (e) { return false; }
    },
  };
})();
