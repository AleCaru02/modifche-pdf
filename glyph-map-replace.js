import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

(function initGlyphAwareReplace(){
  if (window.__glyphAwareReplaceInstalled) return;
  window.__glyphAwareReplaceInstalled = true;

  const canvas = document.querySelector('#canvas');
  const sheet = document.querySelector('#sheet');
  const input = document.querySelector('#pdfinput');
  const download = document.querySelector('#download');
  const tip = document.querySelector('#tip');
  if (!canvas || !sheet || !input || !download) return;

  let sourceBytes = null;
  let sourcePdf = null;
  let baseName = 'documento';
  let edits = [];
  let pageModels = new Map();
  let renderToken = 0;

  const style = document.createElement('style');
  style.textContent = `
    #textLayer{pointer-events:none!important}
    .glyph-map-layer{position:absolute;inset:0;z-index:90;pointer-events:none}
    .glyph-map-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .glyph-map-hit:hover,.glyph-map-hit:focus{border-color:#1769e0;background:#1769e00a;outline:none}
    .glyph-map-hit.edited{border-color:#16834899;background:#1683480a}
    .glyph-map-modal{position:fixed;inset:0;z-index:14000;background:#0b122055;display:grid;place-items:center;padding:16px}
    .glyph-map-card{width:min(440px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .glyph-map-card h3{margin:0 0 8px;font-size:17px}.glyph-map-card p{margin:0 0 12px;color:#546276;font-size:12px;line-height:1.4}
    .glyph-map-card textarea{width:100%;box-sizing:border-box;border:1px solid #b4c0d0;border-radius:9px;padding:11px;font:17px system-ui,sans-serif;resize:vertical}
    .glyph-map-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.glyph-map-actions button{padding:9px 13px;border-radius:8px;border:1px solid #cad4e1;background:#fff}.glyph-map-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0;font-weight:700}
  `;
  document.head.appendChild(style);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'glyph-map-layer';
  sheet.appendChild(hitLayer);

  const clean = v => String(v ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\u00A0/g,' ');
  const currentPageIndex = () => {
    const n = parseInt(document.querySelector('#pageinfo')?.textContent || '1',10);
    return Number.isFinite(n) ? Math.max(0,n-1) : 0;
  };

  function bytesToBinary(bytes){
    let out='';
    const step=0x8000;
    for(let i=0;i<bytes.length;i+=step) out += String.fromCharCode(...bytes.subarray(i,i+step));
    return out;
  }
  function binaryToBytes(text){
    const out=new Uint8Array(text.length);
    for(let i=0;i<text.length;i++) out[i]=text.charCodeAt(i)&255;
    return out;
  }
  function decodeLiteralBytes(raw){
    const out=[];
    for(let i=1;i<raw.length-1;i++){
      const c=raw[i];
      if(c!=='\\'){out.push(c.charCodeAt(0)&255);continue;}
      const n=raw[++i];
      if(n===undefined) break;
      if(n==='n') out.push(10); else if(n==='r') out.push(13); else if(n==='t') out.push(9); else if(n==='b') out.push(8); else if(n==='f') out.push(12);
      else if(n==='\n'){} else if(n==='\r'){if(raw[i+1]==='\n') i++;}
      else if(/[0-7]/.test(n)){
        let oct=n;
        for(let k=0;k<2&&/[0-7]/.test(raw[i+1]||'');k++) oct+=raw[++i];
        out.push(parseInt(oct,8)&255);
      } else out.push(n.charCodeAt(0)&255);
    }
    return new Uint8Array(out);
  }
  function decodeHexBytes(raw){
    let hex=raw.slice(1,-1).replace(/\s+/g,'');
    if(hex.length%2) hex+='0';
    const out=new Uint8Array(hex.length/2);
    for(let i=0;i<out.length;i++) out[i]=parseInt(hex.slice(i*2,i*2+2),16);
    return out;
  }
  function bytesToHex(bytes){return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();}

  function findStringTokens(src,start=0,end=src.length){
    const tokens=[]; let i=start;
    while(i<end){
      if(src[i]==='('){
        const s=i; let depth=1; i++;
        while(i<end&&depth){ if(src[i]==='\\'){i+=2;continue;} if(src[i]==='(') depth++; else if(src[i]===')') depth--; i++; }
        if(!depth){const raw=src.slice(s,i);tokens.push({start:s,end:i,raw,type:'literal',bytes:decodeLiteralBytes(raw)});} continue;
      }
      if(src[i]==='<'&&src[i+1]!=='<'){
        const s=i, close=src.indexOf('>',i+1);
        if(close!==-1&&close<end){const raw=src.slice(s,close+1);if(/^<[0-9A-Fa-f\s]*>$/.test(raw))tokens.push({start:s,end:close+1,raw,type:'hex',bytes:decodeHexBytes(raw)});i=close+1;continue;}
      }
      i++;
    }
    return tokens;
  }

  function fontBefore(src,pos){
    const before=src.slice(0,pos);
    const re=/\/([^\s\/]+)\s+[-+]?\d*\.?\d+\s+Tf\b/g;
    let m,last=null; while((m=re.exec(before))) last=m[1];
    return last;
  }

  function collectCandidates(src){
    const out=[];
    const tokens=findStringTokens(src);
    for(const t of tokens){
      const tail=src.slice(t.end,Math.min(src.length,t.end+40));
      if(/^\s*(?:Tj|'|")\b/.test(tail)||/^\s*(?:Tj|'|")/.test(tail)) out.push({start:t.start,end:t.end,type:t.type,bytes:t.bytes,font:fontBefore(src,t.start)});
    }
    const re=/\[(.*?)\]\s*TJ\b/gs; let m;
    while((m=re.exec(src))){
      const innerStart=m.index+1, innerEnd=m.index+m[0].lastIndexOf(']');
      const parts=findStringTokens(src,innerStart,innerEnd); if(!parts.length) continue;
      const all=[]; for(const p of parts) all.push(...p.bytes);
      out.push({start:m.index,end:m.index+m[0].length,type:'tjarray',bytes:new Uint8Array(all),font:fontBefore(src,m.index)});
    }
    return out.sort((a,b)=>a.start-b.start);
  }

  function getContentTargets(doc,page){
    const entry=page.node.get(PDFLIB.PDFName.of('Contents'));
    const targets=[]; if(!entry) return targets;
    if(entry instanceof PDFLIB.PDFRef){const stream=doc.context.lookup(entry);if(stream instanceof PDFLIB.PDFRawStream)targets.push({ref:entry,stream});}
    else if(entry instanceof PDFLIB.PDFArray){
      for(let i=0;i<entry.size();i++){const child=entry.get(i);if(child instanceof PDFLIB.PDFRef){const stream=doc.context.lookup(child);if(stream instanceof PDFLIB.PDFRawStream)targets.push({ref:child,stream});}else if(child instanceof PDFLIB.PDFRawStream)targets.push({array:entry,index:i,stream:child});}
    } else if(entry instanceof PDFLIB.PDFRawStream) targets.push({direct:true,stream:entry});
    return targets;
  }

  async function rawPageModel(pageIndex){
    const doc=await PDFLIB.PDFDocument.load(sourceBytes.slice(0),{ignoreEncryption:true,updateMetadata:false});
    const page=doc.getPage(pageIndex);
    const targets=getContentTargets(doc,page);
    const streams=targets.map((target,streamIndex)=>{
      const text=bytesToBinary(PDFLIB.decodePDFRawStream(target.stream).getBytes());
      return {streamIndex,text,candidates:collectCandidates(text)};
    });
    const flat=[];
    for(const s of streams) s.candidates.forEach((c,localIndex)=>flat.push({...c,streamIndex:s.streamIndex,localIndex}));
    return {streams,flat};
  }

  function inferWidth(rawBytes, unicodeText){
    const chars=[...unicodeText];
    if(!chars.length||!rawBytes.length||rawBytes.length%chars.length) return 0;
    const w=rawBytes.length/chars.length;
    return [1,2,3,4].includes(w)?w:0;
  }

  async function buildPageModel(pageIndex){
    if(pageModels.has(pageIndex)) return pageModels.get(pageIndex);
    const page=await sourcePdf.getPage(pageIndex+1);
    const textContent=await page.getTextContent();
    const visible=textContent.items.filter(i=>i?.str?.trim()&&i.transform);
    const raw=await rawPageModel(pageIndex);
    const fontMaps=new Map();
    const pairs=[];
    const count=Math.min(visible.length,raw.flat.length);

    for(let i=0;i<count;i++){
      const item=visible[i], cand=raw.flat[i], txt=clean(item.str);
      const w=inferWidth(cand.bytes,txt);
      if(!w) continue;
      if(!fontMaps.has(cand.font)) fontMaps.set(cand.font,{encode:new Map(),decode:new Map(),width:w});
      const fm=fontMaps.get(cand.font); if(fm.width!==w) continue;
      const chars=[...txt];
      for(let j=0;j<chars.length;j++){
        const chunk=cand.bytes.slice(j*w,(j+1)*w); const hex=bytesToHex(chunk);
        if(!fm.encode.has(chars[j])) fm.encode.set(chars[j],chunk);
        if(!fm.decode.has(hex)) fm.decode.set(hex,chars[j]);
      }
      pairs.push({visibleIndex:i,candidateIndex:i});
    }

    function decodeCandidate(cand){
      const fm=fontMaps.get(cand.font); if(!fm||!fm.width) return null;
      let out='';
      for(let i=0;i<cand.bytes.length;i+=fm.width){const hex=bytesToHex(cand.bytes.slice(i,i+fm.width));const ch=fm.decode.get(hex);if(ch==null)return null;out+=ch;}
      return out;
    }

    const mapping=[];
    visible.forEach((item,visibleIndex)=>{
      const txt=clean(item.str);
      let candidateIndex=-1;
      const direct=raw.flat[visibleIndex];
      if(direct&&decodeCandidate(direct)===txt) candidateIndex=visibleIndex;
      if(candidateIndex<0){
        for(let i=0;i<raw.flat.length;i++) if(decodeCandidate(raw.flat[i])===txt){candidateIndex=i;break;}
      }
      mapping.push({item,visibleIndex,candidateIndex,originalText:txt});
    });

    const model={textContent,visible,raw,fontMaps,mapping};
    pageModels.set(pageIndex,model); return model;
  }

  function encodeWithFontMap(text,cand,model){
    const fm=model.fontMaps.get(cand.font);
    if(!fm) throw new Error('Non riesco a ricostruire la codifica del font usato da questo testo.');
    const bytes=[];
    for(const ch of [...clean(text)]){
      const code=fm.encode.get(ch);
      if(!code) throw new Error(`Il carattere “${ch}” non è disponibile nella codifica del font originale. Prova con caratteri già presenti nel PDF.`);
      bytes.push(...code);
    }
    return new Uint8Array(bytes);
  }

  function replacementForCandidate(cand,newBytes){
    const hex=`<${bytesToHex(newBytes)}>`;
    return cand.type==='tjarray' ? `[${hex}] TJ` : hex;
  }

  async function buildEditedPdf(){
    const doc=await PDFLIB.PDFDocument.load(sourceBytes.slice(0),{ignoreEncryption:true,updateMetadata:false});
    const byPage=new Map(); for(const e of edits){const arr=byPage.get(e.page)||[];arr.push(e);byPage.set(e.page,arr);}
    for(const [pageIndex,pageEdits] of byPage){
      const model=await buildPageModel(pageIndex);
      const page=doc.getPage(pageIndex);
      const targets=getContentTargets(doc,page);
      const decoded=targets.map((target,streamIndex)=>({target,streamIndex,text:bytesToBinary(PDFLIB.decodePDFRawStream(target.stream).getBytes())}));
      const editsByStream=new Map();
      for(const edit of pageEdits){
        const map=model.mapping.find(m=>m.visibleIndex===edit.visibleIndex);
        if(!map||map.candidateIndex<0) throw new Error(`Non riesco a collegare direttamente il testo “${edit.originalText}” al suo operatore PDF.`);
        const cand=model.raw.flat[map.candidateIndex];
        const newBytes=encodeWithFontMap(edit.text,cand,model);
        if(!editsByStream.has(cand.streamIndex)) editsByStream.set(cand.streamIndex,[]);
        editsByStream.get(cand.streamIndex).push({cand,replacement:replacementForCandidate(cand,newBytes)});
      }
      for(const [streamIndex,repls] of editsByStream){
        const d=decoded.find(x=>x.streamIndex===streamIndex); if(!d) continue;
        repls.sort((a,b)=>b.cand.start-a.cand.start);
        for(const r of repls) d.text=d.text.slice(0,r.cand.start)+r.replacement+d.text.slice(r.cand.end);
      }
      for(const d of decoded){
        const newStream=doc.context.flateStream(binaryToBytes(d.text));
        if(d.target.ref) doc.context.assign(d.target.ref,newStream);
        else if(d.target.array) d.target.array.set(d.target.index,newStream);
        else if(d.target.direct) page.node.set(PDFLIB.PDFName.of('Contents'),newStream);
      }
    }
    return await doc.save({useObjectStreams:false,updateFieldAppearances:false});
  }

  async function preview(){
    if(!sourceBytes||!edits.length||!canvas.width) return;
    const idx=currentPageIndex(); if(!edits.some(e=>e.page===idx)) return;
    const token=++renderToken;
    try{
      const bytes=await buildEditedPdf(); if(token!==renderToken) return;
      const pdoc=await PDFJS.getDocument({data:bytes.slice(0)}).promise;
      const page=await pdoc.getPage(idx+1);
      const unit=page.getViewport({scale:1,rotation:page.rotate});
      const viewport=page.getViewport({scale:canvas.width/Math.max(1,unit.width),rotation:page.rotate});
      const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise; await pdoc.destroy();
    }catch(err){console.error(err);alert(err?.message||'Sostituzione diretta non disponibile per questo testo.');}
  }

  function openEditor(meta){
    document.querySelector('.glyph-map-modal')?.remove();
    const existing=edits.find(e=>e.key===meta.key);
    const modal=document.createElement('div'); modal.className='glyph-map-modal';
    modal.innerHTML='<div class="glyph-map-card"><h3>Sostituisci testo</h3><p>Il testo viene sostituito nel content stream usando la codifica del font originale. Non viene disegnato alcun riquadro bianco.</p><textarea rows="2"></textarea><div class="glyph-map-actions"><button class="cancel">Annulla</button><button class="apply">Sostituisci</button></div></div>';
    document.body.appendChild(modal);
    const field=modal.querySelector('textarea'); field.value=existing?.text??meta.originalText;
    modal.querySelector('.cancel').onclick=()=>modal.remove(); modal.onclick=e=>{if(e.target===modal)modal.remove();};
    modal.querySelector('.apply').onclick=async()=>{
      const value=clean(field.value);
      if(existing) existing.text=value; else edits.push({...meta,text:value});
      modal.remove(); await rebuild(); await preview();
    };
    requestAnimationFrame(()=>{field.focus();field.select();});
  }

  async function rebuild(){
    hitLayer.innerHTML=''; if(!sourcePdf||!canvas.width) return;
    const idx=currentPageIndex(); const model=await buildPageModel(idx); const page=await sourcePdf.getPage(idx+1);
    const unit=page.getViewport({scale:1,rotation:page.rotate}); const viewport=page.getViewport({scale:canvas.width/Math.max(1,unit.width),rotation:page.rotate});
    hitLayer.style.width=`${viewport.width}px`; hitLayer.style.height=`${viewport.height}px`;
    model.mapping.forEach(({item,visibleIndex,candidateIndex,originalText})=>{
      if(candidateIndex<0) return;
      const transformed=PDFJS.Util.transform(viewport.transform,item.transform);
      const fontHeight=Math.max(6,Math.hypot(transformed[2],transformed[3])); const angle=Math.atan2(transformed[1],transformed[0]);
      const left=transformed[4], top=transformed[5]-fontHeight; const width=Math.max(5,Number(item.width||0)*viewport.scale||originalText.length*fontHeight*.5), height=Math.max(7,fontHeight);
      const key=`${idx}:${visibleIndex}`; const hit=document.createElement('button'); hit.type='button'; hit.className='glyph-map-hit';
      Object.assign(hit.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`,transformOrigin:'left top',transform:angle?`rotate(${angle}rad)`:''});
      hit.title=`Modifica: ${originalText}`; hit.setAttribute('aria-label',hit.title); if(edits.some(e=>e.key===key))hit.classList.add('edited');
      hit.onclick=e=>{e.preventDefault();e.stopPropagation();openEditor({key,page:idx,visibleIndex,originalText});}; hitLayer.appendChild(hit);
    });
    if(tip) tip.innerHTML='<b>Sostituzione glyph-level:</b> clicca su una scritta. Il testo viene sostituito nella codifica del font originale, senza riquadri bianchi.';
  }

  input.addEventListener('change',async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    try{
      sourceBytes=await file.arrayBuffer(); baseName=file.name.replace(/\.pdf$/i,'')||'documento'; edits=[]; pageModels=new Map();
      if(sourcePdf) try{await sourcePdf.destroy();}catch{}
      sourcePdf=await PDFJS.getDocument({data:sourceBytes.slice(0)}).promise;
      setTimeout(rebuild,220);
    }catch(err){console.error(err);}
  },true);

  window.addEventListener('pdf-editor-rendered',()=>setTimeout(async()=>{await rebuild();await preview();},35));

  download.addEventListener('click',async e=>{
    if(!edits.length||!sourceBytes) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try{
      const bytes=await buildEditedPdf(); const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const a=document.createElement('a'); a.href=url; a.download=`${baseName}-modificato.pdf`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),5000);
    }catch(err){console.error(err);alert(err?.message||'Questo testo non può essere sostituito direttamente.');}
  },true);
})();