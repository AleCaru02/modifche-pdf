import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
const PDFLIB = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');

const $ = (selector) => document.querySelector(selector);
const canvas = $('#canvas');
const sheet = $('#sheet');
const layer = $('#layer');
const textLayer = $('#textLayer');
const BASE_SCALE = 1.45;
const MAX_BYTES = 100 * 1024 * 1024;

let sourceBytes = null;
let pdf = null;
let pages = [];
let current = 0;
let zoom = 1;
let tool = 'select';
let selectedId = '';
let history = [];
let future = [];
let baseName = 'documento';
let renderSerial = 0;

const deep = (value) => JSON.parse(JSON.stringify(value));
const pct = (value, total) => (total ? (100 * value) / total : 0);
const px = (value, total) => (total * value) / 100;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pageSpec = () => pages[current];

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hide');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hide'), 3500);
}

function snapshot() {
  history.push(JSON.stringify(pages));
  if (history.length > 50) history.shift();
  future = [];
  updateButtons();
}

function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(pages));
  pages = JSON.parse(from.pop());
  selectedId = '';
  render();
  updateButtons();
}

function updateButtons() {
  const loaded = Boolean(pdf);
  $('#download').disabled = !loaded;
  $('#undo').disabled = !history.length;
  $('#redo').disabled = !future.length;
  $('#remove').disabled = !selectedId;
  $('#prev').disabled = !loaded || current <= 0;
  $('#next').disabled = !loaded || current >= pages.length - 1;
  $('#deletepage').disabled = !loaded || pages.length <= 1;
}

function setTool(next) {
  tool = next;
  $('#tools').querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('on', button.dataset.tool === tool);
  });
  if (tool === 'image') {
    $('#imginput').click();
    tool = 'select';
    setTool('select');
  }
}

function hex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

function dominantColor(samples, fallback = '#ffffff') {
  if (!samples.length) return fallback;
  const groups = new Map();
  for (const [r, g, b] of samples) {
    const key = `${Math.round(r / 16) * 16},${Math.round(g / 16) * 16},${Math.round(b / 16) * 16}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const [best] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  return hex(...best.split(',').map(Number));
}

function sampleTextColors(x, y, w, h) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const W = canvas.width;
    const H = canvas.height;
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(W, Math.ceil(x + w));
    const bottom = Math.min(H, Math.ceil(y + h));
    const outer = [];
    const inner = [];
    const step = Math.max(1, Math.floor(Math.min(Math.max(w, 1), Math.max(h, 1)) / 12));
    const margin = Math.max(2, Math.round(h * 0.18));
    const take = (xx, yy, target) => {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) return;
      const data = ctx.getImageData(xx, yy, 1, 1).data;
      target.push([data[0], data[1], data[2], 0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2]]);
    };
    for (let xx = left; xx < right; xx += step) {
      take(xx, top - margin, outer);
      take(xx, bottom + margin, outer);
    }
    for (let yy = top; yy < bottom; yy += step) {
      take(left - margin, yy, outer);
      take(right + margin, yy, outer);
    }
    for (let yy = top; yy < bottom; yy += step) {
      for (let xx = left; xx < right; xx += step) take(xx, yy, inner);
    }
    const background = dominantColor(outer.map((p) => p.slice(0, 3)), '#ffffff');
    const darkest = inner.sort((a, b) => a[3] - b[3]).slice(0, Math.max(1, Math.ceil(inner.length * 0.18)));
    const avg = darkest.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    const foreground = darkest.length ? hex(avg[0] / darkest.length, avg[1] / darkest.length, avg[2] / darkest.length) : '#111111';
    return { background, foreground };
  } catch {
    return { background: '#ffffff', foreground: '#111111' };
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('Scegli un file PDF.');
  if (file.size > MAX_BYTES) return toast('Il PDF supera il limite di 100 MB.');
  try {
    sourceBytes = await file.arrayBuffer();
    pdf = await PDFJS.getDocument({ data: sourceBytes.slice(0) }).promise;
    pages = Array.from({ length: pdf.numPages }, (_, index) => ({ source: index, rot: 0, items: [] }));
    current = 0;
    zoom = 1;
    baseName = file.name.replace(/\.pdf$/i, '') || 'documento';
    $('#filename').textContent = file.name;
    $('#welcome').classList.add('hide');
    sheet.classList.remove('hide');
    $('#bar').classList.remove('hide');
    history = [];
    future = [];
    selectedId = '';
    setTool('select');
    await render();
    updateButtons();
    toast('PDF caricato senza modificare impaginazione, dimensioni o spaziature.');
  } catch (error) {
    console.error(error);
    toast('PDF protetto, danneggiato o non leggibile. Rimuovi la password e riprova.');
  }
}

function cssFont(item, sizePx) {
  const style = item.fontStyle && item.fontStyle !== 'normal' ? item.fontStyle : '';
  const weight = item.fontWeight || 'normal';
  return `${style} ${weight} ${sizePx}px ${item.fontFamily || 'sans-serif'}`.trim();
}

function measureFit(text, item, targetWidth, fontSizePx) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = cssFont(item, fontSizePx);
  const naturalWidth = Math.max(0.01, probe.measureText(text || ' ').width);
  const gaps = Math.max(0, [...String(text)].length - 1);
  const preferredSpacing = gaps ? (targetWidth - naturalWidth) / gaps : 0;
  const spacingLimit = fontSizePx * 0.22;
  if (gaps && Math.abs(preferredSpacing) <= spacingLimit) return { letterSpacing: preferredSpacing, scaleX: 1, naturalWidth };
  return { letterSpacing: 0, scaleX: targetWidth / naturalWidth, naturalWidth };
}

async function render() {
  if (!pdf) return;
  const serial = ++renderSerial;
  current = clamp(current, 0, pages.length - 1);
  const spec = pageSpec();
  const page = await pdf.getPage(spec.source + 1);
  const viewport = page.getViewport({ scale: BASE_SCALE * zoom, rotation: (page.rotate + spec.rot) % 360 });
  if (serial !== renderSerial) return;
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  sheet.style.width = `${viewport.width}px`;
  sheet.style.height = `${viewport.height}px`;
  layer.style.width = textLayer.style.width = `${viewport.width}px`;
  layer.style.height = textLayer.style.height = `${viewport.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (serial !== renderSerial) return;
  renderItems(viewport);
  await renderTextHits(page, viewport, spec);
  $('#pageinfo').textContent = `${current + 1} / ${pages.length}`;
  $('#zoominfo').textContent = `${Math.round(zoom * 100)}%`;
  updateButtons();
}

async function renderTextHits(page, viewport, spec) {
  textLayer.innerHTML = '';
  let content;
  try { content = await page.getTextContent(); } catch { content = { items: [], styles: {} }; }
  const replaced = new Set(spec.items.filter((item) => item.kind === 'replace').map((item) => item.originalId));
  let count = 0;
  content.items.forEach((item, index) => {
    if (!('str' in item) || !item.str || !item.str.trim()) return;
    const originalId = `${spec.source}:${index}`;
    if (replaced.has(originalId)) return;
    const transformed = PDFJS.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(6, Math.hypot(transformed[2], transformed[3]));
    const angle = Math.atan2(transformed[1], transformed[0]);
    const x = transformed[4];
    const y = transformed[5] - fontHeight;
    const width = Math.max(4, (item.width || item.str.length * fontHeight * 0.48) * viewport.scale);
    const height = Math.max(fontHeight, 8);
    if (x > viewport.width || y > viewport.height || x + width < 0 || y + height < 0) return;
    const style = content.styles?.[item.fontName] || {};
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'text-hit';
    hit.setAttribute('aria-label', `Modifica ${item.str}`);
    hit.title = `Clicca per modificare: ${item.str}`;
    hit.style.left = `${x}px`;
    hit.style.top = `${y}px`;
    hit.style.width = `${width}px`;
    hit.style.height = `${height}px`;
    hit.style.transform = angle ? `rotate(${angle}rad)` : '';
    hit.onclick = (event) => {
      event.stopPropagation();
      if (tool !== 'select') return;
      const colors = sampleTextColors(x, y, width, height);
      openTextEditor({ originalId, text: item.str, x: pct(x, viewport.width), y: pct(y, viewport.height), w: pct(width, viewport.width), h: pct(height, viewport.height), fontSize: fontHeight / (BASE_SCALE * zoom), fontFamily: style.fontFamily || 'sans-serif', fontWeight: style.fontWeight || 'normal', fontStyle: style.italic ? 'italic' : 'normal', angle: (angle * 180) / Math.PI, color: colors.foreground, background: colors.background });
    };
    textLayer.appendChild(hit);
    count += 1;
  });
  const note = $('#scanNote');
  if (count === 0 && !spec.items.some((item) => item.kind === 'replace')) {
    note.textContent = 'Questo PDF è probabilmente una scansione: non contiene testo reale selezionabile. Per renderlo interamente modificabile serve OCR, che può cambiare font e impaginazione.';
    note.classList.remove('hide');
    clearTimeout(note.timer);
    note.timer = setTimeout(() => note.classList.add('hide'), 7500);
  } else note.classList.add('hide');
}

function createFittedTextNode(item, widthPx, heightPx) {
  const holder = document.createElement('div');
  holder.className = 'fitted-holder';
  holder.style.width = `${widthPx}px`;
  holder.style.height = `${heightPx}px`;
  const text = document.createElement('span');
  text.className = 'fitted-text';
  text.textContent = item.text;
  const fontSizePx = Math.max(5, item.fontSize * BASE_SCALE * zoom);
  const fit = measureFit(item.text, item, widthPx, fontSizePx);
  text.style.font = cssFont(item, fontSizePx);
  text.style.color = item.color || '#111111';
  text.style.letterSpacing = `${fit.letterSpacing}px`;
  text.style.transform = `scaleX(${fit.scaleX})`;
  text.style.width = `${fit.naturalWidth + Math.max(0, [...String(item.text)].length - 1) * fit.letterSpacing}px`;
  holder.appendChild(text);
  return holder;
}

function renderItems(viewport) {
  layer.innerHTML = '';
  pageSpec().items.forEach((item) => {
    const element = document.createElement('div');
    element.className = `item ${item.kind}${item.id === selectedId ? ' selected' : ''}`;
    element.dataset.id = item.id;
    const width = px(item.w, viewport.width);
    const height = Math.max(3, px(item.h, viewport.height));
    element.style.left = `${px(item.x, viewport.width)}px`;
    element.style.top = `${px(item.y, viewport.height)}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    if (item.kind === 'replace') {
      element.style.background = item.background || '#ffffff';
      element.style.transformOrigin = 'left top';
      element.style.transform = item.angle ? `rotate(${item.angle}deg)` : '';
      element.appendChild(createFittedTextNode(item, width, height));
      element.onclick = (event) => { event.stopPropagation(); selectedId = item.id; updateButtons(); openTextEditor(item); };
    } else if (item.kind === 'text') {
      element.contentEditable = 'true';
      element.spellcheck = false;
      element.textContent = item.text;
      element.style.font = cssFont(item, Math.max(6, item.fontSize * BASE_SCALE * zoom));
      element.style.color = item.color || '#111111';
      element.onfocus = () => { selectedId = item.id; snapshot(); updateButtons(); };
      element.oninput = () => { item.text = element.textContent || ''; };
      element.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); element.blur(); } };
      element.onclick = (event) => event.stopPropagation();
    } else {
      if (item.kind === 'white') element.style.background = item.background || '#ffffff';
      if (item.kind === 'highlight') element.style.background = item.color || '#ffe35c88';
      if (item.kind === 'rect') element.style.borderColor = item.color || '#1769e0';
      if (item.kind === 'line') { element.style.background = item.color || '#1769e0'; element.style.transform = `rotate(${item.angle || 0}deg)`; }
      if (item.kind === 'image') element.style.backgroundImage = `url(${item.data})`;
      element.onclick = (event) => { event.stopPropagation(); selectedId = item.id; render(); };
      element.onpointerdown = (event) => startMove(event, item, viewport);
    }
    layer.appendChild(element);
  });
}

function openTextEditor(meta) {
  const existing = pageSpec().items.find((item) => item.kind === 'replace' && item.originalId === meta.originalId);
  const model = existing || meta;
  document.querySelector('.text-editor-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'text-editor-modal';
  modal.innerHTML = `<div class="text-editor-card" role="dialog" aria-modal="true" aria-label="Modifica testo PDF"><div class="editor-title">Modifica testo o numero</div><div class="editor-note">Dimensione, posizione, altezza e larghezza restano bloccate. Gli spazi inseriti vengono mantenuti.</div><textarea class="editor-input" rows="3"></textarea><label class="editor-check"><input type="checkbox" class="keep-width" checked> Mantieni esattamente la larghezza originale</label><div class="editor-actions"><button type="button" class="cancel">Annulla</button><button type="button" class="save primary">Applica modifica</button></div></div>`;
  document.body.appendChild(modal);
  const input = modal.querySelector('.editor-input');
  input.value = model.text;
  input.style.font = cssFont(model, 18);
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape') modal.remove(); if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') modal.querySelector('.save').click(); });
  modal.querySelector('.cancel').onclick = () => modal.remove();
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  modal.querySelector('.save').onclick = () => {
    const value = input.value;
    if (existing) {
      snapshot();
      existing.text = value;
      existing.keepWidth = modal.querySelector('.keep-width').checked;
      selectedId = existing.id;
    } else {
      snapshot();
      const item = { id: crypto.randomUUID(), kind: 'replace', originalId: meta.originalId, originalText: meta.text, text: value, x: meta.x, y: meta.y, w: Math.max(meta.w, 0.2), h: Math.max(meta.h, 0.2), fontSize: meta.fontSize, fontFamily: meta.fontFamily, fontWeight: meta.fontWeight, fontStyle: meta.fontStyle, angle: meta.angle || 0, color: meta.color, background: meta.background, keepWidth: modal.querySelector('.keep-width').checked };
      pageSpec().items.push(item);
      selectedId = item.id;
    }
    modal.remove();
    render();
  };
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function addItem(kind, x = 16, y = 16, extra = {}) {
  snapshot();
  const item = { id: crypto.randomUUID(), kind, x, y, w: kind === 'text' ? 34 : kind === 'line' ? 25 : 24, h: kind === 'text' ? 5 : kind === 'line' ? 0.35 : 8, text: 'Scrivi qui', fontSize: 16, fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 'normal', fontStyle: 'normal', color: '#1769e0', background: '#ffffff', angle: 0, ...extra };
  pageSpec().items.push(item);
  selectedId = item.id;
  setTool('select');
  render();
}

function startMove(event, item, viewport) {
  if (tool !== 'select') return;
  event.preventDefault();
  event.stopPropagation();
  snapshot();
  selectedId = item.id;
  const startX = event.clientX, startY = event.clientY, originalX = item.x, originalY = item.y;
  const move = (next) => {
    item.x = clamp(originalX + pct(next.clientX - startX, viewport.width), 0, 99);
    item.y = clamp(originalY + pct(next.clientY - startY, viewport.height), 0, 99);
    const element = layer.querySelector(`[data-id="${item.id}"]`);
    if (element) { element.style.left = `${px(item.x, viewport.width)}px`; element.style.top = `${px(item.y, viewport.height)}px`; }
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); render(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

sheet.onpointerdown = (event) => {
  if ((event.target !== canvas && event.target !== sheet) || !pdf) return;
  const rect = sheet.getBoundingClientRect();
  const x = pct(event.clientX - rect.left, rect.width), y = pct(event.clientY - rect.top, rect.height);
  if (tool === 'select') { selectedId = ''; render(); return; }
  if (tool === 'text') { addItem('text', x, y); return; }
  if (['white', 'highlight', 'rect', 'line'].includes(tool)) {
    snapshot();
    const kind = tool, id = crypto.randomUUID();
    const item = { id, kind, x, y, w: 0.1, h: 0.1, color: kind === 'highlight' ? '#ffe35c88' : '#1769e0', background: '#ffffff', angle: 0 };
    pageSpec().items.push(item);
    const startX = event.clientX, startY = event.clientY;
    const move = (next) => {
      const dx = pct(next.clientX - startX, rect.width), dy = pct(next.clientY - startY, rect.height);
      item.x = dx < 0 ? x + dx : x; item.y = dy < 0 ? y + dy : y; item.w = Math.max(0.2, Math.abs(dx)); item.h = kind === 'line' ? 0.35 : Math.max(0.2, Math.abs(dy));
      if (kind === 'line') item.angle = (Math.atan2(next.clientY - startY, next.clientX - startX) * 180) / Math.PI;
      renderItems({ width: rect.width, height: rect.height });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); selectedId = id; setTool('select'); render(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
};

function removeSelected() {
  if (!selectedId) return;
  snapshot();
  pageSpec().items = pageSpec().items.filter((item) => item.id !== selectedId);
  selectedId = '';
  render();
}

function rgbFromHex(value) {
  const raw = (value || '#000000').replace('#', '').slice(0, 6);
  const normalized = raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw;
  const number = parseInt(normalized || '000000', 16);
  return PDFLIB.rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}

function dataBytes(url) { return Uint8Array.from(atob(url.split(',')[1] || ''), (char) => char.charCodeAt(0)); }

async function textPng(item, widthPoints, heightPoints) {
  await document.fonts?.ready;
  const ratio = 4;
  const output = document.createElement('canvas');
  output.width = Math.max(4, Math.ceil(widthPoints * ratio));
  output.height = Math.max(4, Math.ceil(heightPoints * ratio));
  const ctx = output.getContext('2d');
  const fontSize = Math.max(4, item.fontSize * ratio);
  ctx.font = cssFont(item, fontSize);
  ctx.fillStyle = item.color || '#111111';
  ctx.textBaseline = 'alphabetic';
  const naturalWidth = Math.max(0.01, ctx.measureText(item.text || ' ').width), targetWidth = output.width;
  const gaps = Math.max(0, [...String(item.text)].length - 1), spacing = gaps ? (targetWidth - naturalWidth) / gaps : 0, limit = fontSize * 0.22;
  const baseline = Math.min(output.height - 1, Math.max(fontSize * 0.78, output.height * 0.82));
  if (gaps && Math.abs(spacing) <= limit) {
    let cursor = 0;
    for (const char of [...String(item.text)]) { ctx.fillText(char, cursor, baseline); cursor += ctx.measureText(char).width + spacing; }
  } else {
    const scaleX = targetWidth / naturalWidth;
    ctx.save(); ctx.scale(scaleX, 1); ctx.fillText(item.text, 0, baseline); ctx.restore();
  }
  return output.toDataURL('image/png');
}

async function downloadPdf() {
  if (!sourceBytes) return;
  try {
    toast('Creo il PDF modificato mantenendo misure e impaginazione…');
    const input = await PDFLIB.PDFDocument.load(sourceBytes.slice(0), { ignoreEncryption: true });
    const output = await PDFLIB.PDFDocument.create();
    const fonts = {};
    for (const spec of pages) {
      const [page] = await output.copyPages(input, [spec.source]);
      output.addPage(page);
      page.setRotation(PDFLIB.degrees((page.getRotation().angle + spec.rot) % 360));
      const W = page.getWidth(), H = page.getHeight();
      for (const item of spec.items) {
        const X = (W * item.x) / 100, Y = H - (H * (item.y + item.h)) / 100, width = (W * item.w) / 100, height = (H * item.h) / 100;
        if (item.kind === 'white' || item.kind === 'replace') page.drawRectangle({ x: X, y: Y, width, height, color: rgbFromHex(item.background || '#ffffff') });
        if (item.kind === 'highlight') page.drawRectangle({ x: X, y: Y, width, height, color: PDFLIB.rgb(1, 0.82, 0.05), opacity: 0.42 });
        if (item.kind === 'rect') page.drawRectangle({ x: X, y: Y, width, height, borderColor: rgbFromHex(item.color), borderWidth: 2 });
        if (item.kind === 'line') page.drawLine({ start: { x: X, y: Y + height / 2 }, end: { x: X + width, y: Y + height / 2 }, thickness: 2, color: rgbFromHex(item.color) });
        if (item.kind === 'replace') { const png = await output.embedPng(dataBytes(await textPng(item, width, height))); page.drawImage(png, { x: X, y: Y, width, height }); }
        if (item.kind === 'text') { if (!fonts.helvetica) fonts.helvetica = await output.embedFont(PDFLIB.StandardFonts.Helvetica); page.drawText(String(item.text), { x: X, y: Y, size: Math.max(5, item.fontSize || 14), font: fonts.helvetica, color: rgbFromHex(item.color || '#111111') }); }
        if (item.kind === 'image') { const bytes = dataBytes(item.data); const image = item.data.startsWith('data:image/png') ? await output.embedPng(bytes) : await output.embedJpg(bytes); page.drawImage(image, { x: X, y: Y, width, height }); }
      }
    }
    const bytes = await output.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${baseName}-modificato.pdf`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('PDF scaricato: pagine e spaziature originali mantenute.');
  } catch (error) { console.error(error); toast('Errore nell’esportazione. Prova con un PDF non protetto.'); }
}

$('#tools').onclick = (event) => { const button = event.target.closest('[data-tool]'); if (button) setTool(button.dataset.tool); };
$('#open').onclick = () => $('#pdfinput').click();
$('#pdfinput').onchange = (event) => { loadFile(event.target.files[0]); event.target.value = ''; };
$('#download').onclick = downloadPdf;
$('#undo').onclick = () => restore(history, future);
$('#redo').onclick = () => restore(future, history);
$('#remove').onclick = removeSelected;
$('#prev').onclick = () => { if (current > 0) { current -= 1; selectedId = ''; render(); } };
$('#next').onclick = () => { if (current < pages.length - 1) { current += 1; selectedId = ''; render(); } };
$('#minus').onclick = () => { zoom = Math.max(0.4, +(zoom - 0.15).toFixed(2)); render(); };
$('#plus').onclick = () => { zoom = Math.min(2.5, +(zoom + 0.15).toFixed(2)); render(); };
$('#rotate').onclick = () => { snapshot(); pageSpec().rot = (pageSpec().rot + 90) % 360; selectedId = ''; render(); };
$('#duplicate').onclick = () => { snapshot(); const copy = deep(pageSpec()); copy.items.forEach((item) => (item.id = crypto.randomUUID())); pages.splice(current + 1, 0, copy); current += 1; render(); };
$('#deletepage').onclick = () => { if (pages.length <= 1) return; snapshot(); pages.splice(current, 1); current = Math.min(current, pages.length - 1); render(); };
$('#imginput').onchange = (event) => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => addItem('image', 18, 18, { w: 32, h: 22, data: reader.result }); reader.readAsDataURL(file); event.target.value = ''; };
$('#drop').ondragover = (event) => { event.preventDefault(); $('#welcome').classList.add('drag'); };
$('#drop').ondragleave = () => $('#welcome').classList.remove('drag');
$('#drop').ondrop = (event) => { event.preventDefault(); $('#welcome').classList.remove('drag'); const file = [...event.dataTransfer.files].find((candidate) => candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name)); loadFile(file); };
window.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(event.target.tagName) || event.target.isContentEditable;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? restore(future, history) : restore(history, future); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); restore(future, history); }
  else if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) removeSelected();
});
updateButtons();
