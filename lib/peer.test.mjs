import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePrivateIpv4,
  senderLanHost,
  serializeDescription,
  serializeIceCandidate,
  sha256Fallback,
  shareOriginForLocation,
} from "./peer.ts";

test("normalizes only valid private IPv4 addresses", () => {
  assert.equal(normalizePrivateIpv4("::ffff:192.168.50.42"), "192.168.50.42");
  assert.equal(normalizePrivateIpv4("10.0.0.8"), "10.0.0.8");
  assert.equal(normalizePrivateIpv4("172.31.1.9"), "172.31.1.9");
  assert.equal(normalizePrivateIpv4("172.32.1.9"), null);
  assert.equal(normalizePrivateIpv4("192.168.999.1"), null);
  assert.equal(normalizePrivateIpv4("8.8.8.8"), null);
});

test("uses the configured LAN host only when the sender opened localhost", () => {
  assert.equal(senderLanHost("localhost", "192.168.50.187"), "192.168.50.187");
  assert.equal(senderLanHost("192.168.1.5", "192.168.50.187"), "192.168.1.5");
  assert.equal(senderLanHost("share.example.com", "192.168.50.187"), null);
});

test("turns a localhost invite into a reachable LAN invite", () => {
  assert.equal(
    shareOriginForLocation("http://localhost:3000", "192.168.50.187"),
    "http://192.168.50.187:3000",
  );
  assert.equal(
    shareOriginForLocation("https://share.example.com", "192.168.50.187"),
    "https://share.example.com",
  );
});

test("rewrites mDNS host candidates in trickled ICE and SDP", () => {
  const candidate = {
    toJSON: () => ({
      candidate: "candidate:1 1 udp 2122260223 peer-id.local 53123 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    }),
  };
  const parsedCandidate = JSON.parse(serializeIceCandidate(candidate, "192.168.50.42"));
  assert.match(parsedCandidate.candidate, /192\.168\.50\.42/);
  assert.doesNotMatch(parsedCandidate.candidate, /\.local/);

  const description = {
    type: "offer",
    sdp: "v=0\r\na=candidate:1 1 udp 2122260223 peer-id.local 53123 typ host\r\n",
  };
  const parsedDescription = JSON.parse(
    serializeDescription(description, "192.168.50.42"),
  );
  assert.match(parsedDescription.sdp, /192\.168\.50\.42/);
  assert.doesNotMatch(parsedDescription.sdp, /\.local/);
});

test("HTTP safety-code SHA-256 fallback matches the standard digest", () => {
  const digest = sha256Fallback(new TextEncoder().encode("abc"));
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
