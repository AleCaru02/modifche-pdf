import * as mupdf from 'mupdf';

(function initMuPDFEditorV2(){
  if (window.__muPdfEditorV2Installed) return;
  window.__muPdfEditorV2Installed = true;

  const $ = (s) => document.querySelector(s);
  const input = $('#pdfinput');
  const canvas = $('#canvas');
  const sheet = $('#sheet');
  const download = $('#download');
  const tip = $('#tip');
  if (!input || !canvas || !sheet || !download) return;

  let originalBytes = null;
  let fileName = 'documento';
  let sourceDoc = null;
  let edits = [];
  let spansByPage = new Map();
  let renderVersion = 0;

  const style = document.createElement('style');
  style.textContent = `
    .m2-hit-layer{position:absolute;inset:0;z-index:130;pointer-events:none}
    .m2-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .m2-hit:hover,.m2-hit:focus{border-color:#1769e0;background:#1769e008;outline:none}
    .m2-modal{position:fixed;inset:0;z-index:20000;background:#0b122066;display:grid;place-items:center;padding:16px}
    .m2-card{width:min(460px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .m2-card h3{margin:0 0 7px;font-size:18px}.m2-card p{margin:0 0 12px;color:#5d6879;font-size:12px;line-height:1.45}
    .m2-card textarea{width:100%;box-sizing:border-box;min-height:74px;border:1px solid #b7c3d3;border-radius:9px;padding:10px 11px;font:17px system-ui,sans-serif}
    .m2-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}.m2-actions button{padding:9px 13px}.m2-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0}
  `;
  document.head.appendChild(style);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'm2-hit-layer';
  sheet.appendChild(hitLayer);

  const currentPageIndex = () => {
    const n = parseInt($('#pageinfo')?.textContent || '1', 10);
    return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
  };

  function toast(message){
    const el = $('#toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.classList.remove('hide');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hide'), 4200);
  }

  function destroy(obj){ try { obj?.destroy?.(); } catch {} }

  function rectFromBox(box){
    if (!box) return null;
    if (Array.isArray(box) && box.length >= 4) return [Number(box[0]),Number(box[1]),Number(box[2]),Number(box[3])];
    const x = Number(box.x ?? box.x0 ?? 0);
    const y = Number(box.y ?? box.y0 ?? 0);
    const w = Number(box.w ?? ((box.x1 ?? x) - x));
    const h = Number(box.h ?? ((box.y1 ?? y) - y));
    return [x,y,x+w,y+h];
  }

  function parseSpans(pageIndex){
    if (spansByPage.has(pageIndex)) return spansByPage.get(pageIndex);
    if (!sourceDoc) return [];
    const page = sourceDoc.loadPage(pageIndex);
    let st = null;
    try {
      st = page.toStructuredText('preserve-spans,accurate-bboxes,accurate-ascenders,accurate-side-bearings,collect-styles');
      const json = JSON.parse(st.asJSON());
      const out = [];
      let id = 0;
      for (const block of json.blocks || []) {
        if (block.type !== 'text') continue;
        for (const line of block.lines || []) {
          const text = String(line.text ?? '').replace(/\u00a0/g,' ');
          if (!text.trim()) continue;
          const rect = rectFromBox(line.bbox);
          if (!rect) continue;
          const f = line.font || {};
          out.push({
            id:id++, page:pageIndex, text, rect,
            x:Number(line.x ?? rect[0]), y:Number(line.y ?? rect[3]), wmode:Number(line.wmode || 0),
            font:{
              name:String(f.name || ''), family:String(f.family || ''), weight:String(f.weight || 'normal'), style:String(f.style || 'normal'), size:Number(f.size || 0)
            }
          });
        }
      }
      spansByPage.set(pageIndex,out);
      return out;
    } finally {
      destroy(st); destroy(page);
    }
  }

  function stripSubset(name){ return String(name || '').replace(/^[A-Z]{6}\+/,''); }

  function fallbackBase14(font){
    const family = String(font?.family || '').toLowerCase();
    const name = String(font?.name || '').toLowerCase();
    const weight = String(font?.weight || '').toLowerCase();
    const style = String(font?.style || '').toLowerCase();
    const bold = weight.includes('bold') || weight.includes('700') || name.includes('bold');
    const italic = style.includes('italic') || style.includes('oblique') || name.includes('italic') || name.includes('oblique');
    const mono = family.includes('mono') || name.includes('courier');
    const serif = !mono && (family.includes('serif') || name.includes('times'));
    if (mono) return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : (italic ? 'Courier-Oblique' : 'Courier');
    if (serif) return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
    return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
  }

  function fontCandidates(font){
    const raw = stripSubset(font?.name).trim();
    const family = String(font?.family || '').trim();
    const list = [];
    const push = v => { if (v && !list.includes(v)) list.push(v); };
    push(raw);
    push(raw.replace(/MT$/i,''));
    if (/arial/i.test(raw) || /arial/i.test(family)) push('Arial');
    if (/helvetica/i.test(raw) || /helvetica/i.test(family)) push('Helvetica');
    if (/times/i.test(raw) || /times/i.test(family)) push('Times-Roman');
    if (/courier/i.test(raw) || /mono/i.test(family)) push('Courier');
    push(fallbackBase14(font));
    return list;
  }

  function resolveFont(fontInfo){
    for (const name of fontCandidates(fontInfo)) {
      try {
        const font = new mupdf.Font(name);
        return {font,name};
      } catch {}
    }
    const name = fallbackBase14(fontInfo);
    return {font:new mupdf.Font(name),name};
  }

  function glyphWidth(font, fontSize, text){
    let total = 0;
    for (const ch of String(text ?? '')) {
      const gid = font.encodeCharacter(ch.codePointAt(0));
      total += Number(font.advanceGlyph(gid,0) || 0) * fontSize;
    }
    return total;
  }

  function isMostlyNumber(text){ return /^[\s€$£¥+\-\d.,:%/]+$/.test(String(text || '')); }

  function addRedaction(page, rect){
    let a;
    try { a = page.createAnnotation('Redact'); }
    catch { a = page.createAnnotation('Redaction'); }
    a.setRect(rect); a.update?.(); return a;
  }

  function pdfEscape(value){
    return String(value ?? '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/\r/g,'').replace(/\n/g,' ');
  }

  function addReplacementText(doc,page,edit){
    const fontSize = Math.max(3, Number(edit.font?.size || (edit.rect[3]-edit.rect[1])*0.8 || 10));
    const resolved = resolveFont(edit.font);
    const font = resolved.font;
    const pageObj = page.getObject();
    let resources = pageObj.get('Resources');
    if (!resources.isDictionary()) pageObj.put('Resources', resources = doc.newDictionary());
    let fonts = resources.get('Font');
    if (!fonts.isDictionary()) resources.put('Font', fonts = doc.newDictionary());

    const resourceName = `ME${Math.abs((edit.key || '').split('').reduce((a,c)=>((a*31+c.charCodeAt(0))|0),7))}`;
    fonts.put(resourceName, doc.addSimpleFont(font));

    const originalNatural = Math.max(0.001, glyphWidth(font,fontSize,edit.originalText));
    const originalBoxWidth = Math.max(0.001, Number(edit.rect[2]-edit.rect[0]));
    let hScale = originalBoxWidth / originalNatural;
    if (!Number.isFinite(hScale) || hScale < 0.65 || hScale > 1.35) hScale = 1;

    const newNatural = glyphWidth(font,fontSize,edit.text);
    const newVisualWidth = newNatural * hScale;
    let x = Number(edit.x);
    if (isMostlyNumber(edit.originalText)) x = Number(edit.rect[2]) - newVisualWidth;

    const bounds = page.getBounds();
    const y = Number(bounds[3]) - Number(edit.y);
    const value = pdfEscape(edit.text);
    const tz = (hScale * 100).toFixed(3);
    const stream = `q BT 0 0 0 rg /${resourceName} ${fontSize.toFixed(4)} Tf ${tz} Tz 1 0 0 1 ${x.toFixed(4)} ${y.toFixed(4)} Tm (${value}) Tj ET Q`;
    const extra = doc.addStream(stream,null);
    const contents = pageObj.get('Contents');
    if (contents.isNull()) pageObj.put('Contents',extra);
    else if (contents.isArray()) contents.push(extra);
    else { const arr = doc.newArray(); arr.push(contents); arr.push(extra); pageObj.put('Contents',arr); }
    destroy(font);
  }

  function applyOneEdit(pdfDoc,edit){
    const page = pdfDoc.loadPage(edit.page);
    try {
      const [x0,y0,x1,y1] = edit.rect;
      addRedaction(page,[x0,y0,x1,y1]);
      page.applyRedactions(false,mupdf.PDFPage.REDACT_IMAGE_NONE,mupdf.PDFPage.REDACT_LINE_ART_NONE,mupdf.PDFPage.REDACT_TEXT_REMOVE);
      addReplacementText(pdfDoc,page,edit);
      page.update?.();
    } finally { destroy(page); }
  }

  function buildEditedBytes(){
    if (!originalBytes) throw new Error('Nessun PDF caricato.');
    const opened = mupdf.Document.openDocument(originalBytes.slice(0),'application/pdf');
    const pdfDoc = opened.asPDF ? opened.asPDF() : opened;
    try {
      for (const edit of edits) applyOneEdit(pdfDoc,edit);
      const buffer = pdfDoc.saveToBuffer('garbage,compress');
      const out = buffer.asUint8Array().slice();
      destroy(buffer); return out;
    } finally { destroy(opened); }
  }

  async function renderBytes(bytes,pageIndex){
    const version = ++renderVersion;
    const doc = mupdf.Document.openDocument(bytes.slice(0),'application/pdf');
    const page = doc.loadPage(pageIndex);
    let pix = null;
    try {
      const b = page.getBounds();
      const scale = canvas.width / Math.max(1,b[2]-b[0]);
      pix = page.toPixmap(mupdf.Matrix.scale(scale,scale),mupdf.ColorSpace.DeviceRGB,false,true);
      const blob = new Blob([pix.asPNG()],{type:'image/png'});
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
      if (version === renderVersion) {
        const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height);
      }
      URL.revokeObjectURL(url);
    } finally { destroy(pix); destroy(page); destroy(doc); }
  }

  async function renderPreview(){
    if (!edits.length) return;
    try { await renderBytes(buildEditedBytes(),currentPageIndex()); }
    catch (err) { console.error(err); toast(err?.message || 'Non riesco a generare l’anteprima.'); }
  }

  function openEditor(span){
    document.querySelector('.m2-modal')?.remove();
    const key = `${span.page}:${span.id}`;
    const existing = edits.find(e=>e.key===key);
    const modal = document.createElement('div');
    modal.className='m2-modal';
    modal.innerHTML='<div class="m2-card"><h3>Sostituisci testo</h3><p>Font, dimensione, baseline e proporzioni vengono mantenuti quando il font del PDF è disponibile. Un testo più lungo può crescere naturalmente.</p><textarea rows="2"></textarea><div class="m2-actions"><button class="cancel">Annulla</button><button class="apply">Sostituisci</button></div></div>';
    document.body.appendChild(modal);
    const field = modal.querySelector('textarea'); field.value = existing?.text ?? span.text;
    modal.querySelector('.cancel').onclick=()=>modal.remove();
    modal.onclick=e=>{if(e.target===modal)modal.remove();};
    modal.querySelector('.apply').onclick=async()=>{
      const payload={key,page:span.page,spanId:span.id,originalText:span.text,text:String(field.value??''),rect:span.rect,font:span.font,x:span.x,y:span.y,wmode:span.wmode};
      if(existing)Object.assign(existing,payload);else edits.push(payload);
      modal.remove(); rebuildHits(); await renderPreview();
    };
    requestAnimationFrame(()=>{field.focus();field.select();});
  }

  function rebuildHits(){
    hitLayer.innerHTML='';
    if(!sourceDoc||!canvas.width)return;
    const pageIndex=currentPageIndex();
    const spans=parseSpans(pageIndex);
    const page=sourceDoc.loadPage(pageIndex);
    try{
      const b=page.getBounds(); const sx=canvas.width/Math.max(1,b[2]-b[0]); const sy=canvas.height/Math.max(1,b[3]-b[1]);
      hitLayer.style.width=`${canvas.width}px`; hitLayer.style.height=`${canvas.height}px`;
      for(const span of spans){
        const [x0,y0,x1,y1]=span.rect; const btn=document.createElement('button'); btn.type='button'; btn.className='m2-hit';
        Object.assign(btn.style,{left:`${(x0-b[0])*sx}px`,top:`${(y0-b[1])*sy}px`,width:`${Math.max(5,(x1-x0)*sx)}px`,height:`${Math.max(7,(y1-y0)*sy)}px`});
        btn.title=`Modifica: ${span.text}`; btn.onclick=e=>{e.preventDefault();e.stopPropagation();openEditor(span);}; hitLayer.appendChild(btn);
      }
      if(tip)tip.innerHTML=`<b>Motore MuPDF v2:</b> ${spans.length} elementi rilevati. Il testo nuovo mantiene font, dimensione e baseline quando disponibili.`;
    } finally { destroy(page); }
  }

  input.addEventListener('change',async e=>{
    const file=e.target.files?.[0]; if(!file)return;
    try{
      originalBytes=new Uint8Array(await file.arrayBuffer()); fileName=file.name.replace(/\.pdf$/i,'')||'documento'; edits=[]; spansByPage=new Map();
      destroy(sourceDoc); sourceDoc=mupdf.Document.openDocument(originalBytes.slice(0),'application/pdf'); setTimeout(rebuildHits,220);
    }catch(err){console.error(err);toast('MuPDF non riesce ad aprire questo documento.');}
  },true);

  window.addEventListener('pdf-editor-rendered',()=>setTimeout(rebuildHits,30));
  download.addEventListener('click',e=>{
    if(!edits.length||!originalBytes)return;
    e.preventDefault();e.stopImmediatePropagation();
    try{
      const out=buildEditedBytes();const url=URL.createObjectURL(new Blob([out],{type:'application/pdf'}));const a=document.createElement('a');
      a.href=url;a.download=`${fileName}-modificato.pdf`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    }catch(err){console.error(err);toast(err?.message||'Impossibile esportare il PDF modificato.');}
  },true);
})();
