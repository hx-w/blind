import './styles.css';
import {captureOwner, setInitialScene} from './bootstrap';
import {OperationHost, OperationError} from './operations/core';
import {publishOperations, serveWindowOperations} from './operations/transport';
import {workbenchOperations} from './operations/workbench';

const token = location.pathname.match(/\/s\/([^/]+)$/)?.[1];
const params = new URLSearchParams(location.search);
const childView = params.has('embedded') || params.has('render');

function showUnavailable(status: number, message?: string): void {
  document.querySelector<HTMLElement>('#loading-state')!.hidden = true;
  document.querySelectorAll<HTMLElement>('[data-viewer-chrome]').forEach(element => {element.hidden = true;});
  const invalid = document.querySelector<HTMLElement>('#invalid-state')!;
  invalid.hidden = false;
  if (status !== 410) {
    invalid.querySelector('span')!.textContent = status === 404 ? '404' : 'ERR';
    invalid.querySelector('h2')!.textContent = status === 404 ? '场景不存在' : '暂时无法打开场景';
    invalid.querySelector('p')!.textContent = status === 404 ? '请检查链接是否正确。' : '资源或服务暂时不可用，请稍后重试。';
  }
  if (params.has('render')) {
    document.documentElement.dataset.renderStatus = 'error';
    document.documentElement.dataset.renderError = message ?? 'Scene render failed';
  }
  const operations = new OperationHost({sceneId: params.get('scene') ?? 'scene', ready: () => false});
  operations.register(workbenchOperations.get, () => {throw new OperationError('RESOURCE_UNAVAILABLE', message ?? 'Scene failed');});
  const unpublish = publishOperations(operations);
  const disconnect = params.has('embedded') ? serveWindowOperations(operations) : undefined;
  operations.notify('lifecycle', {error: message ?? 'Scene failed'});
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    operations.dispose(); disconnect?.(); unpublish();
  });
}

if (token) {
  try {
    const owner = captureOwner(token);
    const sceneId = params.get('scene');
    const path = `api/v1/scenes/${token}${sceneId ? `?scene=${encodeURIComponent(sceneId)}` : ''}`;
    const response = await fetch(path, {headers: owner ? {Authorization:`Bearer ${owner}`} : {}, cache:'no-store'});
    if (!response.ok) showUnavailable(response.status);
    else {
      const payload = await response.json() as {kind?: string};
      setInitialScene(payload);
      if (payload.kind === 'collection' && !childView && !sceneId) await import('./collection');
      else await import('./single');
    }
  } catch {
    showUnavailable(503);
  }
} else {
  document.querySelector<HTMLElement>('#loading-state')!.hidden = true;
  document.querySelector<HTMLElement>('#empty-state')!.hidden = false;
  document.querySelectorAll<HTMLElement>('[data-viewer-chrome]').forEach(element => {element.hidden = true;});
}
