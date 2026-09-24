let initialScene: unknown;

export function captureOwner(token: string): string | undefined {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('owner');
  if (fromHash) {
    sessionStorage.setItem(`blind.owner.${token}`, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return fromHash ?? sessionStorage.getItem(`blind.owner.${token}`) ?? undefined;
}

export function setInitialScene(scene: unknown): void { initialScene = scene; }

export function takeInitialScene<T>(): T | undefined {
  const scene = initialScene as T | undefined;
  initialScene = undefined;
  return scene;
}
