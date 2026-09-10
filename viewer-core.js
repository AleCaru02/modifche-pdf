import * as PDFJS from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const canvas = $('#canvas');
const sheet = $('#sheet');
const input = $('#pdfinput');
const openBtn = $('#open');
const download = $('#download');
const MAX_BYTES = 100 * 1024 * 1024;
let pdf = null;
let sourceBytes = null;
let current = 0;
let zoom = 1;
let rotation = 0;
let renderSerial = 0;

function toast(message){
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hide');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hide'), 3000);
}

function updateButtons(){
  const loaded = !!pdf;
  if (download) download.disabled = !loaded;
  if ($('#prev')) $('#prev').disabled = !loaded || current <= 0;
  if ($('#next')) $('#next').disabled = !loaded || current >= (pdf?.numPages || 1) - 1;
  for (const id of ['undo','redo','remove','duplicate','deletepage']) {
    const b = $(`#${id}`); if (b) b.disabled = true;
  }
}

async function render(){
  if (!pdf || !canvas || !sheet) return;
  const serial = ++renderSerial;
  const page = await pdf.getPage(current + 1);
  const viewport = page.getViewport({ scale: 1.45 * zoom, rotation: (page.rotate + rotation) % 360 });
  if (serial !== renderSerial) return;
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  sheet.style.width = `${viewport.width}px`;
  sheet.style.height = `${viewport.height}px`;
  const textLayer = $('#textLayer');
  const layer = $('#layer');
  if (textLayer) { textLayer.innerHTML=''; textLayer.style.width=`${viewport.width}px`; textLayer.style.height=`${viewport.height}px`; textLayer.style.pointerEvents='none'; }
  if (layer) { layer.innerHTML=''; layer.style.width=`${viewport.width}px`; layer.style.height=`${viewport.height}px`; layer.style.pointerEvents='none'; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if ($('#pageinfo')) $('#pageinfo').textContent = `${current + 1} / ${pdf.numPages}`;
  if ($('#zoominfo')) $('#zoominfo').textContent = `${Math.round(zoom * 100)}%`;
  updateButtons();
  window.dispatchEvent(new CustomEvent('pdf-editor-rendered'));
}

async function loadFile(file){
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('Scegli un file PDF.');
  if (file.size > MAX_BYTES) return toast('Il PDF supera il limite di 100 MB.');
  try {
    sourceBytes = await file.arrayBuffer();
    if (pdf) { try { await pdf.destroy(); } catch {} }
    pdf = await PDFJS.getDocument({ data: sourceBytes.slice(0) }).promise;
    current = 0; zoom = 1; rotation = 0;
    if ($('#filename')) $('#filename').textContent = file.name;
    $('#welcome')?.classList.add('hide');
    sheet.classList.remove('hide');
    $('#bar')?.classList.remove('hide');
    await render();
    updateButtons();
    window.dispatchEvent(new CustomEvent('pdf-editor-loaded'));
  } catch (err) {
    console.error(err);
    toast('PDF protetto, danneggiato o non leggibile.');
  }
}

input?.addEventListener('change', e => loadFile(e.target.files?.[0]), true);
openBtn?.addEventListener('click', () => input?.click());
$('#prev')?.addEventListener('click', async () => { if (current > 0) { current--; await render(); } });
$('#next')?.addEventListener('click', async () => { if (pdf && current < pdf.numPages - 1) { current++; await render(); } });
$('#minus')?.addEventListener('click', async () => { zoom = Math.max(.5, zoom - .1); await render(); });
$('#plus')?.addEventListener('click', async () => { zoom = Math.min(3, zoom + .1); await render(); });
$('#rotate')?.addEventListener('click', async () => { rotation = (rotation + 90) % 360; await render(); });
updateButtons();

window.PDFViewerCore = { get sourceBytes(){ return sourceBytes; }, render };
