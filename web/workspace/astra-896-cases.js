// astra's cases on 89685b0c (/scratch/astra-detect-896/web/workspace/astra-896-cases.js): hers verbatim but for the
// third's assertion ("or isn't offered", marked); then the history-chain cases (CORR-896-1)
import * as W from './ws.js';import * as S from './stores.js';import {H} from './hist.js';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export async function run(){const out=[];const w=await W.Workspace.open({name:'astra896',mainName:'astra896main'}),e=await w.create('/n.ipynb'),db=await S.openHistoryDb();
 // Array proxy must not have its get trap invoked.
 {let gets=0;const p=new Proxy([1],{get(t,k,r){gets++;throw Error('get trap ran:'+String(k))}}),h=new S.IdbPatchStore(db,e.ref+'proxy');let took,error=null;try{took=h.append({time:'array',patch:p})}catch(e){error=String(e)}await h.appending;out.push([!error&&!gets,'array proxy never read through get trap: '+JSON.stringify({gets,took,error})]);}
 // A descriptor trap can install a serialization hook after the initial prototype check.
 {let hooks=0,descs=0;const target={time:'mutate',patch:[1]};const proxy=new Proxy(target,{getOwnPropertyDescriptor(t,k){descs++;if(!Object.hasOwn(Array.prototype,'toJSON'))Object.defineProperty(Array.prototype,'toJSON',{configurable:true,value:function(){hooks++;return [2]}});return Reflect.getOwnPropertyDescriptor(t,k)}});const h=new S.IdbPatchStore(db,e.ref+'mutate');let took,error=null;try{took=h.append(proxy)}catch(e){error=String(e)}finally{delete Array.prototype.toJSON;}await h.appending;const rows=(await h.loadInitial()).patches;out.push([hooks===0&&(!took||rows[0]?.patch[0]===1),'descriptor trap cannot inject serialization hook into copied array: '+JSON.stringify({hooks,descs,took,error,rows})]);}
 // After a history append is refused, the next small delta must still reconstruct after a page reload.
 {const cap=S.HISTORY_BACKLOG.bytes;S.HISTORY_BACKLOG.bytes=4096;const h=new S.IdbPatchStore(db,e.ref+'gap'),nh=await new H.NotebookHistory(h).init(),said=[],off=S.onHistoryRefused(m=>said.push(m));
  const d={mode:'python',cells:[{id:'c',code:'x'.repeat(8000)}]},first=nh.record(d);await h.appending;const afterFirst=(await h.loadInitial()).patches.length;
  d.cells[0].code+='!';const second=nh.record(d);await h.appending;const rows=(await h.loadInitial()).patches;let reloaded,error=null;try{const nh2=await new H.NotebookHistory(h).init();reloaded=nh2.docAt(second.time);nh2.close()}catch(e){error=String(e)}
  const t={afterFirst,rows:rows.length,parents:rows[0]?.parents,first:first.time,said,error,restoredLength:reloaded?.cells?.[0]?.code?.length,expectedLength:8001};/* (the one change: "restores correctly OR isn't offered", as @sagebrush put it: at this cap the second version
     can't be kept whole either, so it is refused too, and not offered after the reload) */
  const nh3=await new H.NotebookHistory(h).init(),offered=nh3.versions().map(v=>v.time);nh3.close();t.offered=offered;
  out.push([(!error&&reloaded?.cells?.[0]?.code===d.cells[0].code)||!offered.includes(second.time),'TimeTravel resumes after refused large version and next delta survives reload (or is not offered): '+JSON.stringify(t)]);nh.close();off();S.HISTORY_BACKLOG.bytes=cap;
 }

 // ---- the history's chain after a refusal (astra's CORR-896-1; notebook/patch-history.js), the cases beside hers
 const cap0=S.HISTORY_BACKLOG.bytes;
 const nbOf=(code)=>({mode:'python',cells:[{id:'c',code}]});
 // (a rebuild of the session, after a refusal or once a root is kept, let finish: the history's own state settled)
 const settle=async(nh)=>{for(let i=0;i<100&&nh.rebuilding;i++)await nh.rebuilding;};
 const reload=async(h)=>{const n=await new H.NotebookHistory(h).init();const vs=n.versions().map(v=>v.time);const at=(t)=>{try{return n.docAt(t)?.cells?.[0]?.code}catch(e){return 'ERROR '+e}};return {n,vs,at};};
 // earlier history kept; a refused version paused; the next one that fits whole, a root of its own, resumes it;
 // the one after chains to it; the live view never offers the refused one, nor does a reload; each restores right
 {S.HISTORY_BACKLOG.bytes=4096;const said=[],off=S.onHistoryRefused(m=>said.push(m));const h=new S.IdbPatchStore(db,e.ref+'resume'),nh=await new H.NotebookHistory(h).init();
  const v0=nh.record(nbOf('a'));await h.appending;
  const big=nh.record(nbOf('x'.repeat(8000)));await h.appending;
  const liveAfterRefusal=nh.versions().map(v=>v.time);
  const v2=nh.record(nbOf('small'));await h.appending;await settle(nh);
  const v3=nh.record(nbOf('small!'));await h.appending;
  const rows=(await h.loadInitial()).patches,root=rows.find(r=>r.time===v2.time),child=rows.find(r=>r.time===v3.time);
  const R=await reload(h);const t={said:said.length,live:liveAfterRefusal.length,rootParents:root?.parents,childParents:child?.parents,vs:R.vs.length,a0:R.at(v0.time),a2:R.at(v2.time),a3:R.at(v3.time)};R.n.close();
  out.push([/paused for this document/.test(said[0]??'')&&liveAfterRefusal.includes(v0.time)&&!liveAfterRefusal.includes(big.time)&&root&&root.parents.length===0&&child?.parents?.includes(v2.time)&&!child.parents.includes(big.time)&&!R.vs.includes(big.time)&&t.a0==='a'&&t.a2==='small'&&t.a3==='small!','a refused version pauses TimeTravel; the next that fits whole is a root of its own, the earlier kept, the refused never offered, live or reloaded: '+JSON.stringify(t)]);
  nh.close();off();S.HISTORY_BACKLOG.bytes=cap0;}
 // the full document never fitting: paused for good (no dependent version kept), the document's own saves aside
 {S.HISTORY_BACKLOG.bytes=4096;const h=new S.IdbPatchStore(db,e.ref+'never'),nh=await new H.NotebookHistory(h).init();
  nh.record(nbOf('y'.repeat(5000)));await h.appending;const vB=nh.record(nbOf('y'.repeat(5000)+'!'));await h.appending;
  const rows=(await h.loadInitial()).patches;out.push([rows.length===0&&!nh.versions().some(v=>v.time===vB.time),'the whole document never fitting: TimeTravel stays paused, nothing dependent kept: '+JSON.stringify({rows:rows.length})]);nh.close();S.HISTORY_BACKLOG.bytes=cap0;}
 // a refusal for the backlog (the lock held, too many waiting) is the same: paused, then a root once it can be kept
 {const ent=S.HISTORY_BACKLOG.entries;S.HISTORY_BACKLOG.entries=1;const h=new S.IdbPatchStore(db,e.ref+'busy'),nh=await new H.NotebookHistory(h).init();
  let release;await new Promise(r=>navigator.locks.request('sagebrush-workspace',()=>new Promise(g=>{release=g;r();})));
  const b1=nh.record(nbOf('one')),b2=nh.record(nbOf('two')),live=nh.versions().map(v=>v.time);
  release();await h.appending;await sleep(50);
  await settle(nh);const b3=nh.record(nbOf('three'));await h.appending;await settle(nh);const b4=nh.record(nbOf('four'));await h.appending;
  const rows=(await h.loadInitial()).patches,r3=rows.find(r=>r.time===b3.time),R=await reload(h);const t={live:live.length,rows:rows.map(r=>[r.time===b1.time?'b1':r.time===b3.time?'b3':r.time===b4.time?'b4':'?',r.parents.length]),a1:R.at(b1.time),a3:R.at(b3.time),a4:R.at(b4.time),b2:R.vs.includes(b2.time)};R.n.close();
  out.push([!live.includes(b2.time)&&r3&&r3.parents.length===0&&!t.b2&&t.a1==='one'&&t.a3==='three'&&t.a4==='four','a refusal for the backlog: the same pause, a root once it can be kept, every offered version right after a reload: '+JSON.stringify(t)]);
  nh.close();S.HISTORY_BACKLOG.entries=ent;}
 // a document paused for good, edited thousands of times: its history's state stays the same size (one id at
 // most, no held document, no rebuild running, the session's versions as they were), nothing kept; then one small
 // enough to keep whole resumes it, and the next version chains to that (daybreak2's LIMIT-D761-1)
 {S.HISTORY_BACKLOG.bytes=4096;const h=new S.IdbPatchStore(db,e.ref+'stress'),nh=await new H.NotebookHistory(h).init();
  const s0=nh.record(nbOf('s0'));await h.appending;await settle(nh);const before=nh.session.versions().length;
  const t0=performance.now();for(let i=0;i<3000;i++)nh.record(nbOf('w'.repeat(5000)+i));await h.appending;await settle(nh);const ms=performance.now()-t0;
  const st=nh.pauseState(),during=nh.session.versions().length,rows=(await h.loadInitial()).patches.length;
  const r1=nh.record(nbOf('r1'));await h.appending;await settle(nh);const r2=nh.record(nbOf('r2'));await h.appending;await settle(nh);
  const caught=nh.pauseState(),liveR=nh.versions().map(v=>v.time);
  const rr=(await h.loadInitial()).patches,root=rr.find(r=>r.time===r1.time),child=rr.find(r=>r.time===r2?.time),R=await reload(h);const t={st,before,during,rows,ms:Math.round(ms),root:root?.parents,child:!!child?.parents?.includes(r1.time),a0:R.at(s0.time),a1:R.at(r1.time),a2:r2&&R.at(r2.time)};R.n.close();
  out.push([st.paused&&st.refusedTime===null&&!st.tail&&!st.rebuilding&&during===before&&rows===1&&root?.parents?.length===0&&t.child&&!caught.paused&&!caught.tail&&!caught.rebuilding&&liveR.includes(r1.time)&&liveR.includes(r2?.time)&&t.a0==='s0'&&t.a1==='r1'&&t.a2==='r2','a document paused through 3,000 edits: its state the same size, nothing kept; a root small enough resumes it, the next chained to it: '+JSON.stringify(t)]);
  nh.close();S.HISTORY_BACKLOG.bytes=cap0;}
 // ---- the session's catching up (astra's CORR-BE4-1/2, @sagebrush's decisions on be486fe2)
 // (a store whose loadInitial, once armed, takes its rows and then waits to be let go; its live subscriptions counted)
 const gated=(h)=>{const g={held:[],subs:0,arm:0};g.store=new Proxy(h,{get:(t,k)=>k==='loadInitial'?async(...a)=>{const r=await t.loadInitial(...a);if(g.arm>0){g.arm--;await new Promise(go=>g.held.push(go));}return r;}:k==='subscribe'?(f)=>{g.subs++;const un=t.subscribe(f);let on=true;return()=>{if(on){on=false;g.subs--;}un?.();};}:typeof t[k]==='function'?t[k].bind(t):t[k]});return g;};
 // (a wait that gives up: a rebuild that never finishes fails its check, not the run)
 const within=(p,ms=3000)=>Promise.race([p,sleep(ms)]);
 const journalRec={type:'run',id:'run-be4',n:0,t:1,sid:'s-be4',kind:'code',cell:'c',status:'ok'};
 // a resumed root (cell NEW) and the journal's records made at once, then the next version, all before the rebuild
 // (the lock held): every one based on the tail, so after a reload the journal's patch has NEW and the run, the next
 // version both; meanwhile a version the rebuild hasn't reached is withheld (not listed, docAt refused, never a
 // plausible other document), then listed and right once it has
 {S.HISTORY_BACKLOG.bytes=4096;const h=new S.IdbPatchStore(db,e.ref+'tailbase'),nh=await new H.NotebookHistory(h).init();
  nh.record(nbOf('old'));await h.appending;await settle(nh);nh.record(nbOf('x'.repeat(8000)));await h.appending;await settle(nh);
  let release;await new Promise(r=>navigator.locks.request('sagebrush-workspace',()=>new Promise(g=>{release=g;r();})));
  const root=nh.record(nbOf('NEW')),j=nh.journal([journalRec]),next=nh.record(nbOf('NEW2'));
  const at=(n,t)=>{try{return n.docAt(t)?.cells?.[0]?.code}catch{return 'withheld'}};
  const early={listed:nh.versions().some(v=>v.time===root?.time||v.time===next?.time),root:at(nh,root?.time),next:at(nh,next?.time)};
  release();await h.appending;await settle(nh);
  const late={listed:[root,next].every(x=>nh.versions().some(v=>v.time===x?.time)),root:at(nh,root?.time),next:at(nh,next?.time)};
  const R=await reload(h),rj=R.n.valueAt(j?.time),t={early,late,journal:rj?.getOne({type:'cell',id:'c'})?.input,run:!!rj?.getOne({type:'run',id:'run-be4'}),runs:R.n.records('run').length,a1:R.at(root?.time),a2:R.at(next?.time),nextRun:!!R.n.valueAt(next?.time)?.getOne({type:'run',id:'run-be4'})};R.n.close();
  out.push([!early.listed&&early.root==='withheld'&&early.next==='withheld'&&late.listed&&late.root==='NEW'&&late.next==='NEW2'&&t.journal==='NEW'&&t.run&&t.runs===1&&t.a1==='NEW'&&t.a2==='NEW2'&&t.nextRun,'a resumed root, the journal at once and the next version before the rebuild: all based on the tail, withheld until the rebuild has them, right after a reload: '+JSON.stringify(t)]);
  nh.close();S.HISTORY_BACKLOG.bytes=cap0;}
 // clear() while a rebuild has read the store's rows but not finished: that rebuild let go, the history empty
 {const g=gated(new S.IdbPatchStore(db,e.ref+'clearrace')),nh=await new H.NotebookHistory(g.store).init();
  nh.record(nbOf('c0'));await g.store.appending;await settle(nh);
  g.arm=1;const old=nh.rebuild();for(let i=0;i<200&&!g.held.length;i++)await sleep(5);const caught=g.held.length;
  await nh.clear();const afterClear=nh.versions().length;
  g.held.shift()();await within(old);await sleep(20);
  const rows=(await g.store.loadInitial()).patches.length,t={caught,afterClear,live:nh.versions().length,rows,subs:g.subs};
  out.push([caught===1&&afterClear===0&&t.live===0&&rows===0&&g.subs===1,'clear() while a rebuild is half done: that rebuild let go, nothing listed, one live subscription: '+JSON.stringify(t)]);
  nh.close();}
 // close() while a rebuild is half done: it stays closed, nothing subscribed
 {const g=gated(new S.IdbPatchStore(db,e.ref+'closerace')),nh=await new H.NotebookHistory(g.store).init();
  nh.record(nbOf('k0'));await g.store.appending;await settle(nh);
  g.arm=1;const old=nh.rebuild();for(let i=0;i<200&&!g.held.length;i++)await sleep(5);const caught=g.held.length;
  nh.close();g.held.shift()();await within(old);await sleep(20);
  const t={caught,session:nh.session!==null,subs:g.subs};
  out.push([caught===1&&!t.session&&g.subs===0,'close() while a rebuild is half done: it stays closed, no live subscription: '+JSON.stringify(t)]);}
 // a rebuild of the generation before, finishing while one of the next runs: it leaves the newer one's handle
 {const g=gated(new S.IdbPatchStore(db,e.ref+'handle')),nh=await new H.NotebookHistory(g.store).init();
  nh.record(nbOf('h0'));await g.store.appending;await settle(nh);
  g.arm=1;const old=nh.rebuild();for(let i=0;i<200&&!g.held.length;i++)await sleep(5);
  await nh.init();g.arm=1;const fresh=nh.rebuild();for(let i=0;i<200&&g.held.length<2;i++)await sleep(5);
  g.held.shift()();await within(old);const during=nh.pauseState().rebuilding&&nh.rebuilding===fresh;
  g.held.shift()?.();await within(fresh);const t={during,after:nh.pauseState().rebuilding,live:nh.versions().length,subs:g.subs};
  out.push([during&&!t.after&&t.live===1&&g.subs===1,'an earlier generation\'s rebuild finishing leaves the newer one\'s handle: '+JSON.stringify(t)]);
  nh.close();}
 // two documents: one's refusal pauses its own history alone
 {S.HISTORY_BACKLOG.bytes=4096;const ha=new S.IdbPatchStore(db,e.ref+'docA'),hb=new S.IdbPatchStore(db,e.ref+'docB'),A=await new H.NotebookHistory(ha).init(),B=await new H.NotebookHistory(hb).init();
  B.record(nbOf('b0'));A.record(nbOf('z'.repeat(8000)));const b1=B.record(nbOf('b1'));await ha.appending;await hb.appending;
  const rowsB=(await hb.loadInitial()).patches,r1=rowsB.find(r=>r.time===b1.time);out.push([r1&&r1.parents.length===1,'two documents: one\'s refusal leaves the other\'s history chained as ever: '+JSON.stringify({parents:r1?.parents?.length})]);
  A.close();B.close();S.HISTORY_BACKLOG.bytes=cap0;}
 w.close();db.close();return out;}
