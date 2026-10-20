import * as W from './ws.js';import * as S from './stores.js';import {H,BoardHistory} from './hist.js';
const cells=d=>(d?.cells??[]).map(c=>[c.id,c.code]).sort((a,b)=>a[0].localeCompare(b[0]));
export async function run(){const out=[],w=await W.Workspace.open({name:'astrad76',mainName:'astrad76main'}),e=await w.create('/n.ipynb'),db=await S.openHistoryDb(),cap=S.HISTORY_BACKLOG.bytes;S.HISTORY_BACKLOG.bytes=4096;
 const h=new S.IdbPatchStore(db,e.ref+'complex'),n=await new H.NotebookHistory(h).init(),good=[],bad=[];
 const commit=async(d,take=true)=>{const env=n.record(d);await h.appending;(take?good:bad).push([env.time,structuredClone(d)]);return env};
 await commit({mode:'python',cells:[{id:'old',code:'old'},{id:'gone',code:'remove'}]});
 await commit({mode:'python',cells:[{id:'huge',code:'x'.repeat(8000)}]},false);
 await commit({mode:'sage',cells:[{id:'new',code:'new'},{id:'temp',code:'temporary'}]});
 await commit({mode:'sage',cells:[{id:'new',code:'new!'}]});
 const r=await new H.NotebookHistory(h).init();const rows=(await h.loadInitial()).patches;const byTime=new Set(rows.map(e=>e.time));
 const checkAt=hist=>good.every(([t,d])=>JSON.stringify(cells(hist.docAt(t)))===JSON.stringify(cells(d))&&hist.docAt(t).mode===d.mode);
 out.push([checkAt(n)&&checkAt(r)&&bad.every(([t])=>!n.versions().some(v=>v.time===t)&&!r.versions().some(v=>v.time===t)),'deleted cells and mode changes survive resume live and reloaded: '+JSON.stringify({live:n.versions().length,reload:r.versions().length,rows:rows.map(e=>({parents:e.parents,time:e.time})),latest:cells(r.docAt(good.at(-1)[0]))})]);
 out.push([rows.every(e=>(e.parents??[]).every(t=>byTime.has(t)))&&rows.every(e=>!(e.parents??[]).some(t=>bad.some(([b])=>b===t))),'all stored parent references resolve without refused ids']);
 // A subsequent commit made from a reloaded multi-root history must also rebuild correctly.
 const next={mode:'python',cells:[{id:'fresh',code:'after reload'}]},env=r.record(next);await h.appending;const rr=await new H.NotebookHistory(h).init();
 out.push([JSON.stringify(cells(r.docAt(env.time)))===JSON.stringify(cells(next))&&JSON.stringify(cells(rr.docAt(env.time)))===JSON.stringify(cells(next))&&good.every(([t,d])=>JSON.stringify(cells(rr.docAt(t)))===JSON.stringify(cells(d))),'a commit after reloading resumed roots preserves new and earlier versions: '+JSON.stringify({now:cells(rr.docAt(env.time)),count:rr.versions().length})]);n.close();r.close();rr.close();
 // Board roots must preserve hierarchy, removed edges and omitted fields, not just text changes.
 const bdb=await S.openBoardHistoryDb(),bs=new S.IdbPatchStore(bdb,'board:local:abcdef123456'),b=await new BoardHistory(H,bs).init();
 const d0={title:'before',nodes:[{id:'old',text:'old'}],edges:[]},v0=b.record(d0);await bs.appending;
 b.record({title:'huge',nodes:[{id:'huge',text:'x'.repeat(8000)}]});await bs.appending;
 const d1={title:'after',nodes:[{kind:'group',id:'g',text:'group',children:[{id:'child',text:'child'}]}]},v1=b.record(d1);await bs.appending;
 const d2={title:'last',nodes:[{id:'child',text:'moved'}]},v2=b.record(d2);await bs.appending;
 const br=await new BoardHistory(H,bs).init();const slim=x=>({title:x.title,nodes:x.nodes.map(n=>[n.id,n.text,n.kind??null,(n.children??[]).map(c=>c.id)])});
 const eq=(h,t,d)=>JSON.stringify(slim(h.docAt(t)))===JSON.stringify(slim(d));
 out.push([eq(b,v0.time,d0)&&eq(br,v0.time,d0)&&eq(b,v1.time,d1)&&eq(br,v1.time,d1)&&eq(b,v2.time,d2)&&eq(br,v2.time,d2),'board resume preserves earlier hierarchy and later removals live/reloaded: '+JSON.stringify({live:b.versions().length,reload:br.versions().length,latest:slim(br.docAt(v2.time))})]);b.close();br.close();
 S.HISTORY_BACKLOG.bytes=cap;w.close();db.close();bdb.close();return out;}
