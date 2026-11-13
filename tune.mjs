import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Scores an entry file over rolling cutoffs of the kit practice history,
// using the same local scoring rule as backtest.mjs (per target read: sum
// over places of ln(max(p, 1e-4)) for the actual occupant; unnamed games get
// (1 - named) / (unnamed chart games at that place)). Env vars pass through
// to the entry so MF_* tuning constants apply.
// Usage: node tune.mjs [entryFile] [baselineFile]

const kitInput = "/home/hatch/workspace/makefun/roblox-up-and-coming-forecast-01-kit/input";
const entry = path.resolve(process.argv[2] || "./main.ts");
const baseline = path.resolve(
  process.argv[3] || "/home/hatch/workspace/makefun/roblox-up-and-coming-forecast-01-kit/starter/main.ts"
);
const oldEntry = "/tmp/old-main.ts";
const cutoffs = [14, 18, 22, 26, 30, 32];
const reads = fs.readFileSync(path.join(kitInput, "history.ndjson"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
const baseTask = JSON.parse(fs.readFileSync(path.join(kitInput, "task.json"), "utf8"));

function runForecast(file, history, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "makefun-tune-"));
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(dir, "history.ndjson"), history.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task));
  const run = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    env: { ...process.env, MAKEFUN_INPUT_DIR: dir, MAKEFUN_OUTPUT_DIR: out },
  });
  if (run.status !== 0) throw new Error("entry failed: " + file + " " + run.stderr);
  const forecast = JSON.parse(fs.readFileSync(path.join(out, task.output || "forecast.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return forecast;
}
function score(forecast, targets, places) {
  let logTotal = 0;
  const pmap = new Map();
  for (const row of forecast.probabilities) pmap.set(row.place + ":" + row.universe_id, row.p);
  for (const read of targets) {
    const chart = (read.up_and_coming || []).slice().sort((a, b) => a.rank - b.rank);
    for (let k = 1; k <= places; k++) {
      const actual = chart.find((row) => row.rank === k);
      if (!actual) continue;
      let p = pmap.get(k + ":" + actual.universe_id);
      if (p === undefined) {
        let named = 0;
        for (const row of forecast.probabilities) if (row.place === k) named += row.p;
        const unnamedCount = chart.filter((row) => !pmap.has(k + ":" + row.universe_id)).length;
        p = (1 - named) / Math.max(1, unnamedCount);
      }
      logTotal += Math.log(Math.max(0.0001, p));
    }
  }
  return logTotal / Math.max(1, targets.length);
}
function taskFor(cutoff) {
  const at = Date.parse(reads[cutoff - 1].at);
  return { ...baseTask, history_until: reads[cutoff - 1].at, window: { from: new Date(at).toISOString(), until: new Date(at + 72 * 3600000).toISOString() } };
}
function evaluate(file) {
  const per = [];
  const weights = [];
  for (const cutoff of cutoffs) {
    const task = taskFor(cutoff);
    const from = Date.parse(task.window.from);
    const until = Date.parse(task.window.until);
    const targets = reads.slice(cutoff).filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) <= until);
    if (!targets.length) continue;
    per.push(score(runForecast(file, reads.slice(0, cutoff), task), targets, task.places));
    weights.push(targets.length);
  }
  return { per, weights };
}
const files = { entry, baseline };
if (fs.existsSync(oldEntry)) files.old = oldEntry;
const out = {};
for (const [name, file] of Object.entries(files)) {
  const { per, weights } = evaluate(file);
  const wsum = weights.reduce((a, b) => a + b, 0);
  out[name] = {
    per: per.map((v) => +v.toFixed(2)),
    mean: +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(3),
    wmean: +(per.reduce((a, b, i) => a + b * weights[i], 0) / wsum).toFixed(3),
    targets: weights,
  };
}
console.log(JSON.stringify(out));
