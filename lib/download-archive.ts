// ZIP's stored format keeps file bytes intact and needs no compression dependency.
// Blob parts reuse the received data; CRC calculation reads one chunk at a time.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
async function checksum(blob: Blob) {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
  } finally { reader.releaseLock(); }
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length: number) {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}
export async function createDownloadArchive(files: readonly { name: string; blob: Blob }[]) {
  if (!files.length || files.length > 65535 || files.reduce((sum, file) => sum + file.blob.size, 0) > 256 * 1024 * 1024) throw new Error("Save up to 256 MiB at a time.");
  const parts: BlobPart[] = [], directory: BlobPart[] = [];
  const names = new Set<string>();
  const encoder = new TextEncoder();
  let offset = 0, directorySize = 0;
  for (const file of files) {
    const base = file.name.replace(/[\x00-\x1f/\\]/g, "_").replace(/^\.+$/, "file") || "file";
    let name = base, suffix = 1;
    while (names.has(name.toLowerCase())) name = `${++suffix}-${base}`;
    names.add(name.toLowerCase());
    const encoded = encoder.encode(name);
    const crc = await checksum(file.blob);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true); // UTF-8 names
    local.view.setUint16(12, 33, true); // 1980-01-01
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, file.blob.size, true);
    local.view.setUint32(22, file.blob.size, true);
    local.view.setUint16(26, encoded.length, true);
    parts.push(local.bytes, encoded, file.blob);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true); central.view.setUint16(14, 33, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, file.blob.size, true); central.view.setUint32(24, file.blob.size, true);
    central.view.setUint16(28, encoded.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes, encoded);
    directorySize += 46 + encoded.length;
    offset += 30 + encoded.length + file.blob.size;
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true); end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: "application/zip" });
}
