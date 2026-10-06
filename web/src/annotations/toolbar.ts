import {installIcons} from '../icons';
export const ANNOTATION_COLORS=['#ff6b5e','#ffc857','#5fb4ff','#f4f2ea'];
export function createAnnotationToolbar(supportsSurface:boolean):HTMLElement {
  const panel=document.createElement('section');panel.id='surface-toolbar';panel.hidden=true;
  panel.setAttribute('aria-label','标记工具');panel.setAttribute('data-label-obstacle','');
  panel.innerHTML=`<div class="surface-modes" role="group" aria-label="标注工具">
  <button data-surface-mode="select" type="button"><i data-lucide="mouse-pointer-2" aria-hidden="true"></i>选择</button>
  ${supportsSurface?'<button data-surface-mode="point" type="button"><i data-lucide="crosshair" aria-hidden="true"></i>点</button><button data-surface-mode="line" type="button"><i data-lucide="spline" aria-hidden="true"></i>线</button>':''}
  <button data-surface-mode="screen" id="surface-brush" type="button"><i data-lucide="brush" aria-hidden="true"></i>画笔</button><button id="surface-done" class="surface-primary" type="button">完成</button></div>
  <div class="surface-actions"><div class="surface-colors" role="group" aria-label="标记颜色">${ANNOTATION_COLORS.map((color,i)=>`<button type="button" data-surface-color="${color}" aria-label="${['珊瑚红','琥珀黄','标记蓝','柔白'][i]}" style="--ink:${color}"><i></i></button>`).join('')}</div><span class="surface-action-spacer"></span><button id="surface-undo" type="button" aria-label="撤销标记"><i data-lucide="undo-2" aria-hidden="true"></i></button><button id="surface-redo" type="button" aria-label="重做标记"><i data-lucide="redo-2" aria-hidden="true"></i></button></div>
  <div class="surface-selection" hidden><input id="surface-name" maxlength="120" aria-label="标记名称" placeholder="标记名称" autocomplete="off"/><button id="surface-close" type="button">闭合</button><button id="surface-end" type="button">完成线</button><button id="surface-delete" type="button" aria-label="删除选中标记"><i data-lucide="trash-2" aria-hidden="true"></i></button></div><p id="surface-hint" role="status"></p>`;
  installIcons(panel);return panel;
}
