// astra's real-IdbPatchStore cases on be486fe2 (CORR-BE4-1/2), from
// /scratch/sagebrush-reviews/evidence/durability-detect-be4-astra/astra-be4-idb-cases.js, hers but for one change,
// marked (B): a wait after close() and clear(), which start the session's next generation, so `rebuilding` is no
// longer the earlier one's, and `await h.rebuilding` alone wouldn't wait for it to finish
import * as W from './ws.js';import * as S from './stores.js';import {H} from './hist.js';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const doc=code=>({mode:'python',cells:[{id:'c',code}]});
export async function run(){const out=[],w=await W.Workspace.open({name:'astra-be4',mainName:'astra-be4-main'}),e=await w.create('/n.ipynb'),db=await S.openHistoryDb(),oldcap=S.HISTORY_BACKLOG.bytes;S.HISTORY_BACKLOG.bytes=4096;
const store=()=>new S.IdbPatchStore(db,e.ref+Math.random());
const s=store(),h=await new H.NotebookHistory(s).init();h.record(doc('old'));await s.appending;h.record(doc('x'.repeat(8000)));await h.rebuilding;
let gate=defer(),orig=s.loadInitial.bind(s);s.loadInitial=async()=>{const rows=await orig();await gate.promise;return rows};
const root=h.record(doc('NEW')),journal=h.journal([{type:'session',id:'run',t:1}]);await s.appending;gate.resolve();s.loadInitial=orig;await h.rebuilding;
const r=await new H.NotebookHistory(s).init();out.push([r.docAt(journal.time).cells[0]?.code==='NEW','real IDB journal after accepted root: '+JSON.stringify({root:r.docAt(root.time),journal:r.docAt(journal.time)})]);h.close();r.close();
const s2=store(),h2=await new H.NotebookHistory(s2).init();h2.record(doc('old'));await s2.appending;gate=defer();const entered=defer(),orig2=s2.loadInitial.bind(s2);let first=true;s2.loadInitial=async()=>{const rows=await orig2();if(first){first=false;entered.resolve();await gate.promise}return rows};h2.record(doc('x'.repeat(8000)));await entered.promise;h2.close();gate.resolve();await h2.rebuilding;await new Promise(r=>setTimeout(r,50));/*(B)*/out.push([h2.session===null,'real IDB closed history remains closed: '+JSON.stringify({sessionAlive:!!h2.session})]);h2.close();
const s3=store(),h3=await new H.NotebookHistory(s3).init();h3.record(doc('before clear'));await s3.appending;gate=defer();const entered3=defer(),orig3=s3.loadInitial.bind(s3);first=true;s3.loadInitial=async()=>{const rows=await orig3();if(first){first=false;entered3.resolve();await gate.promise}return rows};h3.record(doc('x'.repeat(8000)));await entered3.promise;await h3.clear();const before=h3.versions().length;gate.resolve();await h3.rebuilding;await new Promise(r=>setTimeout(r,50));/*(B)*/out.push([h3.versions().length===0,'real IDB clear is not undone: '+JSON.stringify({before,after:h3.versions().length,rows:(await orig3()).patches.length,shown:h3.head()?h3.docAt(h3.head()):null})]);h3.close();S.HISTORY_BACKLOG.bytes=oldcap;db.close();w.close();return out;}
