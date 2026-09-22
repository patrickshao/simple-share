// Local-only integration check: changing IDs must not bypass shared limits.
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { randomToken, hashToken } from "../lib/device-identity.ts";
import { makeRoomCode } from "../lib/peer.ts";

const url = process.env.SIMPLE_SHARE_TEST_CONVEX_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  throw new Error("Set SIMPLE_SHARE_TEST_CONVEX_URL to a local development backend.");
}
const client = new ConvexHttpClient(url, { logger: false });
const rooms = [], pairs = [];
const offer = JSON.stringify({ type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 TEST\r\n" });
try {
  for (const kind of ["rooms", "pairs"]) {
    let blocked = false;
    for (let i = 0; i < 150; i++) {
      const code = makeRoomCode(), hostSecret = randomToken();
      const pairId = randomToken(), token = randomToken();
      try {
        if (kind === "rooms") {
          await client.mutation(api.signals.createRoom, { code, hostSecret, offer });
          rooms.push({ code, hostSecret });
        } else {
          await client.mutation(api.pairing.create, { pairId, tokenA: token, hashB: await hashToken(randomToken()) });
          pairs.push({ pairId, token });
        }
      } catch (error) {
        assert.match(String(error), /Simple Share is busy/);
        // The rejected mutation must leave no room or pairing behind.
        if (kind === "rooms") assert.equal(await client.query(api.signals.getRoomForJoin, { code }), null);
        else assert.deepEqual(await client.query(api.pairing.list, { devices: [{ pairId, token }] }), []);
        blocked = true;
        break;
      }
    }
    assert.ok(blocked, `${kind} creation should reject rotating IDs at the shared limit`);
  }
  console.log("Abuse limits passed: rotating room/pair IDs are rejected; rejected writes roll back.");
} finally {
  // Cleanup remains available even when creation is throttled.
  for (const room of rooms) await client.mutation(api.signals.closeRoom, room);
  for (const pair of pairs) await client.mutation(api.pairing.forget, pair);
  console.log(`Removed ${rooms.length} test rooms and ${pairs.length} test pairings.`);
}
