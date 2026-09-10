import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

(function initDirectStreamReplace(){
  if (window.__directStreamReplaceInstalled) return;
  window.__directStreamReplaceInstalled = true;

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
    .direct-stream-layer{position:absolute;inset:0;z-index:80;pointer-events:none}
    .direct-stream-hit{position:absolute;padding:0;margin:0;border:1px solid transparent;background:transparent;pointer-events:auto;cursor:text;border-radius:2px}
    .direct-stream-hit:hover,.direct-stream-hit:focus{border-color:#1769e0;background:#1769e00a;outline:none}
    .direct-stream-hit.edited{border-color:#16834899;background:#1683480a}
    .direct-stream-modal{position:fixed;inset:0;z-index:13000;background:#0b122055;display:grid;place-items:center;padding:16px}
    .direct-stream-card{width:min(440px,calc(100vw - 28px));background:#fff;border-radius:14px;padding:18px;box-shadow:0 18px 60px #0005;font:14px system-ui,sans-serif}
    .direct-stream-card h3{margin:0 0 8px;font-size:17px}.direct-stream-card p{margin:0 0 12px;color:#546276;font-size:12px;line-height:1.4}
    .direct-stream-card textarea{width:100%;box-sizing:border-box;border:1px solid #b4c0d0;border-radius:9px;padding:11px;font:17px system-ui,sans-serif;resize:vertical}
    .direct-stream-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.direct-stream-actions button{padding:9px 13px;border-radius:8px;border:1px solid #cad4e1;background:#fff}.direct-stream-actions .apply{background:#1769e0;color:#fff;border-color:#1769e0;font-weight:700}
  `;
  document.head.appendChild(css);

  const hitLayer = document.createElement('div');
  hitLayer.className = 'direct-stream-layer';
  sheet.appendChild(hitLayer);

  const currentPageIndex = () => {
    const n = parseInt(document.querySelector('#pageinfo')?.textContent || '1', 10);
    return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
  };

  const clean = (v) => String(v ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\u00A0/g, ' ');

  function bytesToBinary(bytes){
    let out = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode(...bytes.subarray(i, i + step));
    return out;
  }

  function binaryToBytes(text){
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
    return out;
  }

  function decodeLiteral(raw){
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch !== '\\') { out += ch; continue; }
      const n = raw[++i];
      if (n === undefined) break;
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === '\n') {}
      else if (n === '\r') { if (raw[i + 1] === '\n') i++; }
      else if (/[0-7]/.test(n)) {
        let oct = n;
        for (let k = 0; k < 2 && /[0-7]/.test(raw[i + 1] || ''); k++) oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8) & 255);
      } else out += n;
    }
    return out;
  }

  function encodeLiteral(text){
    let out = '(';
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code > 255) throw new Error('Carattere non supportato dalla codifica originale del PDF');
      if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else out += ch;
    }
    return out + ')';
  }

  function decodeHex(raw){
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    const even = hex.length % 2 ? hex + '0' : hex;
    let out = '';
    for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
    return out;
  }

  function encodeHex(text){
    let hex = '';
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code > 255) throw new Error('Carattere non supportato dalla codifica originale del PDF');
      hex += code.toString(16).padStart(2, '0').toUpperCase();
    }
    return `<${hex}>`;
  }

  function findStringTokens(src, start = 0, end = src.length){
    const tokens = [];
    let i = start;
    while (i < end) {
      if (src[i] === '(') {
        const s = i; let depth = 1; i++;
        while (i < end && depth) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        }
        if (!depth) {
          const raw = src.slice(s, i);
          tokens.push({ start:s, end:i, raw, type:'literal', text:decodeLiteral(raw) });
        }
        continue;
      }
      if (src[i] === '<' && src[i + 1] !== '<') {
        const s = i; const close = src.indexOf('>', i + 1);
        if (close !== -1 && close < end) {
          const raw = src.slice(s, close + 1);
          if (/^<[0-9A-Fa-f\s]*>$/.test(raw)) tokens.push({ start:s, end:close + 1, raw, type:'hex', text:decodeHex(raw) });
          i = close + 1; continue;
        }
      }
      i++;
    }
    return tokens;
  }

  function collectTextCandidates(src){
    const out = [];
    const tokens = findStringTokens(src);
    for (const t of tokens) {
      const tail = src.slice(t.end, Math.min(src.length, t.end + 40));
      if (/^\s*(?:Tj|'|\")\b/.test(tail) || /^\s*(?:Tj|'|\")/.test(tail)) {
        out.push({ start:t.start, end:t.end, text:t.text, type:t.type, token:t });
      }
    }

    const tjArrayRe = /\[(.*?)\]\s*TJ\b/gs;
    let m;
    while ((m = tjArrayRe.exec(src))) {
      const innerStart = m.index + 1;
      const innerEnd = m.index + m[0].lastIndexOf(']');
      const parts = findStringTokens(src, innerStart, innerEnd);
      if (!parts.length) continue;
      const text = parts.map(p => p.text).join('');
      out.push({ start:m.index, end:m.index + m[0].length, text, type:'tjarray', parts });
    }
    return out.sort((a,b) => a.start - b.start);
  }

  function replacementForCandidate(candidate, newText){
    if (candidate.type === 'literal') return encodeLiteral(newText);
    if (candidate.type === 'hex') return encodeHex(newText);
    const useHex = candidate.parts.some(p => p.type === 'hex');
    return `[${useHex ? encodeHex(newText) : encodeLiteral(newText)}] TJ`;
  }

  function getContentTargets(doc, page){
    const entry = page.node.get(PDFLIB.PDFName.of('Contents'));
    const targets = [];
    if (!entry) return targets;
    if (entry instanceof PDFLIB.PDFRef) {
      const stream = doc.context.lookup(entry);
      if (stream instanceof PDFLIB.PDFRawStream) targets.push({ ref:entry, stream });
    } else if (entry instanceof PDFLIB.PDFArray) {
      for (let i = 0; i < entry.size(); i++) {
        const child = entry.get(i);
        if (child instanceof PDFLIB.PDFRef) {
          const stream = doc.context.lookup(child);
          if (stream instanceof PDFLIB.PDFRawStream) targets.push({ ref:child, stream });
        } else if (child instanceof PDFLIB.PDFRawStream) targets.push({ array:entry, index:i, stream:child });
      }
    } else if (entry instanceof PDFLIB.PDFRawStream) targets.push({ direct:true, stream:entry });
    return targets;
  }

  function replacePageEdits(doc, page, pageEdits){
    const targets = getContentTargets(doc, page);
    if (!targets.length) throw new Error('Il PDF non espone un content stream modificabile');

    const decoded = targets.map(target => {
      const bytes = PDFLIB.decodePDFRawStream(target.stream).getBytes();
      const text = bytesToBinary(bytes);
      return { ...target, text };
    });

    for (const edit of pageEdits) {
      let seen = 0;
      let matched = false;
      for (const target of decoded) {
        const candidates = collectTextCandidates(target.text);
        for (const candidate of candidates) {
          if (candidate.text !== edit.originalText) continue;
          if (seen++ !== edit.occurrence) continue;
          const replacement = replacementForCandidate(candidate, edit.text);
          target.text = target.text.slice(0, candidate.start) + replacement + target.text.slice(candidate.end);
          matched = true;
          break;
        }
        if (matched) break;
      }
      if (!matched) throw new Error(`Non riesco a trovare direttamente il testo “${edit.originalText}” nel content stream`);
    }

    for (const target of decoded) {
      const newStream = doc.context.flateStream(binaryToBytes(target.text));
      if (target.ref) doc.context.assign(target.ref, newStream);
      else if (target.array) target.array.set(target.index, newStream);
      else if (target.direct) page.node.set(PDFLIB.PDFName.of('Contents'), newStream);
    }
  }

  async function buildEditedPdf(bytes){
    const doc = await PDFLIB.PDFDocument.load(bytes.slice(0), { ignoreEncryption:true, updateMetadata:false });
    const byPage = new Map();
    for (const edit of edits) {
      const arr = byPage.get(edit.page) || [];
      arr.push(edit); byPage.set(edit.page, arr);
    }
    for (const [pageIndex, pageEdits] of byPage) replacePageEdits(doc, doc.getPage(pageIndex), pageEdits);
    return await doc.save({ useObjectStreams:false, updateFieldAppearances:false });
  }

  async function preview(){
    if (!sourceBytes || !edits.length || !canvas.width) return;
    const token = ++renderToken;
    const idx = currentPageIndex();
    if (!edits.some(e => e.page === idx)) return;
    try {
      const bytes = await buildEditedPdf(sourceBytes);
      if (token !== renderToken) return;
      const pdoc = await PDFJS.getDocument({data:bytes.slice(0)}).promise;
      const page = await pdoc.getPage(idx + 1);
      const unit = page.getViewport({scale:1, rotation:page.rotate});
      const scale = canvas.width / Math.max(1, unit.width);
      const viewport = page.getViewport({scale, rotation:page.rotate});
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx, viewport}).promise;
      await pdoc.destroy();
    } catch (err) {
      console.error('Direct stream preview failed', err);
      alert(err?.message || 'Questo testo non può essere sostituito direttamente in questo PDF.');
    }
  }

  function openEditor(meta){
    document.querySelector('.direct-stream-modal')?.remove();
    const existing = edits.find(e => e.key === meta.key);
    const modal = document.createElement('div');
    modal.className = 'direct-stream-modal';
    modal.innerHTML = '<div class="direct-stream-card"><h3>Sostituisci testo</h3><p>Il testo originale viene rimosso dal content stream del PDF e sostituito con quello nuovo. Nessun riquadro bianco viene aggiunto.</p><textarea rows="2"></textarea><div class="direct-stream-actions"><button class="cancel">Annulla</button><button class="apply">Sostituisci</button></div></div>';
    document.body.appendChild(modal);
    const field = modal.querySelector('textarea');
    field.value = existing?.text ?? meta.originalText;
    modal.querySelector('.cancel').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    modal.querySelector('.apply').onclick = async () => {
      const value = clean(field.value);
      if (existing) existing.text = value;
      else edits.push({...meta, text:value});
      modal.remove();
      await rebuild();
      await preview();
    };
    requestAnimationFrame(() => { field.focus(); field.select(); });
  }

  async function rebuild(){
    hitLayer.innerHTML = '';
    if (!sourcePdf || !canvas.width) return;
    const idx = currentPageIndex();
    const page = await sourcePdf.getPage(idx + 1);
    const content = await page.getTextContent();
    const unit = page.getViewport({scale:1, rotation:page.rotate});
    const scale = canvas.width / Math.max(1, unit.width);
    const viewport = page.getViewport({scale, rotation:page.rotate});
    hitLayer.style.width = `${viewport.width}px`;
    hitLayer.style.height = `${viewport.height}px`;

    const seenByText = new Map();
    content.items.forEach((item, itemIndex) => {
      if (!item?.str?.trim() || !item.transform) return;
      const originalText = clean(item.str);
      const occurrence = seenByText.get(originalText) || 0;
      seenByText.set(originalText, occurrence + 1);

      const transformed = PDFJS.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.max(6, Math.hypot(transformed[2], transformed[3]));
      const angle = Math.atan2(transformed[1], transformed[0]);
      const left = transformed[4];
      const top = transformed[5] - fontHeight;
      const width = Math.max(5, Number(item.width || 0) * viewport.scale || originalText.length * fontHeight * .5);
      const height = Math.max(7, fontHeight);
      if (left > viewport.width || top > viewport.height || left + width < 0 || top + height < 0) return;

      const key = `${idx}:${itemIndex}`;
      const hit = document.createElement('button');
      hit.type = 'button'; hit.className = 'direct-stream-hit'; hit.dataset.key = key;
      Object.assign(hit.style, {left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px`, transformOrigin:'left top', transform:angle ? `rotate(${angle}rad)` : ''});
      hit.title = `Modifica: ${originalText}`; hit.setAttribute('aria-label', hit.title);
      if (edits.some(e => e.key === key)) hit.classList.add('edited');
      hit.onclick = e => { e.preventDefault(); e.stopPropagation(); openEditor({key, page:idx, originalText, occurrence}); };
      hitLayer.appendChild(hit);
    });

    if (tip && content.items.some(i => i?.str?.trim())) tip.innerHTML = '<b>Sostituzione reale:</b> clicca su una scritta. Il testo viene sostituito nel content stream del PDF, senza riquadri bianchi.';
  }

  input.addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      sourceBytes = await file.arrayBuffer();
      baseName = file.name.replace(/\.pdf$/i,'') || 'documento';
      edits = [];
      if (sourcePdf) try { await sourcePdf.destroy(); } catch {}
      sourcePdf = await PDFJS.getDocument({data:sourceBytes.slice(0)}).promise;
      setTimeout(rebuild, 220);
    } catch (err) { console.error('Direct stream init failed', err); }
  }, true);

  window.addEventListener('pdf-editor-rendered', () => setTimeout(async () => { await rebuild(); await preview(); }, 35));

  download.addEventListener('click', async event => {
    if (!edits.length || !sourceBytes) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      const bytes = await buildEditedPdf(sourceBytes);
      const url = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'}));
      const a = document.createElement('a');
      a.href = url; a.download = `${baseName}-modificato.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error('Direct stream export failed', err);
      alert(err?.message || 'Questo PDF non supporta la sostituzione diretta del testo.');
    }
  }, true);
})();
