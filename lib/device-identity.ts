export type DeviceIdentity = { publicKey: string; privateKey: CryptoKey };
export type PairedDevice = { pairId: string; token: string; publicKey: string; name: string; createdAt: number };
export const PAIRS_STORAGE_KEY = "simple-share-pairs-v1";
export const DEVICE_NAME_KEY = "simple-share-device-name-v1";
export const MAX_PAIRS = 20;
export function randomToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function toBase64(bytes: Uint8Array) { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")); }
function fromBase64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
export async function hashToken(token: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function generateIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))) };
}
let loading: Promise<DeviceIdentity> | undefined;
export function loadIdentity() {
  if (!loading) loading = loadStoredIdentity().catch(error => { loading = undefined; throw error; });
  return loading;
}
async function loadStoredIdentity(): Promise<DeviceIdentity> {
  if (!globalThis.crypto?.subtle) throw new Error("Remembered devices need HTTPS. You can still use a temporary room here.");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("simple-share-device-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("This browser could not save a device identity."));
  });
  try {
    const candidate = await generateIdentity();
    return await new Promise<DeviceIdentity>((resolve, reject) => {
      // Reading and initial creation in one transaction prevents two tabs from replacing the identity.
      const tx = db.transaction("identity", "readwrite");
      const store = tx.objectStore("identity");
      const request = store.get("current");
      let identity: DeviceIdentity;
      request.onsuccess = () => {
        identity = request.result as DeviceIdentity ?? candidate;
        if (!request.result) store.put(identity, "current");
      };
      tx.oncomplete = () => resolve(identity);
      tx.onabort = tx.onerror = () => reject(new Error("This browser could not save a device identity."));
    });
  } finally { db.close(); }
}
export function connectionBinding(localSdp: string, remoteSdp: string) {
  const fingerprints = [localSdp, remoteSdp].map(sdp => {
    const values = [...sdp.matchAll(/^a=fingerprint:(.+)$/gm)].map(match => match[1].trim());
    if (!values.length) throw new Error("The connection has no security fingerprint.");
    return [...new Set(values)].sort().join(",");
  });
  return fingerprints.sort().join("|");
}
function proofBytes(challenge: string, binding: string) {
  return new TextEncoder().encode(JSON.stringify(["simple-share-device-proof-v1", challenge, binding]));
}
export async function signProof(identity: DeviceIdentity, challenge: string, binding: string) {
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, proofBytes(challenge, binding))));
}
export async function verifyProof(publicKey: string, signature: string, challenge: string, binding: string) {
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signature), proofBytes(challenge, binding));
  } catch { return false; }
}
export function readPairs(): PairedDevice[] {
  const value: unknown = JSON.parse(localStorage.getItem(PAIRS_STORAGE_KEY) ?? "[]");
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is PairedDevice => p && typeof p === "object" &&
    /^[A-Za-z0-9_-]{43}$/.test(p.pairId) && /^[A-Za-z0-9_-]{43}$/.test(p.token) &&
    typeof p.publicKey === "string" && p.publicKey.length < 200 &&
    typeof p.name === "string" && p.name.length <= 60 && Number.isFinite(p.createdAt)).slice(0, MAX_PAIRS);
}
export function savePair(pair: PairedDevice) {
  const pairs = readPairs().filter(p => p.pairId !== pair.pairId);
  if (pairs.length >= MAX_PAIRS) throw new Error("You can remember up to 20 devices. Forget one first.");
  localStorage.setItem(PAIRS_STORAGE_KEY, JSON.stringify([...pairs, pair]));
  window.dispatchEvent(new Event("simple-share-pairs-changed"));
}
export function removePair(pairId: string) {
  localStorage.setItem(PAIRS_STORAGE_KEY, JSON.stringify(readPairs().filter(p => p.pairId !== pairId)));
  window.dispatchEvent(new Event("simple-share-pairs-changed"));
}
export function defaultDeviceName() {
  const agent = navigator.userAgent;
  return /iPhone/.test(agent) ? "My iPhone" : /iPad/.test(agent) ? "My iPad" : /Android/.test(agent) ? "My Android" : /Mac/.test(agent) ? "My Mac" : /Windows/.test(agent) ? "My PC" : "My device";
}
