import { connectionBinding, randomToken, signProof, verifyProof, type DeviceIdentity, type PairedDevice } from "./device-identity.ts";

export type PeerIdentity = { publicKey: string; name: string };
export type PairProposal = { pairId: string; token: string };
type Message =
  | { type: "device-hello"; version: 1; publicKey: string; name: string; challenge: string }
  | { type: "device-proof"; signature: string }
  | { type: "pair-offer"; pairId: string; token: string }
  | { type: "pair-result"; pairId: string; accepted: boolean };
export function isDeviceMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const token = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
  switch (m.type) {
    case "device-hello": return m.version === 1 && text(m.publicKey, 200) && text(m.name, 60) && String(m.name).trim().length > 0 && token(m.challenge);
    case "device-proof": return text(m.signature, 128) && String(m.signature).length > 0;
    case "pair-offer": return token(m.pairId) && token(m.token);
    case "pair-result": return token(m.pairId) && typeof m.accepted === "boolean";
    default: return false;
  }
}
export class DeviceHandshake {
  peer: PeerIdentity | null = null;
  verified = false;
  private challenge = randomToken();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;
  private queue: Promise<void> = Promise.resolve();
  private channel: RTCDataChannel;
  private connection: RTCPeerConnection;
  private identity: DeviceIdentity | null;
  private name: string;
  private expected: PairedDevice | null;
  private callbacks: {
    onReady: (peer: PeerIdentity | null) => void;
    onError: (error: Error) => void;
    onPairOffer: (proposal: PairProposal) => void;
    onPairResult: (pairId: string, accepted: boolean) => void;
  };
  constructor(channel: RTCDataChannel, connection: RTCPeerConnection, identity: DeviceIdentity | null, name: string, expected: PairedDevice | null, callbacks: DeviceHandshake["callbacks"]) {
    this.channel = channel; this.connection = connection; this.identity = identity;
    this.name = name; this.expected = expected; this.callbacks = callbacks;
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.timer = setTimeout(() => this.fail(new Error("Device verification timed out. Refresh both devices and try again.")), 15_000);
    this.send({ type: "device-hello", version: 1, publicKey: this.identity?.publicKey ?? "", name: this.name, challenge: this.challenge });
  }
  send(message: Message) { if (!this.stopped && this.channel.readyState === "open") this.channel.send(JSON.stringify(message)); }
  receive(message: Message) {
    // Signature operations must remain ordered even if several frames arrive together.
    this.queue = this.queue.then(() => this.handle(message)).catch(error => this.fail(error instanceof Error ? error : new Error("Device verification failed.")));
    return this.queue;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  private fail(error: Error) { if (!this.stopped) { this.stop(); this.callbacks.onError(error); } }
  private ready() {
    if (this.stopped || this.verified) return;
    this.verified = true;
    clearTimeout(this.timer);
    this.callbacks.onReady(this.peer?.publicKey ? this.peer : null);
  }
  private async handle(message: Message) {
    if (this.stopped) return;
    if (message.type === "device-hello") {
      if (this.peer) throw new Error("The other device changed its identity during connection.");
      if (this.expected && (!this.identity || message.publicKey !== this.expected.publicKey)) throw new Error("This device's identity changed. Forget it and pair again using a room code.");
      this.peer = { publicKey: message.publicKey, name: message.name };
      if (!this.identity || !message.publicKey) { this.ready(); return; }
      const binding = connectionBinding(this.connection.localDescription!.sdp, this.connection.remoteDescription!.sdp);
      const signature = await signProof(this.identity, message.challenge, binding);
      if (!this.stopped) this.send({ type: "device-proof", signature });
    } else if (message.type === "device-proof") {
      if (!this.peer?.publicKey || !this.identity || this.verified) throw new Error("Unexpected device proof.");
      const binding = connectionBinding(this.connection.localDescription!.sdp, this.connection.remoteDescription!.sdp);
      if (!await verifyProof(this.peer.publicKey, message.signature, this.challenge, binding)) throw new Error("The other device could not prove its identity.");
      this.ready();
    } else {
      if (!this.verified || !this.identity || !this.peer?.publicKey) throw new Error("Verify the device before remembering it.");
      if (message.type === "pair-offer") this.callbacks.onPairOffer(message);
      else this.callbacks.onPairResult(message.pairId, message.accepted);
    }
  }
}
