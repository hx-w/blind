import type { PublicScene } from '../api';
import { OperationError } from '../operations/core';

/** Dimension follows authored public structure, never visibility or saved camera shape. */
export function resolveViewportMode(scene: PublicScene): 'board' | 'spatial' {
  const policy = scene.state.viewport.mode;
  let spatial = false;
  let planeZ: number | undefined;
  for (const entity of scene.entities) {
    if (entity.placement === 'panel') continue;
    if (entity.source.kind === 'mesh' || entity.renderer?.capabilities.host_space === 'spatial') spatial = true;
    const z = entity.position?.[2] ?? 0;
    if (planeZ === undefined) planeZ = z;
    else if (Math.abs(z - planeZ) > 1e-6) spatial = true;
  }
  if (policy === 'board' && spatial) throw new OperationError('INVALID_ARGUMENT', 'Board mode cannot contain world geometry, spatial plugins, or noncoplanar authored positions', {field: 'state.viewport.mode'});
  return policy === 'spatial' || spatial ? 'spatial' : 'board';
}
