import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const kit='/home/hatch/workspace/makefun/roblox-up-and-coming-forecast-01-kit';
const source=path.join(kit,'input');
const all=fs.readFileSync(path.join(source,'history.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
const baseTask=JSON.parse(fs.readFileSync(path.join(source,'task.json'),'utf8'));
const baseline=fs.readFileSync(path.join(kit,'starter/main.ts'));
const cutoffs=[16,21,26,30];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'roblox-bt-'));
function run(entry, dir) {
  const out=path.join(dir,'out'); fs.mkdirSync(out,{recursive:true});
  const p=spawnSync('node',[entry],{encoding:'utf8',env:{...process.env,MAKEFUN_INPUT_DIR:dir,MAKEFUN_OUTPUT_DIR:out}});
  if(p.status!==0) throw Error(`${entry}: ${p.stderr||p.stdout}`);
  return fs.readFileSync(path.join(out,baseTask.output),'utf8');
}
function score(obj, targets, places) {
  let logs=0,hits=0,agree=0;
  for(const r of targets) {
    const chart=[...r.up_and_coming].sort((a,b)=>a.rank-b.rank), rank=new Map(chart.map((x,i)=>[x.universe_id,i+1]));
    const predicted=new Map(obj.probabilities.filter(x=>x.place>=1&&x.place<=places).map(x=>[`${x.place}:${x.universe_id}`,x.p]));
    const sums=Array(places+1).fill(0), named=Array.from({length:places+1},()=>new Set());
    for(const x of obj.probabilities){sums[x.place]+=x.p;named[x.place].add(x.universe_id)}
    for(let k=1;k<=places;k++) {const id=chart[k-1]?.universe_id; if(id===undefined)continue;
      let p=predicted.get(`${k}:${id}`);if(p===undefined)p=(1-sums[k])/Math.max(1,chart.filter(x=>!named[k].has(x.universe_id)).length);
      logs+=Math.log(Math.max(.0001,p));
    }
    hits+=obj.top10.filter(id=>rank.has(id)&&rank.get(id)<=places).length;
    for(let i=0;i<obj.top10.length;i++){const j=rank.get(obj.top10[i]);if(j&&j<=places)agree+=places-Math.abs((i+1)-j);}
  }
  return {log:(logs/targets.length).toFixed(6),hits:(hits/targets.length).toFixed(3),agreement:(agree/targets.length).toFixed(3)};
}
const results=[];
for(const n of cutoffs) {
  const cutoff=all[n-1], until=Date.parse(cutoff.at)+72*3600000;
  const targets=all.slice(n).filter(x=>Date.parse(x.at)>=Date.parse(cutoff.at)&&Date.parse(x.at)<until);
  if(!targets.length)continue;
  const dir=path.join(tmp,`c${n}`);fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'history.ndjson'),all.slice(0,n).map(x=>JSON.stringify(x)).join('\n')+'\n');
  fs.writeFileSync(path.join(dir,'task.json'),JSON.stringify({...baseTask,history_until:cutoff.at,window:{...baseTask.window,from:cutoff.at,until:new Date(until).toISOString()}}));
  const b=path.join(dir,'baseline.ts');fs.writeFileSync(b,baseline);
  const mine=JSON.parse(run(path.join(root,'main.ts'),dir));const house=JSON.parse(run(b,dir));
  results.push({cutoff:n,reads:targets.length,model:score(mine,targets,baseTask.places),baseline:score(house,targets,baseTask.places)});
}
// Full input shape, row caps, sums, size, and byte-for-byte determinism.
const full=path.join(tmp,'full');fs.mkdirSync(full);
fs.copyFileSync(path.join(source,'task.json'),path.join(full,'task.json'));fs.copyFileSync(path.join(source,'history.ndjson'),path.join(full,'history.ndjson'));
const a=run(path.join(root,'main.ts'),full),b=run(path.join(root,'main.ts'),full),obj=JSON.parse(a);
if(a!==b)throw Error('nondeterministic output');
if(Object.keys(obj).sort().join(',')!=='probabilities,top10')throw Error('wrong keys');
if(obj.top10.length!==baseTask.places||new Set(obj.top10).size!==obj.top10.length)throw Error('bad top10');
if(Buffer.byteLength(a)>1048576)throw Error('output too large');
const sums=Array(baseTask.places+1).fill(0),counts=Array(baseTask.places+1).fill(0),seen=new Set();
for(const x of obj.probabilities){if(!Number.isInteger(x.universe_id)||!Number.isInteger(x.place)||x.place<1||x.place>baseTask.places||!Number.isFinite(x.p)||x.p<0||x.p>1)throw Error('bad row');const key=`${x.place}:${x.universe_id}`;if(seen.has(key))throw Error('duplicate row');seen.add(key);sums[x.place]+=x.p;counts[x.place]++;}
for(let k=1;k<=baseTask.places;k++)if(counts[k]>100||sums[k]>1+1e-10)throw Error(`bad place ${k}`);
console.log(JSON.stringify({results,validation:{rows:obj.probabilities.length,bytes:Buffer.byteLength(a),sums:sums.slice(1),deterministic:true}},null,2));
fs.rmSync(tmp,{recursive:true,force:true});
