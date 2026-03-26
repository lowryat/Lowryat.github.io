/**
 * Undercut Analysis
 * =================
 * Detects when chalcedony domes or fire-bearing zones are at risk of
 * collapse because supporting material beneath them has been removed.
 *
 * In real lapidary work, "undercutting" is one of the biggest risks:
 *   - Fire agate has layers that follow curved (botryoidal) surfaces
 *   - If you remove too much matrix from under a dome, the chalcedony
 *     and fire layer above become unsupported
 *   - Unsupported areas can crack, crumble, or fall away
 *
 * Our simplified model:
 *   For each non-air voxel (chalcedony or fire), count how many of
 *   its lower neighbors (below and around it) are air vs. solid.
 *   If the ratio of air-to-solid is too high, the voxel is "undercut".
 *
 * "Below" is defined as the -Y direction (gravity points down).
 */

import type { Voxel, SimulationWarning } from '../types';
import { GRID_SIZE, UNDERCUT_WARNING_THRESHOLD, UNDERCUT_DANGER_THRESHOLD } from '../constants';
import { voxelIndex, inBounds } from './specimenGenerator';

export interface UndercutResult {
  /** Overall undercut risk score 0–100. */
  riskScore: number;
  /** Number of voxels classified as undercut. */
  undercutCount: number;
  /** Set of voxel indices that are undercut (for visual highlighting). */
  undercutVoxels: Set<number>;
  /** Generated warnings. */
  warnings: SimulationWarning[];
}

/**
 * Analyze the full grid for undercut risk.
 *
 * For each chalcedony or fire voxel, we check support from below:
 *   - The 5 voxels in the -Y hemisphere (directly below and 4 diagonal-below)
 *   - If most of these are air, the voxel is undercut
 */
export function analyzeUndercut(grid: Voxel[]): UndercutResult {
  const undercutVoxels = new Set<number>();
  let totalVulnerable = 0; // chalcedony + fire voxels that could be undercut

  // Support-check offsets: below and diagonally below
  const supportOffsets = [
    [0, -1, 0],   // directly below
    [1, -1, 0],   // below-right
    [-1, -1, 0],  // below-left
    [0, -1, 1],   // below-front
    [0, -1, -1],  // below-back
  ];

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        const idx = voxelIndex(x, y, z);
        const voxel = grid[idx];

        // Only check chalcedony and fire for undercut risk
        if (voxel.material !== 'chalcedony' && voxel.material !== 'fire') continue;
        totalVulnerable++;

        // Count how many support positions are air (unsupported)
        let airBelow = 0;
        let checkedPositions = 0;

        for (const [dx, dy, dz] of supportOffsets) {
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;

          if (!inBounds(nx, ny, nz)) {
            // Below the grid = no support
            airBelow++;
            checkedPositions++;
            continue;
          }

          checkedPositions++;
          const neighbor = grid[voxelIndex(nx, ny, nz)];
          if (neighbor.material === 'air') {
            airBelow++;
          }
        }

        // If more than 60% of support positions are air, this voxel is undercut
        if (checkedPositions > 0 && airBelow / checkedPositions > 0.6) {
          undercutVoxels.add(idx);
        }
      }
    }
  }

  // Compute overall risk score (0–100)
  const riskScore = totalVulnerable > 0
    ? Math.min(100, (undercutVoxels.size / totalVulnerable) * 300)
    : 0;

  // Generate warnings
  const warnings: SimulationWarning[] = [];
  const now = Date.now();

  if (riskScore > UNDERCUT_DANGER_THRESHOLD) {
    warnings.push({
      id: `undercut-danger-${now}`,
      message: `DANGER: Severe undercutting detected (${Math.round(riskScore)}%). Chalcedony domes may collapse!`,
      severity: 'danger',
      timestamp: now,
    });
  } else if (riskScore > UNDERCUT_WARNING_THRESHOLD) {
    warnings.push({
      id: `undercut-warn-${now}`,
      message: `Undercut risk increasing (${Math.round(riskScore)}%). Consider preserving more support material.`,
      severity: 'warning',
      timestamp: now,
    });
  }

  return {
    riskScore,
    undercutCount: undercutVoxels.size,
    undercutVoxels,
    warnings,
  };
}
