// Mobile/export hotfix: force a white replacement background for manual/OCR areas
// without touching the original PDF canvas. This prevents black rectangles when
// the background sampler mistakes dark glyph pixels for the page background.
(function initMobileHotfix() {
  function install() {
    const api = window.PDFEditorAPI;
    const canvas = document.querySelector('#canvas');
    if (!api?.replaceScreenArea || !canvas) {
      setTimeout(install, 100);
      return;
    }
    if (api.__whiteBackgroundHotfix) return;

    const originalReplace = api.replaceScreenArea.bind(api);

    api.replaceScreenArea = function patchedReplaceScreenArea(rect, initialText = '') {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) return originalReplace(rect, initialText);

      const bounds = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(bounds.width, 1);
      const scaleY = canvas.height / Math.max(bounds.height, 1);
      const left = rect.left * scaleX;
      const top = rect.top * scaleY;
      const right = (rect.left + rect.width) * scaleX;
      const bottom = (rect.top + rect.height) * scaleY;
      const nativeGetImageData = ctx.getImageData.bind(ctx);

      // sampleTextColors reads pixels just outside the selected rectangle to find
      // the replacement background. On dense scanned documents those samples can
      // accidentally land on black characters/lines. Return pure white only for
      // those outside samples; keep inside samples real so foreground stays black.
      ctx.getImageData = function hotfixGetImageData(x, y, w, h, ...rest) {
        if (w === 1 && h === 1 && (x < left || x >= right || y < top || y >= bottom)) {
          const data = new Uint8ClampedArray([255, 255, 255, 255]);
          return { data, width: 1, height: 1, colorSpace: 'srgb' };
        }
        return nativeGetImageData(x, y, w, h, ...rest);
      };

      try {
        return originalReplace(rect, initialText);
      } finally {
        ctx.getImageData = nativeGetImageData;
      }
    };

    api.__whiteBackgroundHotfix = true;
  }

  install();
})();
