// Loads .env.local into process.env (without overriding anything already set) and removes the
// secrets the agent must never hold. Imported first by agent/index.ts, before anything reads env.

import { existsSync } from "node:fs";
import path from "node:path";

/** Variables deleted from the agent's environment whatever their source. */
const FORBIDDEN = ["BAB_PRIVATE_KEY"];

export function loadEnv(root = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    // process.loadEnvFile keeps values that are already set in the environment.
    process.loadEnvFile(file);
    loaded.push(name);
  }
  for (const key of FORBIDDEN) delete process.env[key];
  return loaded;
}

export const loadedEnvFiles = loadEnv();
