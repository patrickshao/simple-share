"use client";
import { useEffect, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DeviceHandshake, type PairProposal, type PeerIdentity } from "@/lib/device-handshake";
import {
  DEVICE_NAME_KEY, PAIRS_STORAGE_KEY, defaultDeviceName, hashToken, loadIdentity,
  randomToken, readPairs, removePair, savePair, type DeviceIdentity, type PairedDevice,
} from "@/lib/device-identity";
import { readableError } from "@/lib/peer";

export function useDevicePairs() {
  const convex = useConvex();
  const heartbeat = useMutation(api.pairing.heartbeat);
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [name, setName] = useState("My device");
  const [pairs, setPairs] = useState<PairedDevice[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [peer, setPeer] = useState<PeerIdentity | null>(null);
  const [proposal, setProposal] = useState<PairProposal | null>(null);
  const [sessionPair, setSessionPair] = useState<PairedDevice | null>(null);
  const [pairStatus, setPairStatus] = useState<"none" | "saving" | "waiting" | "saved">("none");
  const [now, setNow] = useState(Date.now());
  const sessionRef = useRef<DeviceHandshake | null>(null);
  const pendingRef = useRef<PairedDevice | null>(null);
  const currentRef = useRef({ identity, name, pairs });
  currentRef.current = { identity, name, pairs };
  const devices = pairs.map(({ pairId, token }) => ({ pairId, token }));
  const live = useQuery(api.pairing.list, identity && devices.length ? { devices } : "skip");

  useEffect(() => {
    let active = true;
    function refresh() {
      try { setPairs(readPairs()); } catch { setNotice("Saved devices could not be read. Browser storage may be unavailable."); }
    }
    refresh();
    try {
      setName(localStorage.getItem(DEVICE_NAME_KEY) || defaultDeviceName());
      // Verify persistent metadata storage is usable before enabling pairing.
      localStorage.setItem(PAIRS_STORAGE_KEY, localStorage.getItem(PAIRS_STORAGE_KEY) || "[]");
      void loadIdentity().then(value => { if (active) setIdentity(value); }).catch(error => { if (active) setNotice(readableError(error)); }).finally(() => { if (active) setReady(true); });
    } catch { setNotice("Remembered devices need browser storage. Temporary rooms still work."); setReady(true); }
    window.addEventListener("storage", refresh);
    window.addEventListener("simple-share-pairs-changed", refresh);
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("storage", refresh); window.removeEventListener("simple-share-pairs-changed", refresh); sessionRef.current?.stop(); };
  }, []);

  const credentialsJson = JSON.stringify(devices);
  useEffect(() => {
    if (!identity || !devices.length) return;
    const credentials = JSON.parse(credentialsJson) as typeof devices;
    const beat = () => { void heartbeat({ devices: credentials }).catch(() => {}); };
    beat();
    const timer = setInterval(beat, 25_000);
    document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", beat); };
  }, [credentialsJson, identity, heartbeat]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pairStatus === "waiting" && pending && live?.some(item => item.pairId === pending.pairId && item.confirmed)) {
      setSessionPair(pending);
      setPairStatus("saved");
      pendingRef.current = null;
    }
  }, [live, pairStatus]);

  function rename(value: string) {
    const next = value.slice(0, 60);
    setName(next);
    try { localStorage.setItem(DEVICE_NAME_KEY, next.trim() || defaultDeviceName()); }
    catch { setNotice("The device name could not be saved."); }
  }
  function clearConnection() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    pendingRef.current = null;
    setPeer(null); setProposal(null); setPairStatus("none"); setSessionPair(null);
  }
  function attach(channel: RTCDataChannel, connection: RTCPeerConnection, expected: PairedDevice | null, role: "send" | "receive", onReady: () => void, onError: (error: Error) => void) {
    clearConnection();
    const current = currentRef.current;
    const session = new DeviceHandshake(channel, connection, current.identity, current.name.trim() || "My device", expected, {
      onReady: other => { setPeer(other); setSessionPair(expected); setPairStatus(expected ? "saved" : "none"); onReady(); },
      onError,
      onPairOffer: offer => {
        if (role !== "receive" || expected || pendingRef.current) { session.send({ type: "pair-result", pairId: offer.pairId, accepted: false }); return; }
        pendingRef.current = { ...offer, publicKey: session.peer!.publicKey, name: session.peer!.name, createdAt: Date.now() };
        setProposal(offer);
      },
      onPairResult: (pairId, accepted) => {
        const pending = pendingRef.current;
        if (!pending || pending.pairId !== pairId) return;
        if (accepted) {
          setSessionPair(pending);
          setPairStatus("saved");
        } else {
          void convex.mutation(api.pairing.forget, { pairId, token: pending.token }).then(() => removePair(pairId)).catch(error => setNotice(readableError(error)));
          setPairStatus("none");
          setNotice("The other device declined pairing.");
        }
        pendingRef.current = null;
      },
    });
    sessionRef.current = session;
    return session;
  }
  async function remember() {
    const session = sessionRef.current;
    if (!session?.verified || !session.peer || !currentRef.current.identity || pairStatus !== "none" || currentRef.current.pairs.length >= 20) return;
    setPairStatus("saving"); setNotice(null);
    const pairId = randomToken();
    const token = randomToken();
    const remoteToken = randomToken();
    try {
      await convex.mutation(api.pairing.create, { pairId, tokenA: token, hashB: await hashToken(remoteToken) });
      if (sessionRef.current !== session) { await convex.mutation(api.pairing.forget, { pairId, token }); return; }
      const pair = { pairId, token, name: session.peer.name, publicKey: session.peer.publicKey, createdAt: Date.now() };
      savePair(pair);
      pendingRef.current = pair;
      session.send({ type: "pair-offer", pairId, token: remoteToken });
      setPairStatus("waiting");
    } catch (error) {
      void convex.mutation(api.pairing.forget, { pairId, token }).catch(() => {});
      setPairStatus("none"); setNotice(readableError(error));
    }
  }
  async function answerPair(accept: boolean) {
    const pending = pendingRef.current;
    const session = sessionRef.current;
    if (!pending || !session) return;
    setPairStatus("saving");
    try {
      if (accept) {
        savePair(pending);
        try { await convex.mutation(api.pairing.confirm, { pairId: pending.pairId, token: pending.token }); }
        catch (error) { removePair(pending.pairId); throw error; }
      } else await convex.mutation(api.pairing.forget, { pairId: pending.pairId, token: pending.token });
      if (sessionRef.current !== session) return;
      session.send({ type: "pair-result", pairId: pending.pairId, accepted: accept });
      setSessionPair(accept ? pending : null);
      setPairStatus(accept ? "saved" : "none");
      setProposal(null); pendingRef.current = null;
    } catch (error) { setPairStatus("none"); setNotice(readableError(error)); }
  }
  async function forget(pair: PairedDevice) {
    try {
      // Only remove the local credential after revocation succeeds, so offline failures remain retryable.
      await convex.mutation(api.pairing.forget, { pairId: pair.pairId, token: pair.token });
      removePair(pair.pairId);
      setNotice(null);
    } catch { setNotice("Could not revoke this pairing. Reconnect to the internet and try Forget again."); }
  }
  async function clearInvite(pair: PairedDevice, code: string) {
    await convex.mutation(api.pairing.clearInvite, { pairId: pair.pairId, token: pair.token, code });
  }
  const entries = pairs.map(pair => {
    const status = live?.find(item => item.pairId === pair.pairId);
    const valid = !!status?.confirmed && status.expiresAt > now;
    return { ...pair, valid, online: valid && now - status!.peerLastSeen < 60_000,
      state: live === undefined ? "checking" : !status || status.expiresAt <= now ? "expired" : !status.confirmed ? "pending" : "paired",
      invite: valid && status?.invite && status.invite.expiresAt > now ? status.invite : null };
  });
  return { ready, identity, name, rename, entries, notice, peer, proposal, pairStatus, sessionPair, attach, clearConnection, remember, answerPair, forget, clearInvite };
}
