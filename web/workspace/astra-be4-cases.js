// astra's controlled-store cases on be486fe2 (CORR-BE4-1/2), from
// /scratch/sagebrush-reviews/evidence/durability-detect-be4-astra/astra-be4-cases.js, hers but for two changes, marked:
// (A) the first check, live before the rebuild: the journal's version withheld or NEW (never old), and what's
//     committed NEW (@sagebrush's decision: listed once the rebuild holds it, never wrong before);
// (B) a wait after close() and clear(): they start the session's next generation, so `rebuilding` is no longer the
//     earlier one's, and `await h.rebuilding` alone wouldn't wait for it to finish
import {H} from './hist.js'; const {NotebookHistory}=H;
export async function run(){const out=[];
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
class Store{rows=[];refuse=false;gate=null;listeners=new Set();async loadInitial(){const patches=this.rows.slice();if(this.gate)await this.gate.promise;return{patches}}append(e){if(this.refuse)return false;this.rows.push(e);return true}subscribe(f){this.listeners.add(f);return()=>this.listeners.delete(f)}async clear(){this.rows=[]}}
const doc=code=>({mode:'python',cells:[{id:'c',code}]});
const s=new Store(),h=await new NotebookHistory(s).init();h.record(doc('old'));s.refuse=true;h.record(doc('refused'));await h.rebuilding;s.refuse=false;s.gate=defer();const root=h.record(doc('NEW'));const journal=h.journal([{type:'session',id:'run',t:1}]);
const at=t=>{try{return h.docAt(t).cells}catch{return 'withheld'}};/*(A)*/out.push([['withheld','NEW'].includes(at(journal.time)==='withheld'?'withheld':at(journal.time)[0]?.code)&&h.committed().getOne({type:'cell',id:'c'})?.input==='NEW','journal must preserve newest accepted cells: '+JSON.stringify({root:at(root.time),journal:at(journal.time),tail:at(h.tail.time),committed:h.committed().getOne({type:'cell',id:'c'})?.input,rootListed:h.versions().some(v=>v.time===root.time)})]);
s.gate.resolve();s.gate=null;await h.rebuilding;const reload=await new NotebookHistory(s).init();out.push([reload.docAt(journal.time).cells[0]?.code==='NEW','journal must preserve newest cells after reload: '+JSON.stringify(reload.docAt(journal.time))]);
h.close();reload.close();
// A pending rebuild must not resurrect a closed history or leave a subscription.
const s2=new Store(),h2=await new NotebookHistory(s2).init();h2.record(doc('old'));s2.gate=defer();s2.refuse=true;h2.record(doc('refused'));await Promise.resolve();h2.close();s2.gate.resolve();s2.gate=null;await h2.rebuilding;await new Promise(r=>setTimeout(r,50));/*(B)*/out.push([!h2.session&&s2.listeners.size===0,'closed history must stay closed: '+JSON.stringify({sessionAlive:!!h2.session,listeners:s2.listeners.size})]);h2.close();
// Capture the rebuild's initial rows, clear/reinitialize, then finish that old rebuild.
const s3=new Store(),h3=await new NotebookHistory(s3).init();h3.record(doc('before clear'));const gate=defer();const load=s3.loadInitial.bind(s3);let first=true;s3.loadInitial=async()=>{const r=await load();if(first){first=false;await gate.promise}return r};s3.refuse=true;h3.record(doc('refused'));await new Promise(r=>setTimeout(r,0));await h3.clear();const before=h3.versions().length;gate.resolve();await h3.rebuilding;await new Promise(r=>setTimeout(r,50));/*(B)*/out.push([h3.versions().length===0,'cleared history must stay clear: '+JSON.stringify({versionsImmediatelyAfterClear:before,versionsAfterOldRebuild:h3.versions().length,storeRows:s3.rows.length,shown:h3.head()?h3.docAt(h3.head()):null})]);h3.close();return out;}
