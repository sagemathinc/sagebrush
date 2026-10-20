// astra's budget probes on 7222199c (/scratch/sagebrush-reviews/evidence/board-host-gate-722-astra/budget-probes.mjs),
// verbatim but for the two imports: the source and the built /submission, from this checkout.  Run with Bun
// (test.mjs runs it after the build).
const source=await import('../../web/board/edit-state.ts');const built=await import('./dist/submission.js');let checks=0,failed=0;
for(const [where,{editState}] of [['source',source],['built',built]]){
 const init=(text='A')=>editState(JSON.stringify({format:'sagebrush-board',version:1,nodes:[{id:'a',text}]}));const m=changes=>({sagebrush:'edit',version:1,id:crypto.randomUUID(),base:'r',changes:changes??[]});
 for(const mode of ['apply-rate','preview-rate','apply-work']){
  const s=init(mode==='apply-work'?'x'.repeat(3*2**20):'A');let accepted=0;
  if(mode==='apply-rate')for(let i=0;i<20;i++)accepted+=s.apply(m(),0).ok?1:0;
  if(mode==='preview-rate')for(let i=0;i<20;i++)accepted+=s.preview(m(),0).ok?1:0;
  if(mode==='apply-work')for(let i=0;i<10;i++)accepted+=s.apply(m([{op:'set',key:{type:'item',page:'',id:'a'},fields:{x:i},was:{x:i?i-1:null}}]),0).ok?1:0;
  const msg=mode==='apply-work'?m([{op:'set',key:{type:'item',page:'',id:'a'},fields:{x:10},was:{x:9}}]):m();const pv=s.preview(msg,0),ap=s.apply(msg,0),ok=pv.ok===ap.ok&&pv.reason===ap.reason&&pv.retryAfter===ap.retryAfter;checks++;failed+=!ok?1:0;
  console.log(JSON.stringify({where,mode,accepted,ok,preview:pv,apply:ap}));
 }
}
console.log(JSON.stringify({checks,failed}));
