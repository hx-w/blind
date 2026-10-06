export type JsonSchema = Readonly<Record<string, unknown>>;
export interface Schema<T> { readonly json: JsonSchema; parse(value: unknown, path?: string): T }
export type Infer<S> = S extends Schema<infer T> ? T : never;
type OptionalSchema<T> = Schema<T | undefined> & { readonly optional: true };
type Shape = Record<string, Schema<unknown>>;
type ObjectValue<S extends Shape> = { [K in keyof S as S[K] extends OptionalSchema<unknown> ? never : K]: Infer<S[K]> } & { [K in keyof S as S[K] extends OptionalSchema<unknown> ? K : never]?: Exclude<Infer<S[K]>, undefined> };
export type ErrorCode = 'INVALID_ARGUMENT' | 'UNKNOWN_OPERATION' | 'UNKNOWN_ENTITY' | 'UNKNOWN_SCENE' | 'UNSUPPORTED' | 'NOT_READY' | 'FORBIDDEN' | 'CONFLICT' | 'RESOURCE_UNAVAILABLE' | 'USER_ACTIVATION_REQUIRED' | 'DISPOSED' | 'CANCELLED' | 'LIMIT_EXCEEDED';
export class OperationError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: {field?: string; target?: string; retryable?: boolean} = {}) { super(message); this.name = 'OperationError'; }
}
const invalid = (path: string, message: string): never => { throw new OperationError('INVALID_ARGUMENT', message, {field: path}); };
function schema<T>(json: JsonSchema, parse: (value: unknown, path: string) => T): Schema<T> { return {json, parse(value, path = 'params') { return parse(value, path); }}; }
function jsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 64) return invalid(path, 'JSON nesting exceeds 64 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) jsonValue(value[i], `${path}[${i}]`, depth + 1); return value; }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) jsonValue(item, `${path}.${key}`, depth + 1);
    return value;
  }
  return invalid(path, 'Expected a finite, serializable JSON value');
}
export const s = {
  string(options: {min?: number; max?: number; pattern?: string; description?: string} = {}): Schema<string> {
    const pattern = options.pattern ? new RegExp(options.pattern) : undefined;
    return schema({type: 'string', ...(options.min === undefined ? {} : {minLength: options.min}), ...(options.max === undefined ? {} : {maxLength: options.max}), ...(options.pattern ? {pattern: options.pattern} : {}), ...(options.description ? {description: options.description} : {})}, (value, path) => {
      if (typeof value !== 'string') return invalid(path, 'Expected a string');
      let length = 0;
      if (options.min !== undefined || options.max !== undefined) for (const _character of value) length++;
      if (options.min !== undefined && length < options.min || options.max !== undefined && length > options.max || pattern && !pattern.test(value)) return invalid(path, 'String does not satisfy the declared bounds');
      return value;
    });
  },
  number(options: {min?: number; max?: number; integer?: boolean; description?: string} = {}): Schema<number> {
    return schema({type: options.integer ? 'integer' : 'number', ...(options.min === undefined ? {} : {minimum: options.min}), ...(options.max === undefined ? {} : {maximum: options.max}), ...(options.description ? {description: options.description} : {})}, (value, path) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || options.integer && !Number.isInteger(value) || options.min !== undefined && value < options.min || options.max !== undefined && value > options.max) return invalid(path, 'Expected a finite number within the declared bounds');
      return value;
    });
  },
  boolean(): Schema<boolean> { return schema({type: 'boolean'}, (value, path) => typeof value === 'boolean' ? value : invalid(path, 'Expected a boolean')); },
  enum<const T extends readonly string[]>(values: T): Schema<T[number]> { return schema({type: 'string', enum: values}, (value, path) => typeof value === 'string' && values.includes(value) ? value as T[number] : invalid(path, `Expected one of: ${values.join(', ')}`)); },
  literal<const T extends string | number | boolean | null>(value: T): Schema<T> { return schema({const: value}, (input, path) => input === value ? value : invalid(path, `Expected ${String(value)}`)); },
  optional<T>(inner: Schema<T>): OptionalSchema<T> { return {...schema(inner.json, (value, path) => value === undefined ? undefined : inner.parse(value, path)), optional: true}; },
  nullable<T>(inner: Schema<T>): Schema<T | null> { return schema({anyOf: [inner.json, {type: 'null'}]}, (value, path) => value === null ? null : inner.parse(value, path)); },
  array<T>(inner: Schema<T>, options: {min?: number; max?: number; unique?: boolean} = {}): Schema<T[]> {
    return schema({type: 'array', items: inner.json, ...(options.min === undefined ? {} : {minItems: options.min}), ...(options.max === undefined ? {} : {maxItems: options.max}), ...(options.unique ? {uniqueItems: true} : {})}, (value, path) => {
      if (!Array.isArray(value)) return invalid(path, 'Expected an array');
      if (options.min !== undefined && value.length < options.min || options.max !== undefined && value.length > options.max) return invalid(path, 'Array does not satisfy the declared bounds');
      const parsed = new Array<T>(value.length);
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return invalid(`${path}[${index}]`, 'Sparse arrays are not allowed');
        parsed[index] = inner.parse(value[index], `${path}[${index}]`);
      }
      if (options.unique && new Set(parsed.map(item => typeof item === 'object' ? JSON.stringify(item) : item)).size !== parsed.length) return invalid(path, 'Duplicate array entries are not allowed');
      return parsed;
    });
  },
  tuple<const T extends readonly Schema<unknown>[]>(items: T): Schema<{ -readonly [K in keyof T]: Infer<T[K]> }> {
    return schema({type: 'array', prefixItems: items.map(item => item.json), minItems: items.length, maxItems: items.length, items: false}, (value, path) => {
      if (!Array.isArray(value) || value.length !== items.length) return invalid(path, `Expected ${items.length} coordinates`);
      for (let index = 0; index < items.length; index++) if (!Object.hasOwn(value, index)) return invalid(`${path}[${index}]`, 'Sparse tuples are not allowed');
      return items.map((item, index) => item.parse(value[index], `${path}[${index}]`)) as { -readonly [K in keyof T]: Infer<T[K]> };
    });
  },
  object<const S extends Shape>(shape: S): Schema<ObjectValue<S>> {
    const entries = Object.entries(shape);
    return schema({type: 'object', properties: Object.fromEntries(entries.map(([key, value]) => [key, value.json])), required: entries.filter(([, value]) => !('optional' in value)).map(([key]) => key), additionalProperties: false}, (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid(path, 'Expected an object');
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) return invalid(`${path}.${key}`, 'Unknown field');
      const result: Record<string, unknown> = {};
      for (const [key, validator] of entries) { const item = validator.parse(input[key], `${path}.${key}`); if (item !== undefined) result[key] = item; }
      return result as ObjectValue<S>;
    });
  },
  json<T = unknown>(description = 'Serializable JSON value'): Schema<T> { return schema({description}, (value, path) => { jsonValue(value, path); if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return invalid(path, 'JSON value exceeds 64 KiB'); return value as T; }); },
  union<const T extends readonly Schema<unknown>[]>(items: T): Schema<Infer<T[number]>> { return schema({anyOf: items.map(item => item.json)}, (value, path) => {
    for (const item of items) { try { return item.parse(value, path) as Infer<T[number]>; } catch (error) { if (!(error instanceof OperationError) || error.code !== 'INVALID_ARGUMENT') throw error; } }
    return invalid(path, 'Value does not match any declared alternative');
  }); },
};
export interface OperationActor { readonly kind: 'host' | 'collection' | 'component'; readonly entityId?: string; readonly grants?: readonly string[] }
export interface OperationContext { readonly actor: OperationActor; readonly sceneId: string; readonly revision: number }
export interface Operation<P, R = unknown> { readonly name: string; readonly description: string; readonly params: Schema<P>; readonly permission: string; readonly readOnly: boolean; readonly result: JsonSchema; readonly resultType?: R }
export function defineOperation<P, R = unknown>(name: string, description: string, params: Schema<P>, options: {permission: string; readOnly?: boolean; result?: JsonSchema}): Operation<P, R> {
  return Object.freeze({name, description, params, permission: options.permission, readOnly: options.readOnly ?? false, result: options.result ?? {description: 'Operation result'}});
}
export interface OperationEvent { readonly sceneId: string; readonly revision: number; readonly domain: string; readonly data?: unknown }
export interface OperationDescriptor { name: string; description: string; inputSchema: JsonSchema; outputSchema: JsonSchema; permission: string; readOnly: boolean; available: boolean; allowed: boolean }
export const catalogOperation = defineOperation<Record<string, never>, OperationDescriptor[]>('operations:catalog', 'Discover operation names, JSON schemas, permissions and current availability. This query is available before scene readiness.', s.object({}), {permission: 'scene.read', readOnly: true, result: {type: 'array', items: {type: 'object', required: ['name', 'description', 'inputSchema', 'outputSchema', 'permission', 'readOnly', 'available', 'allowed'], properties: {name: {type: 'string'}, description: {type: 'string'}, inputSchema: {type: 'object'}, outputSchema: {type: 'object'}, permission: {type: 'string'}, readOnly: {type: 'boolean'}, available: {type: 'boolean'}, allowed: {type: 'boolean'}}, additionalProperties: false}}});
type Registered = {operation: Operation<unknown>; invoke: (params: unknown, context: OperationContext) => unknown | Promise<unknown>; available?: () => boolean};
const hostActor: OperationActor = Object.freeze({kind: 'host'});
export class OperationHost {
  private readonly definitions = new Map<string, Registered>();
  private readonly listeners = new Set<{listener: (event: OperationEvent) => void; actor: OperationActor}>();
  private sequence = 0;
  private disposed = false;
  get revision(): number { return this.sequence; }
  get sceneId(): string { return this.options.sceneId; }
  constructor(private readonly options: {sceneId: string; ready: () => boolean; exporting?: boolean}) {
    this.register(catalogOperation, (_, context) => this.catalog(context.actor));
  }
  register<P, R>(operation: Operation<P, R>, handler: (params: P, context: OperationContext) => R | Promise<R>, available?: () => boolean): () => void {
    if (this.disposed) throw new OperationError('DISPOSED', 'Operation host is disposed');
    if (this.definitions.has(operation.name)) throw new Error(`Duplicate operation: ${operation.name}`);
    const entry: Registered = {operation: operation as Operation<unknown>, invoke: (params, context) => handler(params as P, context), available};
    this.definitions.set(operation.name, entry);
    return () => { if (this.definitions.get(operation.name) === entry) this.definitions.delete(operation.name); };
  }
  catalog(actor: OperationActor = hostActor): OperationDescriptor[] {
    return [...this.definitions.values()].map(({operation, available}) => ({name: operation.name, description: operation.description, inputSchema: operation.params.json, outputSchema: operation.result, permission: operation.permission, readOnly: operation.readOnly, available: !this.disposed && (operation === catalogOperation || this.options.ready()) && (!available || available()) && (!this.options.exporting || operation.readOnly), allowed: this.allowed(operation, actor)}));
  }
  run<P, R>(operation: Operation<P, R>, params: P, actor: OperationActor = hostActor): Promise<R> { return this.execute(operation.name, params, actor) as Promise<R>; }
  async execute(name: string, params: unknown, actor: OperationActor): Promise<unknown> {
    if (this.disposed) throw new OperationError('DISPOSED', 'Operation host is disposed');
    const entry = this.definitions.get(name);
    if (!entry) throw new OperationError('UNKNOWN_OPERATION', `Unknown operation: ${name}`, {target: name});
    if (!this.allowed(entry.operation, actor)) throw new OperationError('FORBIDDEN', 'This connection is not authorized for this operation', {target: name});
    if (this.options.exporting && !entry.operation.readOnly) throw new OperationError('FORBIDDEN', 'Export snapshots are read-only');
    if (entry.operation !== catalogOperation && !this.options.ready()) throw new OperationError('NOT_READY', 'Scene is not ready', {retryable: true});
    const parsed = entry.operation.params.parse(params);
    if (entry.available && !entry.available()) throw new OperationError('UNSUPPORTED', 'Operation is not supported by the current target', {target: name});
    const revision = this.sequence;
    const value = await entry.invoke(parsed, {actor, sceneId: this.options.sceneId, revision});
    if (this.disposed) throw new OperationError('DISPOSED', 'Operation host was disposed before the operation completed');
    if (!entry.operation.readOnly && revision === this.sequence) this.notify(name.split(':', 1)[0]);
    return value;
  }
  private allowed(operation: Operation<unknown>, actor: OperationActor): boolean {
    if (actor.kind === 'host' || actor.kind === 'collection') return true;
    return actor.grants?.includes(operation.permission) ?? false;
  }
  notify(domain: string, data?: unknown): void {
    if (this.disposed) return;
    const event: OperationEvent = {sceneId: this.options.sceneId, revision: ++this.sequence, domain, ...(data === undefined ? {} : {data})};
    for (const {listener, actor} of this.listeners) {
      if (actor.kind === 'component' && !actor.grants?.includes('scene.read')) continue;
      if (actor.kind === 'component' && domain === 'content' && typeof data === 'object' && data !== null && 'entityId' in data && data.entityId !== actor.entityId && !actor.grants?.includes('content.read-scene')) continue;
      try { listener(event); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }
  subscribe(listener: (event: OperationEvent) => void, actor: OperationActor = hostActor): () => void {
    if (this.disposed) throw new OperationError('DISPOSED', 'Operation host is disposed');
    const entry = {listener, actor}; this.listeners.add(entry); return () => this.listeners.delete(entry);
  }
  dispose(): void { if (this.disposed) return; this.notify('lifecycle', {disposed: true}); this.disposed = true; this.listeners.clear(); this.definitions.clear(); }
}
export function assertContentAccess(context: OperationContext, entityId: string): void {
  if (context.actor.kind === 'component' && context.actor.entityId !== entityId && !context.actor.grants?.includes('content.read-scene')) throw new OperationError('FORBIDDEN', 'Content access is restricted to this component', {target: entityId});
}
export interface OperationFailure {code: ErrorCode; message: string; field?: string; target?: string; retryable?: boolean}
export function operationFailure(error: unknown): OperationFailure {
  if (error instanceof OperationError) return {code: error.code, message: error.message, ...error.details};
  return {code: 'RESOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : 'Operation failed'};
}
