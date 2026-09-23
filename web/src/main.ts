import './styles.css';

const token = location.pathname.match(/\/(?:s|v)\/([^/]+)$/)?.[1];
const params = new URLSearchParams(location.search);
const childView = params.has('embedded') || params.has('render');

if (token && !childView) {
  try {
    const response = await fetch(`api/v1/scenes/${token}`, {cache: 'no-store'});
    const payload = response.ok ? await response.json() as {kind?: string} : null;
    if (payload?.kind === 'collection') await import('./collection');
    else await import('./single');
  } catch {
    await import('./single');
  }
} else {
  await import('./single');
}
