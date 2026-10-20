import * as W from "./ws.js";
import * as S from "./stores.js";
import { createNotebook } from "./nb.js";
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
export async function run() {
 const results=[];
 // A timed-out earlier version must not overwrite a later successful save after leaving the notebook.
 const root=document.body.appendChild(document.createElement('div'));
 const nb=createNotebook(root), calls=[];
 let rejectFirst, secondDone, first=true, rev=1;
 let current={name:'A',mode:'python',cells:[{id:'a',code:'A0'}]};
 const second = new Promise(r=>secondDone=r);
 const A={load:async()=>({...current,rev}),subscribe:()=>()=>{},save:(d)=>{
   if(first){first=false;return new Promise((r,no)=>rejectFirst=no);}
   calls.push({code:d.cells[0].code,baseRev:d.baseRev}); current=structuredClone(d);rev++;
   secondDone(); return Promise.resolve({saved:'saved',rev});
 }};
 const B={load:async()=>({name:'B',mode:'python',cells:[{id:'b',code:'B0'}],rev:1}),subscribe:()=>()=>{},save:async()=>({saved:'saved',rev:2})};
 await nb.attach(A);
 nb.setInput(nb.cells()[0],'A1 older busy');nb.flush();
 nb.setInput(nb.cells()[0],'A2 newer kept');nb.flush();
 await nb.attach(B);
 rejectFirst(Object.assign(new Error('your files are busy'),{busy:true}));
 await second;await sleep(25);
 const before=current.cells[0].code,leftBefore=nb.leftOutstanding;
 let error=null;try{await nb.saved();}catch(e){error=String(e);}
 const trace={before,after:current.cells[0].code,calls,leftBefore,leftAfter:nb.leftOutstanding,error};
 results.push([trace.before==='A2 newer kept' && trace.after==='A2 newer kept','newer success supersedes older busy retry: '+JSON.stringify(trace)]);
 nb.destroy();root.remove();
 // Same schedule through the actual fenced IndexedDB save/CAS implementation.
 {
  const w=await W.Workspace.open({name:'astra9d7retry',mainName:'astra9d7retrymain'});
  const e=await w.create('/A.ipynb',{content:{name:'A',mode:'python',cells:[{id:'a',code:'A0'}]}});
  const st=new S.IdbStore(w.main,e.ref), el=document.body.appendChild(document.createElement('div')), n=createNotebook(el);
  let first=true,rejectFirst,secondDone;const calls=[];const second=new Promise(r=>secondDone=r);
  const A={load:()=>st.load(),subscribe:()=>()=>{},save:async(d)=>{
   if(first){first=false;return new Promise((r,no)=>rejectFirst=no);}
   calls.push({code:d.cells[0].code,baseRev:d.baseRev});const out=await st.save(d);secondDone();return out;
  }};
  await n.attach(A);n.setInput(n.cells()[0],'A1 older busy');n.flush();n.setInput(n.cells()[0],'A2 newer kept');n.flush();await n.attach(B);
  rejectFirst(Object.assign(new Error('your files are busy'),{busy:true}));await second;await sleep(25);
  const before=(await st.load()).cells[0].code;
  let error=null;try{await n.saved();}catch(e){error=String(e);}
  const after=(await st.load()).cells[0].code;
  results.push([after===before,'actual fenced IndexedDB newer save stays kept: '+JSON.stringify({before,after,calls,error})]);
  n.destroy();el.remove();w.close();
 }
 // The clear/drop bound must start when called, not after an indefinite append queue.
 for(const mode of ['clear','drop']){
  const w=await W.Workspace.open({name:'astra9d7-'+mode,mainName:'astra9d7main-'+mode});
  const e=await w.create('/n.ipynb');const db=await S.openHistoryDb();const h=new S.IdbPatchStore(db,e.ref);await h.loadInitial();
  h.append({time:'seed',id:'seed'});await h.appending;
  let release;await new Promise(r=>navigator.locks.request('sagebrush-workspace',()=>new Promise(g=>{release=g;r();})));
  S.LOCK_WAIT.ms=100;
  const appended=h.append({time:'queued',id:'queued'});
  let result;const deletion=h[mode]().then(()=>{result='deleted';return result},e=>{result=String(e);return result});
  const atBound=await Promise.race([deletion,sleep(400).then(()=> 'still waiting')]);
  release();await deletion;await h.appending;await sleep(25);
  const rows=(await h.loadInitial()).patches.map(x=>x.id);
  const t={mode,appended,atBound,afterRelease:result,rows};
  results.push([atBound!=='still waiting' && result!=='deleted' && rows.includes('seed'),mode+' behind blocked append times out without later deletion: '+JSON.stringify(t)]);
  w.close();db.close();S.LOCK_WAIT.ms=10000;
 }
 return results;
}
