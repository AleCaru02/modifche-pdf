import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

// Precision editor for PDFs with a real text layer.
// It does NOT redraw native text with Arial/Helvetica from the browser.
// Instead it appends text operators to the PDF using the same embedded font
// resource already present on the page, at the original baseline and size.

(function initPrecisionNative(){
  if (window.__precisionNativeInstalled) return;
  window.__precisionNativeInstalled = true;

  let sourceBytes = null;
  let nativePdf = null;
  let baseName = 'documento';
  let edits = [];
  let renderToken = 0;

  const canvas = document.querySelector('#canvas');
  const sheet = document.querySelector('#sheet');
  const input = document.querySelector('#pdfinput');
  const download = document.querySelector('#download');
  const tip = document.querySelector('#tip');
  if (!canvas || !sheet || !input || !download) return;

  const style = document.createElement('style');
  style.textContent = `
    #textLayer{pointer-events:none!important}
    .precision-native-layer{position:absolute;inset:0;z-index:66;pointer-events:none}
    .precision-native-hit{position:absolute;border:1px solid transparent;background:transparent;padding:0;margin:0;pointer-events:auto;cursor:text;border-radius:2px}
    .precision-native-hit:hover,.precision-native-hit:focus{border-color:#1667d9;background:#1667d912;outline:none}
    .precision-native-hit.edited{border-color:#14833b88;background:#14833b0c}
    .precision-native-modal{position:fixed;inset:0;z-index:10050;background:#0b122055;display:grid;place-items:center;padding:18px}
    .precision-native-card{width:min(440px,calc(100vw - 28px));background:#fff;border-radius:14px;box-shadow:0 18px 60px #0005;padding:18px;font:14px system-ui,sans-serif}
    .precision-native-card h3{margin:0 0 8px;font-size:17px}.precision-native-card p{margin:0 0 12px;color:#536175;font-size:12px;line-height:1.4}
    .precision-native-card textarea{width:100%;box-sizing:border-box;border:1px solid #aebdd1;border-radius:9px;padding:11px;font:17px system-ui,sans-serif;resize:vertical}
    .precision-native-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.precision-native-actions button{padding:9px 13px;border-radius:8px;border:1px solid #cad4e1;background:#fff}.precision-native-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0;font-weight:700}
  `;
  document.head.appendChild(style);

  const precisionLayer = document.createElement('div');
  precisionLayer.className = 'precision-native-layer';
  sheet.appendChild(precisionLayer);

  function pageIndex(){
    const text = document.querySelector('#pageinfo')?.textContent || '1 / 1';
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
  }

  function normalizeNativeText(value){
    let s = String(value ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\u00A0/g, ' ').trim();
    if (/^[\d\s.,+\-]+$/.test(s)) s = s.replace(/\s+/g, '');
    return s.replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g, ',');
  }

  function isNumericText(value){
    return /^[+\-]?[\d.]+(?:,[\d]+)?$/.test(normalizeNativeText(value));
  }

  function resourceFromPdfJsFont(fontName){
    const m = String(fontName || '').match(/_f(\d+)$/i);
    return m ? `Ty${m[1]}` : null;
  }

  function splitSegments(str){
    const text = String(str || '');
    const gaps = [...text.matchAll(/\s{2,}/g)];
    if (!gaps.length) return [{ text, start:0, end:text.length }];
    const result = [];
    let at = 0;
    for (const gap of gaps){
      const end = gap.index;
      const raw = text.slice(at, end);
      if (raw.trim()) result.push({ text: raw.trim(), start: at + raw.indexOf(raw.trim()), end: end - (raw.length - raw.trimEnd().length) });
      at = end + gap[0].length;
    }
    const raw = text.slice(at);
    if (raw.trim()) result.push({ text: raw.trim(), start: at + raw.indexOf(raw.trim()), end: text.length - (raw.length - raw.trimEnd().length) });
    return result.length ? result : [{ text, start:0, end:text.length }];
  }

  function charUnits(ch){
    if (ch === ' ') return 0.42;
    if (/[.,:;!|]/.test(ch)) return 0.48;
    if (/[ilI1]/.test(ch)) return 0.62;
    if (/[MWmw]/.test(ch)) return 1.45;
    return 1;
  }
  function units(text){ return [...String(text)].reduce((s,ch)=>s+charUnits(ch),0) || 1; }

  function segmentGeometry(item, seg, styleInfo){
    const full = String(item.str || '');
    const total = units(full);
    const before = units(full.slice(0, seg.start));
    const segment = units(full.slice(seg.start, seg.end));
    const itemWidth = Math.max(0.01, Number(item.width || 0));
    const x = Number(item.transform?.[4] || 0) + itemWidth * (before / total);
    const w = Math.max(1, itemWidth * (segment / total));
    const fontSize = Math.max(1, Math.hypot(Number(item.transform?.[0] || 0), Number(item.transform?.[1] || 0)) || Number(item.height || 8));
    const baseline = Number(item.transform?.[5] || 0);
    const ascent = Number.isFinite(styleInfo?.ascent) ? styleInfo.ascent : 0.82;
    const descent = Number.isFinite(styleInfo?.descent) ? styleInfo.descent : -0.18;
    return { x, width:w, baseline, fontSize, ascent, descent, y: baseline + descent * fontSize, height:(ascent-descent)*fontSize };
  }

  function cleanedOriginalForMeasure(text){ return normalizeNativeText(text); }

  function heuristicGlyphWidth(ch, fontSize){
    if (/\d/.test(ch)) return fontSize * 0.556;
    if (ch === ',' || ch === '.') return fontSize * 0.278;
    if (ch === '-') return fontSize * 0.333;
    if (ch === '+') return fontSize * 0.584;
    if (ch === ' ') return fontSize * 0.278;
    if (/[ilI]/.test(ch)) return fontSize * 0.278;
    if (/[MW]/.test(ch)) return fontSize * 0.833;
    return fontSize * 0.556;
  }
  function heuristicWidth(text, fontSize){ return [...String(text)].reduce((sum,ch)=>sum+heuristicGlyphWidth(ch,fontSize),0); }

  function asciiHex(text){
    const bytes = [];
    for (const ch of String(text)){
      const code = ch.charCodeAt(0);
      if (code > 255) throw new Error('Carattere non supportato dal font originale');
      bytes.push(code.toString(16).padStart(2,'0'));
    }
    return bytes.join('').toUpperCase();
  }

  async function appendExactEdits(bytes){
    const doc = await PDFLIB.PDFDocument.load(bytes.slice(0), { ignoreEncryption:true });
    for (const edit of edits){
      const page = doc.getPage(edit.page);
      const oldText = cleanedOriginalForMeasure(edit.originalText);
      const newText = normalizeNativeText(edit.text);
      if (!newText) continue;

      const oldHeuristic = Math.max(0.01, heuristicWidth(oldText, edit.fontSize));
      const horizontalScale = Math.max(0.45, Math.min(2.2, edit.width / oldHeuristic));
      const newNatural = heuristicWidth(newText, edit.fontSize) * horizontalScale;
      const right = edit.x + edit.width;
      const drawX = edit.alignRight ? right - newNatural : edit.x;

      const padX = Math.min(0.7, edit.fontSize * 0.08);
      const padY = Math.min(0.5, edit.fontSize * 0.06);
      page.drawRectangle({
        x: Math.max(0, edit.x - padX),
        y: Math.max(0, edit.y - padY),
        width: edit.width + padX * 2,
        height: edit.height + padY * 2,
        color: PDFLIB.rgb(1,1,1)
      });

      const resource = PDFLIB.PDFName.of(edit.resource);
      page.pushOperators(
        PDFLIB.pushGraphicsState(),
        PDFLIB.beginText(),
        PDFLIB.setFillingColor(PDFLIB.rgb(0,0,0)),
        PDFLIB.setFontAndSize(resource, edit.fontSize),
        PDFLIB.setTextMatrix(horizontalScale, 0, 0, 1, drawX, edit.baseline),
        PDFLIB.showText(PDFLIB.PDFHexString.of(asciiHex(newText))),
        PDFLIB.endText(),
        PDFLIB.popGraphicsState()
      );
    }
    return await doc.save({ useObjectStreams:false });
  }

  async function renderExactPreview(){
    if (!sourceBytes || !nativePdf || !canvas.width) return;
    const token = ++renderToken;
    const idx = pageIndex();
    const relevant = edits.some(e=>e.page===idx);
    if (!relevant) return;
    try{
      const modified = await appendExactEdits(sourceBytes);
      if (token !== renderToken) return;
      const doc = await PDFJS.getDocument({ data: modified.slice(0) }).promise;
      const page = await doc.getPage(idx + 1);
      const unit = page.getViewport({ scale:1, rotation:page.rotate });
      const scale = canvas.width / Math.max(1, unit.width);
      const viewport = page.getViewport({ scale, rotation:page.rotate });
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      await page.render({ canvasContext:ctx, viewport }).promise;
      await doc.destroy();
    }catch(err){ console.error('Precision preview failed', err); }
  }

  function openEditor(meta){
    document.querySelector('.precision-native-modal')?.remove();
    const existing = edits.find(e=>e.key===meta.key);
    const modal = document.createElement('div');
    modal.className = 'precision-native-modal';
    modal.innerHTML = `<div class="precision-native-card"><h3>Modifica testo originale</h3><p>Questa modalità mantiene font incorporato, dimensione e baseline del PDF. Per i numeri mantiene anche l'allineamento originale.</p><textarea rows="2"></textarea><div class="precision-native-actions"><button class="cancel">Annulla</button><button class="apply">Applica</button></div></div>`;
    document.body.appendChild(modal);
    const field = modal.querySelector('textarea');
    field.value = existing?.text ?? normalizeNativeText(meta.originalText);
    modal.querySelector('.cancel').onclick = ()=>modal.remove();
    modal.onclick = e=>{ if(e.target===modal) modal.remove(); };
    modal.querySelector('.apply').onclick = async ()=>{
      const value = normalizeNativeText(field.value);
      if (existing) existing.text = value;
      else edits.push({ ...meta, text:value });
      modal.remove();
      await rebuildHits();
      await renderExactPreview();
    };
    requestAnimationFrame(()=>{ field.focus(); field.select(); });
  }

  async function rebuildHits(){
    precisionLayer.innerHTML='';
    if (!nativePdf || !canvas.width) return;
    const idx = pageIndex();
    const page = await nativePdf.getPage(idx + 1);
    const text = await page.getTextContent();
    const unit = page.getViewport({ scale:1, rotation:page.rotate });
    const scale = canvas.width / Math.max(1, unit.width);
    const viewport = page.getViewport({ scale, rotation:page.rotate });
    precisionLayer.style.width = `${viewport.width}px`;
    precisionLayer.style.height = `${viewport.height}px`;

    text.items.forEach((item,itemIndex)=>{
      if (!item?.str?.trim() || !item.transform) return;
      const styleInfo = text.styles?.[item.fontName] || {};
      const segments = splitSegments(item.str);
      segments.forEach((seg,segIndex)=>{
        const g = segmentGeometry(item,seg,styleInfo);
        const topLeft = viewport.convertToViewportPoint(g.x, g.baseline + g.ascent * g.fontSize);
        const bottomRight = viewport.convertToViewportPoint(g.x + g.width, g.baseline + g.descent * g.fontSize);
        const left = Math.min(topLeft[0], bottomRight[0]);
        const top = Math.min(topLeft[1], bottomRight[1]);
        const width = Math.max(5, Math.abs(bottomRight[0]-topLeft[0]));
        const height = Math.max(7, Math.abs(bottomRight[1]-topLeft[1]));
        if (left > viewport.width || top > viewport.height || left + width < 0 || top + height < 0) return;
        const resource = resourceFromPdfJsFont(item.fontName);
        if (!resource) return;
        const key = `${idx}:${itemIndex}:${segIndex}`;
        const hit = document.createElement('button');
        hit.type='button'; hit.className='precision-native-hit'; hit.dataset.key=key;
        hit.title=`Modifica: ${normalizeNativeText(seg.text)}`;
        hit.setAttribute('aria-label', hit.title);
        Object.assign(hit.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`});
        if (edits.some(e=>e.key===key)) hit.classList.add('edited');
        hit.onclick=(event)=>{
          event.preventDefault(); event.stopPropagation();
          openEditor({
            key, page:idx, resource,
            originalText:seg.text,
            x:g.x, y:g.y, width:g.width, height:g.height,
            baseline:g.baseline, fontSize:g.fontSize,
            alignRight:isNumericText(seg.text)
          });
        };
        precisionLayer.appendChild(hit);
      });
    });

    if (tip && text.items.some(i=>i?.str?.trim())) tip.innerHTML='<b>Modalità precisa:</b> questo PDF contiene testo vero. Clicca direttamente sul testo/numero: il salvataggio usa il font incorporato e la posizione originale. “Modifica area” resta per le scansioni.';
  }

  input.addEventListener('change', async (event)=>{
    const file = event.target.files?.[0];
    if (!file) return;
    try{
      sourceBytes = await file.arrayBuffer();
      baseName = file.name.replace(/\.pdf$/i,'') || 'documento';
      edits = [];
      if (nativePdf) try{ await nativePdf.destroy(); }catch{}
      nativePdf = await PDFJS.getDocument({ data: sourceBytes.slice(0) }).promise;
      setTimeout(rebuildHits, 250);
    }catch(err){ console.error('Precision init failed',err); }
  }, true);

  window.addEventListener('pdf-editor-rendered', ()=>{
    setTimeout(async ()=>{
      await rebuildHits();
      await renderExactPreview();
    }, 40);
  });

  download.addEventListener('click', async (event)=>{
    if (!edits.length || !sourceBytes) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try{
      const bytes = await appendExactEdits(sourceBytes);
      const blob = new Blob([bytes], {type:'application/pdf'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href=url; a.download=`${baseName}-modificato.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    }catch(err){
      console.error('Precision export failed',err);
      alert('Errore nella modalità precisa. Il PDF originale non è stato modificato.');
    }
  }, true);
})();