/**
 * Light Path Analysis
 * ===================
 * Visualizes and computes how light travels through the specimen.
 *
 * For educational purposes, we trace rays from the light source through
 * the grid and mark which voxels they pass through. This helps the user
 * understand why certain areas show fire and others don't.
 *
 * The light path system produces:
 *   1. A "clearance" score: what fraction of fire voxels have unblocked paths
 *   2. A set of blocked fire voxel indices (for highlighting in the UI)
 *   3. A set of blocking matrix voxel indices (showing what to remove)
 */

import type { Voxel } from '../types';
import { GRID_SIZE } from '../constants';
import { voxelIndex, inBounds } from './specimenGenerator';

export interface LightPathResult {
  /** Fraction of fire voxels with clear light paths (0–1). */
  clearance: number;
  /** Fire voxel indices that have blocked light paths. */
  blockedFireVoxels: Set<number>;
  /** Matrix voxel indices that are blocking light to fire voxels. */
  blockingMatrixVoxels: Set<number>;
}

/**
 * Trace a ray from a fire voxel toward the light source.
 * Returns the index of the first matrix voxel that blocks the path,
 * or -1 if the path is clear.
 */
function traceToLight(
  grid: Voxel[],
  startX: number, startY: number, startZ: number,
  lightDirX: number, lightDirY: number, lightDirZ: number
): number {
  let x = startX;
  let y = startY;
  let z = startZ;

  const len = Math.sqrt(lightDirX * lightDirX + lightDirY * lightDirY + lightDirZ * lightDirZ);
  if (len === 0) return -1;

  const sx = lightDirX / len;
  const sy = lightDirY / len;
  const sz = lightDirZ / len;

  for (let step = 0; step < 50; step++) {
    x += sx;
    y += sy;
    z += sz;

    const ix = Math.round(x);
    const iy = Math.round(y);
    const iz = Math.round(z);

    if (!inBounds(ix, iy, iz)) return -1; // reached edge, path is clear

    const voxel = grid[voxelIndex(ix, iy, iz)];
    if (voxel.material === 'matrix') {
      return voxelIndex(ix, iy, iz); // blocked by this matrix voxel
    }
  }

  return -1; // path clear (reached max steps)
}

/**
 * Analyze light paths for all exposed fire voxels.
 *
 * @param grid     - The voxel grid
 * @param lightDir - Direction FROM specimen TOWARD light source (normalized)
 */
export function analyzeLightPaths(
  grid: Voxel[],
  lightDir: [number, number, number]
): LightPathResult {
  const blockedFireVoxels = new Set<number>();
  const blockingMatrixVoxels = new Set<number>();
  let totalExposedFire = 0;
  let clearFire = 0;

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        const idx = voxelIndex(x, y, z);
        if (grid[idx].material !== 'fire') continue;

        // Check if this fire voxel is exposed (adjacent to air)
        let exposed = false;
        const neighbors = [
          [1, 0, 0], [-1, 0, 0],
          [0, 1, 0], [0, -1, 0],
          [0, 0, 1], [0, 0, -1],
        ];
        for (const [dx, dy, dz] of neighbors) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!inBounds(nx, ny, nz) || grid[voxelIndex(nx, ny, nz)].material === 'air') {
            exposed = true;
            break;
          }
        }

        if (!exposed) continue;
        totalExposedFire++;

        // Trace ray toward light
        const blocker = traceToLight(grid, x, y, z, lightDir[0], lightDir[1], lightDir[2]);

        if (blocker >= 0) {
          blockedFireVoxels.add(idx);
          blockingMatrixVoxels.add(blocker);
        } else {
          clearFire++;
        }
      }
    }
  }

  return {
    clearance: totalExposedFire > 0 ? clearFire / totalExposedFire : 0,
    blockedFireVoxels,
    blockingMatrixVoxels,
  };
}
