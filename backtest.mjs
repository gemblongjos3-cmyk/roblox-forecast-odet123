import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const kitInput = "/home/hatch/workspace/makefun/roblox-up-and-coming-forecast-01-kit/input";
const root = process.cwd();
const reads = fs.readFileSync(path.join(kitInput, "history.ndjson"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
const baseTask = JSON.parse(fs.readFileSync(path.join(kitInput, "task.json"), "utf8"));
const cutoffs = [16, 21, 26, 30];
const entry = path.join(root, "main.ts");
const baseline = path.join(kitInput, "..", "starter", "main.ts");
function runForecast(file, history, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "makefun-backtest-"));
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(dir, "history.ndjson"), history.map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task));
  const run = spawnSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, MAKEFUN_INPUT_DIR: dir, MAKEFUN_OUTPUT_DIR: out } });
  if (run.status !== 0) throw new Error("entry failed: " + file + " " + run.stderr);
  const forecastPath = path.join(out, task.output || "forecast.json");
  const forecast = JSON.parse(fs.readFileSync(forecastPath, "utf8"));
  return { dir, forecast, bytes: fs.statSync(forecastPath).size, raw: fs.readFileSync(forecastPath) };
}
function score(forecast, targets, places) {
  let logTotal = 0;
  let hitsTotal = 0;
  let agreementTotal = 0;
  const pmap = new Map();
  for (const row of forecast.probabilities) pmap.set(row.place + ":" + row.universe_id, row.p);
  for (const read of targets) {
    const chart = (read.up_and_coming || []).slice().sort((a, b) => a.rank - b.rank);
    let readLog = 0;
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
      readLog += Math.log(Math.max(0.0001, p));
    }
    logTotal += readLog;
    const forecastPlaces = new Map();
    for (let i = 0; i < forecast.top10.length; i++) forecastPlaces.set(forecast.top10[i], i + 1);
    const actualTop = chart.slice(0, 10);
    const actualIds = new Set(actualTop.map((row) => row.universe_id));
    hitsTotal += forecast.top10.filter((id) => actualIds.has(id)).length;
    const actualPlaces = new Map(actualTop.map((row, i) => [row.universe_id, i + 1]));
    for (const [id, fp] of forecastPlaces) if (actualPlaces.has(id)) agreementTotal += 10 - Math.abs(fp - actualPlaces.get(id));
  }
  const count = Math.max(1, targets.length);
  return { log_score: logTotal / count, top10_hits: hitsTotal / count, agreement: agreementTotal / count };
}
function taskFor(cutoff) {
  const at = Date.parse(reads[cutoff - 1].at);
  return { ...baseTask, history_until: reads[cutoff - 1].at, window: { from: new Date(at).toISOString(), until: new Date(at + 72 * 3600000).toISOString() } };
}
const results = [];
for (const cutoff of cutoffs) {
  const history = reads.slice(0, cutoff);
  const task = taskFor(cutoff);
  const from = Date.parse(task.window.from);
  const until = Date.parse(task.window.until);
  const targets = reads.slice(cutoff).filter((read) => Date.parse(read.at) >= from && Date.parse(read.at) <= until);
  const modelRun = runForecast(entry, history, task);
  const baseRun = runForecast(baseline, history, task);
  results.push({ cutoff, model: score(modelRun.forecast, targets, task.places), baseline: score(baseRun.forecast, targets, task.places) });
  fs.rmSync(modelRun.dir, { recursive: true, force: true });
  fs.rmSync(baseRun.dir, { recursive: true, force: true });
}
const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), "makefun-validation-"));
const fullOutA = path.join(fullDir, "out-a");
const fullOutB = path.join(fullDir, "out-b");
fs.mkdirSync(fullOutA);
fs.mkdirSync(fullOutB);
const fullRunA = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...process.env, MAKEFUN_INPUT_DIR: kitInput, MAKEFUN_OUTPUT_DIR: fullOutA } });
const fullRunB = spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...process.env, MAKEFUN_INPUT_DIR: kitInput, MAKEFUN_OUTPUT_DIR: fullOutB } });
if (fullRunA.status !== 0 || fullRunB.status !== 0) throw new Error("full validation run failed");
const taskFull = JSON.parse(fs.readFileSync(path.join(kitInput, "task.json"), "utf8"));
const fileName = taskFull.output || "forecast.json";
const rawA = fs.readFileSync(path.join(fullOutA, fileName));
const rawB = fs.readFileSync(path.join(fullOutB, fileName));
if (!rawA.equals(rawB)) throw new Error("non-deterministic output");
const output = JSON.parse(rawA.toString("utf8"));
const places = taskFull.places;
if (Object.keys(output).sort().join(",") !== "probabilities,top10") throw new Error("unexpected output keys");
if (output.top10.length !== places || new Set(output.top10).size !== places) throw new Error("invalid top10");
if (rawA.length > 1048576) throw new Error("output too large");
const seen = new Set();
const sums = Array(places).fill(0);
const counts = Array(places).fill(0);
for (const row of output.probabilities) {
  if (!Number.isInteger(row.universe_id) || !Number.isInteger(row.place) || row.place < 1 || row.place > places || !Number.isFinite(row.p) || row.p < 0 || row.p > 1) throw new Error("invalid probability row");
  const key = row.place + ":" + row.universe_id;
  if (seen.has(key)) throw new Error("duplicate row");
  seen.add(key);
  sums[row.place - 1] += row.p;
  counts[row.place - 1]++;
}
if (counts.some((count) => count > 100)) throw new Error("too many rows at a place");
if (sums.some((sum) => sum > 1 + 1e-10)) throw new Error("place probability sum exceeds one");
const validation = { rows: output.probabilities.length, bytes: rawA.length, sums, deterministic: true };
fs.rmSync(fullDir, { recursive: true, force: true });
console.log(JSON.stringify({ results, validation }));
