import type { FileSink } from "./transfer-session.ts";

type FolderPickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};
export function canReceiveToFolder() {
  return typeof window !== "undefined" && typeof (window as FolderPickerWindow).showDirectoryPicker === "function";
}

export async function chooseReceiveFolder() {
  const picker = (window as FolderPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("Folder receiving is unavailable in this browser.");
  const parent = await picker.call(window, { mode: "readwrite" });
  // A separate random subfolder preserves existing user files and gives each
  // transfer its own namespace. Numbering also preserves duplicate filenames.
  const name = `Simple Share ${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}-${crypto.randomUUID()}`;
  const folder = await parent.getDirectoryHandle(name, { create: true });
  let index = 0;
  return {
    name,
    async openFile(file: { name: string }, signal: AbortSignal): Promise<FileSink> {
      if (signal.aborted) throw new Error("Transfer cancelled.");
      // Leave room for the sequence prefix on filesystems with 255-byte names.
      const encoder = new TextEncoder();
      let safeName = "";
      for (const character of file.name) {
        if (encoder.encode(safeName + character).length > 240) break;
        safeName += character;
      }
      const filename = `${String(++index).padStart(4, "0")}-${safeName}`;
      const handle = await folder.getFileHandle(filename, { create: true });
      let stream: FileSystemWritableFileStream;
      try { stream = await handle.createWritable(); }
      catch (error) { await folder.removeEntry(filename).catch(() => {}); throw error; }
      let closed = false;
      const abort = async () => {
        if (closed) return;
        closed = true;
        await stream.abort().catch(() => {});
        await folder.removeEntry(filename).catch(() => {});
      };
      if (signal.aborted) { await abort(); throw new Error("Transfer cancelled."); }
      return {
        write: async bytes => { await stream.write(bytes as Uint8Array<ArrayBuffer>); },
        close: async () => { await stream.close(); closed = true; },
        abort,
      };
    },
  };
}
