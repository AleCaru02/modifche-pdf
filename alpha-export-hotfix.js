// iOS PDFKit hotfix: text replacement PNGs must be opaque.
// Transparent text canvases can be rendered as solid black rectangles by iOS PDF preview.
(function(){
  if (window.__alphaExportHotfix) return;
  window.__alphaExportHotfix = true;

  const nativeToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality){
    const mime = String(type || 'image/png').toLowerCase();
    const isPdfPageCanvas = this.id === 'canvas';
    if (mime.includes('png') && !isPdfPageCanvas && this.width > 0 && this.height > 0) {
      try {
        const opaque = document.createElement('canvas');
        opaque.width = this.width;
        opaque.height = this.height;
        const ctx = opaque.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, opaque.width, opaque.height);
        ctx.drawImage(this, 0, 0);
        return nativeToDataURL.call(opaque, type || 'image/png', quality);
      } catch (e) {
        console.warn('Opaque PNG fallback failed', e);
      }
    }
    return nativeToDataURL.call(this, type, quality);
  };

  // Normalize Italian decimal comma at the last possible moment before the editor saves.
  document.addEventListener('click', function(event){
    const save = event.target instanceof Element ? event.target.closest('.text-editor-modal .save') : null;
    if (!save) return;
    const input = document.querySelector('.text-editor-modal .editor-input');
    if (!input) return;
    const value = String(input.value || '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g, ',');
    if (value !== input.value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);
})();
