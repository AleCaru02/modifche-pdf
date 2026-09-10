const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isMobile = () => window.matchMedia?.('(max-width: 760px), (pointer: coarse)').matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function showFixToast(message, duration = 4500) {
  let toast = document.querySelector('#fix-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fix-toast';
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)', zIndex: '9999',
      background: '#17233b', color: '#fff', padding: '10px 14px', borderRadius: '9px',
      boxShadow: '0 8px 24px #0003', maxWidth: 'min(700px,calc(100vw - 24px))', textAlign: 'center',
      font: '14px system-ui,sans-serif'
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showFixToast.timer);
  showFixToast.timer = setTimeout(() => { toast.hidden = true; }, duration);
}

function createOverlay(sheet, className, zIndex) {
  const element = document.createElement('div');
  element.className = className;
  Object.assign(element.style, { position: 'absolute', inset: '0', zIndex: String(zIndex), pointerEvents: 'none' });
  sheet.appendChild(element);
  return element;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function loadTesseract() {
  if (window.Tesseract?.createWorker) return window.Tesseract;
  const sources = [
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
  ];
  let lastError;
  for (const src of sources) {
    try {
      await loadScript(src);
      if (window.Tesseract?.createWorker) return window.Tesseract;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Tesseract non caricato');
}

function makeOcrCanvas(source) {
  const maxSide = isMobile() ? 1400 : 2200;
  const longest = Math.max(source.width, source.height);
  if (!longest || longest <= maxSide) return { canvas: source, scale: 1 };
  const scale = maxSide / longest;
  const reduced = document.createElement('canvas');
  reduced.width = Math.max(1, Math.round(source.width * scale));
  reduced.height = Math.max(1, Math.round(source.height * scale));
  reduced.getContext('2d', { alpha: false }).drawImage(source, 0, 0, reduced.width, reduced.height);
  return { canvas: reduced, scale };
}

async function initFix() {
  if (window.__pdfFixInitialized) return;
  const sheet = document.querySelector('#sheet');
  const tools = document.querySelector('#tools');
  const canvas = document.querySelector('#canvas');
  if (!sheet || !tools || !canvas) return;
  window.__pdfFixInitialized = true;

  const style = document.createElement('style');
  style.textContent = `
    .pdf-area-layer{touch-action:none}
    .pdf-area-layer.active{pointer-events:auto!important;cursor:crosshair;background:#1769e008}
    .pdf-area-box{position:absolute;border:2px solid #1769e0;background:#1769e01a;border-radius:3px;pointer-events:none}
    .pdf-ocr-hit{position:absolute;padding:0;margin:0;border:1px dashed #1769e0;background:#1769e00d;color:transparent;border-radius:2px;touch-action:manipulation}
    .pdf-ocr-hit:active,.pdf-ocr-hit:focus{background:#1769e028;border-style:solid;outline:none}
    .pdf-mobile-primary{background:#e8f1ff!important;color:#0d58c3!important;border:1px solid #b9d5fb!important;font-weight:800!important}
    .editor-size-row{margin:10px 0}.editor-size-row label{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#35435c;font-size:13px}.editor-size{width:90px;border:1px solid #aebdd1;border-radius:8px;padding:8px;background:#fff;font:inherit}
    @media(max-width:760px){
      .text-hit{border-color:transparent!important;background:transparent!important}
      .text-hit:focus,.text-hit:active{border-color:#2682ff!important;background:#2682ff18!important}
      .pdf-ocr-hit{border-color:#1769e070;background:#1769e008}
    }
  `;
  document.head.appendChild(style);

  const selectionLayer = createOverlay(sheet, 'pdf-area-layer', 70);
  const ocrLayer = createOverlay(sheet, 'pdf-ocr-layer', 65);

  const areaButton = document.createElement('button');
  areaButton.type = 'button';
  areaButton.className = 'tool pdf-mobile-primary';
  areaButton.textContent = '▣ Modifica area';
  areaButton.title = 'Seleziona il testo o numero da sostituire';
  tools.insertBefore(areaButton, tools.children[1] || null);

  const ocrButton = document.createElement('button');
  ocrButton.type = 'button';
  ocrButton.textContent = 'Rileva testo con OCR';
  Object.assign(ocrButton.style, { width: 'calc(100% - 16px)', margin: '8px', color: '#0d58c3' });
  tools.parentElement?.insertBefore(ocrButton, tools.nextSibling);

  if (isMobile()) {
    const tip = document.querySelector('#tip, .tip');
    if (tip) tip.innerHTML = '<b>Da telefono:</b> usa “Modifica area”, trascina sul numero o testo e scrivi il nuovo valore. OCR parte solo se lo premi.';
  }

  let selecting = false;
  function setSelecting(active) {
    selecting = active;
    selectionLayer.classList.toggle('active', active);
    areaButton.classList.toggle('on', active);
    if (active) {
      ocrLayer.style.pointerEvents = 'none';
      showFixToast('Trascina un riquadro leggermente più grande del testo da sostituire.');
    }
  }

  areaButton.addEventListener('click', () => setSelecting(!selecting));

  selectionLayer.addEventListener('pointerdown', (event) => {
    if (!selecting || !canvas.width) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = selectionLayer.getBoundingClientRect();
    const startX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const startY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const box = document.createElement('div');
    box.className = 'pdf-area-box';
    selectionLayer.appendChild(box);

    const move = (next) => {
      next.preventDefault?.();
      const x = Math.max(0, Math.min(bounds.width, next.clientX - bounds.left));
      const y = Math.max(0, Math.min(bounds.height, next.clientY - bounds.top));
      Object.assign(box.style, {
        left: `${Math.min(startX, x)}px`, top: `${Math.min(startY, y)}px`,
        width: `${Math.abs(x - startX)}px`, height: `${Math.abs(y - startY)}px`
      });
    };

    const up = (next) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const x = Math.max(0, Math.min(bounds.width, next.clientX - bounds.left));
      const y = Math.max(0, Math.min(bounds.height, next.clientY - bounds.top));
      const rect = {
        left: Math.min(startX, x), top: Math.min(startY, y),
        width: Math.max(8, Math.abs(x - startX)), height: Math.max(8, Math.abs(y - startY))
      };
      box.remove();
      setSelecting(false);
      const ok = window.PDFEditorAPI?.replaceScreenArea?.(rect, '');
      if (!ok) showFixToast('Editor non pronto. Ricarica la pagina e riprova.');
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { passive: false });
  }, { passive: false });

  let worker = null;
  let running = false;
  async function runOcr() {
    if (running) return;
    if (!canvas.width) return showFixToast('Carica prima un PDF.');
    running = true;
    ocrButton.disabled = true;
    ocrLayer.innerHTML = '';
    ocrLayer.style.pointerEvents = 'none';
    showFixToast('OCR in analisi. Su iPhone può richiedere qualche secondo.', 9000);
    try {
      const Tesseract = await loadTesseract();
      worker ||= await Tesseract.createWorker(['ita', 'eng'], 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
        logger: (message) => {
          if (message.status === 'recognizing text') ocrButton.textContent = `OCR ${Math.round((message.progress || 0) * 100)}%`;
        }
      });
      const prepared = makeOcrCanvas(canvas);
      const result = await worker.recognize(prepared.canvas);
      const words = (result.data.words || []).filter((word) => word.text?.trim() && (word.confidence ?? 100) >= 45);
      const scaleX = canvas.getBoundingClientRect().width / canvas.width / prepared.scale;
      const scaleY = canvas.getBoundingClientRect().height / canvas.height / prepared.scale;
      for (const word of words) {
        const rect = {
          left: word.bbox.x0 * scaleX, top: word.bbox.y0 * scaleY,
          width: Math.max(7, (word.bbox.x1 - word.bbox.x0) * scaleX),
          height: Math.max(9, (word.bbox.y1 - word.bbox.y0) * scaleY)
        };
        const hit = document.createElement('button');
        hit.type = 'button';
        hit.className = 'pdf-ocr-hit';
        hit.setAttribute('aria-label', `Modifica ${word.text}`);
        Object.assign(hit.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        hit.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          ocrLayer.style.pointerEvents = 'none';
          window.PDFEditorAPI?.replaceScreenArea?.(rect, word.text);
        });
        ocrLayer.appendChild(hit);
      }
      ocrLayer.style.pointerEvents = words.length ? 'auto' : 'none';
      showFixToast(words.length ? `OCR pronto: tocca una parola da modificare. Per maggiore precisione usa “Modifica area”.` : 'OCR non ha trovato testo. Usa “Modifica area”.', 6500);
    } catch (error) {
      console.error('OCR error', error);
      try { await worker?.terminate?.(); } catch {}
      worker = null;
      showFixToast('OCR non disponibile. “Modifica area” continua a funzionare.', 6000);
    } finally {
      running = false;
      ocrButton.disabled = false;
      ocrButton.textContent = 'Rileva testo con OCR';
    }
  }

  ocrButton.addEventListener('click', runOcr);

  const clearOcr = () => {
    ocrLayer.innerHTML = '';
    ocrLayer.style.pointerEvents = 'none';
  };
  ['#prev','#next','#rotate','#minus','#plus','#pdfinput'].forEach((selector) => document.querySelector(selector)?.addEventListener('click', clearOcr));
  window.addEventListener('pdf-editor-rendered', () => {
    if (!running) clearOcr();
  });
  window.addEventListener('beforeunload', () => worker?.terminate?.());

  if (isMobile()) showFixToast('Modalità telefono pronta: usa “Modifica area”.', 4500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(initFix, 120));
else setTimeout(initFix, 120);