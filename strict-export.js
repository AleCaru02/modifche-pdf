import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
const PDFLIB = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');

const pageSnapshots = new Map();
let originalBytes = null;
let originalName = 'documento.pdf';
let loadingPromise = null;

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function currentPageNumber() {
  const text = document.querySelector('#pageinfo')?.textContent || '';
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? Number(match[1]) : 1;
}

function readCurrentPage() {
  const sheet = document.querySelector('#sheet');
  const layer = document.querySelector('#layer');
  if (!sheet || !layer || sheet.classList.contains('hide')) return null;
  const sheetRect = sheet.getBoundingClientRect();
  if (!sheetRect.width || !sheetRect.height) return null;

  const items = [...layer.querySelectorAll('.item')].map((node) => {
    const rect = node.getBoundingClientRect();
    const kind = [...node.classList].find((name) => ['replace','text','white','highlight','rect','line','image'].includes(name));
    if (!kind) return null;
    const style = getComputedStyle(node);
    const textNode = node.querySelector('.fitted-text') || node;
    const textStyle = getComputedStyle(textNode);
    const text = cleanText(textNode.textContent || '');
    return {
      kind,
      text,
      x: (rect.left - sheetRect.left) / sheetRect.width,
      y: (rect.top - sheetRect.top) / sheetRect.height,
      w: rect.width / sheetRect.width,
      h: rect.height / sheetRect.height,
      fontSizePx: parseFloat(textStyle.fontSize) || parseFloat(style.fontSize) || 16,
      fontFamily: textStyle.fontFamily || style.fontFamily || 'Arial, sans-serif',
      fontWeight: textStyle.fontWeight || style.fontWeight || '400',
      fontStyle: textStyle.fontStyle || style.fontStyle || 'normal',
      color: textStyle.color || style.color || 'rgb(0,0,0)',
      background: style.backgroundColor || 'rgb(255,255,255)',
      opacity: parseFloat(style.opacity) || 1,
      borderColor: style.borderColor,
      transform: style.transform,
      displayWidth: sheetRect.width,
      displayHeight: sheetRect.height
    };
  }).filter(Boolean);

  return { items };
}

function snapshotCurrentPage() {
  const page = currentPageNumber();
  const snap = readCurrentPage();
  if (snap) pageSnapshots.set(page, snap);
}

function parseCssColor(value, fallback = [0, 0, 0, 1]) {
  const text = String(value || '').trim();
  const rgba = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, Number.isFinite(parts[3]) ? parts[3] : 1];
  }
  const hex = text.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let raw = hex[1];
    if (raw.length === 3 || raw.length === 4) raw = raw.split('').map((c) => c + c).join('');
    const n = parseInt(raw.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, raw.length >= 8 ? parseInt(raw.slice(6,8),16)/255 : 1];
  }
  return fallback;
}

function cssFont(item, sizePx) {
  const family = item.fontFamily || 'Arial, sans-serif';
  const weight = item.fontWeight || '400';
  const style = item.fontStyle || 'normal';
  return `${style} ${weight} ${sizePx}px ${family}`;
}

function drawExactText(ctx, item, x, y, w, h, scale) {
  const text = cleanText(item.text);
  if (!text) return;
  const [r,g,b,a] = parseCssColor(item.color, [0,0,0,1]);
  ctx.save();
  ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
  const fontSize = Math.max(3, item.fontSizePx * scale);
  ctx.font = cssFont(item, fontSize);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const metrics = ctx.measureText(text);
  const natural = Math.max(1, metrics.width);
  const maxWidth = Math.max(1, w);
  const fit = Math.min(1, maxWidth / natural);
  ctx.translate(x, y + h / 2);
  ctx.scale(fit, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawItem(ctx, item, canvasWidth, canvasHeight) {
  const x = item.x * canvasWidth;
  const y = item.y * canvasHeight;
  const w = item.w * canvasWidth;
  const h = item.h * canvasHeight;
  const scale = canvasWidth / Math.max(1, item.displayWidth || canvasWidth);

  if (item.kind === 'replace') {
    // Intentional strict whiteout. It removes every old glyph/pixel in the selected area.
    const padX = Math.max(2, Math.min(8, w * 0.04));
    const padY = Math.max(3, Math.min(10, h * 0.25));
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.max(0, x - padX), Math.max(0, y - padY), Math.min(canvasWidth - x + padX, w + padX * 2), Math.min(canvasHeight - y + padY, h + padY * 2));
    ctx.restore();
    drawExactText(ctx, item, x, y, w, h, scale);
    return;
  }

  if (item.kind === 'white') {
    ctx.save(); ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h); ctx.restore(); return;
  }
  if (item.kind === 'highlight') {
    ctx.save(); ctx.fillStyle = 'rgba(255,227,92,.42)'; ctx.fillRect(x, y, w, h); ctx.restore(); return;
  }
  if (item.kind === 'rect') {
    ctx.save(); ctx.strokeStyle = item.borderColor || '#1769e0'; ctx.lineWidth = Math.max(1, 2 * scale); ctx.strokeRect(x, y, w, h); ctx.restore(); return;
  }
  if (item.kind === 'line') {
    ctx.save(); ctx.strokeStyle = item.background || '#1769e0'; ctx.lineWidth = Math.max(1, 2 * scale); ctx.beginPath(); ctx.moveTo(x, y + h/2); ctx.lineTo(x + w, y + h/2); ctx.stroke(); ctx.restore(); return;
  }
  if (item.kind === 'text') {
    drawExactText(ctx, item, x, y, w, h, scale);
  }
}

async function exportStrictPdf() {
  if (!originalBytes) return;
  snapshotCurrentPage();
  const button = document.querySelector('#download');
  const oldText = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Creo PDF…'; }
  try {
    const pdfjs = await PDFJS.getDocument({ data: originalBytes.slice(0) }).promise;
    const source = await PDFLIB.PDFDocument.load(originalBytes.slice(0), { ignoreEncryption: true });
    const output = await PDFLIB.PDFDocument.create();
    const total = source.getPageCount();

    for (let i = 0; i < total; i += 1) {
      const snapshot = pageSnapshots.get(i + 1);
      if (!snapshot || !snapshot.items.length) {
        const [page] = await output.copyPages(source, [i]);
        output.addPage(page);
        continue;
      }

      const srcPage = source.getPage(i);
      const W = srcPage.getWidth();
      const H = srcPage.getHeight();
      const page = await pdfjs.getPage(i + 1);
      const renderScale = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 2.4 : 2.8;
      const viewport = page.getViewport({ scale: renderScale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(viewport.width);
      c.height = Math.ceil(viewport.height);
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      for (const item of snapshot.items) drawItem(ctx, item, c.width, c.height);

      const pngBytes = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0));
      const image = await output.embedPng(pngBytes);
      const outPage = output.addPage([W, H]);
      outPage.drawImage(image, { x: 0, y: 0, width: W, height: H });
    }

    const bytes = await output.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    const base = originalName.replace(/\.pdf$/i, '') || 'documento';
    a.href = url;
    a.download = `${base}-modificato.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    console.error('Strict export failed', error);
    alert('Errore durante il salvataggio. Riprova ricaricando il PDF.');
  } finally {
    if (button) { button.disabled = false; button.textContent = oldText || 'Scarica PDF modificato'; }
  }
}

document.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.id !== 'pdfinput') return;
  const file = input.files?.[0];
  if (!file) return;
  originalName = file.name;
  pageSnapshots.clear();
  loadingPromise = file.arrayBuffer().then((buf) => { originalBytes = buf; return buf; });
}, true);

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target) return;
  if (['prev','next','rotate','deletepage','duplicate'].includes(target.id)) snapshotCurrentPage();
  if (target.id === 'download') {
    event.preventDefault();
    event.stopImmediatePropagation();
    Promise.resolve(loadingPromise).then(exportStrictPdf);
  }
}, true);

window.addEventListener('pdf-editor-rendered', () => {
  requestAnimationFrame(snapshotCurrentPage);
});
