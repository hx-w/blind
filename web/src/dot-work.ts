// These are renderer safety limits, shared by standalone and Markdown consumers.
export const DOT_MAX_NODES = 1000;
export const DOT_MAX_EDGES = 10000;
export const DIAGRAM_MAX_OUTPUT = 8 * 1024 * 1024;
export const DOT_TIMEOUT_MS = 20000;
const MAX_TOKENS = 100000;
const MAX_DEPTH = 64;

type Token = {value: string; id: boolean; bare?: boolean};

/** A complexity preflight, not a DOT-to-graph converter. Graphviz still parses the original
 * source. Ignore attributes/comments/string contents and count endpoint sets before its
 * parser can materialize Cartesian edges. Counts may conservatively include duplicate
 * edges in strict graphs and nodes added to named subgraphs after an edge statement. */
export function checkDotWork(source: string): {nodes: number; edges: number} {
  const tokens: Token[] = [];
  let cursor = 0;
  const push = (token: Token) => {
    if (tokens.length >= MAX_TOKENS) throw new Error('DOT 超过 100000 个语法标记');
    tokens.push(token);
  };
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char)) { cursor++; continue; }
    if (char === '#' || source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor); cursor = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) throw new Error('DOT 注释未结束');
      cursor = end + 2; continue;
    }
    if (source.startsWith('->', cursor) || source.startsWith('--', cursor)) {
      push({value: source.slice(cursor, cursor + 2), id: false}); cursor += 2; continue;
    }
    if ('{}[];,:=+'.includes(char)) { push({value: char, id: false}); cursor++; continue; }
    if (char === '"') {
      const start = cursor++;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '\\') { cursor += 2; continue; }
        if (source[cursor++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('DOT 字符串未结束');
      push({value: source.slice(start, cursor), id: true}); continue;
    }
    if (char === '<') {
      const start = cursor++;
      let depth = 1;
      while (cursor < source.length && depth) {
        if (source[cursor] === '<') depth++;
        if (source[cursor++] === '>') depth--;
      }
      if (depth) throw new Error('DOT HTML 标签未结束');
      push({value: source.slice(start, cursor), id: true}); continue;
    }
    const start = cursor;
    if (/[A-Za-z_\u0080-\uffff]/.test(char)) {
      while (cursor < source.length && /[A-Za-z_0-9\u0080-\uffff]/.test(source[cursor])) cursor++;
    } else {
      if (source[cursor] === '-') cursor++;
      while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor++;
      if (source[cursor] === '.') {
        cursor++;
        while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor++;
      }
    }
    if (cursor === start || (cursor === start + 1 && char === '-')) throw new Error('DOT 包含无效语法标记');
    push({value: source.slice(start, cursor), id: true, bare: true});
  }

  let position = 0;
  const nodes = new Set<string>();
  const subgraphs = new Map<string, Set<string>>();
  const children = new Map<Set<string>, Set<Set<string>>>();
  const requests: [Set<string>, Set<string>][] = [];
  const peek = () => tokens[position]?.value;
  const take = (value: string) => {
    if (peek() !== value) throw new Error(`DOT 缺少 ${value}`);
    position++;
  };
  const keyword = (value: string) => tokens[position]?.bare && peek()?.toLowerCase() === value;
  const id = (): string => {
    if (!tokens[position]?.id) throw new Error('DOT 缺少标识符');
    const first = tokens[position];
    // cgraph scan.l decodes only escaped quotes and backslash-newline.
    // Backslash pairs remain pairs; HTML atoms lose their outer angle brackets.
    // grammar.y permits concatenation of any quoted/HTML atoms, but not bare IDs.
    let value = '';
    do {
      const part = tokens[position++].value;
      value += part.startsWith('"')
        ? part.slice(1, -1).replace(/\\(?:"|\\|\n)/g, escape => escape === '\\"' ? '"' : escape === '\\\n' ? '' : escape)
        : part.startsWith('<') ? part.slice(1, -1) : part;
      if (peek() !== '+') break;
      if (first.bare || !tokens[position + 1]?.id || tokens[position + 1].bare) throw new Error('DOT 字符串连接无效');
      position++;
    } while (position < tokens.length);
    return value;
  };
  const attributes = () => {
    while (peek() === '[') {
      position++;
      while (peek() !== ']') {
        if (position >= tokens.length || peek() === '{' || peek() === '}') throw new Error('DOT 属性列表无效');
        position++;
      }
      position++;
    }
  };
  const merge = (target: Set<string>, incoming: Set<string>) => {
    for (const name of incoming) target.add(name);
  };
  const block = (depth: number, members: Set<string>): Set<string> => {
    if (depth > MAX_DEPTH) throw new Error('DOT 子图嵌套超过 64 层');
    take('{');
    while (peek() !== '}') {
      if (position >= tokens.length) throw new Error('DOT 子图未结束');
      if (peek() === ';' || peek() === ',') { position++; continue; }
      if ((keyword('graph') || keyword('node') || keyword('edge')) && tokens[position + 1]?.value === '[') {
        position++; attributes(); continue;
      }
      if (tokens[position]?.id && !keyword('subgraph')) {
        const start = position;
        id();
        if (peek() === '=') { position++; id(); continue; }
        position = start;
      }
      let left = endpoint(depth);
      merge(members, left);
      let descendants = children.get(members);
      if (!descendants) { descendants = new Set(); children.set(members, descendants); }
      descendants.add(left);
      while (peek() === '->' || peek() === '--') {
        position++;
        const right = endpoint(depth);
        // Count against final memberships below, including reopened nested subgraphs.
        requests.push([left, right]);
        merge(members, right);
        descendants.add(right);
        left = right;
      }
      attributes();
    }
    position++;
    return members;
  };
  const endpoint = (depth: number): Set<string> => {
    if (peek() === '{' || keyword('subgraph')) {
      let name: string | undefined;
      if (keyword('subgraph')) {
        position++;
        if (tokens[position]?.id) name = id();
      }
      const members = name !== undefined ? (subgraphs.get(name) ?? new Set<string>()) : new Set<string>();
      if (name !== undefined) {
        if (!subgraphs.has(name) && subgraphs.size >= DOT_MAX_NODES) throw new Error('DOT 超过 1000 个命名子图');
        subgraphs.set(name, members);
      }
      // Older Graphviz syntax also permits references to a previously named subgraph.
      if (peek() !== '{') {
        if (name === undefined) throw new Error('DOT 缺少子图');
        return members;
      }
      return block(depth + 1, members);
    }
    const members = new Set<string>();
    do {
      const name = id();
      nodes.add(name);
      if (nodes.size > DOT_MAX_NODES) throw new Error('DOT 超过 1000 个节点');
      members.add(name);
      if (peek() === ':') { position++; id(); if (peek() === ':') { position++; id(); } }
      if (peek() !== ',') break;
      position++;
    } while (position < tokens.length);
    return members;
  };
  if (keyword('strict')) position++;
  if (!keyword('graph') && !keyword('digraph')) throw new Error('DOT 必须以 graph 或 digraph 开始');
  position++;
  if (tokens[position]?.id) id();
  block(0, new Set());
  if (position !== tokens.length) throw new Error('DOT 只能包含一个图');
  // Graphviz propagates nodes from reopened nested subgraphs to their ancestors.
  // Final memberships conservatively bound even edges declared before later additions.
  const visiting = new Set<Set<string>>();
  const completed = new Set<Set<string>>();
  const expand = (members: Set<string>, depth: number): void => {
    if (completed.has(members)) return;
    if (depth > MAX_DEPTH || visiting.has(members)) throw new Error('DOT 子图关系过深或循环');
    visiting.add(members);
    for (const child of children.get(members) ?? []) {
      expand(child, depth + 1);
      merge(members, child);
    }
    visiting.delete(members);
    completed.add(members);
  };
  for (const members of children.keys()) expand(members, 0);
  let edges = 0;
  for (const [left, right] of requests) {
    edges += left.size * right.size;
    if (edges > DOT_MAX_EDGES) throw new Error('DOT 展开后超过 10000 条边');
  }
  return {nodes: nodes.size, edges};
}

