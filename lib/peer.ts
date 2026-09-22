export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const SHA_256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function normalizePrivateIpv4(value: string) {
  const candidate = value.trim().replace(/^::ffff:/i, "");
  const parts = candidate.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  const isPrivate =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  return isPrivate ? octets.join(".") : null;
}

/** When the page is opened via a private LAN IP, rewrite mDNS `.local` host
 *  candidates to that IP so Android/Brave can reach the peer without multicast DNS.
 *  Only safe when location.hostname is a private IPv4 (not localhost). */
export function lanHostFromLocation(hostname = typeof window !== "undefined" ? window.location.hostname : "") {
  return normalizePrivateIpv4(hostname);
}

export function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function senderLanHost(
  hostname = typeof window !== "undefined" ? window.location.hostname : "",
  configuredLanHost = process.env.NEXT_PUBLIC_SIMPLE_SHARE_LAN_HOST ?? "",
) {
  return (
    lanHostFromLocation(hostname) ??
    (isLoopbackHostname(hostname) ? normalizePrivateIpv4(configuredLanHost) : null)
  );
}

export function shareOriginForLocation(origin: string, configuredLanHost: string) {
  try {
    const url = new URL(origin);
    const lanHost = normalizePrivateIpv4(configuredLanHost);
    if (lanHost && isLoopbackHostname(url.hostname)) url.hostname = lanHost;
    return url.origin;
  } catch {
    return origin;
  }
}

/** Ask the local Next server which private address made this request. This is
 * only used when the page itself came from a private LAN host; cloud deployments
 * keep the browser's normal mDNS candidate untouched. */
export async function discoverClientLanHost() {
  if (typeof window === "undefined" || !lanHostFromLocation()) return null;
  try {
    const response = await fetch("/api/lan-address", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { address?: unknown };
    return typeof body.address === "string" ? normalizePrivateIpv4(body.address) : null;
  } catch {
    return null;
  }
}

export function serializeIceCandidate(candidate: RTCIceCandidate, lanHost: string | null) {
  const json = candidate.toJSON();
  if (!lanHost || !json.candidate || !json.candidate.includes(".local")) {
    return JSON.stringify(json);
  }
  const rewritten = {
    ...json,
    candidate: json.candidate.replace(/[A-Za-z0-9-]+\.local/g, lanHost),
    address: lanHost,
  };
  return JSON.stringify(rewritten);
}

export function createPeerConnection(iceServers: RTCIceServer[] = FALLBACK_ICE_SERVERS) {
  return new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 4,
  });
}

export function makeRoomCode() {
  const values = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(values, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join(
    "",
  );
}

export function formatRoomCode(code: string) {
  const normalized = normalizeRoomCode(code);
  return normalized.length > 4
    ? `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`
    : normalized;
}

export function normalizeRoomCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export function makeHostSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return;

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(finish, 4_000);

    function finish() {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", handleStateChange);
      resolve();
    }

    function handleStateChange() {
      if (peer.iceGatheringState === "complete") finish();
    }

    peer.addEventListener("icegatheringstatechange", handleStateChange);
  });
}

export function serializeDescription(
  description: RTCSessionDescription | null,
  lanHost: string | null = null,
) {
  if (!description) throw new Error("The browser did not create connection details.");
  const sdp = lanHost
    ? description.sdp.replace(/[A-Za-z0-9-]+\.local/g, lanHost)
    : description.sdp;
  return JSON.stringify({ type: description.type, sdp });
}

export function parseDescription(value: string): RTCSessionDescriptionInit {
  const parsed = JSON.parse(value) as { type?: unknown; sdp?: unknown };
  if (
    (parsed.type !== "offer" && parsed.type !== "answer") ||
    typeof parsed.sdp !== "string"
  ) {
    throw new Error("The connection details are malformed.");
  }
  return { type: parsed.type, sdp: parsed.sdp };
}

export async function createSafetyCode(offer: string, answer: string) {
  const sdp = (value: string) => { try { return parseDescription(value).sdp ?? value; } catch { return value; } };
  const fingerprints = [...sdp(offer).matchAll(/^a=fingerprint:(.+)$/gm), ...sdp(answer).matchAll(/^a=fingerprint:(.+)$/gm)]
    .map((match) => match[1].trim())
    .sort()
    .join("|");
  const source = fingerprints || [offer, answer].sort().join("|");
  const sourceBytes = new TextEncoder().encode(source);
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", sourceBytes))
    : sha256Fallback(sourceBytes);
  const hex = Array.from(digest.slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)}`;
}

/** SHA-256 for HTTP LAN origins, where browsers may omit SubtleCrypto. */
export function sha256Fallback(input: Uint8Array) {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const paddedView = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 =
        ((word15 >>> 7) | (word15 << 25)) ^
        ((word15 >>> 18) | (word15 << 14)) ^
        (word15 >>> 3);
      const sigma1 =
        ((word2 >>> 17) | (word2 << 15)) ^
        ((word2 >>> 19) | (word2 << 13)) ^
        (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA_256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const resultView = new DataView(result.buffer);
  hash.forEach((word, index) => resultView.setUint32(index * 4, word));
  return result;
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

export function readableError(error: unknown) {
  if (!(error instanceof Error)) return "Something interrupted the connection.";
  const message = error.message
    .replace(/^\[CONVEX [^\]]+\]\s*/i, "")
    .replace(/^Uncaught Error:\s*/i, "")
    .split("\n")[0];
  return message || "Something interrupted the connection.";
}
