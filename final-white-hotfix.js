import * as PDFLIB from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

// Final replacement hotfix.
// Manual/OCR text replacement on this editor is always intended to erase old text
// on a white document area and write new dark text. Some scanned PDFs caused the
// background sampler to pick a black glyph as the replacement background.

(function installFinalWhiteHotfix(){
  if (window.__finalWhiteReplacementFix) return;
  window.__finalWhiteReplacementFix = true;

  function normalizeAmount(value){
    return String(value ?? '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g, ',');
  }

  function forceReplacementDom(){
    document.querySelectorAll('.item.replace').forEach((el) => {
      el.style.setProperty('background', '#ffffff', 'important');
      el.style.setProperty('background-color', '#ffffff', 'important');
      el.querySelectorAll('.fitted-holder').forEach((holder) => {
        holder.style.setProperty('background', '#ffffff', 'important');
      });
      el.querySelectorAll('.fitted-text').forEach((text) => {
        text.style.setProperty('color', '#111111', 'important');
        text.style.setProperty('background', 'transparent', 'important');
      });
    });
  }

  const observer = new MutationObserver(forceReplacementDom);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style','class'] });
  window.addEventListener('pdf-editor-rendered', () => requestAnimationFrame(forceReplacementDom));
  document.addEventListener('DOMContentLoaded', forceReplacementDom);

  // Force a white background at creation time for manual/OCR areas.
  function patchApi(){
    const api = window.PDFEditorAPI;
    const canvas = document.querySelector('#canvas');
    if (!api?.replaceScreenArea || !canvas) {
      setTimeout(patchApi, 80);
      return;
    }
    if (api.__finalWhiteApiFix) return;

    const original = api.replaceScreenArea.bind(api);
    api.replaceScreenArea = function(rect, initialText = ''){
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return original(rect, normalizeAmount(initialText));
      const native = ctx.getImageData.bind(ctx);
      const bounds = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(1, bounds.width);
      const sy = canvas.height / Math.max(1, bounds.height);
      const L = rect.left * sx;
      const T = rect.top * sy;
      const R = (rect.left + rect.width) * sx;
      const B = (rect.top + rect.height) * sy;

      // sampleTextColors asks the canvas for 1x1 pixels outside the selection
      // to infer its background. Make those samples pure white. Keep inside
      // samples real so the foreground detector still sees dark glyphs.
      ctx.getImageData = function(x, y, w, h, ...rest){
        if (w === 1 && h === 1 && (x < L || x >= R || y < T || y >= B)) {
          return { data: new Uint8ClampedArray([255,255,255,255]), width: 1, height: 1, colorSpace: 'srgb' };
        }
        return native(x, y, w, h, ...rest);
      };
      try {
        return original(rect, normalizeAmount(initialText));
      } finally {
        ctx.getImageData = native;
        requestAnimationFrame(forceReplacementDom);
      }
    };
    api.__finalWhiteApiFix = true;
  }
  patchApi();

  // Last-moment text cleanup before Apply.
  document.addEventListener('click', (event) => {
    const save = event.target instanceof Element ? event.target.closest('.text-editor-modal .save') : null;
    if (!save) return;
    const input = document.querySelector('.text-editor-modal .editor-input');
    if (input) {
      const clean = normalizeAmount(input.value);
      if (clean !== input.value) {
        input.value = clean;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    requestAnimationFrame(forceReplacementDom);
  }, true);

  // Export guard: if a replacement background was accidentally stored as black,
  // the editor's PDF export reaches PDFPage.drawRectangle with a dark fill.
  // Coerce dark filled eraser rectangles to white; border-only rectangles and
  // highlights are untouched.
  const proto = PDFLIB.PDFPage?.prototype;
  if (proto && !proto.__finalWhiteDrawPatch) {
    const nativeDrawRectangle = proto.drawRectangle;
    proto.drawRectangle = function(options = {}){
      const c = options.color;
      const hasFill = c && typeof c === 'object';
      const darkRgb = hasFill && c.type === 'RGB' && Number(c.red) < 0.2 && Number(c.green) < 0.2 && Number(c.blue) < 0.2;
      const borderOnly = options.borderColor && !options.color;
      if (darkRgb && !borderOnly) {
        options = { ...options, color: PDFLIB.rgb(1,1,1) };
      }
      return nativeDrawRectangle.call(this, options);
    };
    proto.__finalWhiteDrawPatch = true;
  }
})();