// The screen's small Swift helpers (scripts/audio-levels, scripts/listen) are compiled on this Mac the first time
// they are needed, into .data, and again whenever their source is newer than the build. Each links its Info.plist
// into the binary, so macOS asks for its permission (system audio, microphone) in the helper's own name.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const COMPILE_TIMEOUT_MS = 5 * 60_000;

export type SwiftHelper = { source: string; infoPlist: string; binary: string };

/** A helper whose source is scripts/<name>/<file>.swift and whose build is .data/<name>. */
export function swiftHelper(name: string, file: string): SwiftHelper {
  const folder = path.join(process.cwd(), "scripts", name);
  return { source: path.join(folder, file), infoPlist: path.join(folder, "Info.plist"), binary: path.join(process.cwd(), ".data", name) };
}

async function modified(file: string) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Builds the helper when it is missing or older than its source. Resolves to an error message, or null. */
export async function buildSwiftHelper(helper: SwiftHelper): Promise<string | null> {
  const [built, source] = await Promise.all([modified(helper.binary), modified(helper.source)]);
  if (source === null) return `${path.relative(process.cwd(), helper.source)} is missing`;
  if (built !== null && built >= source) return null;
  const args = ["-O", helper.source, "-o", helper.binary, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", helper.infoPlist];
  return new Promise((resolve) => {
    execFile("swiftc", args, { timeout: COMPILE_TIMEOUT_MS }, (error, _out, stderr) => resolve(error ? `swiftc failed: ${String(stderr).trim() || error.message}` : null));
  });
}
