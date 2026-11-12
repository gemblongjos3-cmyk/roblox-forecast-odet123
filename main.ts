import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const input=process.env.MAKEFUN_INPUT_DIR??'/input', output=process.env.MAKEFUN_OUTPUT_DIR??'/output';
const task=JSON.parse(readFileSync(join(input,'task.json'),'utf8'));
const reads=readFileSync(join(input,'history.ndjson'),'utf8').trim().split('\n').map((s:string)=>JSON.parse(s));
const places=task.places, last=reads.at(-1), ids=[...new Set(reads.flatMap((r:any)=>r.up_and_coming.map((x:any)=>x.universe_id)))];
const hours=reads.map((r:any)=>Date.parse(r.at)/3600000), target=Math.max(1,(Date.parse(task.window.until)-Date.parse(task.window.from))/3600000);
const charts=reads.map((r:any)=>new Map(r.up_and_coming.map((x:any)=>[x.universe_id,x.rank])));
const ranks=new Map<number,number[]>();
for(const id of ids) ranks.set(id,charts.map((c:Map<number,number>)=>c.get(id)??110));
// Empirical transition drift and variance per hour; shrink noisy game estimates to pooled chart movement.
let pooledDrift=0, pooledVar=0, n=0;
for(let t=1;t<reads.length;t++) { const dt=hours[t]-hours[t-1]; if(dt<=0)continue; const old=charts[t-1], now=charts[t];
 for(const [id,a] of old) {const b=now.get(id)??110; if(a<=40){pooledDrift+=(b-a)/dt; pooledVar+=((b-a)/Math.sqrt(dt))**2; n++;}}
}
pooledDrift/=Math.max(1,n); pooledVar=Math.sqrt(pooledVar/Math.max(1,n));
const current=new Map<number,{survival:number;vol:number;trend:number}>();
// Estimate newcomer mass from observed transitions into the scored top ten.
let top10Entrants=0, top10Arrivals=0;
for(let t=1;t<reads.length;t++){const old=charts[t-1],now=charts[t];for(const [id,r] of now){if(r<=places){top10Arrivals++;if(!old.has(id))top10Entrants++;}}}
const newcomerShare=Math.max(.16,Math.min(.38,.16+.55*top10Entrants/Math.max(1,top10Arrivals)));
for(const id of ids){const rs=ranks.get(id)!, usable:number[]=[]; for(let i=0;i<rs.length;i++)if(rs[i]<=40)usable.push(i);
 const recent=usable.slice(-5); let drift=pooledDrift, varHr=pooledVar**2;
 if(recent.length>=2){let ds=0,vs=0,nn=0;for(let j=1;j<recent.length;j++){const a=recent[j-1],b=recent[j],dt=hours[b]-hours[a];if(dt>0){ds+=(rs[b]-rs[a])/dt;vs+=((rs[b]-rs[a])/Math.sqrt(dt))**2;nn++;}} if(nn){drift=.65*pooledDrift+.35*ds/nn;varHr=.65*varHr+.35*vs/nn;}}
 const rank=rs.at(-1)!; if(rank>100)continue;
 // Age removes games at day 28; estimate 72h survival from details when supplied.
 let survival=1; const det=last.details?.[String(id)]??last.details?.[id]; if(det?.created){const age=(Date.parse(last.at)-Date.parse(det.created))/3600000; survival=Math.max(.04,Math.min(1,(672-age-target)/Math.max(1,672-age)));}
 const mu=rank+drift*target, sigma=Math.max(3,Math.sqrt(varHr*target)*.72+2.5);
 // Per-game volatility and recent playing-count trend are measured when present.
 const ps=reads.map((r:any)=>r.up_and_coming.find((x:any)=>x.universe_id===id)?.playing).filter((x:any)=>Number.isFinite(x));
 let trend=0;if(ps.length>=2){const m=ps.length;trend=Math.max(-.15,Math.min(.15,(ps[m-1]-ps[0])/Math.max(1,Math.abs(ps[0]))));}
 current.set(id,{survival,vol:Math.sqrt(varHr),trend});
}
const probs:any[]=[];
// Empirical long-horizon kernel mixed with persistence. Short, sparse histories
// keep more mass near the latest observed ordering; longer histories can use drift.
const observations=reads.length;
const persistence=observations<20?.90:observations<28?.82:.985;
for(let k=1;k<=places;k++){
 const raw=new Map<number,number>(); let total=0;
 for(const [id,stats] of current){const {survival,vol,trend}=stats;const rs=ranks.get(id)!, rank=rs.at(-1)!;
  const trail=rs.map((x,i)=>x<=100?i:-1).filter(x=>x>=0).slice(-5);let drift=pooledDrift;
  if(trail.length>=2){let sum=0,ct=0;for(let j=1;j<trail.length;j++){const a=trail[j-1],b=trail[j],dt=hours[b]-hours[a];if(dt>0){sum+=(rs[b]-rs[a])/dt;ct++;}}if(ct)drift=.7*pooledDrift+.3*sum/ct;}
  const sigma=Math.max(4,Math.sqrt((.65*pooledVar*pooledVar+.35*vol*vol)*target)*.48+2);
  const predicted=rank+(drift-.12*trend)*target;
  const transit=Math.exp(-.5*((k-predicted)/sigma)**2);
  const local=k===rank?.5:(Math.abs(k-rank)===1?.15:0);
  // The observed local stay/neighbour mass anchors rank persistence; the empirical
  // transition kernel redistributes only the residual named share.
  let weight=(persistence*local+(1-persistence)*transit)*survival;
  raw.set(id,weight);total+=weight;
 }
 const namedMass=1-newcomerShare;
 for(const [id,x] of raw){const p=namedMass*x/(total||1);if(p>0.00001)probs.push({universe_id:id,place:k,p});}
}
const aggregate=new Map<number,number>();for(const x of probs)aggregate.set(x.universe_id,(aggregate.get(x.universe_id)??0)+x.p);
const top10=[...aggregate].sort((a,b)=>b[1]-a[1]).slice(0,places).map(x=>x[0]);
writeFileSync(join(output,task.output),JSON.stringify({probabilities:probs,top10})+'\n');
