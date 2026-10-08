import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.join(root, ".data");
await mkdir(data, { recursive: true, mode: 0o700 });
const keyFile = path.join(data, "jam-bridge.json");
let token;
try { token = JSON.parse(await readFile(keyFile, "utf8")).token; } catch { token = undefined; }
if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
  token = randomBytes(32).toString("hex");
  await writeFile(keyFile, JSON.stringify({ token }) + "\n", { mode: 0o600 });
}
await chmod(keyFile, 0o600);
const config = execFileSync("spicetify", ["-c"], { encoding: "utf8" }).trim();
const extensions = path.join(path.dirname(config), "Extensions");
await mkdir(extensions, { recursive: true });
const source = await readFile(path.join(root, "scripts/spotify-jam-extension.js"), "utf8");
await writeFile(path.join(extensions, "bab-jam.js"), source.replace("__BAB_JAM_BRIDGE_TOKEN__", token), { mode: 0o600 });
execFileSync("spicetify", ["config", "extensions", "bab-jam.js"], { stdio: "inherit" });
stdout.write("Installed B@B Jam extension and private bridge key. Apply Spicetify and restart Spotify next.\n");
