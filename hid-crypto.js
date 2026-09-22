// Híd titkosítás: WebCrypto, külső függőség nélkül.
// Tételek: véletlen AES-256-GCM kulccsal titkosítva, a kulcsot RSA-OAEP nyilvános kulcs csomagolja.
// A privát kulcs jelszóból (PBKDF2) és külön a helyreállítási kulcsból is feloldható.
(function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = crypto.subtle;
  const ITER = 600000;
  const RSA = { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const b64 = (buf) => {
    const u = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  function recoveryToString(bytes) {
    let bits = 0, acc = 0, out = "";
    for (const b of bytes) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPHA[(acc << (5 - bits)) & 31];
    return out.match(/.{1,4}/g).join("-");
  }
  function recoveryFromString(str) {
    const clean = str.toUpperCase().replace(/[^A-Z2-9]/g, "");
    let bits = 0, acc = 0;
    const out = [];
    for (const ch of clean) {
      const v = ALPHA.indexOf(ch);
      if (v < 0) throw new Error("Érvénytelen helyreállítási kulcs.");
      acc = (acc << 5) | v; bits += 5;
      if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; }
    }
    if (out.length < 32) throw new Error("A helyreállítási kulcs túl rövid.");
    return new Uint8Array(out.slice(0, 32));
  }

  async function passwordKey(password, salt, iter) {
    const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const recoveryAesKey = (bytes) => subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);

  async function seal(key, bytes) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function open(key, box) {
    return subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  }

  async function makeKeyfile(pkcs8, publicKey, password, recoveryBytes) {
    const salt = rand(16);
    const pw = await seal(await passwordKey(password, salt, ITER), pkcs8);
    pw.salt = b64(salt); pw.iter = ITER;
    const rec = await seal(await recoveryAesKey(recoveryBytes), pkcs8);
    return { v: 1, publicKey, pw, rec };
  }

  async function createKeys(password) {
    if (!password || password.length < 10) throw new Error("A jelszó legyen legalább 10 karakter.");
    const pair = await subtle.generateKey(RSA, true, ["encrypt", "decrypt"]);
    const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
    const publicKey = b64(await subtle.exportKey("spki", pair.publicKey));
    const recoveryBytes = rand(32);
    const keyfile = await makeKeyfile(pkcs8, publicKey, password, recoveryBytes);
    return { keyfile, recoveryKey: recoveryToString(recoveryBytes), publicKey };
  }

  async function pkcs8FromPassword(keyfile, password) {
    try {
      const key = await passwordKey(password, unb64(keyfile.pw.salt), keyfile.pw.iter);
      return await open(key, keyfile.pw);
    } catch (e) { throw new Error("Hibás jelszó."); }
  }
  async function pkcs8FromRecovery(keyfile, recoveryKey) {
    const bytes = recoveryFromString(recoveryKey);
    try { return await open(await recoveryAesKey(bytes), keyfile.rec); }
    catch (e) { throw new Error("Hibás helyreállítási kulcs."); }
  }
  const toPrivateKey = (pkcs8) => subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);

  const unlockWithPassword = async (keyfile, password) => toPrivateKey(await pkcs8FromPassword(keyfile, password));
  const unlockWithRecovery = async (keyfile, recoveryKey) => toPrivateKey(await pkcs8FromRecovery(keyfile, recoveryKey));

  // Jelszócsere: a helyreállítási kulcs változatlan marad.
  async function changePassword(keyfile, oldPassword, newPassword) {
    if (!newPassword || newPassword.length < 10) throw new Error("A jelszó legyen legalább 10 karakter.");
    const pkcs8 = await pkcs8FromPassword(keyfile, oldPassword);
    const salt = rand(16);
    const pw = await seal(await passwordKey(newPassword, salt, ITER), pkcs8);
    pw.salt = b64(salt); pw.iter = ITER;
    return { ...keyfile, pw };
  }
  // Elfelejtett jelszó: a helyreállítási kulccsal új jelszót lehet adni.
  async function resetPassword(keyfile, recoveryKey, newPassword) {
    if (!newPassword || newPassword.length < 10) throw new Error("A jelszó legyen legalább 10 karakter.");
    const pkcs8 = await pkcs8FromRecovery(keyfile, recoveryKey);
    const salt = rand(16);
    const pw = await seal(await passwordKey(newPassword, salt, ITER), pkcs8);
    pw.salt = b64(salt); pw.iter = ITER;
    return { ...keyfile, pw };
  }

  const importPublicKey = (spkiB64) => subtle.importKey("spki", unb64(spkiB64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);

  async function encryptItem(publicKey, obj) {
    const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const box = await seal(aes, enc.encode(JSON.stringify(obj)));
    const k = await subtle.encrypt({ name: "RSA-OAEP" }, publicKey, await subtle.exportKey("raw", aes));
    return { v: 1, k: b64(k), iv: box.iv, ct: box.ct };
  }
  async function decryptItem(privateKey, blob) {
    const raw = await subtle.decrypt({ name: "RSA-OAEP" }, privateKey, unb64(blob.k));
    const aes = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    return JSON.parse(dec.decode(await open(aes, blob)));
  }

  window.HidCrypto = { createKeys, unlockWithPassword, unlockWithRecovery, changePassword, resetPassword, importPublicKey, encryptItem, decryptItem, ITER };
})();
