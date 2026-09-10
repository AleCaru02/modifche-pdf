import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
PDFJS.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

(function(){
  if(window.__directUniversalInstalled) return;
  window.__directUniversalInstalled=true;

  const canvas=document.querySelector('#canvas');
  const sheet=document.querySelector('#sheet');
  const input=document.querySelector('#pdfinput');
  const download=document.querySelector('#download');
  const tip=document.querySelector('#tip');
  if(!canvas||!sheet||!input||!download) return;

  let sourceBytes=null, sourcePdf=null, baseName='documento', edits=[], models=new Map(), renderToken=0;

  const style=document.createElement('style');
  style.textContent=`
    #textLayer{pointer-events:none!important}
    .du-layer{position:absolute;inset:0;z-index:120;pointer-events:none}
    .du-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .du-hit:hover,.du-hit:focus{border-color:#1769e0;background:#1769e00a;outline:none}
    .du-hit.edited{border-color:#16834899;background:#1683480a}
    .du-modal{position:fixed;inset:0;z-index:16000;background:#0b122055;display:grid;place-items:center;padding:16px}
    .du-card{width:min(440px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .du-card h3{margin:0 0 8px;font-size:17px}.du-card p{margin:0 0 12px;color:#546276;font-size:12px;line-height:1.45}
    .du-card textarea{width:100%;box-sizing:border-box;border:1px solid #b4c0d0;border-radius:9px;padding:11px;font:17px system-ui,sans-serif;resize:vertical}
    .du-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.du-actions button{padding:9px 13px;border-radius:8px;border:1px solid #cad4e1;background:#fff}.du-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0;font-weight:700}
  `;
  document.head.appendChild(style);
  const hitLayer=document.createElement('div'); hitLayer.className='du-layer'; sheet.appendChild(hitLayer);

  const clean=v=>String(v??'').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\u00A0/g,' ');
  const norm=v=>clean(v).replace(/\s+/g,' ').trim();
  const pageIndex=()=>Math.max(0,(parseInt(document.querySelector('#pageinfo')?.textContent||'1',10)||1)-1);
  const bytesToString=bytes=>{let out='';for(let i=0;i<bytes.length;i+=0x8000)out+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return out;};
  const stringToBytes=s=>Uint8Array.from(s,c=>c.charCodeAt(0)&255);
  const toHex=bytes=>[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();

  function decodeLiteral(raw){
    const out=[];
    for(let i=1;i<raw.length-1;i++){
      const ch=raw[i];
      if(ch!=='\\'){out.push(ch.charCodeAt(0)&255);continue;}
      const n=raw[++i]; if(n==null) break;
      if(/[0-7]/.test(n)){
        let oct=n; for(let k=0;k<2&&/[0-7]/.test(raw[i+1]||'');k++)oct+=raw[++i];
        out.push(parseInt(oct,8)&255);
      }else if(n==='n')out.push(10);else if(n==='r')out.push(13);else if(n==='t')out.push(9);else if(n==='b')out.push(8);else if(n==='f')out.push(12);
      else if(n==='\n'){} else if(n==='\r'){if(raw[i+1]==='\n')i++;}
      else out.push(n.charCodeAt(0)&255);
    }
    return new Uint8Array(out);
  }
  function decodeHex(raw){
    let h=raw.slice(1,-1).replace(/\s+/g,''); if(h.length%2)h+='0';
    const out=new Uint8Array(h.length/2); for(let i=0;i<out.length;i++)out[i]=parseInt(h.slice(i*2,i*2+2),16);
    return out;
  }
  function findStringTokens(src,start=0,end=src.length){
    const out=[]; let i=start;
    while(i<end){
      if(src[i]==='('){
        const s=i; let depth=1; i++;
        while(i<end&&depth){if(src[i]==='\\'){i+=2;continue;}if(src[i]==='(')depth++;else if(src[i]===')')depth--;i++;}
        if(!depth){const raw=src.slice(s,i);out.push({start:s,end:i,type:'literal',bytes:decodeLiteral(raw)});}continue;
      }
      if(src[i]==='<'&&src[i+1]!=='<'){
        const s=i,close=src.indexOf('>',i+1); if(close!==-1&&close<end){const raw=src.slice(s,close+1);if(/^<[0-9A-Fa-f\s]*>$/.test(raw))out.push({start:s,end:close+1,type:'hex',bytes:decodeHex(raw)});i=close+1;continue;}
      }
      i++;
    }
    return out;
  }
  function fontBefore(src,pos){
    const re=/\/([^\s\/]+)\s+[-+]?\d*\.?\d+\s+Tf\b/g; const before=src.slice(0,pos); let m,last='';
    while((m=re.exec(before))) last=m[1]; return last;
  }
  function collectRawCandidates(src){
    const out=[];
    for(const t of findStringTokens(src)){
      const tail=src.slice(t.end,Math.min(src.length,t.end+40));
      if(/^\s*(?:Tj|'|")/.test(tail)) out.push({...t,font:fontBefore(src,t.start)});
    }
    const re=/\[(.*?)\]\s*TJ\b/gs; let m;
    while((m=re.exec(src))){
      const innerStart=m.index+1,innerEnd=m.index+m[0].lastIndexOf(']'); const parts=findStringTokens(src,innerStart,innerEnd); if(!parts.length)continue;
      const all=[]; for(const p of parts)all.push(...p.bytes);
      out.push({start:m.index,end:m.index+m[0].length,type:'array',bytes:new Uint8Array(all),font:fontBefore(src,m.index),parts});
    }
    return out.sort((a,b)=>a.start-b.start);
  }
  function getContentTargets(doc,page){
    const name=PDFLIB.PDFName.of('Contents'),entry=page.node.get(name),out=[]; if(!entry)return out;
    if(entry instanceof PDFLIB.PDFRef){const stream=doc.context.lookup(entry);if(stream instanceof PDFLIB.PDFRawStream)out.push({ref:entry,stream});}
    else if(entry instanceof PDFLIB.PDFArray){for(let i=0;i<entry.size();i++){const child=entry.get(i),stream=child instanceof PDFLIB.PDFRef?doc.context.lookup(child):child;if(stream instanceof PDFLIB.PDFRawStream)out.push(child instanceof PDFLIB.PDFRef?{ref:child,stream}:{array:entry,index:i,stream});}}
    else if(entry instanceof PDFLIB.PDFRawStream)out.push({direct:true,stream:entry});
    return out;
  }
  function glyphTextFromOperator(fn,args){
    const glyphs=args?.[0];
    if(fn===PDFJS.OPS.showText&&Array.isArray(glyphs)) return clean(glyphs.map(g=>g?.unicode??g?.fontChar??'').join(''));
    if(fn===PDFJS.OPS.showSpacedText&&Array.isArray(glyphs)){
      let out=''; for(const part of glyphs){if(Array.isArray(part))out+=part.map(g=>g?.unicode??g?.fontChar??'').join('');}
      return clean(out);
    }
    return null;
  }
  function inferCodeWidth(rawBytes,text){
    const chars=[...text]; if(!chars.length||!rawBytes.length||rawBytes.length%chars.length)return 0;
    const w=rawBytes.length/chars.length; return [1,2,3,4].includes(w)?w:0;
  }

  async function buildModel(pi){
    if(models.has(pi))return models.get(pi);
    const page=await sourcePdf.getPage(pi+1);
    const [textContent,opList]=await Promise.all([page.getTextContent(),page.getOperatorList()]);
    const visible=textContent.items.filter(i=>i?.str?.trim()&&i.transform);

    const rawDoc=await PDFLIB.PDFDocument.load(sourceBytes.slice(0),{ignoreEncryption:true,updateMetadata:false});
    const rawPage=rawDoc.getPage(pi),targets=getContentTargets(rawDoc,rawPage),raw=[];
    targets.forEach((target,streamIndex)=>{
      const src=bytesToString(PDFLIB.decodePDFRawStream(target.stream).getBytes());
      collectRawCandidates(src).forEach((cand,localIndex)=>raw.push({...cand,streamIndex,localIndex,src}));
    });

    const opTexts=[];
    for(let i=0;i<opList.fnArray.length;i++){
      const text=glyphTextFromOperator(opList.fnArray[i],opList.argsArray[i]);
      if(text!=null)opTexts.push({operatorIndex:i,text});
    }

    // Page content streams and PDF.js show-text operators normally keep the same order.
    const pairCount=Math.min(raw.length,opTexts.length);
    const paired=[];
    const fontMaps=new Map();
    for(let i=0;i<pairCount;i++){
      const cand=raw[i],unicode=clean(opTexts[i].text),w=inferCodeWidth(cand.bytes,unicode);
      paired.push({rawIndex:i,unicode,w});
      if(!w)continue;
      const key=cand.font||'_'; if(!fontMaps.has(key))fontMaps.set(key,{width:w,encode:new Map(),decode:new Map()});
      const fm=fontMaps.get(key); if(fm.width!==w)continue;
      [...unicode].forEach((ch,j)=>{const chunk=cand.bytes.slice(j*w,(j+1)*w),h=toHex(chunk);if(!fm.encode.has(ch))fm.encode.set(ch,chunk);if(!fm.decode.has(h))fm.decode.set(h,ch);});
    }

    // Map each PDF.js text item to one or more consecutive show-text operators.
    const mapping=[]; let opCursor=0;
    for(let vi=0;vi<visible.length;vi++){
      const target=norm(visible[vi].str); let found=null;
      for(let start=opCursor;start<paired.length&&!found;start++){
        let acc='';
        for(let end=start;end<Math.min(paired.length,start+12);end++){
          acc+=paired[end].unicode;
          const n=norm(acc);
          if(n===target){found={start,end};break;}
          if(target&&n.length>target.length+8)break;
        }
      }
      if(found){mapping.push({visibleIndex:vi,item:visible[vi],originalText:clean(visible[vi].str),rawIndices:Array.from({length:found.end-found.start+1},(_,k)=>found.start+k)});opCursor=found.end+1;}
      else mapping.push({visibleIndex:vi,item:visible[vi],originalText:clean(visible[vi].str),rawIndices:[]});
    }

    const model={page,textContent,visible,raw,paired,fontMaps,mapping}; models.set(pi,model); return model;
  }

  function encodeText(text,cand,model){
    const fm=model.fontMaps.get(cand.font||'_'); if(!fm)throw new Error('Codifica del font originale non ricostruibile per questo testo.');
    const out=[]; for(const ch of [...clean(text)]){const code=fm.encode.get(ch);if(!code)throw new Error(`Il carattere “${ch}” non è disponibile nella codifica già presente nel font del PDF.`);out.push(...code);} return new Uint8Array(out);
  }
  const replacementFor=(cand,newBytes)=>cand.type==='array'?`[<${toHex(newBytes)}>] TJ`:`<${toHex(newBytes)}>`;

  async function buildEditedPdf(){
    const doc=await PDFLIB.PDFDocument.load(sourceBytes.slice(0),{ignoreEncryption:true,updateMetadata:false});
    const byPage=new Map(); for(const edit of edits){const arr=byPage.get(edit.page)||[];arr.push(edit);byPage.set(edit.page,arr);}
    for(const [pi,pageEdits] of byPage){
      const model=await buildModel(pi),page=doc.getPage(pi),targets=getContentTargets(doc,page);
      const decoded=targets.map((target,streamIndex)=>({target,streamIndex,src:bytesToString(PDFLIB.decodePDFRawStream(target.stream).getBytes())}));
      const replsByStream=new Map();
      for(const edit of pageEdits){
        const map=model.mapping.find(m=>m.visibleIndex===edit.visibleIndex);
        if(!map||!map.rawIndices.length)throw new Error(`Questo elemento testuale non è collegabile in modo sicuro al content stream del PDF.`);
        const first=model.raw[map.rawIndices[0]],newBytes=encodeText(edit.text,first,model);
        const all=[{cand:first,replacement:replacementFor(first,newBytes)}];
        for(const ri of map.rawIndices.slice(1)){const cand=model.raw[ri];all.push({cand,replacement:replacementFor(cand,new Uint8Array())});}
        for(const r of all){if(!replsByStream.has(r.cand.streamIndex))replsByStream.set(r.cand.streamIndex,[]);replsByStream.get(r.cand.streamIndex).push(r);}
      }
      for(const [streamIndex,repls] of replsByStream){
        const d=decoded.find(x=>x.streamIndex===streamIndex); if(!d)continue;
        repls.sort((a,b)=>b.cand.start-a.cand.start);
        for(const r of repls)d.src=d.src.slice(0,r.cand.start)+r.replacement+d.src.slice(r.cand.end);
      }
      for(const d of decoded){const stream=doc.context.flateStream(stringToBytes(d.src));if(d.target.ref)doc.context.assign(d.target.ref,stream);else if(d.target.array)d.target.array.set(d.target.index,stream);else page.node.set(PDFLIB.PDFName.of('Contents'),stream);}
    }
    return await doc.save({useObjectStreams:false,updateFieldAppearances:false});
  }

  async function preview(){
    if(!sourceBytes||!edits.length||!canvas.width)return; const pi=pageIndex(); if(!edits.some(e=>e.page===pi))return; const token=++renderToken;
    try{const out=await buildEditedPdf();if(token!==renderToken)return;const doc=await PDFJS.getDocument({data:out.slice(0)}).promise,page=await doc.getPage(pi+1),unit=page.getViewport({scale:1,rotation:page.rotate}),viewport=page.getViewport({scale:canvas.width/Math.max(1,unit.width),rotation:page.rotate}),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);await page.render({canvasContext:ctx,viewport}).promise;await doc.destroy();}
    catch(err){console.error(err);alert(err?.message||'Modifica non disponibile per questo elemento.');}
  }

  function openEditor(meta){
    document.querySelector('.du-modal')?.remove(); const existing=edits.find(e=>e.key===meta.key),modal=document.createElement('div');modal.className='du-modal';
    modal.innerHTML='<div class="du-card"><h3>Sostituisci testo</h3><p>Il motore modifica gli operatori testuali del PDF quando il testo è realmente presente nel documento.</p><textarea rows="2"></textarea><div class="du-actions"><button class="cancel">Annulla</button><button class="apply">Sostituisci</button></div></div>';
    document.body.appendChild(modal); const field=modal.querySelector('textarea');field.value=existing?.text??meta.originalText;
    modal.querySelector('.cancel').onclick=()=>modal.remove();modal.onclick=e=>{if(e.target===modal)modal.remove();};
    modal.querySelector('.apply').onclick=async()=>{const value=clean(field.value);if(existing)existing.text=value;else edits.push({...meta,text:value});modal.remove();await rebuild();await preview();};
    requestAnimationFrame(()=>{field.focus();field.select();});
  }

  async function rebuild(){
    hitLayer.innerHTML=''; if(!sourcePdf||!canvas.width)return; const pi=pageIndex(),model=await buildModel(pi),page=await sourcePdf.getPage(pi+1),unit=page.getViewport({scale:1,rotation:page.rotate}),viewport=page.getViewport({scale:canvas.width/Math.max(1,unit.width),rotation:page.rotate});
    hitLayer.style.width=`${viewport.width}px`;hitLayer.style.height=`${viewport.height}px`;
    model.mapping.forEach(({item,visibleIndex,originalText,rawIndices})=>{
      const t=PDFJS.Util.transform(viewport.transform,item.transform),fontHeight=Math.max(6,Math.hypot(t[2],t[3])),angle=Math.atan2(t[1],t[0]),left=t[4],top=t[5]-fontHeight,width=Math.max(5,(Number(item.width)||originalText.length*fontHeight*.5)*viewport.scale),height=Math.max(7,fontHeight),key=`${pi}:${visibleIndex}`;
      const hit=document.createElement('button');hit.type='button';hit.className='du-hit'+(edits.some(e=>e.key===key)?' edited':'');Object.assign(hit.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`,transformOrigin:'left top',transform:angle?`rotate(${angle}rad)`:''});hit.title=`Modifica: ${originalText}`;hit.setAttribute('aria-label',hit.title);
      hit.onclick=e=>{e.preventDefault();e.stopPropagation();if(!rawIndices.length){alert('Questo testo è visibile ma non è esposto come operatore testuale modificabile dal motore corrente.');return;}openEditor({key,page:pi,visibleIndex,originalText});};hitLayer.appendChild(hit);
    });
    if(tip)tip.innerHTML='<b>Modifica testo automatica:</b> clicca direttamente su una scritta. Il motore sceglie internamente il collegamento corretto al testo del PDF.';
  }

  input.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;sourceBytes=await file.arrayBuffer();baseName=file.name.replace(/\.pdf$/i,'')||'documento';edits=[];models=new Map();if(sourcePdf)try{await sourcePdf.destroy();}catch{}sourcePdf=await PDFJS.getDocument({data:sourceBytes.slice(0)}).promise;setTimeout(rebuild,120);},true);
  window.addEventListener('pdf-editor-rendered',()=>setTimeout(async()=>{await rebuild();await preview();},20));
  download.addEventListener('click',async e=>{if(!edits.length||!sourceBytes)return;e.preventDefault();e.stopImmediatePropagation();try{const out=await buildEditedPdf(),url=URL.createObjectURL(new Blob([out],{type:'application/pdf'})),a=document.createElement('a');a.href=url;a.download=`${baseName}-modificato.pdf`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}catch(err){console.error(err);alert(err?.message||'Modifica non disponibile.');}},true);
})();