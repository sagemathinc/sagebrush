// astra's browser probes on c05ffd53 (CORR-C05-1/2), from /scratch/sagebrush-reviews/evidence/durability-detect-c05-astra/browser-cases.js:
// the three hook cases verbatim; the fourth inverted (see it)
import * as W from './ws.js';import * as S from './stores.js';
export async function run(){const out=[];const w=await W.Workspace.open({name:'astrac05',mainName:'astrac05main'}),e=await w.create('/n.ipynb'),db=await S.openHistoryDb();
 for(const mode of ['undefined','changed','inherited']){
  const h=new S.IdbPatchStore(db,e.ref+mode),d={time:'wanted',patch:'original'};let invokes=0;
  const fn=function(){if(this!==d)return this;invokes++;return mode==='changed'?{time:'other',patch:'changed'}:undefined};
  if(mode==='inherited')Object.defineProperty(Object.prototype,'toJSON',{value:fn,configurable:true});else Object.defineProperty(d,'toJSON',{value:fn});
  let took,error=null,measured;try{measured=S.jsonTextSize(d,1000);took=h.append(d)}catch(e){error=String(e)}finally{if(mode==='inherited')delete Object.prototype.toJSON;}
  await h.appending;const rows=(await h.loadInitial()).patches;
  out.push([took===false&&!error&&!invokes,'serialization hook refused without invoking or throwing: '+JSON.stringify({mode,measured,took,error,invokes,rows})]);
 }
 // (this one inverted, the only change: under the strict 8 MiB that @sagebrush decided for LIMIT-C05-1, a first
 // entry past it is refused, its precheck and final admission one limit (CORR-C05-1); HISTORY_ENTRY_MAX is gone)
 const h=new S.IdbPatchStore(db,e.ref+'large'),d={time:'large',patch:'x'.repeat(4*2**20+100)};const len=JSON.stringify(d).length,before=S.historyBacklog(),took=h.append(d),charge=2*len+S.ENTRY_OVERHEAD;
 out.push([took===false,'empty-backlog first entry past the strict 8 MiB of charge refused: '+JSON.stringify({before,len,charge,normalCap:S.HISTORY_BACKLOG.bytes,took})]);await h.appending;w.close();db.close();return out;}
