import * as THREE from 'three';
import { packGroups } from './component-layout';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { PublicScene, Vec3 } from './api';
import { MeshViewer } from './viewer';
import { ComponentRegistry, componentGroups, entityUpdate, effectiveVisibility, sceneEntities, type ComponentCapabilities, type ComponentRuntime, type Presentation, type SceneEntity } from './scene-components';
import { textContent, jsonContent, pluginContent, htmlContent, imageContent, type ContentFactory } from './component-content';
import {installIcons} from './icons';
import {compactLabel} from './compact-label';
import './components.css';

interface Context { viewer: MeshViewer; host: ComponentViewer; scene: PublicScene }
interface Entry { spec: SceneEntity; runtime: ComponentRuntime; capabilities: ComponentCapabilities }
interface TreeRow { button: HTMLButtonElement; edit: HTMLButtonElement; editor: HTMLFormElement; input: HTMLTextAreaElement; label: string; opacity: HTMLInputElement; visibility: HTMLButtonElement; color?: HTMLButtonElement; palette?: HTMLElement; choices?: HTMLButtonElement[] }
const geometryPalette = ['#8fa9c9', '#8ca49c', '#b2a4ad', '#bf8078', '#8f8bb2', '#b7b3aa'];
const sceneInput = {spatial: 'scene', focus: 'scene', fullscreen: 'scene'} as const;
const contentInput = {spatial: 'scene', focus: 'content', fullscreen: 'content'} as const;
export function builtInComponents(): ComponentRegistry<Context> {
  const registry = new ComponentRegistry<Context>();
  for (const type of ['mesh', 'points']) registry.register({type,
    capabilities: {presentations: ['spatial', 'focus', 'fullscreen'], movable: false, resizable: false, input: sceneInput, geometry: type as 'mesh' | 'points'},
    create(spec, {viewer}) {
      const index = spec.source.index;
      return {
        get bounds() { return viewer.meshBounds(index); },
        setPosition: p => viewer.setMeshPosition(index, p),
        setVisible: v => viewer.setVisible(index, v),
        setOpacity: v => viewer.setMeshOpacity(index, v),
        setLabel: label => viewer.setLabelAt(index, label),
        setPresentation: () => {}, select: () => viewer.select(index),
        focus: () => viewer.focusLabelGroup([index], false), dispose: () => {},
      };
    },
  });
  for (const [type, content] of Object.entries({text: textContent, json: jsonContent, html: htmlContent, image: imageContent})) {
    registry.register({type, capabilities: {presentations: ['spatial', 'focus'], movable: false, resizable: false, input: contentInput},
      create: (spec, context) => new SurfaceRuntime(spec, context, content)});
  }
  return registry;
}

export class ComponentViewer {
  readonly layer = new THREE.Scene();
  private readonly compositor = document.createElement('div');
  private readonly planes = new Map<number, {scene: THREE.Scene; renderer: CSS3DRenderer}>();
  private readonly bands: HTMLCanvasElement[] = [];
  private readonly entries: Entry[] = [];
  private readonly tree = document.createElement('aside');
  private readonly treeViews = new Map<'elements' | 'info', {button: HTMLButtonElement; content: HTMLElement}>();
  private treeResize?: ResizeObserver;
  private readonly rows = new Map<string, TreeRow>();
  private openColorPicker?: {trigger: HTMLButtonElement; palette: HTMLElement; item: HTMLElement};
  private activeRename?: {entry: Entry; trigger: HTMLButtonElement; editor: HTMLFormElement; input: HTMLTextAreaElement; item: HTMLElement};
  private nameLayoutQueued = false;
  private readonly nameMeasure = document.createElement('canvas').getContext('2d');
  private readonly toggle = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly expandedContent = document.createElement('div');
  private readonly dialogTitle = document.createElement('h2');
  private readonly groupLabels = document.createElement('div');
  private readonly captions: {element: HTMLElement; entries: Entry[]}[] = [];
  private readonly viewport = matchMedia('(min-width: 1100px) and (min-height: 600px)');
  private expanded?: Entry;
  private returnFocus?: HTMLElement;
  private selected?: Entry;
  private opened = this.viewport.matches;
  private syncing = false;
  onSelect?: (entity: SceneEntity) => void;
  onChange?: () => void;
  get selectedEntity(): SceneEntity | undefined { return this.selected?.spec; }
  get selectedGeometry(): 'mesh' | 'points' | undefined { return this.selected?.capabilities.geometry; }
  openInfo(): void { this.showTreeView('info'); this.setOpen(true); }
  get entities(): readonly SceneEntity[] { return this.entries.map(e => e.spec); }
  private setLabel(entry: Entry, value: string): void {
    const spec = entry.spec;
    const fallback = spec.source.kind === 'mesh'
      ? this.scene.meshes[spec.source.index]?.name
      : this.scene.attachments?.[spec.source.index]?.label;
    const label = value.replace(/\s+/g, ' ').trim() || fallback || spec.label;
    if (label === spec.label) return;
    spec.label = label;
    entry.runtime.setLabel(label);
    if (this.expanded === entry) this.dialogTitle.textContent = label;
    this.sync(); this.onChange?.();
  }
  private applyStyle(entry: Entry, visible: boolean, opacity: number): void {
    this.syncing = true;
    entry.spec.visible = visible; entry.spec.opacity = opacity;
    entry.runtime.setOpacity(opacity); entry.runtime.setVisible(visible && opacity > 0);
    this.syncing = false; this.sync(); this.onChange?.();
  }

  constructor(readonly root: HTMLElement, private readonly viewer: MeshViewer, readonly scene: PublicScene, registry = builtInComponents()) {
    this.compositor.className = 'component-compositor'; root.append(this.compositor);
    this.groupLabels.className = 'component-group-labels'; root.append(this.groupLabels);
    const customTypes = new Set<string>();
    for (const spec of sceneEntities(scene)) {
      if (spec.renderer && !customTypes.has(spec.component)) {
        registry.register({type:spec.component,capabilities:{...spec.renderer.capabilities,movable:false,resizable:false,input:contentInput},create:(spec,context)=>new SurfaceRuntime(spec,context,pluginContent)});
        customTypes.add(spec.component);
      }
      const definition = registry.get(spec.component);
      this.entries.push({spec, capabilities: definition.capabilities, runtime: definition.create(spec, {viewer, host: this, scene})});
    }
    if (this.entries.some(e => e.runtime.element)) {
      root.classList.add('has-spatial-content');
      root.addEventListener('pointerdown', this.routePointer, true);
      root.addEventListener('click', this.routeClick, true);
      root.addEventListener('wheel', this.routeWheel, {capture: true, passive: false});
    }
    this.layout(); this.buildTree(); this.buildDialog(); this.sync();
    viewer.renderListeners.add(this.render); this.viewport.addEventListener('change', this.viewportChanged);
    viewer.entityUpdates = () => this.entries.map(e => entityUpdate(e.spec));
    this.refreshBounds();
    if (!scene.state.camera && (scene.entities?.length || scene.components?.length)) { viewer.setCanonicalView('pz'); viewer.fitAll(false); }
    if (this.entries[0]) this.select(this.entries.find(e => e.spec.id === viewer.focusedComponentId)?.spec ?? this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === viewer.selectedIndex)?.spec ?? this.entries[0].spec, false);
    this.render();
  }
  async ready(): Promise<void> { await Promise.all(this.entries.filter(e => effectiveVisibility(e.spec)).map(e => e.runtime.ready)); this.render(); }
  // Geometry bands do not intercept DOM events. Route their covered pixels
  // to geometry, while exposed content controls remain interactive.
  private occluded(event: MouseEvent): boolean {
    const element = event.target instanceof Element ? event.target.closest('.scene-surface') : null;
    const entry = this.entries.find(e => e.runtime.element === element);
    return entry?.runtime instanceof SurfaceRuntime && entry.runtime.occludedAt(event.clientX, event.clientY);
  }
  private routePointer = (event: PointerEvent): void => {
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigatePointer(event);
      // Picking listens for pointerup on the canvas. Keep the native gesture
      // there after redirecting its start, even though DOM content receives hits.
      this.root.querySelector('canvas')?.setPointerCapture(event.pointerId);
    }
  };
  private routeClick = (event: MouseEvent): void => {
    if (this.occluded(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private routeWheel = (event: WheelEvent): void => {
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigateWheel(event);
    }
  };
  private layout(): void {
    // Explicit positions are absolute world coordinates. Only unpositioned components are tiled.
    for (const entry of this.entries) {
      if (entry.spec.position) entry.runtime.setPosition(entry.spec.position);
    }
    const originals = new Map(sceneEntities(this.scene).map(c => [c.id, c]));
    const groups = [...componentGroups(this.entries.map(e => e.spec)).entries()];
    const plans = groups.map(([label, specs]) => {
      const entries = specs.map(s => this.entries.find(e => e.spec === s)!);
      const geometry = entries.filter(e => !e.runtime.element);
      const geometryBounds = new THREE.Box3(); geometry.forEach(e => geometryBounds.union(e.runtime.bounds));
      const center = geometryBounds.getCenter(new THREE.Vector3());
      const size = geometryBounds.getSize(new THREE.Vector3());
      const automaticGeometry = geometry.filter(e => !e.spec.position);
      automaticGeometry.forEach(e => this.position(e, new THREE.Vector3().fromArray(this.viewer.modelInfos[e.spec.source.index].translation ?? [0, 0, 0]).sub(center).toArray() as Vec3));
      let x = geometry.length ? Math.max(size.x / 2, 30) + 18 : 0;
      for (const entry of entries.filter(e => e.runtime.element && !e.spec.position)) {
        const [w] = entry.spec.size ?? [110, 70];
        this.position(entry, [x + w / 2, 0, 0]); x += w + 14;
      }
      const bounds = new THREE.Box3(); entries.forEach(e => bounds.union(e.runtime.bounds));
      return {label, entries, bounds};
    });
    const packed = packGroups(plans.map(p => {const size = p.bounds.getSize(new THREE.Vector3());return [size.x,size.y] as const;}),this.root.clientWidth / Math.max(1,this.root.clientHeight));
    plans.forEach((plan, index) => {
      const center = plan.bounds.getCenter(new THREE.Vector3());
      const offset = new THREE.Vector3(...packed[index],0).sub(center);
      for (const entry of plan.entries) {
        const original = originals.get(entry.spec.id)!;
        if (!original.position) this.position(entry, new THREE.Vector3().fromArray(entry.spec.position ?? [0, 0, 0]).add(offset).toArray() as Vec3);
      }
      if (plan.label) {
        const caption = document.createElement('span'); caption.textContent = plan.label; this.groupLabels.append(caption);
        this.captions.push({element: caption, entries: plan.entries});
      }
    });
  }
  private position(entry: Entry, position: Vec3): void { entry.spec.position = position; entry.runtime.setPosition(position); }
  refreshBounds(): void {
    const box = new THREE.Box3();
    this.entries.filter(e => e.runtime.element && effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
    this.viewer.setComponentBounds(box);
  }
  select(spec: SceneEntity, notify = true): void {
    const entry = this.entries.find(e => e.spec === spec); if (!entry) return;
    this.selected = entry;
    this.viewer.setFocusedComponent(spec.id);
    if (notify) { entry.runtime.select(); this.onSelect?.(spec); }
    for (const e of this.entries) { const selected = e === entry; this.rows.get(e.spec.id)?.button.setAttribute('aria-pressed', String(selected)); e.runtime.element?.classList.toggle('selected', selected); }
    this.scheduleNameLayout();
  }
  selectMesh(index: number): void { const entry = this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === index); if (entry) this.select(entry.spec, false); }
  sync(): void {
    if (this.syncing) return; this.syncing = true;
    for (const entry of this.entries) {
      const {spec, runtime} = entry;
      if (spec.source.kind === 'mesh') {
        const info = this.viewer.modelInfos[spec.source.index]; if (info) { spec.visible = info.visible; spec.opacity = info.opacity; spec.label = info.label?.text ?? info.name; }
      }
      runtime.setVisible(effectiveVisibility(spec));
      const row = this.rows.get(spec.id);
      if (row) {
        const visible = effectiveVisibility(spec);
        const percentage = Math.round(spec.opacity * 100);
        row.label = spec.label;
        row.button.setAttribute('aria-label', spec.label);
        row.button.title = `${spec.label} · 双击仅显示此元素`;
        row.edit.setAttribute('aria-label', `修改 ${spec.label} 的名称`);
        row.input.setAttribute('aria-label', `${spec.label} 的名称`);
        row.button.style.setProperty('--element-opacity', String(visible ? Math.max(.45, spec.opacity) : .35));
        row.opacity.value = String(percentage);
        row.opacity.style.setProperty('--level', `${percentage}%`);
        row.opacity.setAttribute('aria-label', `${spec.label} 透明度`);
        row.opacity.setAttribute('aria-valuetext', `${percentage}%`);
        row.opacity.title = `${spec.label} · ${percentage}%`;
        row.opacity.dataset.visible = String(visible);
        row.visibility.dataset.visible = String(visible);
        row.visibility.setAttribute('aria-label', `${visible ? '隐藏' : '显示'} ${spec.label}`);
        row.visibility.title = `${visible ? '隐藏' : '显示'} ${spec.label}`;
        if (row.color && spec.source.kind === 'mesh') {
          const color = this.viewer.modelInfos[spec.source.index]?.color ?? '#8fa9c9';
          row.color.style.setProperty('--swatch', color);
          row.color.setAttribute('aria-label', `修改 ${spec.label} 的颜色`);
          row.color.title = `${spec.label} · ${color}`;
          row.palette?.setAttribute('aria-label', `${spec.label} 颜色候选`);
          for (const choice of row.choices ?? []) {
            choice.setAttribute('aria-label', `将 ${spec.label} 设为 ${choice.dataset.color}`);
            choice.setAttribute('aria-pressed', String(choice.dataset.color === color.toLowerCase()));
          }
        }
      }
    }
    this.syncing = false; this.refreshBounds(); this.scheduleNameLayout();
  }
  private setVisible(entry: Entry, visible: boolean): void {
    this.applyStyle(entry, visible, visible && entry.spec.opacity === 0 ? 1 : entry.spec.opacity);
  }
  private setVisibility(visible: (entry: Entry) => boolean): void {
    this.syncing = true;
    try {
      for (const entry of this.entries) {
        entry.spec.visible = visible(entry);
        if (entry.spec.visible && entry.spec.opacity === 0) {
          entry.spec.opacity = 1;
          entry.runtime.setOpacity(1);
        }
        entry.runtime.setVisible(effectiveVisibility(entry.spec));
      }
    } finally { this.syncing = false; }
    this.sync(); this.onChange?.();
  }
  private scheduleNameLayout(): void {
    if (this.nameLayoutQueued) return;
    this.nameLayoutQueued = true;
    requestAnimationFrame(() => {
      this.nameLayoutQueued = false;
      const context = this.nameMeasure;
      if (!context) return;
      for (const row of this.rows.values()) {
        const style = getComputedStyle(row.button);
        const width = row.button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (width <= 0) continue;
        context.font = style.font;
        const display = compactLabel(row.label, text => context.measureText(text).width <= width);
        if (row.button.textContent !== display) row.button.textContent = display;
      }
    });
  }
  private finishRename(save: boolean, restoreFocus = true): void {
    const current = this.activeRename; if (!current) return;
    this.activeRename = undefined;
    current.editor.hidden = true; current.item.classList.remove('rename-open');
    if (save) this.setLabel(current.entry, current.input.value);
    this.scheduleNameLayout();
    if (restoreFocus) current.trigger.focus({preventScroll: true});
  }
  private startRename(entry: Entry, trigger: HTMLButtonElement, editor: HTMLFormElement, input: HTMLTextAreaElement, item: HTMLElement): void {
    if (this.activeRename?.editor === editor) { this.finishRename(true); return; }
    this.finishRename(true, false); this.closeColorPicker(); this.select(entry.spec);
    this.activeRename = {entry, trigger, editor, input, item};
    input.value = entry.spec.label; editor.hidden = false; item.classList.add('rename-open');
    this.scheduleNameLayout(); input.focus({preventScroll: true}); input.select();
    requestAnimationFrame(() => editor.scrollIntoView({block: 'nearest'}));
  }
  private closeColorPicker(): void {
    if (!this.openColorPicker) return;
    const {trigger, palette, item} = this.openColorPicker;
    trigger.setAttribute('aria-expanded', 'false'); palette.hidden = true; item.classList.remove('color-open');
    this.openColorPicker = undefined;
  }
  private toggleColorPicker(trigger: HTMLButtonElement, palette: HTMLElement, item: HTMLElement): void {
    const wasOpen = this.openColorPicker?.trigger === trigger;
    this.closeColorPicker();
    if (wasOpen) return;
    palette.hidden = false; trigger.setAttribute('aria-expanded', 'true'); item.classList.add('color-open');
    this.openColorPicker = {trigger, palette, item};
    requestAnimationFrame(() => palette.scrollIntoView({block: 'nearest'}));
  }
  private dismissColorPicker = (event: MouseEvent): void => {
    const target = event.target;
    const rename = this.activeRename;
    if (rename && target instanceof Node && !rename.trigger.contains(target) && !rename.editor.contains(target)) this.finishRename(true, false);
    const open = this.openColorPicker;
    if (!open || !(target instanceof Node) || open.trigger.contains(target) || open.palette.contains(target)) return;
    this.closeColorPicker();
  };

  open(spec: SceneEntity): void {
    const entry = this.entries.find(e => e.spec === spec);
    if (!entry) return;
    const mode = entry.capabilities.presentations.includes('focus') ? 'focus'
      : entry.capabilities.presentations.includes('fullscreen') ? 'fullscreen' : null;
    if (mode) this.present(spec, mode);
  }
  present(spec: SceneEntity, mode: Presentation): void {
    const entry = this.entries.find(e => e.spec === spec); if (!entry || !entry.capabilities.presentations.includes(mode)) return;
    this.select(spec);
    if (!entry.runtime.element) {
      entry.runtime.focus();
      return;
    }
    if (this.expanded && this.expanded !== entry) this.close();
    if (!this.expanded) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.expanded = entry; this.dialogTitle.textContent = spec.label;
      moveElement(this.expandedContent, entry.runtime.element);
      this.viewer.setInteractionEnabled(false); this.dialog.showModal();
    }
    entry.runtime.setPresentation(mode);
  }
  private close = (): void => {
    if (!this.expanded) return;
    const entry = this.expanded; this.expanded = undefined;
    entry.runtime.setPresentation('spatial'); this.dialog.close(); this.viewer.setInteractionEnabled(true);
    this.returnFocus?.focus({preventScroll: true}); this.viewer.invalidate();
  };
  private buildDialog(): void {
    this.dialog.className = 'component-dialog'; this.dialog.setAttribute('aria-labelledby', 'component-dialog-title');
    this.dialogTitle.id = 'component-dialog-title'; const heading = document.createElement('header');
    const close = button('返回场景', this.close); heading.append(this.dialogTitle, close);
    this.expandedContent.className = 'component-expanded-content'; this.dialog.append(heading, this.expandedContent);
    document.querySelector('#app-shell')!.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.close(); });
    this.dialog.addEventListener('close', this.close);
  }
  private buildTree(): void {
    this.tree.className = 'scene-tree'; this.tree.id = 'scene-tree'; this.tree.setAttribute('aria-label', '场景元素'); this.tree.dataset.labelObstacle = '';
    const heading = document.createElement('header'); const title = document.createElement('h2'); title.textContent = '场景';
    heading.append(title); this.tree.append(heading);
    const tabs = document.createElement('div'); tabs.className = 'scene-tree-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '场景内容');
    const elementsTab = button('', () => this.showTreeView('elements')); elementsTab.innerHTML = '<i data-lucide="layers-3" aria-hidden="true"></i>'; elementsTab.setAttribute('aria-label', '元素'); elementsTab.title = '元素';
    const infoTab = button('', () => this.showTreeView('info')); infoTab.innerHTML = '<i data-lucide="info" aria-hidden="true"></i>'; infoTab.setAttribute('aria-label', '信息'); infoTab.title = '信息';
    for (const [name, tab] of [['elements', elementsTab], ['info', infoTab]] as const) {
      tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.id = `scene-tree-${name}-tab`; tabs.append(tab);
    }
    heading.append(tabs);
    const elements = document.createElement('div'); elements.className = 'scene-tree-elements';
    const actions = document.createElement('div'); actions.className = 'scene-tree-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '场景显示');
    const showAll = button('全部显示', () => this.setVisibility(() => true));
    const hideAll = button('全部隐藏', () => this.setVisibility(() => false));
    for (const [action, icon] of [[showAll, 'eye'], [hideAll, 'eye-off']] as const) {
      const marker = document.createElement('i'); marker.dataset.lucide = icon; marker.setAttribute('aria-hidden', 'true'); action.prepend(marker);
    }
    actions.append(showAll, hideAll); elements.append(actions);
    const list = document.createElement('div'); list.className = 'scene-tree-list'; list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', '场景元素列表'); elements.append(list);
    this.tree.append(elements);
    const info = document.querySelector<HTMLElement>('#scene-info')!;
    info.classList.add('scene-tree-info'); this.tree.append(info);
    this.treeViews.set('elements', {button: elementsTab, content: elements});
    this.treeViews.set('info', {button: infoTab, content: info});
    this.showTreeView('elements');
    const content = document.createElement('div'); list.append(content);
    const updateEdges = () => {
      list.style.setProperty('--scroll-fade-top', `${Math.min(16, Math.max(0, list.scrollTop))}px`);
      list.style.setProperty('--scroll-fade-bottom', `${Math.min(16, Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop))}px`);
    };
    list.addEventListener('scroll', updateEdges, {passive: true});
    this.treeResize = new ResizeObserver(() => { updateEdges(); this.scheduleNameLayout(); }); this.treeResize.observe(list); this.treeResize.observe(content);
    for (const [group, specs] of componentGroups(this.entries.map(e => e.spec))) {
      if (group) { const label = document.createElement('h3'); label.textContent = group; content.append(label); }
      for (const spec of specs) {
        const entry = this.entries.find(e => e.spec === spec)!;
        const item = document.createElement('div'); item.className = 'scene-tree-item';
        const row = document.createElement('div'); row.className = 'scene-tree-row';
        const select = button(spec.label, () => this.select(spec)); select.className = 'scene-tree-select'; select.setAttribute('aria-pressed', 'false'); select.title = `${spec.label} · 双击仅显示此元素`;
        select.addEventListener('dblclick', () => { this.setVisibility(candidate => candidate === entry); entry.runtime.focus(); });
        const name = document.createElement('div'); name.className = 'scene-tree-name';
        const editor = document.createElement('form'); editor.className = 'scene-tree-rename'; editor.hidden = true;
        const input = document.createElement('textarea'); input.rows = 2; input.maxLength = 120; input.spellcheck = false;
        const save = button('', () => {}); save.type = 'submit'; save.className = 'scene-tree-rename-save'; save.setAttribute('aria-label', '保存名称'); save.innerHTML = '<i data-lucide="check" aria-hidden="true"></i>';
        const cancel = button('', () => this.finishRename(false)); cancel.className = 'scene-tree-rename-cancel'; cancel.setAttribute('aria-label', '取消改名'); cancel.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
        editor.append(input, save, cancel);
        editor.addEventListener('submit', event => {event.preventDefault(); this.finishRename(true);});
        input.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.finishRename(false); }
          if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); this.finishRename(true);}
        });
        editor.addEventListener('focusout', () => setTimeout(() => {if (this.activeRename?.editor === editor && !editor.contains(document.activeElement)) this.finishRename(true, false);}, 0));
        const edit = button('', () => this.startRename(entry, edit, editor, input, item)); edit.className = 'scene-tree-edit'; edit.innerHTML = '<i data-lucide="pencil" aria-hidden="true"></i>';
        name.append(select, edit);
        const opacity = document.createElement('input'); opacity.className = 'scene-tree-opacity'; opacity.type = 'range'; opacity.min = '0'; opacity.max = '100'; opacity.step = '1';
        opacity.addEventListener('input', () => this.applyStyle(entry, Number(opacity.value) > 0, Number(opacity.value) / 100));
        const visibility = button('', () => this.setVisible(entry, !effectiveVisibility(spec))); visibility.className = 'scene-tree-visibility';
        visibility.innerHTML = '<i data-lucide="eye" aria-hidden="true"></i><i data-lucide="eye-off" aria-hidden="true"></i>';
        const view: TreeRow = {button: select, edit, editor, input, label: spec.label, opacity, visibility};
        if (entry.capabilities.geometry && spec.source.kind === 'mesh') {
          item.classList.add('has-color'); row.classList.add('has-color');
          const palette = document.createElement('div'); palette.className = 'scene-tree-color-options'; palette.hidden = true;
          palette.id = `scene-color-${this.rows.size}`; palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', `${spec.label} 颜色候选`);
          const color = button('', () => this.toggleColorPicker(color, palette, item)); color.className = 'scene-tree-color';
          color.setAttribute('aria-controls', palette.id); color.setAttribute('aria-expanded', 'false');
          view.color = color; view.palette = palette; view.choices = geometryPalette.map(value => {
            const choice = button('', () => {
              this.viewer.setMeshColor(spec.source.index, value);
              this.sync(); this.onChange?.(); this.closeColorPicker(); color.focus({preventScroll: true});
            });
            choice.className = 'scene-tree-color-choice'; choice.dataset.color = value; choice.style.setProperty('--swatch', value);
            palette.append(choice); return choice;
          });
          row.append(color); item.append(row, editor, palette);
        } else item.append(row, editor);
        row.append(name, opacity, visibility); content.append(item); this.rows.set(spec.id, view);
      }
    }
    this.toggle.className = 'icon-button'; this.toggle.type = 'button'; this.toggle.id = 'scene-tree-toggle'; this.toggle.setAttribute('aria-label', '场景元素'); this.toggle.setAttribute('aria-controls', this.tree.id);
    this.toggle.innerHTML = '<i data-lucide="layers-3" aria-hidden="true"></i>';
    this.toggle.onclick = () => this.setOpen(!this.opened);
    document.querySelector('.top-actions')!.prepend(this.toggle); document.querySelector('#scene-panels')!.prepend(this.tree); this.setOpen(this.opened);
    installIcons(document);
    document.addEventListener('click', this.dismissColorPicker);
    this.tree.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (this.activeRename) { event.preventDefault(); event.stopPropagation(); this.finishRename(false); }
      else if (this.openColorPicker) { event.preventDefault(); event.stopPropagation(); const trigger = this.openColorPicker.trigger; this.closeColorPicker(); trigger.focus(); }
      else this.setOpen(false);
    });
  }
  private showTreeView(view: 'elements' | 'info'): void {
    if (view !== 'elements') this.finishRename(true, false);
    if (view !== 'elements') this.closeColorPicker();
    for (const [name, {button, content}] of this.treeViews) {
      const selected = name === view;
      button.setAttribute('aria-selected', String(selected));
      content.hidden = !selected;
    }
  }
  private setOpen(open: boolean): void { if (!open) {this.finishRename(true, false); this.closeColorPicker();} this.opened = open; this.tree.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open)); document.querySelector('#app-shell')!.classList.toggle('tree-open', open); if (!open && this.tree.contains(document.activeElement)) this.toggle.focus(); if (open) this.scheduleNameLayout(); }
  private viewportChanged = (): void => this.setOpen(this.viewport.matches);
  private renderLayers(): void {
    const runtimes = this.entries.flatMap(entry => entry.runtime instanceof SurfaceRuntime ? [entry.runtime] : []);
    const objects = runtimes.map(runtime => runtime.object);
    const surfaces = runtimes.flatMap(runtime => runtime.spatialObject ? [runtime.spatialObject] : []);
    const allDepths = [...new Set(objects.map(object => object.position.z))];
    const depths = [...new Set(surfaces.map(object => object.position.z))].sort((a,b) => a-b);
    this.root.classList.toggle('composited-content', depths.length > 0);
    this.compositor.hidden = depths.length === 0;
    for (const [z, plane] of this.planes) {
      if (allDepths.includes(z)) continue;
      for (const object of [...plane.scene.children]) this.layer.add(object);
      plane.renderer.domElement.remove(); this.planes.delete(z);
    }
    for (const z of allDepths) {
      let plane = this.planes.get(z);
      if (!plane) {
        plane = {scene: new THREE.Scene(), renderer: new CSS3DRenderer()};
        plane.renderer.domElement.className = 'component-layer';
        this.planes.set(z, plane); this.compositor.append(plane.renderer.domElement);
      }
      // Keep hidden wrappers connected so visibility toggles do not reload
      // plugin frames or discard content state.
      plane.renderer.domElement.hidden = !depths.includes(z);
      for (const object of objects.filter(object => object.position.z === z)) if (object.parent !== plane.scene) plane.scene.add(object);
      plane.renderer.setSize(this.root.clientWidth, this.root.clientHeight);
      plane.renderer.render(plane.scene, this.viewer.activeCamera);
    }
    if (!depths.length) return;
    while (this.bands.length < depths.length + 1) {
      const canvas = document.createElement('canvas'); canvas.className = 'component-geometry';
      this.bands.push(canvas); this.compositor.append(canvas);
    }
    while (this.bands.length > depths.length + 1) this.bands.pop()!.remove();
    let order = 0;
    const band = (index: number) => {
      const canvas = this.bands[index]; canvas.style.zIndex = String(order++);
      this.viewer.renderGeometryBand(canvas, depths[index-1] ?? -Infinity, depths[index] ?? Infinity);
    };
    const plane = (index: number) => { this.planes.get(depths[index])!.renderer.domElement.style.zIndex = String(order++); };
    const camera = this.viewer.activeCamera;
    if (camera instanceof THREE.OrthographicCamera) {
      if (camera.getWorldDirection(new THREE.Vector3()).z <= 0) {
        for (let i=0;i<=depths.length;i++) { band(i); if(i<depths.length) plane(i); }
      } else {
        for (let i=depths.length;i>=0;i--) { band(i); if(i>0) plane(i-1); }
      }
    } else {
      // If the eye lies between planes, rays on opposite sides never share a
      // pixel. Paint both far branches first, then the band containing the eye.
      const split = depths.findIndex(z => z > camera.position.z);
      const middle = split < 0 ? depths.length : split;
      for (let i=0;i<middle;i++) { band(i); plane(i); }
      for (let i=depths.length;i>middle;i--) { band(i); plane(i-1); }
      band(middle);
    }
  }
  private render = (): void => {
    this.renderLayers();
    for (const caption of this.captions) {
      const box = new THREE.Box3(); caption.entries.filter(e => effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
      caption.element.hidden = box.isEmpty(); if (box.isEmpty()) continue;
      const p = new THREE.Vector3(box.min.x, box.max.y + 5, box.max.z).project(this.viewer.activeCamera);
      caption.element.hidden = p.z < -1 || p.z > 1;
      // Reserve a screen-space header above geometry assembly captions.
      caption.element.style.transform = `translate(${(p.x + 1) * this.root.clientWidth / 2}px,${(1 - p.y) * this.root.clientHeight / 2 - 32}px)`;
    }
  };
  dispose(): void { document.removeEventListener('click', this.dismissColorPicker); this.root.classList.remove('has-spatial-content'); this.root.removeEventListener('pointerdown', this.routePointer, true); this.root.removeEventListener('click', this.routeClick, true); this.root.removeEventListener('wheel', this.routeWheel, true); this.close(); this.treeResize?.disconnect(); this.entries.forEach(e => e.runtime.dispose()); this.viewer.renderListeners.delete(this.render); this.viewport.removeEventListener('change', this.viewportChanged); this.viewer.entityUpdates = undefined; this.root.classList.remove('composited-content'); this.compositor.remove(); this.planes.clear(); this.bands.length = 0; this.groupLabels.remove(); this.tree.remove(); this.toggle.remove(); this.dialog.remove(); }
}

class SurfaceRuntime implements ComponentRuntime {
  readonly element = document.createElement('section');
  private readonly wrapper = document.createElement('div');
  readonly object = new CSS3DObject(this.wrapper);
  get spatialObject(): CSS3DObject | undefined { return this.mode === 'spatial' && this.object.visible ? this.object : undefined; }
  private readonly content;
  private mode: Presentation = 'spatial';
  constructor(private readonly spec: SceneEntity, private readonly context: Context, factory: ContentFactory) {
    const {host, scene} = context; this.element.className = 'scene-surface'; this.element.dataset.component = spec.component;
    const header = document.createElement('header'); header.className = 'component-handle'; header.title = spec.label;
    const label = document.createElement('span'); label.textContent = spec.label;
    header.append(label);
    const source = scene.attachments?.[spec.source.index];
    this.content = source?.url ? factory(source.url, spec.label, spec) : {element: document.createElement('p'), ready: Promise.reject(new Error('资源不可用')), dispose() {}};
    void this.content.ready.catch(() => {});
    if (!source?.url) this.content.element.textContent = source?.unavailable ?? '资源不可用';
    const body = document.createElement('div'); body.className = 'component-body'; body.append(this.content.element);
    const enter = button(`选中 ${spec.label}`, () => host.select(spec)); enter.className = 'component-enter'; enter.setAttribute('aria-label', `选中 ${spec.label}，双击展开`); enter.textContent = ''; body.append(enter);
    // The same orbit/pan/zoom gestures work over content previews. Single click selects.
    let navigating = false;
    let gesture: AbortController | undefined;
    enter.onclick = () => { if (!navigating) host.select(spec); };
    enter.addEventListener('dblclick', event => { event.preventDefault(); host.open(spec); });
    enter.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); host.open(spec); } });
    header.addEventListener('dblclick', event => { event.preventDefault(); host.open(spec); });
    enter.addEventListener('pointerdown', event => {
      if (event.isPrimary) {
        gesture?.abort(); gesture = new AbortController(); navigating = false;
        const x = event.clientX, y = event.clientY;
        window.addEventListener('pointermove', move => { if (Math.hypot(move.clientX - x, move.clientY - y) > 6) navigating = true; }, {signal: gesture.signal});
        window.addEventListener('pointerup', () => gesture?.abort(), {once: true, signal: gesture.signal});
        window.addEventListener('pointercancel', () => { navigating = true; gesture?.abort(); }, {once: true, signal: gesture.signal});
      } else navigating = true;
      host.select(spec); context.viewer.navigatePointer(event);
    });
    enter.addEventListener('wheel', event => { event.preventDefault(); context.viewer.navigateWheel(event); }, {passive: false});
    this.content.element.inert = true;
    this.element.append(header, body); this.wrapper.append(this.element); host.layer.add(this.object);
    this.setPosition(spec.position ?? [0, 0, 0]); this.setOpacity(spec.opacity); this.size();
    header.addEventListener('pointerdown', event => {
      host.select(spec);
      if (!(event.target as Element).closest('button')) context.viewer.navigatePointer(event);
    });
    header.addEventListener('wheel', event => {event.preventDefault(); context.viewer.navigateWheel(event);}, {passive: false});
  }
  get ready(): Promise<void> { return this.content.ready; }
  get bounds(): THREE.Box3 {
    const [w, h] = this.spec.size ?? [110,70]; const p = this.object.position;
    return new THREE.Box3(new THREE.Vector3(p.x - w / 2, p.y - h / 2, p.z - .1), new THREE.Vector3(p.x + w / 2, p.y + h / 2, p.z + .1));
  }
  setPosition(position: Vec3): void { this.object.position.fromArray(position); }
  setVisible(visible: boolean): void { this.object.visible = visible; }
  setOpacity(opacity: number): void { this.element.style.opacity = String(opacity); }
  setLabel(label: string): void {
    this.element.querySelector<HTMLElement>('.component-handle > span')!.textContent = label;
    this.element.querySelector<HTMLElement>('.component-handle')!.title = label;
    this.element.querySelector<HTMLButtonElement>('.component-enter')!.setAttribute('aria-label', `选中 ${label}，双击展开`);
  }
  occludedAt(x: number, y: number): boolean {
    if (this.mode !== 'spatial') return false;
    const rect = this.context.host.root.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1, 1-(y-rect.top)/rect.height*2), this.context.viewer.activeCamera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1), -this.object.position.z), new THREE.Vector3());
    return !!point && this.context.viewer.geometryOccludes(x, y, point.toArray() as Vec3);
  }
  select(): void { this.element.classList.add('selected'); }
  focus(): void { this.context.viewer.focusBounds(this.bounds); }
  setPresentation(mode: Presentation): void {
    this.mode = mode; this.context.viewer.invalidate(); this.element.classList.toggle('expanded', mode !== 'spatial');
    this.content.element.inert = mode === 'spatial';
    if (mode === 'spatial') moveElement(this.wrapper, this.element);
    this.content.present?.(mode);
  }
  private size(): void { const [w,h] = this.spec.size ?? [110,70]; this.wrapper.style.width = '800px'; this.wrapper.style.height = `${800 * h / w}px`; this.object.scale.setScalar(w / 800); this.context.viewer.invalidate(); }
  dispose(): void { this.content.dispose(); this.object.removeFromParent(); this.wrapper.remove(); this.element.remove(); }
}
function button(text: string, action: () => void): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = action; return button; }
function moveElement(parent: HTMLElement, element: HTMLElement): void {
  // Preserve iframe browsing context on browsers supporting state-preserving moves.
  const movable = parent as HTMLElement & {moveBefore?: (node: Node, child: Node | null) => void};
  if (movable.moveBefore && parent.isConnected && element.isConnected) movable.moveBefore(element, null); else parent.append(element);
}
