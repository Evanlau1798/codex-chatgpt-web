import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type LauncherEvent = {
  at: string;
  event: string;
  detail?: Record<string, any>;
  message?: string;
};

export function unseenLauncherEvents(values: LauncherEvent[], seen: WeakSet<object>): LauncherEvent[] {
  return values.filter(value => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

type Cursor = {
  identity: string;
  offset: number;
  remainder: string;
  remainderOffset: number;
  discardPartial: boolean;
  decoder: TextDecoder;
};

const DEFAULT_INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETAINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_LINE_BYTES = 4 * 1024 * 1024;

export class LauncherEventReader {
  private cursors = new Map<string, Cursor>();
  private records: LauncherEvent[] = [];
  private seen = new Set<string>();
  private retainedBytes = 0;

  constructor(private limits: {
    maxInitialTailBytes?: number;
    maxRetainedBytes?: number;
    maxLineBytes?: number;
  } = {}, private afterOpen?: (path: string) => void) {}

  read(paths: string[], since = 0): LauncherEvent[] {
    let changed = false;
    for (const path of paths) {
      try { changed = this.readPath(path) || changed; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (changed) this.records.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    return this.records.filter(value => Date.parse(value.at) >= since);
  }

  private readPath(path: string): boolean {
    const fd = openSync(path, "r");
    try {
      this.afterOpen?.(path);
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let cursor = this.cursors.get(path);
      if (!cursor || cursor.identity !== identity || stat.size < cursor.offset) {
        const offset = Math.max(0, stat.size - (this.limits.maxInitialTailBytes ?? DEFAULT_INITIAL_TAIL_BYTES));
        cursor = {
          identity,
          offset,
          remainder: "",
          remainderOffset: offset,
          discardPartial: offset > 0,
          decoder: new TextDecoder(),
        };
        this.cursors.set(path, cursor);
      }
      if (stat.size === cursor.offset) return false;
      let changed = false;
      while (cursor.offset < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - cursor.offset));
        const bytes = readSync(fd, buffer, 0, buffer.length, cursor.offset);
        if (bytes === 0) break;
        cursor.offset += bytes;
        cursor.remainder += cursor.decoder.decode(buffer.subarray(0, bytes), { stream: true });
        changed = this.consume(cursor) || changed;
      }
      this.assertLine(cursor.remainder);
      return changed;
    } finally {
      closeSync(fd);
    }
  }

  private consume(cursor: Cursor): boolean {
    if (cursor.discardPartial) {
      const newline = cursor.remainder.indexOf("\n");
      if (newline < 0) {
        cursor.remainderOffset += Buffer.byteLength(cursor.remainder);
        cursor.remainder = "";
        return false;
      }
      cursor.remainderOffset += Buffer.byteLength(cursor.remainder.slice(0, newline + 1));
      cursor.remainder = cursor.remainder.slice(newline + 1);
      cursor.discardPartial = false;
    }
    let changed = false;
    for (let newline = cursor.remainder.indexOf("\n"); newline >= 0; newline = cursor.remainder.indexOf("\n")) {
      const line = cursor.remainder.slice(0, newline).replace(/\r$/, "");
      const recordKey = `${cursor.identity}:${cursor.remainderOffset}`;
      cursor.remainderOffset += Buffer.byteLength(cursor.remainder.slice(0, newline + 1));
      cursor.remainder = cursor.remainder.slice(newline + 1);
      if (!line) continue;
      this.assertLine(line);
      if (this.seen.has(recordKey)) continue;
      let record: LauncherEvent;
      try { record = JSON.parse(line) as LauncherEvent; }
      catch { continue; }
      const bytes = Buffer.byteLength(line) + recordKey.length;
      if (this.retainedBytes + bytes > (this.limits.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES)) {
        throw new Error("Launcher event cache exceeded lifecycle cache limit");
      }
      this.retainedBytes += bytes;
      this.seen.add(recordKey);
      this.records.push(record);
      changed = true;
    }
    return changed;
  }

  private assertLine(value: string): void {
    if (Buffer.byteLength(value) > (this.limits.maxLineBytes ?? DEFAULT_LINE_BYTES)) {
      throw new Error("Launcher event line exceeded lifecycle line limit");
    }
  }
}
