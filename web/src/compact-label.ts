/** Keep both ends of a long label while leaving its full value untouched. */
export function compactLabel(value: string, fits: (text: string) => boolean): string {
  if (fits(value)) return value;
  const characters = Array.from(value);
  for (let count = characters.length - 1; count >= 2; count--) {
    const head = Math.min(count - 1, Math.ceil(count * .62));
    const tail = count - head;
    const candidate = `${characters.slice(0, head).join('')}…${characters.slice(-tail).join('')}`;
    if (fits(candidate)) return candidate;
  }
  return '…';
}
