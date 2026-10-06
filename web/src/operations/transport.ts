import {OperationError, operationFailure, type Operation, type OperationActor, type OperationDescriptor, type OperationEvent, type OperationFailure, type OperationHost} from './core';

export interface OperationRequest {type: 'blind:operation-request'; version: 1; sceneId: string; requestId: string; operation: string; params: unknown}
export type OperationResult = {ok: true; value: unknown; sceneId: string; revision: number} | {ok: false; error: OperationFailure; sceneId: string; revision: number};
type WireResult = OperationResult & {type: 'blind:operation-result'; version: 1; requestId: string};
export interface AgentOperations {
  readonly version: 1;
  readonly sceneId: string;
  catalog(): OperationDescriptor[];
  execute(operation: string, params?: unknown): Promise<OperationResult>;
  subscribe(listener: (event: OperationEvent) => void): () => void;
}
declare global { interface Window {blind?: AgentOperations} }
const trustedHost: OperationActor = Object.freeze({kind: 'host'});
function request(value: unknown): OperationRequest | undefined {
  if (typeof value !== 'object' || value === null) return;
  const input = value as Partial<OperationRequest>;
  if (input.type !== 'blind:operation-request' || input.version !== 1 || typeof input.sceneId !== 'string' || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 128 || typeof input.operation !== 'string' || input.operation.length > 120) return;
  return input as OperationRequest;
}
async function execute(host: OperationHost, input: OperationRequest, actor: OperationActor): Promise<WireResult> {
  const base = {type: 'blind:operation-result' as const, version: 1 as const, requestId: input.requestId, sceneId: host.sceneId};
  try {
    if (input.sceneId !== host.sceneId) throw new OperationError('UNKNOWN_SCENE', 'This connection is bound to a different scene', {target: input.sceneId});
    const value = await host.execute(input.operation, input.params ?? {}, actor);
    return {...base, ok: true, value, revision: host.revision};
  } catch (error) { return {...base, ok: false, error: operationFailure(error), revision: host.revision}; }
}
export function publishOperations(host: OperationHost): () => void {
  const api: AgentOperations = Object.freeze({
    version: 1 as const, sceneId: host.sceneId,
    catalog: () => host.catalog(trustedHost),
    async execute(operation: string, params: unknown = {}): Promise<OperationResult> {
      try { const value = await host.execute(operation, params, trustedHost); return {ok: true, value, sceneId: host.sceneId, revision: host.revision}; }
      catch (error) { return {ok: false, error: operationFailure(error), sceneId: host.sceneId, revision: host.revision}; }
    },
    subscribe: (listener: (event: OperationEvent) => void) => host.subscribe(listener, trustedHost),
  });
  window.blind = api;
  return () => { if (window.blind === api) delete window.blind; };
}
export function serveWindowOperations(host: OperationHost, target: Window = parent): () => void {
  let disposed = false;
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== target || event.origin !== location.origin) return;
    const input = request(event.data); if (!input) return;
    void execute(host, input, {kind: 'collection'}).then(result => { if (!disposed) target.postMessage(result, location.origin); });
  };
  window.addEventListener('message', receive);
  const unsubscribe = host.subscribe(event => target.postMessage({type: 'blind:operation-event', version: 1, ...event}, location.origin), {kind: 'collection'});
  return () => { disposed = true; window.removeEventListener('message', receive); unsubscribe(); };
}
export function servePortOperations(host: OperationHost, port: MessagePort, actor: OperationActor): () => void {
  let disposed = false;
  const receive = (event: MessageEvent) => {
    const input = request(event.data); if (!input || disposed) return;
    void execute(host, input, actor).then(result => { if (!disposed) port.postMessage(result); });
  };
  port.addEventListener('message', receive); port.start();
  const unsubscribe = host.subscribe(event => { if (!disposed) port.postMessage({type: 'blind:operation-event', version: 1, ...event}); }, actor);
  return () => { disposed = true; unsubscribe(); port.removeEventListener('message', receive); };
}
export interface OperationClient {
  execute(operation: string, params?: unknown): Promise<unknown>;
  run<P, R>(operation: Operation<P, R>, params: P): Promise<R>;
  catalog(): Promise<OperationDescriptor[]>;
  subscribe(listener: (event: OperationEvent) => void): () => void;
  dispose(): void;
}
export function connectWindowOperations(target: Window, sceneId: string, options: {onEvent?: (event: OperationEvent) => void} = {}): OperationClient {
  let sequence = 0, disposed = false;
  const session = crypto.randomUUID();
  const pending = new Map<string, {resolve: (value: unknown) => void; reject: (error: OperationError) => void; timer: number}>();
  const listeners = new Set<(event: OperationEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== target || event.origin !== location.origin || event.data?.version !== 1 || event.data.sceneId !== sceneId) return;
    if (event.data.type === 'blind:operation-event') {
      if (!Number.isSafeInteger(event.data.revision) || typeof event.data.domain !== 'string') return;
      for (const listener of listeners) listener({sceneId, revision: event.data.revision, domain: event.data.domain, data: event.data.data});
      return;
    }
    if (event.data.type !== 'blind:operation-result' || typeof event.data.requestId !== 'string') return;
    const entry = pending.get(event.data.requestId); if (!entry) return;
    pending.delete(event.data.requestId); clearTimeout(entry.timer);
    const result = event.data as WireResult;
    if (result.ok) entry.resolve(result.value);
    else entry.reject(new OperationError(result.error.code, result.error.message, {field: result.error.field, target: result.error.target, retryable: result.error.retryable}));
  };
  window.addEventListener('message', receive);
  const client: OperationClient = {
    execute(operation, params = {}) {
      if (disposed) return Promise.reject(new OperationError('DISPOSED', 'Scene connection is disposed'));
      const requestId = `${session}:${++sequence}`;
      const {promise, resolve, reject} = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new OperationError('NOT_READY', 'Scene operation did not respond; its completion is unknown', {target: operation, retryable: false})); }, 90000);
      pending.set(requestId, {resolve, reject, timer});
      try { target.postMessage({type: 'blind:operation-request', version: 1, sceneId, requestId, operation, params} satisfies OperationRequest, location.origin); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(new OperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Request cannot be transferred')); }
      return promise;
    },
    run<P, R>(operation: Operation<P, R>, params: P): Promise<R> { return client.execute(operation.name, params) as Promise<R>; },
    async catalog() { return await client.execute('operations:catalog') as OperationDescriptor[]; },
    subscribe(listener) { if (disposed) throw new OperationError('DISPOSED', 'Scene connection is disposed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; window.removeEventListener('message', receive); listeners.clear(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new OperationError('DISPOSED', 'Scene connection is disposed')); } pending.clear(); },
  };
  return client;
}
