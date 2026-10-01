// Tiny JSON-file persistence for the song-request feature.
// Everything lives in a gitignored directory (.data by default) next to the app.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function dataDir(): string {
  return process.env.SONGS_DATA_DIR || path.join(process.cwd(), ".data");
}

/** Parsed JSON, or null if the file is missing or unreadable. Never throws. */
export async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir(), name), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename) so a crash mid-write can't leave a truncated file. */
export async function writeJson(name: string, value: unknown, mode = 0o600): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  // writeFile's mode is masked by umask and ignored for an existing file; make it explicit.
  await chmod(temp, mode);
  await rename(temp, target);
}
