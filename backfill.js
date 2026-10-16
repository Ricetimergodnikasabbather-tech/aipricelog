// One-time: rebuild price history from LiteLLM's git log so the change log starts in 2023, not today.
// Usage: node backfill.js <path to a clone of BerriAI/litellm>
// Dates are when a change first appeared in LiteLLM's data, not the provider's announcement date.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalize } from "./lib.js";

const repo = process.argv[2];
if (!repo) throw new Error("usage: node backfill.js <litellm clone>");
const FILE = "model_prices_and_context_window.json";
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8", maxBuffer: 1 << 30 });

// Last commit of each day that touched the price file, oldest first.
const days = new Map();
for (const line of git("log", "--format=%H %cs", "--", FILE).trim().split("\n")) {
  const [hash, date] = line.split(" ");
  if (!days.has(date)) days.set(date, hash);
}
const ordered = [...days].reverse();

const changes = [];
let prev = null;
for (const [date, hash] of ordered) {
  let raw;
  try { raw = JSON.parse(git("show", `${hash}:${FILE}`)); } catch { continue; } // a few historical commits hold broken JSON
  const models = normalize(raw, date);
  if (Object.keys(models).length < 10) continue;
  if (prev) {
    for (const [key, m] of Object.entries(models)) {
      const p = prev[key];
      if (!p) { changes.push({ date, key, model: m.name, provider: m.provider, type: "added", note: `$${m.input} in / $${m.output} out` }); continue; }
      for (const f of ["input", "output", "context"]) {
        if (p[f] !== m[f]) changes.push({ date, key, model: m.name, provider: m.provider, type: f, old: p[f], new: m[f] });
      }
    }
    for (const [key, p] of Object.entries(prev)) {
      if (!models[key]) changes.push({ date, key, model: p.name, provider: p.provider, type: "removed" });
    }
  }
  prev = models;
  process.stdout.write(`\r${date} ${changes.length} changes`);
}

// Merge: history first, then anything update.js has logged since; newest first like update.js writes it.
const existing = existsSync("data/changes.json") ? JSON.parse(readFileSync("data/changes.json", "utf-8")) : [];
const cutoff = existing.at(-1)?.date ?? "9999";
const merged = [...existing, ...changes.filter(c => c.date < cutoff).reverse()];
writeFileSync("data/changes.json", JSON.stringify(merged, null, 1));
console.log(`\nwrote ${merged.length} changes (${ordered[0][0]} to ${ordered.at(-1)[0]})`);
