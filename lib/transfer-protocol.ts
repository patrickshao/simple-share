export const CHUNK_FRAME_SIZE = 16 * 1024;
export const CHUNK_HEADER_SIZE = 4;
export const CHUNK_PAYLOAD_SIZE = CHUNK_FRAME_SIZE - CHUNK_HEADER_SIZE;
export const ACK_WINDOW_CHUNKS = 64;
export const ACK_TIMEOUT_MS = 12_000;
export const MAX_WINDOW_RETRIES = 3;
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
export const MAX_BATCH_FILES = 1000;
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_CONTROL_LENGTH = 16_384;

export type TransferControlMessage =
  | { type: "batch-start"; id: string; count: number; totalBytes: number; version?: 2; largestFile?: number; repeat?: true }
  | { type: "batch-accept"; id: string; flow?: 2; repeat?: true }
  | { type: "file-ready"; id: string }
  | { type: "batch-reject"; id: string }
  | { type: "file-start"; id: string; name: string; size: number; mime: string; totalChunks: number }
  | { type: "chunk-ack"; id: string; nextChunk: number }
  | { type: "file-end"; id: string }
  | { type: "file-complete"; id: string }
  | { type: "batch-end"; id: string }
  | { type: "batch-complete"; id: string }
  | { type: "cancel"; reason: string };

const integer = (value: unknown, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const string = (value: unknown, max: number, min = 1) =>
  typeof value === "string" && value.length >= min && value.length <= max;

export function isTransferControlMessage(value: unknown): value is TransferControlMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case "batch-start":
      return (m.repeat === undefined || m.repeat === true) && string(m.id, 80) && integer(m.count, MAX_BATCH_FILES) && Number(m.count) > 0 && integer(m.totalBytes, MAX_TRANSFER_BYTES) && (m.version === undefined || (m.version === 2 && integer(m.largestFile, MAX_TRANSFER_BYTES) && Number(m.largestFile) <= Number(m.totalBytes)));
    case "file-start":
      return string(m.id, 80) && string(m.name, 255) && !/[\x00-\x1f/\\]/.test(String(m.name)) &&
        string(m.mime, 255, 0) && integer(m.size, MAX_TRANSFER_BYTES) &&
        integer(m.totalChunks, chunkCountForSize(MAX_TRANSFER_BYTES)) && m.totalChunks === chunkCountForSize(Number(m.size));
    case "chunk-ack":
      return string(m.id, 80) && integer(m.nextChunk, chunkCountForSize(MAX_TRANSFER_BYTES));
    case "batch-accept": return string(m.id, 80) && (m.flow === undefined || m.flow === 2) && (m.repeat === undefined || m.repeat === true);
    case "file-ready": case "batch-reject": case "file-end": case "file-complete": case "batch-end": case "batch-complete":
      return string(m.id, 80);
    case "cancel": return string(m.reason, 200);
    default: return false;
  }
}

export function encodeChunk(index: number, payload: ArrayBuffer) {
  if (!integer(index, 0xffffffff) || payload.byteLength > CHUNK_PAYLOAD_SIZE) throw new Error("Invalid outgoing file chunk.");
  const frame = new ArrayBuffer(CHUNK_HEADER_SIZE + payload.byteLength);
  new DataView(frame).setUint32(0, index);
  new Uint8Array(frame, CHUNK_HEADER_SIZE).set(new Uint8Array(payload));
  return frame;
}

export function decodeChunk(frame: ArrayBuffer) {
  if (frame.byteLength < CHUNK_HEADER_SIZE || frame.byteLength > CHUNK_FRAME_SIZE) throw new Error("Received an invalid file chunk.");
  return { index: new DataView(frame).getUint32(0), payload: frame.slice(CHUNK_HEADER_SIZE) };
}

export function chunkCountForSize(size: number) {
  return size <= 0 ? 0 : Math.ceil(size / CHUNK_PAYLOAD_SIZE);
}

export function validateFiles(files: readonly { name: string; size: number }[]) {
  if (!files.length || files.length > MAX_BATCH_FILES) throw new Error(`Choose between 1 and ${MAX_BATCH_FILES} files.`);
  if (files.some(f => !integer(f.size, MAX_TRANSFER_BYTES) || !string(f.name, 255) || /[\x00-\x1f/\\]/.test(f.name))) {
    throw new Error("A file has an unsupported name or size.");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TRANSFER_BYTES) {
    throw new Error("Send up to 20 GiB in one selection. Split larger selections into separate transfers.");
  }
}
