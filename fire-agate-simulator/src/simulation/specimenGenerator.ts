/**
 * Specimen Generator
 * ==================
 * Generates a 3D voxel grid representing a fire agate specimen.
 *
 * Structure (from outside in):
 *   1. Matrix (host rock) — outermost layer
 *   2. Chalcedony — translucent protective dome
 *   3. Fire layer — ultra-thin iridescent band
 *   4. More chalcedony / matrix in the core
 *
 * The layers follow botryoidal (grape-like) shapes created by
 * summing several offset sine-based "bumps" to produce an organic,
 * dome-covered surface.
 */

import type { Voxel, MaterialType } from '../types';
import {
  GRID_SIZE,
  SPECIMEN_RADIUS,
  CHALCEDONY_THICKNESS,
  FIRE_THICKNESS,
} from '../constants';

// ---------------------------------------------------------------------------
// Simple pseudo-random noise (deterministic, no dependencies)
// ---------------------------------------------------------------------------

/**
 * A basic 3D hash function that returns a value in [0, 1].
 * Used to add organic variation to layer boundaries.
 * This is NOT cryptographic — just enough for visual noise.
 */
function hash3d(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

/**
 * Smooth noise via trilinear interpolation of hash values.
 * `scale` controls the frequency of variation.
 */
function smoothNoise(x: number, y: number, z: number, scale: number): number {
  const sx = x / scale;
  const sy = y / scale;
  const sz = z / scale;

  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const z0 = Math.floor(sz);

  const fx = sx - x0;
  const fy = sy - y0;
  const fz = sz - z0;

  // Trilinear interpolation of 8 corner hash values
  const c000 = hash3d(x0, y0, z0);
  const c100 = hash3d(x0 + 1, y0, z0);
  const c010 = hash3d(x0, y0 + 1, z0);
  const c110 = hash3d(x0 + 1, y0 + 1, z0);
  const c001 = hash3d(x0, y0, z0 + 1);
  const c101 = hash3d(x0 + 1, y0, z0 + 1);
  const c011 = hash3d(x0, y0 + 1, z0 + 1);
  const c111 = hash3d(x0 + 1, y0 + 1, z0 + 1);

  const lerp = (a: number, b: number, t: number) => a + t * (b - a);

  const c00 = lerp(c000, c100, fx);
  const c10 = lerp(c010, c110, fx);
  const c01 = lerp(c001, c101, fx);
  const c11 = lerp(c011, c111, fx);

  const c0 = lerp(c00, c10, fy);
  const c1 = lerp(c01, c11, fy);

  return lerp(c0, c1, fz);
}

// ---------------------------------------------------------------------------
// Botryoidal surface generation
// ---------------------------------------------------------------------------

/**
 * Creates an array of "bump centres" that produce the characteristic
 * grape-like surface of real fire agate chalcedony domes.
 *
 * Each bump is a point slightly inside the specimen with a radius
 * of influence. The effective surface at any point is the maximum
 * of all bump contributions.
 */
interface Bump {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

function generateBumps(count: number, seed: number): Bump[] {
  const bumps: Bump[] = [];
  const half = GRID_SIZE / 2;

  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random placement on a sphere shell
    const phi = hash3d(i + seed, 0, 0) * Math.PI * 2;
    const theta = hash3d(0, i + seed, 0) * Math.PI;
    const r = SPECIMEN_RADIUS * (0.5 + hash3d(0, 0, i + seed) * 0.35);

    bumps.push({
      cx: half + r * Math.sin(theta) * Math.cos(phi),
      cy: half + r * Math.sin(theta) * Math.sin(phi),
      cz: half + r * Math.cos(theta),
      radius: 3 + hash3d(i, i, seed) * 4, // 3–7 grid units
    });
  }
  return bumps;
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

/**
 * Generate the full voxel grid for one fire agate specimen.
 *
 * Algorithm:
 *   1. Compute distance from each voxel to the grid centre.
 *   2. Add smooth noise to create organic surface variation.
 *   3. Add botryoidal bumps to the chalcedony boundary.
 *   4. Assign material based on distance thresholds:
 *      - Beyond outer radius → air
 *      - Outer shell → matrix
 *      - Next band → chalcedony
 *      - Thin band → fire layer
 *      - Core → chalcedony (fire sits between chalcedony layers)
 *
 * Returns a flat array indexed as grid[x][y][z] = grid[x * G*G + y * G + z].
 */
export function generateSpecimen(): Voxel[] {
  const grid: Voxel[] = new Array(GRID_SIZE * GRID_SIZE * GRID_SIZE);
  const half = GRID_SIZE / 2;

  // Pre-compute botryoidal bumps for the chalcedony layer
  const bumps = generateBumps(18, 42);

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        const idx = x * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + z;

        // Distance from centre
        const dx = x - half;
        const dy = y - half;
        const dz = z - half;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Add noise for organic variation (±1.5 grid units)
        const noise = smoothNoise(x, y, z, 6) * 3 - 1.5;

        // Botryoidal bump contribution: expand inward boundary near bumps
        let bumpContribution = 0;
        for (const b of bumps) {
          const bdx = x - b.cx;
          const bdy = y - b.cy;
          const bdz = z - b.cz;
          const bDist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz);
          if (bDist < b.radius) {
            // Smooth falloff
            const t = 1 - bDist / b.radius;
            bumpContribution = Math.max(bumpContribution, t * 2.5);
          }
        }

        // Effective distance (modified by noise and bumps)
        const effectiveDist = dist + noise - bumpContribution;

        // Determine material based on distance thresholds
        let material: MaterialType;

        const outerBoundary = SPECIMEN_RADIUS;
        const chalcedonyOuter = SPECIMEN_RADIUS - 2; // matrix shell ~2 units thick
        const fireOuter = chalcedonyOuter - CHALCEDONY_THICKNESS;
        const fireInner = fireOuter - FIRE_THICKNESS;

        if (effectiveDist > outerBoundary) {
          material = 'air';
        } else if (effectiveDist > chalcedonyOuter) {
          material = 'matrix';
        } else if (effectiveDist > fireOuter) {
          material = 'chalcedony';
        } else if (effectiveDist > fireInner) {
          material = 'fire';
        } else if (effectiveDist > 3) {
          // Inner core is more chalcedony with some matrix
          material = effectiveDist > fireInner - 2 ? 'chalcedony' : 'matrix';
        } else {
          material = 'matrix';
        }

        grid[idx] = {
          material,
          roughness: material === 'air' ? 0 : 0.5,
          integrity: material === 'air' ? 0 : 1.0,
        };
      }
    }
  }

  return grid;
}

/**
 * Utility: convert (x, y, z) to flat array index.
 */
export function voxelIndex(x: number, y: number, z: number): number {
  return x * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + z;
}

/**
 * Utility: check if coordinates are within the grid bounds.
 */
export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE && z >= 0 && z < GRID_SIZE;
}
