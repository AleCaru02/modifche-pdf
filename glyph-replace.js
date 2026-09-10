import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

// Native-looking text replacement for ordinary/non-official PDFs.
// Important: no white rectangle is drawn. The old glyphs are painted over
// using the SAME page font resource and text matrix, but in white; then the
// new glyphs are drawn in black using the same font resource/matrix.
// This preserves surrounding lines/background much better than rectangle masks.

(function initGlyphReplace(){
  if (window.__glyphReplaceInstalled) return;
  window.__glyphReplaceInstalled = true;

  let sourceBytes = null;
  let sourcePdf = null;
  let baseName = 'documento';
  let edits = [];
  let renderToken = 0;

  const canvas = document.querySelector('#canvas');
  const sheet = document.querySelector('#sheet');
  const input = document.querySelector('#pdfinput');
  const download = document.querySelector('#download');
  const tip = document.querySelector('#tip');
  if (!canvas || !sheet || !input || !download) return;

  const css = document.createElement('style');
  css.textContent = `
    #textLayer{pointer-events:none!important}
    .glyph-edit-layer{position:absolute;inset:0;z-index:70;pointer-events:none}
    .glyph-edit-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .glyph-edit-hit:hover,.glyph-edit-hit:focus{border-color:#1769e0;background:#1769e00d;outline:none}
    .glyph-edit-hit.edited{border-color:#1d8a4a99;background:#1d8a4a0b}
    .glyph-edit-modal{position:fixed;inset:0;z-index:12000;background:#0b122055;display:grid;place-items:center;padding:16px}
    .glyph-edit-card{width:min(440px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .glyph-edit-card h3{margin:0 0 8px;font-size:17px}.glyph-edit-card p{margin:0 0 12px;color:#546276;font-size:12px;line-height:1.4}
    .glyph-edit-card textarea{width:100%;box-sizing:border-box;border:1px solid #b4c0d0;border-radius:9px;padding:11px;font:17px system-ui,sans-serif;resize:vertical}
    .glyph-edit-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.glyph-edit-actions button{padding:9px 13px;border-radius:8px;border:1px solid #cad4e1;background:#fff}.glyph-edit-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0;font-weight:700}
  `;
  document.head.appendChild(css);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'glyph-edit-layer';
  sheet.appendChild(hitLayer);

  function currentPageIndex(){
    const t = document.querySelector('#pageinfo')?.textContent || '1 / 1';
    const n = parseInt(t,10);
    return Number.isFinite(n) ? Math.max(0,n-1) : 0;
  }

  function clean(v){
    let s = String(v ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\u00A0/g,' ');
    return s;
  }

  function resourceFromFontName(name){
    const m = String(name || '').match(/_f(\d+)$/i);
    return m ? `Ty${m[1]}` : null;
  }

  function latin1Hex(text){
    const out=[];
    for (const ch of String(text)){
      const code = ch.charCodeAt(0);
      if (code > 255) throw new Error('Il font originale non supporta questo carattere.');
      out.push(code.toString(16).padStart(2,'0'));
    }
    return out.join('').toUpperCase();
  }

  function splitSegments(str){
    const s=String(str||'');
    const matches=[...s.matchAll(/\s{2,}/g)];
    if(!matches.length) return [{text:s,start:0,end:s.length}];
    const parts=[]; let at=0;
    for(const m of matches){
      const raw=s.slice(at,m.index); const trimmed=raw.trim();
      if(trimmed){ const offset=raw.indexOf(trimmed); parts.push({text:trimmed,start:at+offset,end:at+offset+trimmed.length}); }
      at=m.index+m[0].length;
    }
    const raw=s.slice(at); const trimmed=raw.trim();
    if(trimmed){ const offset=raw.indexOf(trimmed); parts.push({text:trimmed,start:at+offset,end:at+offset+trimmed.length}); }
    return parts.length?parts:[{text:s,start:0,end:s.length}];
  }

  function estimateUnits(ch){
    if(ch===' ') return .5;
    if(/[.,:;!|]/.test(ch)) return .5;
    if(/[ilI1]/.test(ch)) return .62;
    if(/[MWmw]/.test(ch)) return 1.4;
    return 1;
  }
  function unitSum(s){return [...String(s)].reduce((a,c)=>a+estimateUnits(c),0)||1;}

  function segmentMeta(item,seg,styleInfo){
    const full=String(item.str||'');
    const total=unitSum(full), before=unitSum(full.slice(0,seg.start)), part=unitSum(full.slice(seg.start,seg.end));
    const fullWidth=Math.max(.01,Number(item.width||0));
    const x=Number(item.transform?.[4]||0)+fullWidth*(before/total);
    const width=Math.max(.1,fullWidth*(part/total));
    const a=Number(item.transform?.[0]||1), b=Number(item.transform?.[1]||0), c=Number(item.transform?.[2]||0), d=Number(item.transform?.[3]||1);
    const e=Number(item.transform?.[4]||0)+(x-Number(item.transform?.[4]||0));
    const f=Number(item.transform?.[5]||0);
    const fontSize=Math.max(1,Math.hypot(a,b)||Number(item.height||8));
    const ascent=Number.isFinite(styleInfo?.ascent)?styleInfo.ascent:.82;
    const descent=Number.isFinite(styleInfo?.descent)?styleInfo.descent:-.18;
    return {x,width,a,b,c,d,e,f,fontSize,ascent,descent};
  }

  function widthHeuristic(text){
    return [...String(text)].reduce((n,ch)=>n+estimateUnits(ch),0)||1;
  }

  async function buildEditedPdf(bytes){
    const doc=await PDFLIB.PDFDocument.load(bytes.slice(0),{ignoreEncryption:true});
    for(const edit of edits){
      const page=doc.getPage(edit.page);
      const resource=PDFLIB.PDFName.of(edit.resource);
      const oldText=clean(edit.originalText);
      const newText=clean(edit.text);
      if(!newText) continue;

      const oldHex=PDFLIB.PDFHexString.of(latin1Hex(oldText));
      const newHex=PDFLIB.PDFHexString.of(latin1Hex(newText));

      // Same font resource and same original text matrix.
      // First erase only the old glyph shapes (no rectangle), then draw the new text.
      page.pushOperators(
        PDFLIB.pushGraphicsState(),
        PDFLIB.beginText(),
        PDFLIB.setFontAndSize(resource,1),
        PDFLIB.setTextMatrix(edit.a,edit.b,edit.c,edit.d,edit.e,edit.f),
        PDFLIB.setFillingColor(PDFLIB.rgb(1,1,1)),
        PDFLIB.showText(oldHex),
        PDFLIB.endText(),
        PDFLIB.popGraphicsState()
      );

      let e=edit.e;
      if(edit.alignRight && oldText!==newText){
        const ratio=widthHeuristic(newText)/widthHeuristic(oldText);
        e = edit.e + edit.width * (1-ratio);
      }

      page.pushOperators(
        PDFLIB.pushGraphicsState(),
        PDFLIB.beginText(),
        PDFLIB.setFontAndSize(resource,1),
        PDFLIB.setTextMatrix(edit.a,edit.b,edit.c,edit.d,e,edit.f),
        PDFLIB.setFillingColor(PDFLIB.rgb(0,0,0)),
        PDFLIB.showText(newHex),
        PDFLIB.endText(),
        PDFLIB.popGraphicsState()
      );
    }
    return await doc.save({useObjectStreams:false});
  }

  async function preview(){
    if(!sourceBytes||!edits.length||!canvas.width) return;
    const token=++renderToken;
    const idx=currentPageIndex();
    if(!edits.some(e=>e.page===idx)) return;
    try{
      const bytes=await buildEditedPdf(sourceBytes);
      if(token!==renderToken) return;
      const pdoc=await PDFJS.getDocument({data:bytes.slice(0)}).promise;
      const page=await pdoc.getPage(idx+1);
      const unit=page.getViewport({scale:1,rotation:page.rotate});
      const scale=canvas.width/Math.max(1,unit.width);
      const viewport=page.getViewport({scale,rotation:page.rotate});
      const ctx=canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      await pdoc.destroy();
    }catch(err){console.error('Glyph preview failed',err);}
  }

  function isNumeric(text){return /^[+\-]?[\d\s.,]+$/.test(String(text||'').trim());}

  function editor(meta){
    document.querySelector('.glyph-edit-modal')?.remove();
    const existing=edits.find(e=>e.key===meta.key);
    const modal=document.createElement('div');
    modal.className='glyph-edit-modal';
    modal.innerHTML='<div class="glyph-edit-card"><h3>Modifica testo</h3><p>Il testo viene sostituito senza riquadro: il sito riutilizza il font e la matrice del testo originale.</p><textarea rows="2"></textarea><div class="glyph-edit-actions"><button class="cancel">Annulla</button><button class="apply">Applica</button></div></div>';
    document.body.appendChild(modal);
    const field=modal.querySelector('textarea'); field.value=existing?.text??meta.originalText;
    modal.querySelector('.cancel').onclick=()=>modal.remove();
    modal.onclick=e=>{if(e.target===modal) modal.remove();};
    modal.querySelector('.apply').onclick=async()=>{
      const value=clean(field.value);
      if(existing) existing.text=value; else edits.push({...meta,text:value});
      modal.remove(); await rebuild(); await preview();
    };
    requestAnimationFrame(()=>{field.focus();field.select();});
  }

  async function rebuild(){
    hitLayer.innerHTML='';
    if(!sourcePdf||!canvas.width) return;
    const idx=currentPageIndex();
    const page=await sourcePdf.getPage(idx+1);
    const content=await page.getTextContent();
    const unit=page.getViewport({scale:1,rotation:page.rotate});
    const scale=canvas.width/Math.max(1,unit.width);
    const viewport=page.getViewport({scale,rotation:page.rotate});
    hitLayer.style.width=`${viewport.width}px`; hitLayer.style.height=`${viewport.height}px`;

    content.items.forEach((item,itemIndex)=>{
      if(!item?.str?.trim()||!item.transform) return;
      const resource=resourceFromFontName(item.fontName); if(!resource) return;
      const styleInfo=content.styles?.[item.fontName]||{};
      splitSegments(item.str).forEach((seg,segIndex)=>{
        const g=segmentMeta(item,seg,styleInfo);
        const p1=viewport.convertToViewportPoint(g.x,g.f+g.ascent*g.fontSize);
        const p2=viewport.convertToViewportPoint(g.x+g.width,g.f+g.descent*g.fontSize);
        const left=Math.min(p1[0],p2[0]), top=Math.min(p1[1],p2[1]);
        const width=Math.max(5,Math.abs(p2[0]-p1[0])), height=Math.max(7,Math.abs(p2[1]-p1[1]));
        const key=`${idx}:${itemIndex}:${segIndex}`;
        const hit=document.createElement('button');
        hit.type='button';hit.className='glyph-edit-hit';hit.dataset.key=key;
        Object.assign(hit.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});
        hit.title=`Modifica: ${seg.text}`; hit.setAttribute('aria-label',hit.title);
        if(edits.some(e=>e.key===key)) hit.classList.add('edited');
        hit.onclick=e=>{e.preventDefault();e.stopPropagation();editor({key,page:idx,resource,originalText:seg.text,width:g.width,a:g.a,b:g.b,c:g.c,d:g.d,e:g.e,f:g.f,alignRight:isNumeric(seg.text)});};
        hitLayer.appendChild(hit);
      });
    });
    if(tip&&content.items.some(i=>i?.str?.trim())) tip.innerHTML='<b>Sostituzione diretta:</b> questo PDF contiene testo vero. Clicca sul testo da modificare. Il metodo non usa riquadri bianchi; “Modifica area” resta solo per scansioni.';
  }

  input.addEventListener('change',async event=>{
    const file=event.target.files?.[0]; if(!file) return;
    try{
      sourceBytes=await file.arrayBuffer(); baseName=file.name.replace(/\.pdf$/i,'')||'documento'; edits=[];
      if(sourcePdf) try{await sourcePdf.destroy();}catch{}
      sourcePdf=await PDFJS.getDocument({data:sourceBytes.slice(0)}).promise;
      setTimeout(rebuild,220);
    }catch(err){console.error('Glyph editor init failed',err);}
  },true);

  window.addEventListener('pdf-editor-rendered',()=>setTimeout(async()=>{await rebuild();await preview();},35));

  download.addEventListener('click',async event=>{
    if(!edits.length||!sourceBytes) return;
    event.preventDefault();event.stopImmediatePropagation();
    try{
      const bytes=await buildEditedPdf(sourceBytes);
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const a=document.createElement('a');a.href=url;a.download=`${baseName}-modificato.pdf`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    }catch(err){console.error('Glyph export failed',err);alert('Questa codifica/font PDF non è compatibile con la sostituzione diretta. Usa un PDF ordinario con testo standard oppure “Modifica area”.');}
  },true);
})();