import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Keep document content inside the surface, without styles, scripts or app controls. */
export function renderMarkdown(source: string): HTMLElement {
  const article = document.createElement('article');
  const fragment = DOMPurify.sanitize(marked.parse(source, {async: false, gfm: true}), {
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
  article.append(fragment);
  return article;
}
