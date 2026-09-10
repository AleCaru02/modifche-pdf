const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showFixToast(message, duration = 4500) {
  let toast = document.querySelector('#fix-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fix-toast';
    Object.assign(toast.style, {
      position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
      zIndex: '9999', background: '#17233b', color: '#fff', padding: '10px 14px',
      borderRadius: '9px', boxShadow: '0 8px 24px #0003', maxWidth: 'min(700px,calc(100vw - 24px))',
      textAlign: 'center', font: '14px system-ui,sans-serif'
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showFixToast.timer);
  showFixToast.timer = setTimeout(() => { toast.hidden = true; }, duration);
}

function pointer(target, type, clientX, clientY, buttons = 1) {
  const EventCtor = window.PointerEvent || window.MouseEvent;
  target.dispatchEvent(new EventCtor(type, {
    bubbles: true, cancelable: true, pointerId: 77, pointerType: 'mouse',
    isPrimary: true, buttons, clientX, clientY
  }));
}

async function replaceAreaWithExistingTools(rect, initialText = '') {
  const canvas = document.querySelector('#canvas');
  if (!canvas || !canvas.width) return showFixToast('Carica prima un PDF.');
  const canvasRect = canvas.getBoundingClientRect();
  const x1 = canvasRect.left + rect.left;
  const y1 = canvasRect.top + rect.top;
  const x2 = x1 + rect.width;
  const y2 = y1 + rect.height;

  const white = document.querySelector('[data-tool="white"]');
  const text = document.querySelector('[data-tool="text"]');
  if (!white || !text) return showFixToast('Gli strumenti dell’editor non sono disponibili. Ricarica la pagina.');

  white.click();
  await wait(20);
  pointer(canvas, 'pointerdown', x1, y1, 1);
  pointer(window, 'pointermove', x2, y2, 1);
  pointer(window, 'pointerup', x2, y2, 0);
  await wait(120);

  text.click();
  await wait(20);
  pointer(canvas, 'pointerdown', x1 + 2, y1 + 2, 1);
  pointer(window, 'pointerup', x1 + 2, y1 + 2, 0);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(50);
    const items = [...document.querySelectorAll('.item.text[contenteditable="true"], .item.text')];
    const editor = items.at(-1);
    if (!editor) continue;
    editor.focus();
    if (initialText) {
      editor.textContent = initialText;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: initialText }));
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.addRange(range);
    showFixToast('Scrivi il nuovo testo, poi clicca fuori e scarica il PDF.');
    return;
  }
  showFixToast('Area coperta. Premi “Aggiungi testo” e clicca nel riquadro per scrivere.');
}

function createOverlay(sheet, className, zIndex) {
  const layer = document.createElement('div');
  layer.className = className;
  Object.assign(layer.style, {
    position: 'absolute', inset: '0', zIndex: String(zIndex), pointerEvents: 'none'
  });
  sheet.appendChild(layer);
  return layer;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((script) => script.src === src);
    if (existing) {
      if (window.Tesseract) return resolve();
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
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
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Tesseract non caricato');
}

function makeOcrCanvas(source) {
  const maxSide = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 1600 : 2200;
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
  window.__pdfFixInitialized = true;

  const sheet = document.querySelector('#sheet');
  const tools = document.querySelector('#tools');
  const canvas = document.querySelector('#canvas');
  if (!sheet || !tools || !canvas) {
    window.__pdfFixInitialized = false;
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    #textLayer,.text-layer{z-index:30!important}
    #layer,.layer{z-index:29!important}
    .text-hit{pointer-events:auto!important;cursor:text!important}
    .pdf-fix-hit{position:absolute;padding:0;margin:0;border:1px dashed #1769e0;background:#1769e014;color:transparent;cursor:text;border-radius:2px;touch-action:manipulation}
    .pdf-fix-hit:hover{background:#1769e02b;border-style:solid}
    .pdf-fix-selecting{cursor:crosshair;background:#1769e008;touch-action:none}
    .pdf-fix-box{position:absolute;border:2px dashed #1769e0;background:#1769e018;pointer-events:none}
  `;
  document.head.appendChild(style);

  const selectionLayer = createOverlay(sheet, 'pdf-fix-selection-layer', 60);
  const ocrLayer = createOverlay(sheet, 'pdf-fix-ocr-layer', 55);

  const manualButton = document.createElement('button');
  manualButton.type = 'button';
  manualButton.className = 'tool';
  manualButton.innerHTML = '▣ Modifica area';
  manualButton.title = 'Trascina un riquadro sopra qualsiasi scritta, anche se il PDF è una scansione';
  tools.insertBefore(manualButton, tools.children[1] || null);

  const ocrButton = document.createElement('button');
  ocrButton.type = 'button';
  ocrButton.textContent = 'Rileva testo con OCR';
  Object.assign(ocrButton.style, { width: 'calc(100% - 16px)', margin: '8px', color: '#0d58c3' });
  tools.parentElement?.insertBefore(ocrButton, tools.nextSibling);

  let selecting = false;
  function setSelecting(active) {
    selecting = active;
    selectionLayer.style.pointerEvents = active ? 'auto' : 'none';
    selectionLayer.classList.toggle('pdf-fix-selecting', active);
    manualButton.classList.toggle('on', active);
    if (active) showFixToast('Trascina un riquadro preciso sopra la scritta da sostituire.');
  }

  manualButton.addEventListener('click', () => setSelecting(!selecting));

  selectionLayer.addEventListener('pointerdown', (event) => {
    if (!selecting || !canvas.width) return;
    event.preventDefault();
    const layerRect = selectionLayer.getBoundingClientRect();
    const startX = Math.max(0, Math.min(layerRect.width, event.clientX - layerRect.left));
    const startY = Math.max(0, Math.min(layerRect.height, event.clientY - layerRect.top));
    const box = document.createElement('div');
    box.className = 'pdf-fix-box';
    selectionLayer.appendChild(box);

    const move = (next) => {
      const x = Math.max(0, Math.min(layerRect.width, next.clientX - layerRect.left));
      const y = Math.max(0, Math.min(layerRect.height, next.clientY - layerRect.top));
      Object.assign(box.style, {
        left: `${Math.min(startX, x)}px`, top: `${Math.min(startY, y)}px`,
        width: `${Math.abs(x - startX)}px`, height: `${Math.abs(y - startY)}px`
      });
    };
    const up = async (next) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const x = Math.max(0, Math.min(layerRect.width, next.clientX - layerRect.left));
      const y = Math.max(0, Math.min(layerRect.height, next.clientY - layerRect.top));
      const rect = {
        left: Math.min(startX, x), top: Math.min(startY, y),
        width: Math.max(4, Math.abs(x - startX)), height: Math.max(4, Math.abs(y - startY))
      };
      box.remove();
      setSelecting(false);
      await replaceAreaWithExistingTools(rect);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up, { passive: false });
  }, { passive: false });

  let worker = null;
  let running = false;

  async function createOcrWorker(Tesseract) {
    const options = {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: (message) => {
        if (message.status === 'recognizing text') {
          ocrButton.textContent = `OCR ${Math.round((message.progress || 0) * 100)}%`;
        }
      }
    };
    return Tesseract.createWorker(['ita', 'eng'], 1, options);
  }

  async function runOcr() {
    if (running) return;
    if (!canvas.width) return showFixToast('Carica prima un PDF.');
    running = true;
    ocrButton.disabled = true;
    ocrLayer.innerHTML = '';
    showFixToast('OCR in avvio. Su iPhone la prima analisi può richiedere 10–30 secondi.', 10000);
    try {
      const Tesseract = await loadTesseract();
      if (!worker) worker = await createOcrWorker(Tesseract);

      const prepared = makeOcrCanvas(canvas);
      const result = await worker.recognize(prepared.canvas);
      const words = (result.data.words || []).filter((word) => word.text?.trim() && (word.confidence ?? 100) >= 25);
      const scaleX = canvas.getBoundingClientRect().width / canvas.width / prepared.scale;
      const scaleY = canvas.getBoundingClientRect().height / canvas.height / prepared.scale;

      for (const word of words) {
        const rect = {
          left: word.bbox.x0 * scaleX, top: word.bbox.y0 * scaleY,
          width: Math.max(5, (word.bbox.x1 - word.bbox.x0) * scaleX),
          height: Math.max(8, (word.bbox.y1 - word.bbox.y0) * scaleY)
        };
        const hit = document.createElement('button');
        hit.type = 'button';
        hit.className = 'pdf-fix-hit';
        hit.title = `Modifica: ${word.text}`;
        hit.setAttribute('aria-label', `Modifica ${word.text}`);
        Object.assign(hit.style, {
          left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`
        });
        hit.addEventListener('click', async (event) => {
          event.preventDefault();
          event.stopPropagation();
          ocrLayer.style.pointerEvents = 'none';
          await replaceAreaWithExistingTools(rect, word.text);
          ocrLayer.style.pointerEvents = 'auto';
        });
        ocrLayer.appendChild(hit);
      }
      ocrLayer.style.pointerEvents = 'auto';
      showFixToast(words.length ? `OCR completato: ${words.length} parole cliccabili.` : 'OCR non ha trovato parole. Usa “Modifica area”.', 6000);
    } catch (error) {
      console.error('OCR error', error);
      if (worker) {
        try { await worker.terminate(); } catch {}
        worker = null;
      }
      showFixToast('OCR non disponibile su questa rete/browser. Usa “Modifica area” oppure ricarica e riprova.', 7000);
    } finally {
      running = false;
      ocrButton.disabled = false;
      ocrButton.textContent = 'Rileva testo con OCR';
    }
  }

  ocrButton.addEventListener('click', runOcr);

  const observer = new MutationObserver(() => {
    if (!sheet.classList.contains('hide') && canvas.width) {
      const nativeHits = document.querySelectorAll('.text-hit').length;
      if (!nativeHits && !running && !ocrLayer.children.length) {
        setTimeout(runOcr, 400);
      }
    }
  });
  observer.observe(sheet, { attributes: true, childList: true, subtree: true });

  const clearOcr = () => { ocrLayer.innerHTML = ''; ocrLayer.style.pointerEvents = 'none'; };
  document.querySelector('#prev')?.addEventListener('click', clearOcr);
  document.querySelector('#next')?.addEventListener('click', clearOcr);
  document.querySelector('#rotate')?.addEventListener('click', clearOcr);
  document.querySelector('#minus')?.addEventListener('click', clearOcr);
  document.querySelector('#plus')?.addEventListener('click', clearOcr);
  document.querySelector('#pdfinput')?.addEventListener('change', clearOcr);

  setTimeout(() => {
    if (!sheet.classList.contains('hide') && canvas.width && !document.querySelector('.text-hit')) runOcr();
  }, 1200);
  window.addEventListener('beforeunload', () => worker?.terminate?.());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(initFix, 100));
else setTimeout(initFix, 100);
