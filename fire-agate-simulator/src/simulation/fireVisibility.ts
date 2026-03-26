/**
 * Fire Visibility Computation — Realistic Model
 * ===============================================
 * Determines how much "fire" is visible from the current viewing angle.
 *
 * Key improvement over the basic model: fire can be visible THROUGH
 * thin chalcedony, not just when directly exposed. This matches real
 * fire agate where the chalcedony dome acts as a translucent lens
 * over the fire layers beneath.
 *
 * Visibility depends on:
 *   1. Is the fire voxel exposed (adjacent to air) OR covered by
 *      thin chalcedony (≤3 voxels thick)?
 *   2. Is the light path clear of matrix?
 *   3. Is the view path clear of matrix?
 *   4. What's the angle between light/view directions and the surface normal?
 *   5. Surface roughness (polished chalcedony transmits more light)
 *   6. Chalcedony thickness above fire (thinner = more visible)
 */

import type { Voxel } from '../types';
import { GRID_SIZE } from '../constants';
import { voxelIndex, inBounds } from './specimenGenerator';

export interface FireVisibilityResult {
  score: number;
  exposureFraction: number;
  lightClearanceFraction: number;
  fireIntensityMap: Map<number, number>;
}

/** Check if a voxel is directly exposed (adjacent to air). */
function isExposed(grid: Voxel[], x: number, y: number, z: number): boolean {
  const neighbors = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  for (const [dx, dy, dz] of neighbors) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (!inBounds(nx, ny, nz)) return true;
    if (grid[voxelIndex(nx, ny, nz)].material === 'air') return true;
  }
  return false;
}

/**
 * Check if fire is visible through thin chalcedony.
 * Traces outward from the fire voxel looking for the nearest air.
 * If only chalcedony (no matrix) lies between fire and air,
 * and the chalcedony is thin enough, fire is "translucently visible".
 *
 * Returns the chalcedony thickness (in voxels) to the nearest air,
 * or -1 if matrix blocks the path or chalcedony is too thick.
 */
function chalcedonyThicknessToAir(
  grid: Voxel[],
  x: number, y: number, z: number,
  maxDepth: number = 4
): number {
  const neighbors = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  // BFS outward up to maxDepth
  let minThickness = maxDepth + 1;

  for (const [dx, dy, dz] of neighbors) {
    let thickness = 0;
    let blocked = false;

    for (let step = 1; step <= maxDepth; step++) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      const nz = z + dz * step;

      if (!inBounds(nx, ny, nz)) {
        // Reached grid edge through chalcedony = visible
        break;
      }

      const mat = grid[voxelIndex(nx, ny, nz)].material;
      if (mat === 'air') {
        break; // Found air
      } else if (mat === 'matrix') {
        blocked = true;
        break; // Matrix blocks
      } else {
        thickness++; // chalcedony or fire
      }
    }

    if (!blocked && thickness < minThickness) {
      minThickness = thickness;
    }
  }

  return minThickness <= maxDepth ? minThickness : -1;
}

/** Estimate surface normal from air neighbors. */
function estimateNormal(
  grid: Voxel[],
  x: number, y: number, z: number
): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  const offsets = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  for (const [dx, dy, dz] of offsets) {
    const ax = x + dx, ay = y + dy, az = z + dz;
    if (!inBounds(ax, ay, az) || grid[voxelIndex(ax, ay, az)].material === 'air') {
      nx += dx;
      ny += dy;
      nz += dz;
    }
  }

  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

/** Ray march: returns true if path is clear of matrix. */
function isPathClear(
  grid: Voxel[],
  startX: number, startY: number, startZ: number,
  dirX: number, dirY: number, dirZ: number,
  maxSteps: number = 50
): boolean {
  let x = startX, y = startY, z = startZ;
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  if (len === 0) return false;
  const sx = dirX / len, sy = dirY / len, sz = dirZ / len;

  for (let i = 0; i < maxSteps; i++) {
    x += sx; y += sy; z += sz;
    const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
    if (!inBounds(ix, iy, iz)) return true;
    if (grid[voxelIndex(ix, iy, iz)].material === 'matrix') return false;
  }
  return true;
}

/**
 * Compute fire visibility for the entire specimen.
 * Now includes fire visible through thin chalcedony (translucent domes).
 */
export function computeFireVisibility(
  grid: Voxel[],
  lightDir: [number, number, number],
  viewDir: [number, number, number]
): FireVisibilityResult {
  let totalFireVoxels = 0;
  let visibleFireVoxels = 0;  // exposed OR visible through thin chalcedony
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

        // Check direct exposure OR translucent visibility through chalcedony
        const directlyExposed = isExposed(grid, x, y, z);
        let chalcThickness = -1;

        if (!directlyExposed) {
          chalcThickness = chalcedonyThicknessToAir(grid, x, y, z);
          if (chalcThickness < 0) continue; // not visible at all
        }

        visibleFireVoxels++;

        // Check light and view paths
        const lightClear = isPathClear(grid, x, y, z, lightDir[0], lightDir[1], lightDir[2]);
        const viewClear = isPathClear(grid, x, y, z, viewDir[0], viewDir[1], viewDir[2]);

        if (lightClear && viewClear) {
          clearPathVoxels++;

          const normal = estimateNormal(grid, x, y, z);

          const lightDot = Math.abs(
            normal[0] * lightDir[0] + normal[1] * lightDir[1] + normal[2] * lightDir[2]
          );
          const viewDot = Math.abs(
            normal[0] * viewDir[0] + normal[1] * viewDir[1] + normal[2] * viewDir[2]
          );

          // Angle factors (thin-film interference peaks at moderate angles)
          const lightAngleFactor = Math.sin(Math.acos(Math.min(1, lightDot)) * 1.2);
          const viewAngleFactor = Math.sin(Math.acos(Math.min(1, viewDot)) * 1.2);

          // Roughness penalty
          const roughnessPenalty = 1 - voxel.roughness * 0.6;

          // Chalcedony attenuation: fire seen through chalcedony is dimmer
          // Directly exposed fire = full brightness
          // Through 1 voxel chalcedony = 70% brightness
          // Through 3 voxels = 30% brightness
          const chalcAttenuation = directlyExposed
            ? 1.0
            : Math.max(0.15, 1.0 - (chalcThickness * 0.25));

          const visibility = lightAngleFactor * viewAngleFactor * roughnessPenalty * chalcAttenuation;
          totalVisibility += visibility;
          fireIntensityMap.set(idx, visibility);
        }
      }
    }
  }

  const maxPossible = Math.max(totalFireVoxels, 1);
  const score = Math.min(100, (totalVisibility / maxPossible) * 200);

  return {
    score,
    exposureFraction: totalFireVoxels > 0 ? visibleFireVoxels / totalFireVoxels : 0,
    lightClearanceFraction: visibleFireVoxels > 0 ? clearPathVoxels / visibleFireVoxels : 0,
    fireIntensityMap,
  };
}
