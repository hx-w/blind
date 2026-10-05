import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import { renderDiagram } from './graph.ts';
import type { DiagramKind } from './graph.ts';
import './diagram.css';

const readiness = new WeakMap<HTMLElement, Promise<void>>();
export function markdownReady(article: HTMLElement): Promise<void> {
  return readiness.get(article) ?? Promise.resolve();
}

/** Keep document content inside the surface, without styles, scripts or app controls. */
export function renderMarkdown(source: string, signal?: AbortSignal): HTMLElement {
  const article = document.createElement('article');
  const diagrams: {placeholder: string; kind: DiagramKind; source: string}[] = [];
  const renderer = new Renderer();
  const ordinaryCode = renderer.code.bind(renderer);
  renderer.code = token => {
    const language = token.lang?.trim().split(/\s+/)[0].toLowerCase();
    if (language !== 'mermaid' && language !== 'dot' && language !== 'gv' && language !== 'graphviz') return ordinaryCode(token);
    const placeholder = `blind-diagram-${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-')}`;
    diagrams.push({placeholder, kind: language === 'mermaid' ? 'mermaid' : 'dot', source: token.text});
    return `<pre><code>${placeholder}</code></pre>`;
  };
  const fragment = DOMPurify.sanitize(marked.parse(source, {async: false, gfm: true, renderer}), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
      'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'input', 'sup', 'sub', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll('a')) {
    // Relative paths are not bundled with a shared Markdown attachment.
    if (!/^(https?:\/\/|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else input.disabled = true;
  }
  for (const image of fragment.querySelectorAll('img')) {
    // Self-contained raster images keep browser review and isolated PNG export identical.
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(image.getAttribute('src') ?? '')) {
      image.replaceWith(document.createTextNode(image.alt || '图片未嵌入'));
    }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const scroll = document.createElement('div'); scroll.className = 'markdown-table'; scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '表格');
    table.replaceWith(scroll); scroll.append(table);
  }
  const renders: Promise<void>[] = [];
  for (const diagram of diagrams) {
    const code = [...fragment.querySelectorAll('pre > code')].find(code => code.textContent === diagram.placeholder);
    if (!code?.parentElement) continue;
    const figure = document.createElement('figure');
    figure.className = 'markdown-diagram';
    figure.tabIndex = 0;
    figure.setAttribute('role', 'region');
    figure.setAttribute('aria-label', diagram.kind === 'dot' ? 'Graphviz 图表' : 'Mermaid 图表');
    figure.textContent = '正在绘制图表…';
    code.parentElement.replaceWith(figure);
    renders.push(renderDiagram(diagram.kind, diagram.source, signal).then(svg => {
      const box = svg.viewBox.baseVal;
      svg.style.width = `${box.width}px`;
      svg.style.height = `${box.height}px`;
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', figure.getAttribute('aria-label')!);
      figure.replaceChildren(svg);
    }).catch(error => {
      figure.classList.add('diagram-error');
      figure.textContent = `图表无法绘制：${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }));
  }
  article.append(fragment);
  const ready = Promise.all(renders).then(async () => { await document.fonts.ready; });
  readiness.set(article, ready);
  // Synchronous callers still see errors in the document, without an unhandled rejection.
  void ready.catch(() => {});
  return article;
}
