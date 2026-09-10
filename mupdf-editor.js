import * as mupdf from 'mupdf';

(function initMuPDFEditor(){
  if (window.__muPdfEditorInstalled) return;
  window.__muPdfEditorInstalled = true;

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

  const css = document.createElement('style');
  css.textContent = `
    .mupdf-hit-layer{position:absolute;inset:0;z-index:130;pointer-events:none}
    .mupdf-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .mupdf-hit:hover,.mupdf-hit:focus{border-color:#1769e0;background:#1769e008;outline:none}
    .mupdf-hit.edited{border-color:transparent!important;background:transparent!important}
    .mupdf-hit.edited:hover,.mupdf-hit.edited:focus{border-color:#1769e0!important;background:#1769e008!important}
    .mupdf-modal{position:fixed;inset:0;z-index:20000;background:#0b122066;display:grid;place-items:center;padding:16px}
    .mupdf-card{width:min(460px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .mupdf-card h3{margin:0 0 7px;font-size:18px}.mupdf-card p{margin:0 0 12px;color:#5d6879;font-size:12px;line-height:1.45}
    .mupdf-card textarea{width:100%;box-sizing:border-box;min-height:74px;border:1px solid #b7c3d3;border-radius:9px;padding:10px 11px;font:17px system-ui,sans-serif}
    .mupdf-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:13px}.mupdf-actions button{padding:9px 13px}.mupdf-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0}
  `;
  document.head.appendChild(css);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'mupdf-hit-layer';
  sheet.appendChild(hitLayer);

  const currentPageIndex = () => {
    const value = parseInt($('#pageinfo')?.textContent || '1', 10);
    return Number.isFinite(value) ? Math.max(0, value - 1) : 0;
  };

  function toast(message){
    const el = $('#toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.classList.remove('hide');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hide'), 4200);
  }

  function destroyDoc(doc){ try { doc?.destroy?.(); } catch {} }

  function rectFromBox(box){
    if (!box) return null;
    if (Array.isArray(box)) {
      if (box.length >= 4) return [Number(box[0]), Number(box[1]), Number(box[2]), Number(box[3])];
      return null;
    }
    const x = Number(box.x ?? box.x0 ?? 0);
    const y = Number(box.y ?? box.y0 ?? 0);
    const w = Number(box.w ?? ((box.x1 ?? x) - x));
    const h = Number(box.h ?? ((box.y1 ?? y) - y));
    return [x, y, x + w, y + h];
  }

  function parseSpans(pageIndex){
    if (spansByPage.has(pageIndex)) return spansByPage.get(pageIndex);
    if (!sourceDoc) return [];
    const page = sourceDoc.loadPage(pageIndex);
    let st = null;
    try {
      st = page.toStructuredText('preserve-spans,accurate-bboxes,accurate-ascenders,accurate-side-bearings,collect-styles');
      const json = JSON.parse(st.asJSON());
      const spans = [];
      let id = 0;
      for (const block of json.blocks || []) {
        if (block.type !== 'text') continue;
        for (const line of block.lines || []) {
          const text = String(line.text ?? '').replace(/\u00a0/g, ' ');
          if (!text.trim()) continue;
          const rect = rectFromBox(line.bbox);
          if (!rect) continue;
          const font = line.font || {};
          spans.push({
            id: id++, page: pageIndex, text, rect,
            font: {
              name: String(font.name || ''),
              family: String(font.family || ''),
              weight: String(font.weight || 'normal'),
              style: String(font.style || 'normal'),
              size: Number(font.size || 0)
            },
            x: Number(line.x ?? rect[0]),
            y: Number(line.y ?? rect[3]),
            wmode: Number(line.wmode || 0)
          });
        }
      }
      spansByPage.set(pageIndex, spans);
      return spans;
    } finally {
      try { st?.destroy?.(); } catch {}
      try { page.destroy?.(); } catch {}
    }
  }

  function base14Font(font){
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

  function isMostlyNumber(text){
    return /^[\s€$£¥+\-\d.,:%/]+$/.test(String(text || ''));
  }

  function addRedaction(page, rect){
    let annot = null;
    try { annot = page.createAnnotation('Redact'); }
    catch { annot = page.createAnnotation('Redaction'); }
    annot.setRect(rect);
    annot.update?.();
    return annot;
  }

  function pdfEscapeText(value){
    return String(value ?? '')
      .replace(/\\/g,'\\\\')
      .replace(/\(/g,'\\(')
      .replace(/\)/g,'\\)')
      .replace(/\r/g,'')
      .replace(/\n/g,' ');
  }

  function textWidth(fontName, fontSize, value){
    let font = null;
    try {
      font = new mupdf.Font(fontName);
      let total = 0;
      for (const ch of String(value ?? '')) {
        const gid = font.encodeCharacter(ch.codePointAt(0));
        total += Number(font.advanceGlyph(gid, 0) || 0) * fontSize;
      }
      return total;
    } catch {
      return String(value ?? '').length * fontSize * 0.52;
    } finally {
      try { font?.destroy?.(); } catch {}
    }
  }

  function appendDirectText(doc, page, edit){
    const fontName = base14Font(edit.font);
    const fontSize = Math.max(3, Number(edit.font?.size || (edit.rect[3]-edit.rect[1]) * 0.8 || 10));
    const pageObj = page.getObject();
    let resources = pageObj.get('Resources');
    if (!resources.isDictionary()) pageObj.put('Resources', resources = doc.newDictionary());
    let fonts = resources.get('Font');
    if (!fonts.isDictionary()) resources.put('Font', fonts = doc.newDictionary());

    const resourceName = `ME${Math.abs((edit.key || '').split('').reduce((a,c)=>((a*31+c.charCodeAt(0))|0),7))}`;
    const font = new mupdf.Font(fontName);
    const fontResource = doc.addSimpleFont(font);
    fonts.put(resourceName, fontResource);

    const bounds = page.getBounds();
    let x = Number(edit.x);
    const baselineTop = Number(edit.y);
    const y = Number(bounds[3]) - baselineTop;

    if (isMostlyNumber(edit.originalText)) {
      const originalRight = Number(edit.rect[2]);
      const w = textWidth(fontName, fontSize, edit.text);
      x = originalRight - w;
    }

    const value = pdfEscapeText(edit.text);
    const streamText = `q BT 0 0 0 rg /${resourceName} ${fontSize.toFixed(4)} Tf 1 0 0 1 ${x.toFixed(4)} ${y.toFixed(4)} Tm (${value}) Tj ET Q`;
    const extra = doc.addStream(streamText, null);
    const contents = pageObj.get('Contents');
    if (contents.isNull()) pageObj.put('Contents', extra);
    else if (contents.isArray()) contents.push(extra);
    else {
      const arr = doc.newArray();
      arr.push(contents); arr.push(extra);
      pageObj.put('Contents', arr);
    }
    try { font.destroy?.(); } catch {}
  }

  function applyOneEdit(pdfDoc, edit){
    const page = pdfDoc.loadPage(edit.page);
    try {
      const [x0,y0,x1,y1] = edit.rect;
      addRedaction(page, [x0, y0, x1, y1]);
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE
      );
      appendDirectText(pdfDoc, page, edit);
      page.update?.();
    } finally {
      try { page.destroy?.(); } catch {}
    }
  }

  function buildEditedBytes(){
    if (!originalBytes) throw new Error('Nessun PDF caricato.');
    const opened = mupdf.Document.openDocument(originalBytes.slice(0), 'application/pdf');
    const pdfDoc = opened.asPDF ? opened.asPDF() : opened;
    try {
      for (const edit of edits) applyOneEdit(pdfDoc, edit);
      const buffer = pdfDoc.saveToBuffer('garbage,compress');
      const out = buffer.asUint8Array().slice();
      try { buffer.destroy?.(); } catch {}
      return out;
    } finally {
      destroyDoc(opened);
    }
  }

  async function renderBytes(bytes, pageIndex){
    const version = ++renderVersion;
    const doc = mupdf.Document.openDocument(bytes.slice(0), 'application/pdf');
    const page = doc.loadPage(pageIndex);
    let pix = null;
    try {
      const bounds = page.getBounds();
      const pageWidth = Math.max(1, Number(bounds[2] - bounds[0]));
      const scale = canvas.width / pageWidth;
      pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pix.asPNG();
      const blob = new Blob([png], {type:'image/png'});
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});
      if (version === renderVersion) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
      }
      URL.revokeObjectURL(url);
    } finally {
      try { pix?.destroy?.(); } catch {}
      try { page.destroy?.(); } catch {}
      destroyDoc(doc);
    }
  }

  async function renderPreview(){
    if (!edits.length) return;
    try {
      const bytes = buildEditedBytes();
      await renderBytes(bytes, currentPageIndex());
    } catch (err) {
      console.error(err);
      toast(err?.message || 'Non riesco a generare l’anteprima della modifica.');
    }
  }

  function openEditor(span){
    document.querySelector('.mupdf-modal')?.remove();
    const key = `${span.page}:${span.id}`;
    const existing = edits.find(e => e.key === key);
    const modal = document.createElement('div');
    modal.className = 'mupdf-modal';
    modal.innerHTML = `<div class="mupdf-card"><h3>Sostituisci testo</h3><p>Il testo viene rimosso e riscritto direttamente sulla baseline originale, senza riquadro di testo.</p><textarea rows="2"></textarea><div class="mupdf-actions"><button class="cancel">Annulla</button><button class="apply">Sostituisci</button></div></div>`;
    document.body.appendChild(modal);
    const field = modal.querySelector('textarea');
    field.value = existing?.text ?? span.text;
    modal.querySelector('.cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.querySelector('.apply').onclick = async () => {
      const text = String(field.value ?? '');
      const payload = {key,page:span.page,spanId:span.id,originalText:span.text,text,rect:span.rect,font:span.font,x:span.x,y:span.y,wmode:span.wmode};
      if (existing) Object.assign(existing,payload); else edits.push(payload);
      modal.remove();
      rebuildHits();
      await renderPreview();
    };
    requestAnimationFrame(()=>{field.focus();field.select();});
  }

  function rebuildHits(){
    hitLayer.innerHTML = '';
    if (!sourceDoc || !canvas.width) return;
    const pageIndex = currentPageIndex();
    const spans = parseSpans(pageIndex);
    const page = sourceDoc.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const pageW = Math.max(1, bounds[2]-bounds[0]);
      const pageH = Math.max(1, bounds[3]-bounds[1]);
      const sx = canvas.width / pageW;
      const sy = canvas.height / pageH;
      hitLayer.style.width = `${canvas.width}px`;
      hitLayer.style.height = `${canvas.height}px`;
      for (const span of spans) {
        const [x0,y0,x1,y1] = span.rect;
        const button = document.createElement('button');
        const key = `${span.page}:${span.id}`;
        button.type='button';
        button.className='mupdf-hit' + (edits.some(e=>e.key===key) ? ' edited' : '');
        Object.assign(button.style,{
          left:`${(x0-bounds[0])*sx}px`, top:`${(y0-bounds[1])*sy}px`,
          width:`${Math.max(5,(x1-x0)*sx)}px`, height:`${Math.max(7,(y1-y0)*sy)}px`
        });
        button.title=`Modifica: ${span.text}`;
        button.onclick=(e)=>{e.preventDefault();e.stopPropagation();openEditor(span);};
        hitLayer.appendChild(button);
      }
      if (tip) tip.innerHTML = `<b>Motore MuPDF:</b> ${spans.length} elementi rilevati. Il nuovo testo usa dimensione, stile e baseline estratti dal PDF.`;
    } finally {
      try { page.destroy?.(); } catch {}
    }
  }

  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      originalBytes = new Uint8Array(ab);
      fileName = file.name.replace(/\.pdf$/i,'') || 'documento';
      edits = []; spansByPage = new Map();
      destroyDoc(sourceDoc);
      sourceDoc = mupdf.Document.openDocument(originalBytes.slice(0),'application/pdf');
      setTimeout(rebuildHits, 220);
    } catch (err) {
      console.error(err);
      toast('MuPDF non riesce ad aprire questo documento.');
    }
  }, true);

  window.addEventListener('pdf-editor-rendered', () => setTimeout(rebuildHits, 30));

  download.addEventListener('click', (e) => {
    if (!edits.length || !originalBytes) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try {
      const out = buildEditedBytes();
      const url = URL.createObjectURL(new Blob([out],{type:'application/pdf'}));
      const a = document.createElement('a');
      a.href=url; a.download=`${fileName}-modificato.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    } catch (err) {
      console.error(err);
      toast(err?.message || 'Impossibile esportare il PDF modificato.');
    }
  }, true);
})();
