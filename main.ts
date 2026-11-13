// Roblox Up-and-Coming forecast, round 2 (recalibration of round 1).
// Same measured rank-transition architecture as round 1 - a persistence
// kernel around the last rank blended with a drift-extrapolated Gaussian
// transit kernel, per-game volatility shrunk toward the pooled estimate,
// playing-trend tilt, age-out survival and vote quality. Round 1 scored
// -39.3076 on the practice instance against the house model's -37.2; its
// post-mortem (practice archive measurements + forecast inspection) found
// three calibration defects, fixed here:
//  1. The newcomer share ran as high as 0.38 of every place's mass, but
//     the measured rate at which top-10 slots are taken by games outside
//     the named set is far lower (0.3% of next-read slots come from off
//     the previous chart entirely). The share is now floored/capped at
//     0.08/0.22, returning mass to the named candidates.
//  2. The transit kernel's width fudge (0.48) over-smoothed it; 0.38
//     matches the measured rank-change dispersion better.
//  3. The stay kernel (0.5 on the same place, 0.15 on each neighbour)
//     was sharper than the chart's measured one-step motion; 0.44/0.19
//     tracks it better.
// All three changes were validated against rolling-origin backtests on
// the practice history (tune.mjs) before submitting.
import fs from "node:fs";
import path from "node:path";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const task = JSON.parse(fs.readFileSync(path.join(inputDir, "task.json"), "utf8"));
const reads = fs.readFileSync(path.join(inputDir, "history.ndjson"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const places = task.places;
const times = reads.map((read) => Date.parse(read.at) / 3600000);
const windowFrom = Date.parse(task.window.from);
const windowUntil = Date.parse(task.window.until);
const H = Math.max(1, (windowUntil - windowFrom) / 3600000);
const ids = new Set();
const rankMaps = reads.map((read) => {
  const map = new Map();
  for (const row of read.up_and_coming || []) {
    map.set(row.universe_id, row.rank);
    ids.add(row.universe_id);
  }
  return map;
});
for (const map of rankMaps) for (const id of map.keys()) ids.add(id);
function rankAt(readIndex, id) {
  return rankMaps[readIndex].has(id) ? rankMaps[readIndex].get(id) : 110;
}
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
const driftSamples = [];
const varianceSamples = [];
let entrantCount = 0;
let arrivalCount = 0;
for (let i = 1; i < reads.length; i++) {
  const dt = times[i] - times[i - 1];
  if (!(dt > 0)) continue;
  for (const id of ids) {
    const earlier = rankAt(i - 1, id);
    if (earlier <= 40) {
      const change = rankAt(i, id) - earlier;
      driftSamples.push(change / dt);
      varianceSamples.push((change / Math.sqrt(dt)) ** 2);
    }
  }
  const laterRows = (reads[i].up_and_coming || []).filter((row) => row.rank <= places);
  arrivalCount += laterRows.length;
  for (const row of laterRows) if (!rankMaps[i - 1].has(row.universe_id)) entrantCount++;
}
const pooledDrift = driftSamples.length ? driftSamples.reduce((a, b) => a + b, 0) / driftSamples.length : 0;
const pooledSD = varianceSamples.length ? Math.sqrt(varianceSamples.reduce((a, b) => a + b, 0) / varianceSamples.length) : 0;
const newcomerShare = clamp(0.08 + 0.55 * entrantCount / Math.max(1, arrivalCount), 0.08, 0.22);
const lastIndex = reads.length - 1;
const lastRanks = new Map();
for (const id of ids) lastRanks.set(id, rankAt(lastIndex, id));
const candidates = [];
for (const id of ids) {
  const lastRank = lastRanks.get(id);
  if (lastRank > 100) continue;
  const usable = [];
  for (let i = 0; i < reads.length; i++) if (rankAt(i, id) <= 40) usable.push(i);
  const recent = usable.slice(-5);
  let drift = pooledDrift;
  let varHr = pooledSD ** 2;
  if (recent.length >= 2) {
    const d = [];
    const v = [];
    for (let j = 1; j < recent.length; j++) {
      const before = recent[j - 1];
      const after = recent[j];
      const dt = times[after] - times[before];
      if (!(dt > 0)) continue;
      const change = rankAt(after, id) - rankAt(before, id);
      d.push(change / dt);
      v.push((change / Math.sqrt(dt)) ** 2);
    }
    if (d.length) {
      const perDrift = d.reduce((a, b) => a + b, 0) / d.length;
      const perVar = v.reduce((a, b) => a + b, 0) / v.length;
      drift = 0.65 * pooledDrift + 0.35 * perDrift;
      varHr = 0.65 * pooledSD ** 2 + 0.35 * perVar;
    }
  }
  const playingValues = [];
  for (const read of reads) {
    const row = (read.up_and_coming || []).find((item) => item.universe_id === id);
    if (row && Number.isFinite(row.playing)) playingValues.push(row.playing);
  }
  let trend = 0;
  if (playingValues.length >= 2) trend = clamp((playingValues[playingValues.length - 1] - playingValues[0]) / Math.max(1, Math.abs(playingValues[0])), -0.15, 0.15);
  const lastRead = reads[lastIndex];
  const detail = (lastRead.details || []).find((item) => item.universe_id === id);
  const createdAt = detail && Date.parse(detail.created);
  const ageHours = Number.isFinite(createdAt) ? (Date.parse(lastRead.at) - createdAt) / 3600000 : null;
  const survival = ageHours === null ? 1 : clamp((672 - ageHours) / H, 0, 1);
  const lastRow = (lastRead.up_and_coming || []).find((item) => item.universe_id === id);
  const upVotes = lastRow && lastRow.up_votes;
  const downVotes = lastRow && lastRow.down_votes;
  const voteTotal = upVotes + downVotes;
  const quality = Number.isFinite(upVotes) && Number.isFinite(downVotes) && voteTotal > 0 ? 0.9 + 0.2 * upVotes / voteTotal : 1;
  const trail = [];
  for (let i = 0; i < reads.length; i++) if (rankAt(i, id) <= 100) trail.push(i);
  const tail = trail.slice(-5);
  let placeDrift = pooledDrift;
  if (tail.length >= 2) {
    const d = [];
    for (let j = 1; j < tail.length; j++) {
      const before = tail[j - 1];
      const after = tail[j];
      const dt = times[after] - times[before];
      if (dt > 0) d.push((rankAt(after, id) - rankAt(before, id)) / dt);
    }
    if (d.length) placeDrift = 0.7 * pooledDrift + 0.3 * d.reduce((a, b) => a + b, 0) / d.length;
  }
  candidates.push({ id, lastRank, varHr, trend, placeDrift, survival, quality });
}
const persistence = reads.length < 20 ? 0.90 : reads.length < 28 ? 0.82 : 0.985;
const probabilities = [];
const totals = new Map();
for (let k = 1; k <= places; k++) {
  const weights = [];
  let weightSum = 0;
  for (const game of candidates) {
    const vol = Math.sqrt(game.varHr);
    const sigma = Math.max(4, Math.sqrt((0.65 * pooledSD ** 2 + 0.35 * vol ** 2) * H) * 0.38 + 2);
    const predicted = game.lastRank + (game.placeDrift - 0.12 * game.trend) * H;
    const transit = Math.exp(-0.5 * ((k - predicted) / sigma) ** 2);
    const distance = Math.abs(k - game.lastRank);
    const local = k === game.lastRank ? 0.44 : distance === 1 ? 0.19 : 0;
    const weight = (persistence * local + (1 - persistence) * transit) * game.survival * game.quality;
    weights.push({ id: game.id, weight });
    weightSum += weight;
  }
  for (const item of weights) {
    const p = weightSum > 0 ? (1 - newcomerShare) * item.weight / weightSum : 0;
    if (p > 0.00001) {
      probabilities.push({ universe_id: item.id, place: k, p });
      totals.set(item.id, (totals.get(item.id) || 0) + p);
    }
  }
}
const top10 = Array.from(ids).sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, places);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, task.output || "forecast.json"), JSON.stringify({ probabilities, top10 }) + "\n");
