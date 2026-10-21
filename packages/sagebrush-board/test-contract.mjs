// astra's contract probes on 74b4e93f (/scratch/sagebrush-reviews/evidence/board-host-gate-74b-astra/probes.mjs),
// verbatim but for the two imports: the source and the built /submission, from this checkout.  Run with Bun
// (test.mjs runs it after the build).
const source=await import('../../web/board/edit-state.ts');
const built=await import('./dist/submission.js');
const results=[];
for(const [where,{editState,EDIT_LIMITS}] of [['source',source],['built',built]]){
 const init=()=>editState(JSON.stringify({format:'sagebrush-board',version:1,title:'T',nodes:[{id:'a',text:''}]}),{pictures:'by-reference'});
 const edit=changes=>({sagebrush:'edit',version:1,id:crypto.randomUUID(),base:'r',changes});
 const pic=images=>edit([{op:'set',key:{type:'doc',page:'',id:''},fields:{images},was:{images:null}}]);
 const name='i'+'a'.repeat(32),png='data:image/png;base64,iVBORw0KGgo=';
 for(const [label,images] of [['short-name',{['i'+'a'.repeat(16)]:{w:1,h:1}}],['array-value',{[name]:[{w:1,h:1,src:png}]}],['array-images',[{[name]:{w:1,h:1,src:png}}]],['invalid-https',{[name]:{w:1,h:1,src:'https://'}}]]){
  const s=init(),m=pic(images),p=s.preview(m,1),a=s.apply(m,1);results.push({where,label,ok:!p.ok&&!a.ok,preview:p,applied:a,images:s.board().images});
 }
 for(const [label,m,what] of [['byte-refusal',edit([{op:'set',key:{type:'item',page:'',id:'a'},fields:{text:'x'.repeat(2**20)},was:{text:''}}]),'edit'],['count-refusal',edit(Array.from({length:1001},()=>({op:'set',key:{type:'item',page:'',id:'a'},fields:{x:1},was:{x:null}}))),'changes']]){
  const s=init(),p=s.preview(m,1),a=s.apply(m,1);results.push({where,label,ok:!p.ok&&p.reason==='too-large'&&p.what===what&&typeof p.limit==='number'&&typeof p.size==='number',preview:p,applied:a});
 }
}
for(const r of results)console.log(JSON.stringify(r));
console.log(JSON.stringify({passed:results.filter(r=>r.ok).length,checks:results.length}));
