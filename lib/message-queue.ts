import { CHUNK_FRAME_SIZE, MAX_CONTROL_LENGTH } from "./transfer-protocol.ts";

/** Bound frames before asynchronous key verification or disk work can retain them. */
export class BoundedMessageQueue {
  private queue = Promise.resolve();
  private count = 0;
  private bytes = 0;
  private stopped = false;
  private onError: (error: Error) => void;

  constructor(onError: (error: Error) => void) { this.onError = onError; }

  push(data: unknown, handle: () => Promise<void>) {
    if (this.stopped) return;
    const size = typeof data === "string" ? data.length * 2 : data instanceof ArrayBuffer ? data.byteLength : -1;
    if (size < 0 || (typeof data === "string" ? data.length > MAX_CONTROL_LENGTH : size > CHUNK_FRAME_SIZE) ||
        this.count >= 256 || this.bytes + size > 2 * 1024 * 1024) {
      this.fail(new Error("The other device sent oversized or excessive transfer data."));
      return;
    }
    this.count++; this.bytes += size;
    this.queue = this.queue.then(async () => {
      try { if (!this.stopped) await handle(); }
      finally { this.count--; this.bytes -= size; }
    }).catch(error => this.fail(error instanceof Error ? error : new Error("Invalid transfer data.")));
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    this.onError(error);
  }
}
