import {
  ACK_TIMEOUT_MS, ACK_WINDOW_CHUNKS, CHUNK_PAYLOAD_SIZE, MAX_WINDOW_RETRIES, MAX_BATCH_BYTES,
  chunkCountForSize, decodeChunk, encodeChunk, isTransferControlMessage, validateFiles,
  type TransferControlMessage,
} from "./transfer-protocol.ts";

export type TransferOffer = Extract<TransferControlMessage, { type: "batch-start" }>;
export type TransferProgress = { bytes: number; total: number; bytesPerSecond: number; remainingSeconds: number | null };
export type DataTransport = Pick<RTCDataChannel, "send" | "readyState" | "bufferedAmount" | "addEventListener" | "removeEventListener">;
export type FileSink = { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };
export type ReceiveOptions = {
  retainedBytes?: number;
  openFile?: (file: { name: string; size: number }, signal: AbortSignal) => Promise<FileSink>;
  beforeFile?: (size: number, signal: AbortSignal) => Promise<void>;
};
type Callbacks = {
  onOffer: (offer: TransferOffer | null) => void;
  onStart: () => void;
  onStatus: (status: string) => void;
  onProgress: (progress: TransferProgress) => void;
  onFile: (file: { id: string; name: string; size: number; blob?: Blob }) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
};
type IncomingFile = Extract<TransferControlMessage, { type: "file-start" }> & {
  chunks: ArrayBuffer[]; next: number; bytes: number;
};
type Waiter = { match: (message: TransferControlMessage) => boolean; resolve: (message: TransferControlMessage) => void; reject: (error: Error) => void };

/** Sequential, independently approved collections with bounded receive buffering. */
export class TransferSession {
  private options: ReceiveOptions = {};
  private sink: FileSink | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedMessages = 0;
  private memoryBytes = 0;
  private stopped = false;
  private used = false;
  private completed = false;
  private peerRepeat = false;
  private accepted = false;
  private offer: TransferOffer | null = null;
  private current: IncomingFile | null = null;
  private received = 0;
  private completedFiles = 0;
  private ids = new Set<string>();
  private startedAt = 0;
  private lastProgressAt = 0;
  private waiters = new Set<Waiter>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private closeListener = () => {
    if (!this.completed) this.fail(new Error("The other device disconnected. Files already received are still available below."), false);
  };
  private channel: DataTransport;
  private role: "send" | "receive";
  private callbacks: Callbacks;
  private timeoutMs: number;
  constructor(channel: DataTransport, role: "send" | "receive", callbacks: Callbacks, timeoutMs = ACK_TIMEOUT_MS) {
    this.channel = channel;
    this.role = role;
    this.callbacks = callbacks;
    this.timeoutMs = timeoutMs;
    channel.addEventListener("close", this.closeListener);
  }

  get canSendMore() {
    return this.role === "send" && this.completed && this.peerRepeat && !this.stopped && this.channel.readyState === "open";
  }

  private resetBatch() {
    this.used = false; this.completed = false; this.accepted = false;
    this.offer = null; this.current = null; this.options = {};
    this.received = 0; this.completedFiles = 0; this.memoryBytes = 0;
    this.ids.clear(); this.startedAt = 0; this.lastProgressAt = 0;
  }

  receive(message: TransferControlMessage | ArrayBuffer) {
    if (this.stopped) return;
    if (this.completed) {
      if (this.role !== "receive" || message instanceof ArrayBuffer || message.type !== "batch-start" || !this.offer?.repeat || !isTransferControlMessage(message)) return;
      this.resetBatch();
    }
    const bytes = message instanceof ArrayBuffer ? message.byteLength : 0;
    // A conforming sender has at most one 64-chunk window in flight.
    if (this.queuedBytes + bytes > 2 * 1024 * 1024 || this.queuedMessages >= 256) {
      this.fail(new Error("The other device sent data faster than it could be saved."));
      return;
    }
    // Sender responses and cancellation must not wait behind filesystem work.
    if (!(message instanceof ArrayBuffer) && message.type === "cancel") {
      this.fail(new Error(message.reason), false); return;
    }
    if (this.role === "send") { void this.handle(message); return; }
    this.queuedBytes += bytes; this.queuedMessages++;
    this.queue = this.queue.then(async () => {
      try { if (!this.stopped && !this.completed) await this.handle(message); }
      finally { this.queuedBytes -= bytes; this.queuedMessages--; }
    }).catch(error => this.fail(error instanceof Error ? error : new Error("Transfer failed.")));
  }

  private async handle(message: TransferControlMessage | ArrayBuffer) {
    try {
      if (message instanceof ArrayBuffer) {
        if (this.role !== "receive") throw new Error("Unexpected file data.");
        await this.receiveChunk(message); return;
      }
      if (!isTransferControlMessage(message)) throw new Error("The other device sent invalid transfer details.");
      if (this.role === "send") {
        if (message.type === "batch-reject") throw new Error("The other device declined this transfer.");
        for (const waiter of this.waiters) if (waiter.match(message)) { waiter.resolve(message); return; }
        if (!["chunk-ack", "file-ready", "file-complete", "batch-complete", "batch-accept"].includes(message.type)) throw new Error("Unexpected transfer response.");
        return;
      }
      await this.receiveControl(message);
    } catch (error) { this.fail(error instanceof Error ? error : new Error("The transfer could not continue.")); }
  }

  approve(options: ReceiveOptions = {}) {
    if (!this.offer || this.accepted || this.stopped) return;
    try {
      this.assertOpen();
      if (!options.openFile && (this.offer.largestFile ?? this.offer.totalBytes) > MAX_BATCH_BYTES) throw new Error("A file exceeds 256 MiB. Receive into a folder using a supported desktop browser.");
      const retained = options.retainedBytes ?? 0;
      if (!Number.isSafeInteger(retained) || retained < 0 || retained > MAX_BATCH_BYTES) throw new Error("Invalid retained download size.");
      this.memoryBytes = retained;
      this.options = options;
      this.accepted = true;
      this.startedAt = Date.now();
      this.callbacks.onOffer(null);
      this.callbacks.onStart();
      this.control({ type: "batch-accept", id: this.offer.id, flow: 2, repeat: true });
      this.armIdle();
    } catch (error) { this.fail(error instanceof Error ? error : new Error("The connection closed.")); }
  }

  decline() { this.cancel("The receiver declined this transfer."); }
  cancel(reason = "Transfer cancelled. Files already received are still available below.") { this.fail(new Error(reason)); }
  dispose() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.controller.abort();
    this.channel.removeEventListener("close", this.closeListener);
    for (const waiter of this.waiters) waiter.reject(new Error("Transfer cancelled."));
    this.current = null;
    const sink = this.sink; this.sink = null;
    if (sink) void sink.abort().catch(() => {});
  }

  private fail(error: Error, notifyPeer = true) {
    if (this.stopped || this.completed) return;
    if (notifyPeer && this.channel.readyState === "open") {
      try { this.control({ type: "cancel", reason: error.message.slice(0, 200) }); } catch { /* Already closed. */ }
    }
    this.dispose();
    this.callbacks.onOffer(null);
    this.callbacks.onError(error);
  }
  private control(message: TransferControlMessage) { this.channel.send(JSON.stringify(message)); }
  private assertOpen() {
    if (this.stopped || this.channel.readyState !== "open") throw new Error("The transfer connection closed.");
  }
  private armIdle(multiplier = 4) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail(new Error("Transfer timed out. Open a new connection to try again.")), this.timeoutMs * multiplier);
  }
  private progress(bytes: number, total: number) {
    const now = Date.now();
    if (bytes !== total && now - this.lastProgressAt < 100) return;
    this.lastProgressAt = now;
    const seconds = Math.max((Date.now() - this.startedAt) / 1000, 0.1);
    const bytesPerSecond = bytes / seconds;
    this.callbacks.onProgress({ bytes, total, bytesPerSecond, remainingSeconds: bytesPerSecond > 0 ? Math.ceil((total - bytes) / bytesPerSecond) : null });
  }
  private async receiveControl(message: TransferControlMessage) {
    if (message.type === "batch-start") {
      if (this.used) throw new Error("Open a new connection for another transfer.");
      this.used = true;
      this.offer = message;
      this.armIdle(50);
      this.callbacks.onOffer(message);

      return;
    }
    if (!this.offer || !this.accepted) throw new Error("File data arrived before you approved the transfer.");
    this.armIdle();
    if (message.type === "file-start") {
      if (this.current || this.completedFiles >= this.offer.count || this.ids.has(message.id) || this.received + message.size > this.offer.totalBytes) throw new Error("Invalid file sequence or size.");
      if (!this.options.openFile) {
        if (message.size > MAX_BATCH_BYTES) throw new Error("This file needs direct-to-folder receiving.");
        if (this.memoryBytes + message.size > MAX_BATCH_BYTES) {
          if (!this.options.beforeFile) throw new Error("Save and clear received files before continuing.");
          this.armIdle(50);
          await this.options.beforeFile(message.size, this.controller.signal);
          this.assertOpen(); this.memoryBytes = 0;
        }
        this.memoryBytes += message.size;
      }
      if (this.options.openFile) {
        this.armIdle(50);
        const sink = await this.options.openFile(message, this.controller.signal);
        if (this.stopped) { await sink.abort(); return; }
        this.sink = sink;
      }
      this.ids.add(message.id);
      this.current = { ...message, chunks: [], next: 0, bytes: 0 };
      this.callbacks.onStatus(`Receiving ${message.name}…`);
      if (this.offer.version === 2) this.control({ type: "file-ready", id: message.id });
      this.armIdle();
    } else if (message.type === "file-end") {
      const file = this.current;
      if (!file || file.id !== message.id || file.next !== file.totalChunks || file.bytes !== file.size) throw new Error("A file arrived incomplete. Please try again.");
      let blob: Blob | undefined;
      if (this.sink) {
        await this.sink.close();
        this.assertOpen(); this.sink = null;
      } else {
        blob = new Blob(file.chunks, { type: "application/octet-stream" });
        if (blob.size !== file.size) throw new Error("The received file size did not match.");
      }
      this.callbacks.onFile({ id: file.id, name: file.name, size: file.size, blob });
      this.current = null;
      this.completedFiles += 1;
      this.control({ type: "file-complete", id: file.id });
    } else if (message.type === "batch-end") {
      if (message.id !== this.offer.id || this.current || this.completedFiles !== this.offer.count || this.received !== this.offer.totalBytes) throw new Error("The transfer arrived incomplete.");
      this.control({ type: "batch-complete", id: message.id });
      this.completed = true;
      clearTimeout(this.idleTimer);
      this.callbacks.onComplete();
    } else throw new Error("Unexpected transfer message.");
  }
  private async receiveChunk(frame: ArrayBuffer) {
    const file = this.current;
    if (!this.accepted || !file) throw new Error("Unexpected file chunk.");
    const { index, payload } = decodeChunk(frame);
    const expected = Math.min(CHUNK_PAYLOAD_SIZE, file.size - index * CHUNK_PAYLOAD_SIZE);
    if (index >= file.totalChunks || payload.byteLength !== expected || index > file.next) throw new Error("A file chunk had an invalid size or position.");
    this.armIdle();
    if (index < file.next) {
      // Re-send cumulative acknowledgment when a timed-out sender retries.
      this.control({ type: "chunk-ack", id: file.id, nextChunk: file.next });
      return;
    }
    if (this.sink) { await this.sink.write(new Uint8Array(payload)); this.assertOpen(); }
    else file.chunks.push(payload);
    file.bytes += payload.byteLength;
    file.next += 1;
    this.received += payload.byteLength;
    this.progress(this.received, this.offer!.totalBytes);
    if (file.next % ACK_WINDOW_CHUNKS === 0 || file.next === file.totalChunks) this.control({ type: "chunk-ack", id: file.id, nextChunk: file.next });
  }

  private wait(match: Waiter["match"], timeout = this.timeoutMs) {
    let cancel = () => {};
    const promise = new Promise<TransferControlMessage>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter: Waiter = {
        match,
        resolve: message => { finish(); resolve(message); },
        reject: error => { finish(); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new Error("Timed out waiting for the other device.")), timeout);
      cancel = () => waiter.reject(new Error("Transfer operation cancelled."));
      this.waiters.add(waiter);
    });
    // Attach immediately: file reads/backpressure can outlast the timeout.
    void promise.catch(() => {});
    return { promise, cancel };
  }
  private async buffer() {
    this.assertOpen();
    if (this.channel.bufferedAmount <= 1024 * 1024) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.channel.removeEventListener("bufferedamountlow", low);
        this.controller.signal.removeEventListener("abort", abort);
      };
      const low = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error("The transfer connection closed.")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("The connection stopped sending data.")); }, this.timeoutMs);
      this.channel.addEventListener("bufferedamountlow", low, { once: true });
      this.controller.signal.addEventListener("abort", abort, { once: true });
      if (this.channel.bufferedAmount <= 1024 * 1024) low();
    });
    this.assertOpen();
  }
  async send(files: File[]) {
    if (this.canSendMore) this.resetBatch();
    if (this.role !== "send" || this.used || this.stopped) return;
    this.used = true;
    try {
      validateFiles(files);
      this.assertOpen();
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const acceptance = this.wait(m => m.type === "batch-accept" && m.id === id, this.timeoutMs * 50);
      this.control({ type: "batch-start", id, count: files.length, totalBytes: total, version: 2, repeat: true, largestFile: Math.max(...files.map(file => file.size)) });
      this.callbacks.onStatus("Waiting for the other device to accept…");
      const accepted = await acceptance.promise;
      if (accepted.type !== "batch-accept" || accepted.flow !== 2) throw new Error("Refresh both devices to use the updated transfer version.");
      this.peerRepeat = accepted.repeat === true;
      this.startedAt = Date.now();
      this.callbacks.onStart();
      let completedBytes = 0;
      for (const [fileIndex, file] of files.entries()) {
        this.assertOpen();
        const fileId = `${id}-${fileIndex}`;
        const totalChunks = chunkCountForSize(file.size);
        const ready = this.wait(m => m.type === "file-ready" && m.id === fileId, this.timeoutMs * 50);
        this.control({ type: "file-start", id: fileId, name: file.name, size: file.size, mime: file.type || "application/octet-stream", totalChunks });
        this.callbacks.onStatus(`Waiting for the receiver to prepare ${file.name}…`);
        await ready.promise;
        this.callbacks.onStatus(`Sending ${file.name}…`);
        for (let start = 0; start < totalChunks; start += ACK_WINDOW_CHUNKS) {
          const end = Math.min(totalChunks, start + ACK_WINDOW_CHUNKS);
          for (let attempt = 0; ; attempt++) {
            const ack = this.wait(m => m.type === "chunk-ack" && m.id === fileId && m.nextChunk === end);
            try {
              for (let index = start; index < end; index++) {
                await this.buffer();
                const payload = await file.slice(index * CHUNK_PAYLOAD_SIZE, (index + 1) * CHUNK_PAYLOAD_SIZE).arrayBuffer();
                this.assertOpen();
                this.channel.send(encodeChunk(index, payload));
              }
              await ack.promise;
              break;
            } catch (error) {
              ack.cancel();
              this.assertOpen();
              if (attempt >= MAX_WINDOW_RETRIES) throw error;
              this.callbacks.onStatus(`Retrying part of ${file.name}…`);
            }
          }
          this.progress(completedBytes + Math.min(file.size, end * CHUNK_PAYLOAD_SIZE), total);
        }
        const fileDone = this.wait(m => m.type === "file-complete" && m.id === fileId);
        this.control({ type: "file-end", id: fileId });
        await fileDone.promise;
        completedBytes += file.size;
      }
      const done = this.wait(m => m.type === "batch-complete" && m.id === id);
      this.callbacks.onStatus("Checking that every file arrived…");
      this.control({ type: "batch-end", id });
      await done.promise;
      this.completed = true;
      this.progress(total, total);
      this.callbacks.onComplete();
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Transfer failed.")); }
  }
}
