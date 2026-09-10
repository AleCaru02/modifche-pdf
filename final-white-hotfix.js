// Safe replacement hotfix for iPhone/mobile.
// Keeps only the narrow fix needed for manual/OCR replacement areas.
// It does NOT patch PDF-lib globally and does NOT run a mutation loop.
(function installFinalWhiteHotfix(){
  if (window.__finalWhiteReplacementFix) return;
  window.__finalWhiteReplacementFix = true;

  function normalizeAmount(value){
    return String(value ?? '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g, ',');
  }

  function forcePreviewWhite(){
    document.querySelectorAll('.item.replace').forEach((el) => {
      el.style.background = '#ffffff';
      el.style.backgroundColor = '#ffffff';
      const holder = el.querySelector('.fitted-holder');
      if (holder) holder.style.background = '#ffffff';
      const text = el.querySelector('.fitted-text');
      if (text) {
        text.style.color = '#111111';
        text.style.background = 'transparent';
      }
    });
  }

  function patchApi(){
    const api = window.PDFEditorAPI;
    const canvas = document.querySelector('#canvas');
    if (!api?.replaceScreenArea || !canvas) {
      setTimeout(patchApi, 100);
      return;
    }
    if (api.__finalWhiteApiFix) return;

    const original = api.replaceScreenArea.bind(api);
    api.replaceScreenArea = function(rect, initialText = ''){
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) {
        return original(rect, normalizeAmount(initialText));
      }

      const bounds = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(1, bounds.width);
      const sy = canvas.height / Math.max(1, bounds.height);
      const L = rect.left * sx;
      const T = rect.top * sy;
      const R = (rect.left + rect.width) * sx;
      const B = (rect.top + rect.height) * sy;
      const native = ctx.getImageData.bind(ctx);

      // Only force the OUTSIDE background samples to white. Inside samples stay
      // untouched, so foreground/text detection remains correct.
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
        setTimeout(forcePreviewWhite, 0);
      }
    };
    api.__finalWhiteApiFix = true;
  }

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
    setTimeout(forcePreviewWhite, 0);
  }, true);

  window.addEventListener('pdf-editor-rendered', () => setTimeout(forcePreviewWhite, 0));
  patchApi();
})();