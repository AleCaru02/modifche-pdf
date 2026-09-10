(function(){
  function rectOverlap(a,b){
    const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));
    const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const inter=x*y;
    const minArea=Math.max(1,Math.min(a.width*a.height,b.width*b.height));
    return inter/minArea;
  }

  function install(){
    const api=window.PDFEditorAPI;
    const sheet=document.querySelector('#sheet');
    if(!api?.replaceScreenArea||!sheet){setTimeout(install,100);return;}
    if(api.__dedupeHotfix)return;

    const original=api.replaceScreenArea.bind(api);
    api.replaceScreenArea=function(rect,initialText=''){
      const sheetRect=sheet.getBoundingClientRect();
      const target={
        left:sheetRect.left+rect.left,
        top:sheetRect.top+rect.top,
        right:sheetRect.left+rect.left+rect.width,
        bottom:sheetRect.top+rect.top+rect.height,
        width:rect.width,
        height:rect.height
      };

      const existing=[...sheet.querySelectorAll('.item.replace')]
        .map(el=>({el,r:el.getBoundingClientRect()}))
        .filter(({r})=>rectOverlap(target,r)>.55)
        .sort((a,b)=>rectOverlap(target,b.r)-rectOverlap(target,a.r))[0];

      if(existing){
        existing.el.click();
        requestAnimationFrame(()=>{
          const input=document.querySelector('.text-editor-modal .editor-input');
          if(input&&initialText){
            input.value=initialText.replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g,',');
            input.dispatchEvent(new Event('input',{bubbles:true}));
            input.select();
          }
        });
        return true;
      }

      const normalized=String(initialText||'').replace(/(?<=\d)\.(?=\d{2}(?:\D|$))/g,',');
      return original(rect,normalized);
    };

    const observer=new MutationObserver(()=>{
      const items=[...sheet.querySelectorAll('.item.replace')];
      for(let i=0;i<items.length;i++){
        const a=items[i].getBoundingClientRect();
        for(let j=i+1;j<items.length;j++){
          const b=items[j].getBoundingClientRect();
          if(rectOverlap(a,b)>.88){
            items[j].style.display='none';
            items[j].dataset.duplicateVisual='1';
          }
        }
      }
    });
    observer.observe(sheet,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});

    document.addEventListener('input',e=>{
      const input=e.target;
      if(!(input instanceof HTMLTextAreaElement)||!input.classList.contains('editor-input'))return;
      const v=input.value;
      if(/^\s*[-+]?\d+[.]\d{2}\s*$/.test(v)){
        const pos=input.selectionStart;
        input.value=v.replace('.',',');
        try{input.setSelectionRange(pos,pos);}catch{}
      }
    },true);

    api.__dedupeHotfix=true;
  }
  install();
})();