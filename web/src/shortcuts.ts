export interface Shortcut {
  key: string;
  shift?: boolean;
  run: () => void | Promise<void>;
}

/** Scene shortcuts only run when the page, rather than editable content, owns Copy. */
export function installShortcuts(shortcuts: readonly Shortcut[], enabled: () => boolean): void {
  window.addEventListener('keydown', event => {
    const macOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
    const modifier = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!enabled() || event.defaultPrevented || event.repeat || event.altKey || !modifier) return;
    if (document.querySelector('dialog[open]') || window.getSelection()?.toString()) return;
    if (event.composedPath().some(node => node instanceof HTMLElement &&
      (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"]')))) return;
    const shortcut = shortcuts.find(item => item.key === event.key.toLowerCase() && !!item.shift === event.shiftKey);
    if (!shortcut) return;
    event.preventDefault();
    void shortcut.run();
  });
}
