/**
 * Fire Visibility Computation
 * ===========================
 * Determines how much "fire" is visible from the current viewing angle,
 * given the light source position and the state of the voxel grid.
 *
 * Real fire agate shows colour through thin-film interference:
 *   - Light enters through chalcedony
 *   - Reflects off nano-thin iron oxide layers
 *   - Colour depends on layer thickness AND the angle of incidence
 *
 * Our simplified model:
 *   1. For each exposed fire voxel, cast a ray toward the light source
 *      and a ray toward the camera.
 *   2. If either ray is blocked by matrix, fire is not visible.
 *   3. If both rays are clear, compute visibility based on:
 *      - The angle between light direction and surface normal
 *      - The angle between view direction and surface normal
 *      - Surface roughness (rough surfaces scatter light, reducing fire)
 *   4. Sum contributions to get an overall fire visibility score.
 */

import type { Voxel } from '../types';
import { GRID_SIZE } from '../constants';
import { voxelIndex, inBounds } from './specimenGenerator';

/**
 * Result of the fire visibility analysis.
 */
export interface FireVisibilityResult {
  /** Overall score 0–100. */
  score: number;
  /** Fraction of fire voxels that are surface-exposed. */
  exposureFraction: number;
  /** Fraction of exposed fire voxels with clear light paths. */
  lightClearanceFraction: number;
  /** Per-voxel fire intensity (used for rendering glow). Sparse map: index → intensity. */
  fireIntensityMap: Map<number, number>;
}

/**
 * Check if a voxel is "exposed" — adjacent to at least one air voxel.
 * Only exposed fire voxels can be seen.
 */
function isExposed(grid: Voxel[], x: number, y: number, z: number): boolean {
  const neighbors = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  for (const [dx, dy, dz] of neighbors) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!inBounds(nx, ny, nz)) return true; // edge of grid = exposed
    if (grid[voxelIndex(nx, ny, nz)].material === 'air') return true;
  }
  return false;
}

/**
 * Estimate the surface normal at a voxel by looking at which neighbors are air.
 * The normal points away from solid material toward air.
 */
function estimateNormal(
  grid: Voxel[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;

  const offsets = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  for (const [dx, dy, dz] of offsets) {
    const ax = x + dx;
    const ay = y + dy;
    const az = z + dz;
    if (!inBounds(ax, ay, az) || grid[voxelIndex(ax, ay, az)].material === 'air') {
      // This direction faces air — contributes to normal
      nx += dx;
      ny += dy;
      nz += dz;
    }
  }

  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 1, 0]; // fallback: point up
  return [nx / len, ny / len, nz / len];
}

/**
 * Cast a ray through the voxel grid using DDA (Digital Differential Analyzer).
 * Returns true if the ray reaches the grid boundary without hitting non-air,
 * non-fire, non-chalcedony material (i.e., matrix blocks the path).
 *
 * We allow the ray to pass through chalcedony (it's translucent) and air.
 * Only matrix blocks the light path.
 */
function isPathClear(
  grid: Voxel[],
  startX: number, startY: number, startZ: number,
  dirX: number, dirY: number, dirZ: number,
  maxSteps: number = 50
): boolean {
  let x = startX;
  let y = startY;
  let z = startZ;

  // Step size: move one voxel at a time along the ray
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  if (len === 0) return false;
  const stepX = dirX / len;
  const stepY = dirY / len;
  const stepZ = dirZ / len;

  for (let i = 0; i < maxSteps; i++) {
    x += stepX;
    y += stepY;
    z += stepZ;

    const ix = Math.round(x);
    const iy = Math.round(y);
    const iz = Math.round(z);

    // Exited grid → path is clear
    if (!inBounds(ix, iy, iz)) return true;

    const voxel = grid[voxelIndex(ix, iy, iz)];

    // Matrix blocks the path
    if (voxel.material === 'matrix') return false;

    // Air and chalcedony are transparent (simplified)
    // Fire voxels along the path don't block (they're thin films)
  }

  return true; // reached max steps without hitting matrix
}

/**
 * Compute fire visibility for the entire specimen.
 *
 * @param grid       - The voxel grid
 * @param lightDir   - Normalized direction FROM the specimen TOWARD the light
 * @param viewDir    - Normalized direction FROM the specimen TOWARD the camera
 */
export function computeFireVisibility(
  grid: Voxel[],
  lightDir: [number, number, number],
  viewDir: [number, number, number]
): FireVisibilityResult {
  let totalFireVoxels = 0;
  let exposedFireVoxels = 0;
  let clearPathVoxels = 0;
  let totalVisibility = 0;
  const fireIntensityMap = new Map<number, number>();

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        const idx = voxelIndex(x, y, z);
        const voxel = grid[idx];

        if (voxel.material !== 'fire') continue;
        totalFireVoxels++;

        // Is this fire voxel exposed (adjacent to air)?
        if (!isExposed(grid, x, y, z)) continue;
        exposedFireVoxels++;

        // Check light path: can light reach this voxel?
        const lightClear = isPathClear(grid, x, y, z, lightDir[0], lightDir[1], lightDir[2]);

        // Check view path: can the viewer see this voxel?
        const viewClear = isPathClear(grid, x, y, z, viewDir[0], viewDir[1], viewDir[2]);

        if (lightClear && viewClear) {
          clearPathVoxels++;

          // Compute angle-dependent visibility
          const normal = estimateNormal(grid, x, y, z);

          // Dot product of light direction with surface normal
          const lightDot = Math.abs(
            normal[0] * lightDir[0] + normal[1] * lightDir[1] + normal[2] * lightDir[2]
          );

          // Dot product of view direction with surface normal
          const viewDot = Math.abs(
            normal[0] * viewDir[0] + normal[1] * viewDir[1] + normal[2] * viewDir[2]
          );

          // Fire visibility is best when both light and view are at moderate angles
          // (thin-film interference is angle-dependent)
          // Peak visibility around 30-60 degrees from normal
          const lightAngleFactor = Math.sin(Math.acos(Math.min(1, lightDot)) * 1.2);
          const viewAngleFactor = Math.sin(Math.acos(Math.min(1, viewDot)) * 1.2);

          // Roughness penalty: rough surfaces scatter light and reduce fire visibility
          const roughnessPenalty = 1 - voxel.roughness * 0.6;

          // Combined visibility for this voxel
          const visibility = lightAngleFactor * viewAngleFactor * roughnessPenalty;
          totalVisibility += visibility;
          fireIntensityMap.set(idx, visibility);
        }
      }
    }
  }

  // Normalize score to 0–100
  const maxPossible = Math.max(totalFireVoxels, 1);
  const score = Math.min(100, (totalVisibility / maxPossible) * 200);

  return {
    score,
    exposureFraction: totalFireVoxels > 0 ? exposedFireVoxels / totalFireVoxels : 0,
    lightClearanceFraction: exposedFireVoxels > 0 ? clearPathVoxels / exposedFireVoxels : 0,
    fireIntensityMap,
  };
}
