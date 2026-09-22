"use client";

import { useConvex, useMutation, useQuery } from "convex/react";
import {
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/convex/_generated/api";
import { createDownloadArchive } from "@/lib/download-archive";
import { Icon } from "@/components/icon";
import { QuickStart } from "@/components/quick-start";
import { ConnectionCheck } from "@/components/connection-check";
import { JoinQr } from "@/components/join-qr";
import {
  createPeerConnection,
  createSafetyCode,
  discoverClientLanHost,
  formatBytes,
  formatRoomCode,
  makeHostSecret,
  makeRoomCode,
  normalizeRoomCode,
  parseDescription,
  readableError,
  senderLanHost,
  shareOriginForLocation,
  serializeDescription,
  serializeIceCandidate,
  waitForIceGathering,
} from "@/lib/peer";
import { MAX_CONTROL_LENGTH, MAX_BATCH_BYTES, MAX_TRANSFER_BYTES, MAX_BATCH_FILES, isTransferControlMessage, validateFiles } from "@/lib/transfer-protocol";
import { canReceiveToFolder, chooseReceiveFolder } from "@/lib/receive-folder";
import { TransferSession, type TransferOffer, type TransferProgress } from "@/lib/transfer-session";
import { BoundedMessageQueue } from "@/lib/message-queue";
import { DeviceHandshake, isDeviceMessage } from "@/lib/device-handshake";
import type { PairedDevice } from "@/lib/device-identity";
import { useDevicePairs } from "@/components/use-device-pairs";

// Files: */* steers Android toward Documents (avoids Sound Recorder).
// Photos: image/* + HEIC — separate control so gallery opens without capture=.
const FILE_INPUT_ACCEPT = "*/*";
const PHOTO_INPUT_ACCEPT = "image/*,.heic,.heif,image/heic,image/heif";


type Mode = "send" | "receive";
type Stage =
  | "selecting"
  | "idle"
  | "preparing"
  | "waiting"
  | "connecting"
  | "connected"
  | "transferring"
  | "complete"
  | "error";

type RoomCredentials = {
  code: string;
  hostSecret: string;
  offer: string;
  expiresAt: number;
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  url: string;
  blob: Blob;
};

export function DirectShare() {
  const convex = useConvex();
  const pairing = useDevicePairs();
  const createSignalRoom = useMutation(api.signals.createRoom);
  const joinSignalRoom = useMutation(api.signals.joinRoom);
  const closeSignalRoom = useMutation(api.signals.closeRoom);
  const addHostCandidate = useMutation(api.signals.addHostCandidate);
  const addGuestCandidate = useMutation(api.signals.addGuestCandidate);

  const [pendingInvite, setPendingInvite] = useState<string | null>(null);
  const attemptedInvites = useRef(new Set<string>());
  const [mode, setMode] = useState<Mode>("send");
  const [stage, setStage] = useState<Stage>("idle");
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const [files, setFiles] = useState<File[]>([]);
  const [room, setRoom] = useState<RoomCredentials | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [status, setStatus] = useState("Choose what you want to do.");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [safetyCode, setSafetyCode] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<ReceivedFile[]>([]);
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [origin, setOrigin] = useState("");
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [incomingOffer, setIncomingOffer] = useState<TransferOffer | null>(null);
  const [transferStats, setTransferStats] = useState<TransferProgress | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(600);
  const [pairingConfirmOpen, setPairingConfirmOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [folderSupported, setFolderSupported] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [savedToFolder, setSavedToFolder] = useState(0);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [needsSpace, setNeedsSpace] = useState(false);
  const continueRef = useRef<(() => void) | null>(null);
  useEffect(() => { setFolderSupported(canReceiveToFolder()); }, []);
  const retainedBytesRef = useRef(0);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connectedPair, setConnectedPair] = useState<PairedDevice | null>(null);
  const sessionRef = useRef<TransferSession | null>(null);
  const handshakeRef = useRef<DeviceHandshake | null>(null);
  const generationRef = useRef(0);
  const activePairRef = useRef<PairedDevice | null>(null);
  const hostRoomRef = useRef<RoomCredentials | null>(null);
  const activeCodeRef = useRef<string | null>(null);
  const guestSecretRef = useRef("");

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const appliedCandidatesRef = useRef<Set<string>>(new Set());
  const [activeJoinCode, setActiveJoinCode] = useState<string | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const applyingAnswerRef = useRef(false);
  const downloadUrlsRef = useRef<string[]>([]);
  const hostAnswer = useQuery(
    api.signals.getAnswerForHost,
    room && (stage === "waiting" || stage === "connecting")
      ? { code: room.code, hostSecret: room.hostSecret }
      : "skip",
  );

  const hostCandidatesLive = useQuery(
    api.signals.getHostCandidates,
    activeJoinCode ? { code: activeJoinCode, guestSecret: guestSecretRef.current } : "skip",
  );

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );
  const shareUrl = room && origin ? `${origin}/#join=${room.code}` : "";
  const isConnected = linkOpen && ["selecting", "connected", "transferring", "complete"].includes(stage);
  const shouldKeepScreenAwake = [
    "waiting",
    "connecting",
    "connected",
    "transferring",
  ].includes(stage);

  useEffect(() => {
    setOrigin(
      shareOriginForLocation(
        window.location.origin,
        process.env.NEXT_PUBLIC_SIMPLE_SHARE_LAN_HOST ?? "",
      ),
    );
    setCanNativeShare(typeof navigator.share === "function");
    const incomingCode = normalizeRoomCode(
      new URLSearchParams(window.location.hash.slice(1)).get("join") ??
      new URLSearchParams(window.location.search).get("join") ?? "",
    );
    if (incomingCode.length === 8) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("join");
      cleanUrl.hash = "";
      window.history.replaceState(null, "", cleanUrl);
      setMode("receive");
      setJoinCode(formatRoomCode(incomingCode));
      setPendingInvite(incomingCode);
      setStatus("Joining the sender’s room…");
    }

    return () => {
      sessionRef.current?.dispose();
      handshakeRef.current?.stop();
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      generationRef.current += 1;
      channelRef.current?.close();
      peerRef.current?.close();
      downloadUrlsRef.current.forEach(URL.revokeObjectURL);
    };
  }, []);

  useEffect(() => {
    if (!pairing.ready || stage !== "idle" || files.length || linkOpen) return;
    const saved = pairing.entries.find(device => device.valid && device.invite && !attemptedInvites.current.has(device.invite.code));
    const code = pendingInvite ?? saved?.invite?.code;
    if (!code || attemptedInvites.current.has(code)) return;
    const timer = window.setTimeout(() => {
      attemptedInvites.current.add(code);
      setPendingInvite(null);
      void joinRoom(code, pendingInvite ? null : saved ?? null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pairing.ready, pairing.entries, pendingInvite, stage, files.length, linkOpen]);

  useEffect(() => {
    let cancelled = false;

    async function requestWakeLock() {
      if (
        cancelled ||
        !shouldKeepScreenAwake ||
        document.visibilityState !== "visible" ||
        !("wakeLock" in navigator) ||
        (wakeLockRef.current && !wakeLockRef.current.released)
      ) {
        return;
      }

      try {
        const wakeLock = await navigator.wakeLock.request("screen");
        if (cancelled || document.visibilityState !== "visible") {
          await wakeLock.release();
          return;
        }

        wakeLockRef.current = wakeLock;
        setWakeLockActive(true);
        wakeLock.addEventListener(
          "release",
          () => {
            if (wakeLockRef.current === wakeLock) wakeLockRef.current = null;
            setWakeLockActive(false);
          },
          { once: true },
        );
      } catch {
        setWakeLockActive(false);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void requestWakeLock();
    }

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      setWakeLockActive(false);
      if (wakeLock && !wakeLock.released) void wakeLock.release().catch(() => {});
    };
  }, [shouldKeepScreenAwake]);

  useEffect(() => {
    if (
      !room ||
      !hostAnswer?.answer ||
      !peerRef.current ||
      peerRef.current.remoteDescription ||
      applyingAnswerRef.current
    ) {
      return;
    }

    const generation = generationRef.current;
    applyingAnswerRef.current = true;
    setStage("connecting");
    setStatus("The other device joined. Securing the direct path…");

    void (async () => {
      try {
        const peer = peerRef.current;
        if (!peer) return;
        await peer.setRemoteDescription(parseDescription(hostAnswer.answer!));
        for (const raw of hostAnswer.guestCandidates ?? []) {
          if (appliedCandidatesRef.current.has(raw)) continue;
          appliedCandidatesRef.current.add(raw);
          try {
            await peer.addIceCandidate(JSON.parse(raw) as RTCIceCandidateInit);
          } catch {
            // The complete answer also contains gathered candidates.
          }
        }
        const code = await createSafetyCode(room.offer, hostAnswer.answer!);
        if (generationRef.current === generation) setSafetyCode(code);
      } catch (caught) {
        if (generationRef.current === generation) fail(caught);
      } finally {
        if (generationRef.current === generation) applyingAnswerRef.current = false;
      }
    })();
  }, [hostAnswer?.answer, room]);

  // Trickle: apply guest ICE candidates as they land in Convex.
  useEffect(() => {
    const peer = peerRef.current;
    const list = hostAnswer?.guestCandidates;
    if (!peer || !peer.remoteDescription || !list?.length) return;
    for (const raw of list) {
      if (appliedCandidatesRef.current.has(raw)) continue;
      appliedCandidatesRef.current.add(raw);
      try {
        const init = JSON.parse(raw) as RTCIceCandidateInit;
        void peer.addIceCandidate(init).catch(() => {});
      } catch {
        // ignore malformed
      }
    }
  }, [hostAnswer?.guestCandidates]);


  // Trickle: receiver applies host ICE candidates.
  useEffect(() => {
    const peer = peerRef.current;
    if (!peer || !peer.remoteDescription || !hostCandidatesLive?.length) return;
    for (const raw of hostCandidatesLive) {
      if (appliedCandidatesRef.current.has(raw)) continue;
      appliedCandidatesRef.current.add(raw);
      try {
        const init = JSON.parse(raw) as RTCIceCandidateInit;
        void peer.addIceCandidate(init).catch(() => {});
      } catch {
        // ignore malformed
      }
    }
  }, [hostCandidatesLive]);

  useEffect(() => {
    if (!room || !["waiting", "connecting"].includes(stage)) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (!remaining) fail(new Error("This room expired. Create a new room to try again."));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [room, stage]);

  useEffect(() => {
    if (room && stage === "waiting" && hostAnswer === null) fail(new Error("This room closed or the connection request was declined. Open a new connection to try again."));
  }, [room, stage, hostAnswer]);

  useEffect(() => {
    if (stage !== "preparing" && stage !== "connecting") return;
    const timer = window.setTimeout(() => { setConnectionFailed(true); fail(new Error("Connection test timed out. Open Details above for help, then try a new room.")); }, 45_000);
    return () => window.clearTimeout(timer);
  }, [stage]);

  useEffect(() => {
    const watchedPair = connectedPair ?? pairing.sessionPair;
    if (!watchedPair) return;
    const entry = pairing.entries.find(item => item.pairId === watchedPair.pairId);
    if (!entry || entry.state === "expired") fail(new Error("This pairing was removed or expired. Connect with a room code to pair again."));
  }, [connectedPair, pairing.sessionPair, pairing.entries]);

  function fail(caught: unknown) {
    closePeer();
    setError(readableError(caught));
    setStage("error");
    setStatus("The connection stopped. You can try again.");
  }

  function closePeer() {
    generationRef.current += 1;
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = null;
    setLinkOpen(false);
    sessionRef.current?.dispose();
    handshakeRef.current?.stop();
    sessionRef.current = null;
    handshakeRef.current = null;
    pairing.clearConnection();
    channelRef.current?.close();
    peerRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
    applyingAnswerRef.current = false;
    setIncomingOffer(null);
    setActiveJoinCode(null);
    setConnectedPair(null);
    setPairingConfirmOpen(false);
    const currentRoom = hostRoomRef.current;
    const currentPair = activePairRef.current;
    const currentCode = activeCodeRef.current;
    if (currentRoom) void closeSignalRoom({ code: currentRoom.code, hostSecret: currentRoom.hostSecret }).catch(() => {});
    if (currentPair && currentCode) void pairing.clearInvite(currentPair, currentCode).catch(() => {});
    hostRoomRef.current = null;
    activePairRef.current = null;
    activeCodeRef.current = null;
  }

  function reset(nextMode: Mode = mode) {
    setFolderName(null); setSavedToFolder(0); setNeedsSpace(false);
    closePeer();
    setRoom(null);
    setJoinCode("");
    setPendingInvite(null);
    setFiles([]);
    setProgress(0);
    setTransferStats(null);
    setSafetyCode(null);
    setError(null);
    setCopied(false);
    setConnectionFailed(false);
    setStage("idle");
    setMode(nextMode);
    appliedCandidatesRef.current = new Set();
    setStatus(nextMode === "send" ? "Choose files to send." : "Enter a room code.");
  }

  function wirePeerState(peer: RTCPeerConnection) {
    const generation = generationRef.current;
    peer.addEventListener("connectionstatechange", () => {
      if (generationRef.current !== generation) return;
      if (stageRef.current === "complete" && ["disconnected", "failed", "closed"].includes(peer.connectionState)) {
        closePeer();
        return;
      }
      if (peer.connectionState === "connected") {
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      } else if (peer.connectionState === "disconnected") {
        setStatus("The direct path was interrupted. Keep both apps open…");
        if (!disconnectTimerRef.current) disconnectTimerRef.current = setTimeout(() => {
          if (generationRef.current === generation) fail(new Error("The other device disconnected. Files already received remain available below."));
        }, 15_000);
      } else if (peer.connectionState === "failed") {
        setConnectionFailed(true);
        fail(new Error("The browsers could not establish a direct connection. Open Details above or How it works below for help."));
      }
    });
  }

  function setupChannel(channel: RTCDataChannel, role: Mode, peer: RTCPeerConnection) {
    const generation = generationRef.current;
    const active = () => generationRef.current === generation;
    const target = activePairRef.current;
    channelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    let receivedOnDisk = false;
    const session = new TransferSession(channel, role, {
      onOffer: offer => {
        if (!active()) return;
        setIncomingOffer(offer);
        if (offer) {
          receivedOnDisk = false;
          setFolderName(null); setSavedToFolder(0); setNeedsSpace(false);
          setTransferStats(null); setProgress(0); setStage("connected");
          setStatus("Accept to start the transfer.");
        }
      },
      onStart: () => { if (active()) { setStage("transferring"); setProgress(0); } },
      onStatus: value => { if (active()) setStatus(value); },
      onProgress: stats => { if (active()) { setTransferStats(stats); setProgress(stats.total ? stats.bytes / stats.total * 100 : 100); } },
      onFile: file => {
        if (!active()) return;
        if (!file.blob) { receivedOnDisk = true; setSavedToFolder(count => count + 1); return; }
        const url = URL.createObjectURL(file.blob);
        downloadUrlsRef.current.push(url);
        retainedBytesRef.current += file.size;
        setDownloads(items => [...items, { id: file.id, name: file.name, size: file.size, url, blob: file.blob! }]);
      },
      onComplete: () => { if (active()) { setProgress(100); setStage("complete"); setStatus(role === "send" ? "The other device confirmed every file arrived." : receivedOnDisk ? "Every file was saved to your chosen folder." : "Every file arrived. Save your files below."); } },
      onError: error => { if (active()) fail(error); },
    });
    sessionRef.current = session;
    const handshake = pairing.attach(channel, peer, target, role, () => {
      if (!active()) return;
      setConnectedPair(target);
      setLinkOpen(true);
      setStage("connected");
      setStatus(target ? `Connected to ${target.name}. Device identity verified.` : role === "send" ? "Direct path ready." : "Connected. Waiting for files…");
      const currentRoom = hostRoomRef.current;
      if (currentRoom) void closeSignalRoom({ code: currentRoom.code, hostSecret: currentRoom.hostSecret }).catch(() => {});
      if (target && activeCodeRef.current) void pairing.clearInvite(target, activeCodeRef.current).catch(() => {});
      if (role === "send") void session.send(files);
    }, error => { if (active()) fail(error); });
    handshakeRef.current = handshake;
    channel.addEventListener("open", () => { if (active()) handshake.start(); });
    const messageQueue = new BoundedMessageQueue(error => { if (active()) fail(error); });
    channel.addEventListener("message", event => {
      messageQueue.push(event.data, async () => {
        if (!active()) return;
        try {
          if (typeof event.data === "string") {
            if (event.data.length > MAX_CONTROL_LENGTH) throw new Error("The other device sent oversized transfer details.");
            const parsed: unknown = JSON.parse(event.data);
            if (isDeviceMessage(parsed)) { await handshake.receive(parsed); return; }
            if (!isTransferControlMessage(parsed) || (!handshake.verified && parsed.type !== "cancel")) throw new Error("The other device sent invalid transfer details. Refresh both devices and try again.");
            session.receive(parsed);
          } else if (event.data instanceof ArrayBuffer) {
            if (!handshake.verified) throw new Error("File data arrived before device verification.");
            session.receive(event.data);
          } else throw new Error("Unsupported transfer data.");
        } catch (caught) { if (active()) fail(caught); }
      });
    });
    channel.addEventListener("close", () => { if (active()) setLinkOpen(false); });
    channel.addEventListener("error", () => {
      if (!active()) return;
      if (stageRef.current === "complete") { closePeer(); return; }
      fail(new Error("The encrypted transfer channel reported an error."));
    });
    if (channel.readyState === "open") handshake.start();
  }

  function selectMoreFiles() {
    if (!sessionRef.current?.canSendMore) { reset("send"); return; }
    setFiles([]); setProgress(0); setTransferStats(null); setError(null);
    setStage("selecting");
    setStatus("Choose more files for this device. It will approve the new transfer.");
  }

  function sendMoreFiles() {
    const session = sessionRef.current;
    if (!session?.canSendMore) { fail(new Error("The connection closed. Create a new room to send these files.")); return; }
    try { validateFiles(files); } catch (caught) { setError(readableError(caught)); return; }
    setError(null); setStage("connected");
    void session.send(files);
  }

  function addFiles(nextFiles: File[]) {
    if (!nextFiles.length) return;
    try {
      const selection = [...files, ...nextFiles];
      validateFiles(selection);
      setFiles(selection);
      setError(null);
      setStatus("Files stay on this device until the other device accepts.");
    } catch (caught) { setError(readableError(caught)); }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function openRoom(target: PairedDevice | null = null) {
    if (!files.length) {
      setError("Choose at least one file first.");
      return;
    }

    setError(null);
    setConnectionFailed(false);
    setStage("preparing");
    setStatus("Preparing a private room…");
    closePeer();
    setSafetyCode(null);
    setTransferStats(null);
    const generation = generationRef.current;
    activePairRef.current = target;

    try {
      validateFiles(files);
      const peer = createPeerConnection();
      peerRef.current = peer;
      appliedCandidatesRef.current = new Set();
      const channel = peer.createDataChannel("simple-share", { ordered: true });
      setupChannel(channel, "send", peer);

      const hostSecret = makeHostSecret();
      let code = makeRoomCode();
      const lanHost = senderLanHost();
      const queuedCandidates: string[] = [];
      let roomIsReady = false;

      const publishHost = (candidate: RTCIceCandidate | null) => {
        if (!candidate || generationRef.current !== generation) return;
        const raw = serializeIceCandidate(candidate, lanHost);
        if (!roomIsReady) {
          queuedCandidates.push(raw);
          return;
        }
        void addHostCandidate({ code, hostSecret, candidate: raw }).catch(() => {});
      };
      // Candidate events can fire immediately after setLocalDescription, so the
      // listener must exist before gathering starts.
      peer.addEventListener("icecandidate", (event) => publishHost(event.candidate));

      await peer.setLocalDescription(await peer.createOffer());
      // Short gather so the room opens quickly; remaining candidates trickle via Convex.
      await waitForIceGathering(peer);
      if (generationRef.current !== generation) return;
      const offer = serializeDescription(peer.localDescription, lanHost);

      let result: { expiresAt: number } | null = null;
      for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
        try {
          result = await createSignalRoom({ code, offer, hostSecret, ...(target ? { pairing: { pairId: target.pairId, token: target.token } } : {}) });
        } catch (caught) {
          if (attempt === 2 || !readableError(caught).includes("already in use")) throw caught;
          code = makeRoomCode();
        }
      }
      if (!result) throw new Error("A room code could not be created.");

      if (generationRef.current !== generation) {
        await closeSignalRoom({ code, hostSecret });
        if (target) await pairing.clearInvite(target, code);
        return;
      }
      roomIsReady = true;
      for (const candidate of queuedCandidates) {
        void addHostCandidate({ code, hostSecret, candidate }).catch(() => {});
      }

      wirePeerState(peer);
      activeCodeRef.current = code;
      hostRoomRef.current = { code, hostSecret, offer, expiresAt: result.expiresAt };
      setRoom({ code, hostSecret, offer, expiresAt: result.expiresAt });
      setStage("waiting");
      setStatus(
        target ? `Waiting for ${target.name} to accept the connection. Keep Simple Share open on both devices.` : "Share the link, QR code, or room code with your other device.",
      );
    } catch (caught) {
      if (generationRef.current === generation) fail(caught);
    }
  }

  async function joinRoom(codeOverride?: string, target: PairedDevice | null = null) {
    const code = normalizeRoomCode(codeOverride ?? joinCode);
    if (code.length !== 8) {
      setError("Enter the full eight-character room code.");
      return;
    }

    setError(null);
    setConnectionFailed(false);
    setStage("preparing");
    setStatus("Finding the sender…");
    closePeer();
    setSafetyCode(null);
    setTransferStats(null);
    setMode("receive");
    const generation = generationRef.current;
    activePairRef.current = target;
    activeCodeRef.current = code;
    const guestSecret = makeHostSecret();
    guestSecretRef.current = guestSecret;
    try {
      const signalRoom = await convex.query(api.signals.getRoomForJoin, { code, ...(target ? { pairingToken: target.token } : {}) });
      if (generationRef.current !== generation) return;
      if (!signalRoom || signalRoom.expiresAt <= Date.now()) throw new Error("That room was not found or has expired.");
      if (signalRoom.state === "joined") {
        throw new Error("Another device already joined this room.");
      }

      const peer = createPeerConnection();
      peerRef.current = peer;
      appliedCandidatesRef.current = new Set();

      wirePeerState(peer);
      peer.addEventListener("datachannel", (event) => {
        if (generationRef.current !== generation || channelRef.current || event.channel.label !== "simple-share") {
          event.channel.close();
          return;
        }
        setupChannel(event.channel, "receive", peer);
      });

      // Unlike the sender, the receiver cannot use location.hostname: that is
      // the sender's address. Ask the local server which client address connected.
      const lanHost = await discoverClientLanHost();
      if (generationRef.current !== generation) return;
      const queuedCandidates: string[] = [];
      let joined = false;
      peer.addEventListener("icecandidate", (event) => {
        if (!event.candidate || generationRef.current !== generation) return;
        const raw = serializeIceCandidate(event.candidate, lanHost);
        if (!joined) queuedCandidates.push(raw);
        else void addGuestCandidate({ code, guestSecret, candidate: raw }).catch(() => {});
      });
      await peer.setRemoteDescription(parseDescription(signalRoom.offer));
      // Apply host candidates only after remote description is set.
      for (const raw of signalRoom.hostCandidates ?? []) {
        if (appliedCandidatesRef.current.has(raw)) continue;
        appliedCandidatesRef.current.add(raw);
        try {
          await peer.addIceCandidate(JSON.parse(raw) as RTCIceCandidateInit);
        } catch {
          // ignore
        }
      }
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIceGathering(peer);
      const answer = serializeDescription(peer.localDescription, lanHost);
      if (generationRef.current !== generation) return;
      await joinSignalRoom({ code, answer, guestSecret, ...(target ? { pairingToken: target.token } : {}) });
      if (generationRef.current !== generation) return;
      joined = true;
      setActiveJoinCode(code);
      for (const candidate of queuedCandidates) void addGuestCandidate({ code, guestSecret, candidate }).catch(() => {});

      setSafetyCode(await createSafetyCode(signalRoom.offer, answer));
      if (generationRef.current !== generation) return;
      setStage(current => current === "connected" ? current : "connecting");
      if (!handshakeRef.current?.verified) setStatus("Securing a direct path to the sender…");
    } catch (caught) {
      if (generationRef.current === generation) fail(caught);
    }
  }

  function clearReceived() {
    downloadUrlsRef.current.forEach(URL.revokeObjectURL);
    downloadUrlsRef.current = [];
    retainedBytesRef.current = 0;
    setDownloads([]);
  }

  function approveInMemory() {
    sessionRef.current?.approve({
      retainedBytes: retainedBytesRef.current,
      beforeFile: (_size, signal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error("Transfer cancelled.")); return; }
        setNeedsSpace(true);
        setStatus("Save the received files, then continue with the next batch.");
        const abort = () => { continueRef.current = null; setNeedsSpace(false); reject(new Error("Transfer cancelled.")); };
        signal.addEventListener("abort", abort, { once: true });
        continueRef.current = () => {
          signal.removeEventListener("abort", abort);
          clearReceived(); setNeedsSpace(false); continueRef.current = null; resolve();
        };
      }),
    });
  }

  async function approveToFolder() {
    const session = sessionRef.current;
    if (!session || choosingFolder) return;
    setChoosingFolder(true); setError(null);
    try {
      const folder = await chooseReceiveFolder();
      if (sessionRef.current !== session) return;
      setFolderName(folder.name); setSavedToFolder(0);
      session.approve({ openFile: folder.openFile });
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(readableError(caught));
    } finally { setChoosingFolder(false); }
  }

  function cancelConnection() {
    sessionRef.current?.cancel();
    fail(new Error(downloads.length
      ? "Cancelled. Files already received are still available below."
      : mode === "send"
        ? "Cancelled. Your selected files are ready to try again."
        : "Cancelled. Enter a room code to try again."));
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("The browser could not copy the link. Select the room code instead.");
    }
  }

  async function shareLink() {
    if (!shareUrl) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Join my Simple Share room",
          text: `Use room code ${formatRoomCode(room?.code ?? "")}`,
          url: shareUrl,
        });
        return;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
      }
    }
    await copyLink();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Simple Share home">
          <span className="brand-mark"><Icon name="send" /></span>
          <span>Simple Share</span>
        </a>
        <span className="privacy-pill"><Icon name="shield" /> No server storage</span>
      </header>

      <section className="app-content" aria-label="File transfer">
        <div className="transfer-card">
          {stage === "idle" && <QuickStart mode={mode} />}

          <div className="mode-switch" role="group" aria-label="Transfer direction">
            <button
              className={mode === "send" ? "selected" : ""}
              onClick={() => { if (mode !== "send") reset("send"); }}
              disabled={!["idle", "error", "complete", "selecting"].includes(stage)}
              aria-pressed={mode === "send"}
            ><Icon name="send" /> Send</button>
            <button
              className={mode === "receive" ? "selected" : ""}
              onClick={() => { if (mode !== "receive") reset("receive"); }}
              disabled={!["idle", "error", "complete", "selecting"].includes(stage)}
              aria-pressed={mode === "receive"}
            ><Icon name="receive" /> Receive</button>
          </div>

          <div className="panel-heading">
            <div>
              <h1>{panelTitle(mode, stage)}</h1>
              {!["idle", "waiting"].includes(stage) && <p role="status" aria-live="polite">{status}</p>}
            </div>
            {stage !== "idle" && stage !== "preparing" && stage !== "error" && (
              <span className={`state-dot ${isConnected ? "online" : ""}`}>
                {isConnected ? "Connected" : stage === "waiting" ? "Room open" : stage === "complete" ? "Complete" : "Working"}
              </span>
            )}
          </div>

          {error && !connectionFailed && <div className="error-banner" role="alert">{error}</div>}
          {connectionFailed && <ConnectionCheck />}

          {mode === "send" ? (
            <SendPanel
              files={files}
              targetName={activePairRef.current?.name ?? null}
              totalSize={totalSize}
              stage={stage}
              room={room}
              shareUrl={shareUrl}
              copied={copied}
              canNativeShare={canNativeShare}
              progress={progress}
              safetyCode={safetyCode}
              onFiles={addFiles}
              onDrop={handleDrop}
              onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
              onOpenRoom={() => void openRoom()}
              onCopy={copyLink}
              onShare={shareLink}
              onReset={selectMoreFiles}
              canSendMore={!!sessionRef.current?.canSendMore}
              onSendMore={sendMoreFiles}
              devices={pairing.entries.filter(device => device.valid && device.online)}
              onSendToDevice={device => void openRoom(device)}
            />
          ) : (
            <ReceivePanel
              stage={stage}
              code={joinCode}
              hasOffer={!!incomingOffer}
              connected={linkOpen}
              progress={progress}
              safetyCode={safetyCode}
              onCode={(value) => setJoinCode(formatRoomCode(value))}
              onJoin={() => void joinRoom()}
              onReset={() => reset("receive")}
            />
          )}

          {downloads.length > 0 && <Downloads files={downloads} onClear={clearReceived} />}
          {folderName && <p role="status">Saved {savedToFolder} files to {folderName}.</p>}
          {needsSpace && (
            <div className="approval-panel" role="region" aria-label="Save received batch">
              <strong>Save this batch to continue</strong>
              <p>Download these files first. Continue clears this batch and receives the next.</p>
              <button className="primary-button" onClick={() => continueRef.current?.()}>I’ve saved these — continue</button>
            </div>
          )}
          {incomingOffer && (
            <div className="approval-panel" role="region" aria-label="Incoming transfer">
              <strong>Accept {incomingOffer.count} {incomingOffer.count === 1 ? "file" : "files"}?</strong>
              <p>{formatBytes(incomingOffer.totalBytes)} from {connectedPair?.name ?? pairing.peer?.name ?? "the connected device"}.</p>
              {!folderSupported && incomingOffer.totalBytes > MAX_BATCH_BYTES && <p>{(incomingOffer.largestFile ?? incomingOffer.totalBytes) > MAX_BATCH_BYTES ? "This file needs a desktop browser with folder saving. Try Chrome on a computer." : "You’ll download this transfer in batches. We’ll pause when it’s time to save."}</p>}
              {downloads.length > 0 && retainedBytesRef.current + incomingOffer.totalBytes > MAX_BATCH_BYTES && !(folderSupported && incomingOffer.totalBytes > MAX_BATCH_BYTES) && <p>We’ll pause if you need to save previous downloads to make room.</p>}
              <div className="pair-actions">
                {folderSupported && incomingOffer.totalBytes > MAX_BATCH_BYTES
                  ? <button className="primary-button" disabled={choosingFolder} onClick={() => void approveToFolder()}>{choosingFolder ? "Choosing location…" : "Choose save location"}</button>
                  : <button className="primary-button" disabled={(incomingOffer.largestFile ?? incomingOffer.totalBytes) > MAX_BATCH_BYTES} onClick={approveInMemory}>Accept files</button>}
                <button className="text-button" onClick={() => sessionRef.current?.decline()}>Decline</button>
              </div>
            </div>
          )}
          {transferStats && stage === "transferring" && !needsSpace && (
            <p className="transfer-details">{formatBytes(transferStats.bytes)} of {formatBytes(transferStats.total)} · {formatBytes(transferStats.bytesPerSecond)}/s{transferStats.remainingSeconds !== null ? ` · About ${formatDuration(transferStats.remainingSeconds)} left` : ""}</p>
          )}
          {stage === "waiting" && <p className="room-expiry">Room expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</p>}
          {["selecting", "preparing", "waiting", "connecting", "connected", "transferring"].includes(stage) && (
            <button className="secondary-button full cancel-button" onClick={cancelConnection}>Cancel {stage === "transferring" ? "transfer" : "connection"}</button>
          )}

          {isConnected && pairing.peer && pairing.identity && (
            <section className={`remember-device ${pairing.pairStatus === "saved" ? "remembered" : ""}`} aria-label="Remember connected device">
              <div className="remember-device-heading">
                <span className="remember-device-icon"><Icon name={pairing.pairStatus === "saved" ? "check" : "device"} /></span>
                <div><strong>{pairing.peer.name}</strong><p>{pairing.pairStatus === "saved" ? "Remembered · Connect without a room code" : "Remember for 30 days. Skip the room code next time."}</p></div>
                {mode === "send" && pairing.pairStatus === "none" && !pairingConfirmOpen && <button className="secondary-button" onClick={() => setPairingConfirmOpen(true)}>Remember device</button>}
              </div>
              {pairing.pairStatus === "waiting" && <p className="remember-status" role="status">Approve on {pairing.peer.name} to finish.</p>}
              {pairing.pairStatus === "saving" && <p className="remember-status" role="status">Saving…</p>}
              {pairing.pairStatus === "none" && (pairingConfirmOpen || pairing.proposal) && (
                <div className="remember-confirm">
                  <strong>{pairing.proposal ? `${pairing.peer.name} wants to pair` : "Do the codes match?"}</strong>
                  <p>Compare with the other screen before remembering this device.</p>
                  <span className="remember-code">{safetyCode ?? "Checking…"}</span>
                  <div className="pair-actions">
                    <button className="primary-button" disabled={!safetyCode} onClick={() => { if (pairing.proposal) void pairing.answerPair(true); else void pairing.remember(); }}>Codes match — remember</button>
                    <button className="text-button" onClick={() => { setPairingConfirmOpen(false); if (pairing.proposal) void pairing.answerPair(false); }}>Not now</button>
                  </div>
                </div>
              )}
              {mode === "receive" && pairing.pairStatus === "none" && !pairing.proposal && <p className="remember-status">Choose “Remember device” on the sender to pair.</p>}
            </section>
          )}

          <section className="paired-devices" aria-label="Paired devices">
            <div className="device-section-heading"><h2>Saved devices</h2></div>
            {pairing.identity && <details className="device-name-settings"><summary>This device: {pairing.name || "My device"}</summary><label className="device-name-field">Device name<input value={pairing.name} onChange={event => pairing.rename(event.target.value)} maxLength={60} autoComplete="off" /></label></details>}
            {pairing.entries.length === 0 && <p>Connect once, then remember the device for next time.</p>}
            {pairing.entries.map(device => (
              <div className="paired-device" key={device.pairId}>
                <Icon name="device" />
                <div className="paired-device-info"><strong>{device.name}</strong><span>{device.state === "checking" ? "Checking availability…" : device.state === "expired" ? "Pairing expired or removed" : device.state === "pending" ? "Waiting for pairing approval" : isConnected && (connectedPair ?? pairing.sessionPair)?.pairId === device.pairId ? "Connected" : device.invite ? "Connection requested" : device.online ? "Available" : "Offline — open Simple Share on this device"}</span></div>
                <div className="device-actions">
                  {mode === "send" && device.valid && <button className="secondary-button" disabled={!files.length || !device.online || !["idle", "error"].includes(stage)} onClick={() => void openRoom(device)}>Send</button>}
                  <button className="text-button" onClick={() => void pairing.forget(device)}>Forget</button>
                </div>
                {device.invite && <div className="device-invitation"><p>{device.name} wants to connect.</p><div className="pair-actions"><button className="primary-button" disabled={!["idle", "error"].includes(stage)} onClick={() => void joinRoom(device.invite!.code, device)}>Accept connection</button><button className="secondary-button" onClick={() => void pairing.clearInvite(device, device.invite!.code).catch(caught => setError(readableError(caught)))}>Decline</button></div></div>}
              </div>
            ))}
            {pairing.notice && <p className="pair-notice" role="status">{pairing.notice}</p>}
          </section>

          {shouldKeepScreenAwake && <p className="network-note">{wakeLockActive ? "Keeping this screen awake" : "Keep this screen open"}</p>}
          <details className="transfer-help">
            <summary>How it works</summary>
            <p>Choose files, create a room, and share the link or QR. The receiver accepts to start.</p>
            <p>Small transfers stay in the browser until you download them. Large transfers ask for a save location where supported.</p>
            <p>Files travel encrypted between devices, with no server storage. Compare the safety codes to check you’ve connected to the right person.</p>
            <strong>Having trouble?</strong>
            <p>On Mac, allow your browser in System Settings → Privacy & Security → Local Network, then reopen it.</p>
            <p>If a connection fails, we’ll show troubleshooting here. Brave settings, VPNs, and guest Wi-Fi can block connections. Try Chrome or Samsung Internet on the same regular Wi-Fi.</p>
          </details>
        </div>
      </section>
    </main>
  );
}

function SendPanel({
  files,
  targetName,
  totalSize,
  stage,
  room,
  shareUrl,
  copied,
  canNativeShare,
  progress,
  safetyCode,
  onFiles,
  onDrop,
  onRemove,
  onOpenRoom,
  canSendMore,
  onSendMore,
  devices,
  onSendToDevice,
  onCopy,
  onShare,
  onReset,
}: {
  files: File[];
  targetName: string | null;
  totalSize: number;
  stage: Stage;
  room: RoomCredentials | null;
  shareUrl: string;
  copied: boolean;
  canNativeShare: boolean;
  progress: number;
  safetyCode: string | null;
  onFiles: (files: File[]) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onRemove: (index: number) => void;
  onOpenRoom: () => void;
  canSendMore: boolean;
  onSendMore: () => void;
  devices: PairedDevice[];
  onSendToDevice: (device: PairedDevice) => void;
  onCopy: () => void;
  onShare: () => void;
  onReset: () => void;
}) {
  if (stage === "idle" || stage === "error" || stage === "selecting") {
    return (
      <div className="panel-body">
        <FilePickZone
          files={files}
          totalSize={totalSize}
          onPicked={onFiles}
          onDrop={onDrop}
          onRemove={onRemove}
        />

        {stage !== "selecting" && devices.length > 0 && (
          <section className="device-shortcuts" aria-label="Send to a saved device">
            <h2>Send to a device</h2>
            {devices.map(device => <button key={device.pairId} className="secondary-button" disabled={!files.length} onClick={() => onSendToDevice(device)}><Icon name="device" /><span>{device.name}</span><Icon name="send" /></button>)}
            {!files.length && <p>Choose files, then tap a device to send.</p>}
          </section>
        )}
        <button className="primary-button" onClick={stage === "selecting" ? onSendMore : onOpenRoom} disabled={!files.length}>
          {stage === "selecting" ? "Send files" : devices.length ? "Share with a room code" : "Create room"} <Icon name={stage === "selecting" ? "send" : "link"} />
        </button>
      </div>
    );
  }

  if (stage === "preparing") return <LoadingState label="Creating a private room" />;

  if ((stage === "waiting" || stage === "connecting") && room) {
    if (targetName) return <div className="panel-body"><div className="waiting-receiver"><span className="receive-pulse"><Icon name="device" /></span><strong>{stage === "waiting" ? `Waiting for ${targetName}` : `Connecting to ${targetName}`}</strong><span>Keep Simple Share open on your other device. It connects automatically, then asks before receiving files.</span></div></div>;
    return (
      <div className="panel-body room-state">
        <div className="invite-layout">
          {shareUrl ? <JoinQr value={shareUrl} /> : <div className="qr-frame"><span className="qr-loading" /></div>}
          <div className="room-code-block">
            <span>Room code</span>
            <strong>{formatRoomCode(room.code)}</strong>
            <small>Scan or share to connect</small>
          </div>
        </div>
        <div className="share-actions">
          <button className="primary-button" onClick={onShare} disabled={!shareUrl}>
            <Icon name="share" /> {canNativeShare ? "Share invite" : copied ? "Copied" : "Copy link"}
          </button>
          {canNativeShare && <button className="secondary-button" onClick={onCopy} disabled={!shareUrl}>
            <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy link"}
          </button>}
        </div>
        <p className="invite-hint">Files send when the other device accepts.</p>
        <div className="waiting-line"><span />{stage === "waiting" ? "Waiting for the other device" : "Making the encrypted path"}</div>
      </div>
    );
  }

  return (
    <div className="panel-body">
      {safetyCode && <SafetyCode code={safetyCode} />}
      {(stage === "transferring" || stage === "complete") && <ProgressBar value={progress} />}
      {stage === "connected" && (
        <div className="ready-summary">
          <span className="ready-check"><Icon name="check" /></span>
          <div><strong>{files.length} {files.length === 1 ? "file" : "files"} offered</strong><span>{formatBytes(totalSize)} · Waiting for acceptance</span></div>
        </div>
      )}

      {stage === "complete" && <button className="secondary-button full" onClick={onReset}>{canSendMore ? "Send more" : "Start another transfer"}</button>}
    </div>
  );
}

function ReceivePanel({
  hasOffer,
  connected,
  stage,
  code,
  progress,
  safetyCode,
  onCode,
  onJoin,
  onReset,
}: {
  stage: Stage;
  code: string;
  hasOffer: boolean;
  connected: boolean;
  progress: number;
  safetyCode: string | null;
  onCode: (value: string) => void;
  onJoin: () => void;
  onReset: () => void;
}) {
  if (stage === "idle" || stage === "error") {
    return (
      <div className="panel-body">
        <label className="code-field">
          <span>Room code</span>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="go"
            inputMode="text"
            maxLength={9}
            onChange={(event) => onCode(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void onJoin(); }}
            placeholder="ABCD-2345"
            spellCheck={false}
            value={code}
          />
          <small>Enter the sender’s code.</small>
        </label>
        <button className="primary-button" onClick={onJoin} disabled={normalizeRoomCode(code).length !== 8}>
          Join room <Icon name="link" />
        </button>
      </div>
    );
  }

  if (stage === "preparing" || stage === "connecting") {
    return <LoadingState label={stage === "preparing" ? "Finding the sender" : "Securing the direct path"} />;
  }

  return (
    <div className="panel-body">
      {safetyCode && <SafetyCode code={safetyCode} />}
      {stage === "connected" && !hasOffer && (
        <div className="waiting-receiver">
          <span className="receive-pulse"><Icon name="receive" /></span>
          <strong>Waiting for files…</strong>
        </div>
      )}
      {(stage === "transferring" || stage === "complete") && <ProgressBar value={progress} />}
      {stage === "complete" && <>
        {connected && <p className="transfer-details">Ready for more files from this device. Keep this page open.</p>}
        <button className="secondary-button full" onClick={onReset}>{connected ? "Receive from another device" : "Receive another transfer"}</button>
      </>}
    </div>
  );
}

function SafetyCode({ code }: { code: string }) {
  return (
    <div className="safety-code">
      <Icon name="shield" />
      <div><span>Safety code</span><strong>{code}</strong><small>Both screens should match</small></div>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const rounded = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div className="progress-block">
      <div><span>Encrypted transfer</span><strong>{rounded}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label="Transfer progress" aria-valuenow={rounded} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${rounded}%` }} /></div>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <span className="loading-orbit"><i /></span>
      <strong>{label}</strong>
      <span>Keep both screens open.</span>
    </div>
  );
}


function FilePickZone({
  files,
  totalSize,
  onPicked,
  onDrop,
  onRemove,
}: {
  files: File[];
  totalSize: number;
  onPicked: (files: File[]) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onRemove: (index: number) => void;
}) {
  const filesInputRef = useRef<HTMLInputElement>(null);
  const photosInputRef = useRef<HTMLInputElement>(null);
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;

  useEffect(() => {
    const inputs = [filesInputRef.current, photosInputRef.current].filter(Boolean) as HTMLInputElement[];
    const onChange = (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      const picked = Array.from(input.files ?? []);
      onPickedRef.current(picked);
    };
    for (const input of inputs) input.addEventListener("change", onChange);
    return () => {
      for (const input of inputs) input.removeEventListener("change", onChange);
    };
  }, []);

  function openFiles() {
    const input = filesInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  function openPhotos() {
    const input = photosInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  return (
    <>
      <div
        className="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onDrop(event);
        }}
      >
        <span className="drop-icon"><Icon name="arrow-up" /></span>
        <strong>Choose files to send</strong>
        <span>Up to {formatBytes(MAX_TRANSFER_BYTES)} per selection · {MAX_BATCH_FILES} files</span>
        <div className="drop-actions">
          <div className="file-browse-wrap">
            <button type="button" className="secondary-button" onClick={openPhotos}>
              Photos
            </button>
            <input
              ref={photosInputRef}
              id="simple-share-photo-input"
              className="file-browse-input"
              type="file"
              accept={PHOTO_INPUT_ACCEPT}
              multiple
              aria-label="Choose photos to send"
            />
          </div>
          <div className="file-browse-wrap">
            <button type="button" className="secondary-button" onClick={openFiles}>
              Files
            </button>
            <input
              ref={filesInputRef}
              id="simple-share-file-input"
              className="file-browse-input"
              type="file"
              accept={FILE_INPUT_ACCEPT}
              multiple
              aria-label="Choose files to send"
            />
          </div>
        </div>
      </div>


      {files.length > 0 && (
        <div className="file-stack">
          <div className="file-summary">
            <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
            <span>{formatBytes(totalSize)}</span>
          </div>
          {files.map((file, index) => (
            <div className="file-row" key={`${file.name}-${file.lastModified}-${index}`}>
              <span className="file-glyph"><Icon name="file" /></span>
              <span className="file-name"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
              <button className="icon-button" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}><Icon name="x" /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function panelTitle(mode: Mode, stage: Stage) {
  if (stage === "selecting") return "Send more files";
  if (stage === "complete") return "Transfer complete";
  if (stage === "transferring") return mode === "send" ? "Sending securely" : "Receiving securely";
  if (stage === "connected") return mode === "send" ? "Waiting for acceptance" : "Incoming files";
  if (stage === "waiting") return "Room is open";
  if (stage === "connecting" || stage === "preparing") return "Connecting devices";
  return mode === "send" ? "Send files" : "Receive files";
}

function Downloads({ files, onClear }: { files: ReceivedFile[]; onClear: () => void }) {
  return <section className="download-list" aria-label="Received files">
    <h2>Ready to save</h2>
    {files.length > 1 && <DownloadAll files={files} />}
    <div className="download-items">
    {files.map(file => <a className="download-row" href={file.url} download={file.name} key={file.id}>
      <span className="file-glyph"><Icon name="file" /></span>
      <span className="file-name"><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
      <span className="download-icon"><Icon name="download" /></span>
    </a>)}
    </div>
    <p className="transfer-details">Download before closing this tab.</p>
    <button className="text-button" onClick={onClear}>Clear downloads</button>
  </section>;
}
function DownloadAll({ files }: { files: ReceivedFile[] }) {
  const [preparing, setPreparing] = useState(false);
  const [archiveUrl, setArchiveUrl] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const generation = useRef(0);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    generation.current++;
    setPreparing(false); setArchiveUrl(null); setArchiveError(null);
    return () => {
      generation.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [files]);
  async function saveAll() {
    if (preparing) return;
    const current = generation.current;
    setPreparing(true); setArchiveError(null);
    try {
      const blob = await createDownloadArchive(files);
      if (current !== generation.current) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url; setArchiveUrl(url);
      const link = document.createElement("a");
      link.href = url; link.download = "Simple Share.zip";
      document.body.append(link); link.click(); link.remove();
    } catch {
      if (current === generation.current) setArchiveError("Could not prepare the ZIP. Save the files individually or try again.");
    } finally { if (current === generation.current) setPreparing(false); }
  }
  return <div className="save-all">
    {archiveUrl
      ? <a className="secondary-button recovery-link" href={archiveUrl} download="Simple Share.zip"><Icon name="download" />Download ZIP again</a>
      : <button className="secondary-button" disabled={preparing} onClick={() => void saveAll()}><Icon name="download" />{preparing ? "Preparing ZIP…" : `Save all ${files.length} files as ZIP`}</button>}
    <p role="status">{preparing ? "Preparing one download. Your original files stay available below." : "One ZIP download, with every file kept at its original quality."}</p>
    {archiveError && <p role="alert">{archiveError}</p>}
  </div>;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}
