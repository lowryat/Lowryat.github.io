/**
 * Specimen Generator — Realistic Fire Agate
 * ==========================================
 * Generates a 3D voxel grid modeled after real fire agate specimens.
 *
 * Based on observation of actual stones, the key structural features are:
 *
 *   1. IRREGULAR OUTER SHAPE — not a sphere; lumpy, organic form
 *   2. MULTIPLE BOTRYOIDAL DOMES — grape-like chalcedony clusters of varying
 *      sizes (one primary dome, several smaller "bubble" domes)
 *   3. MATRIX FILLS VALLEYS — tan/cream matrix sits between and around domes,
 *      not just as a uniform outer shell
 *   4. MULTIPLE FIRE BANDS — thin iron oxide layers at different depths within
 *      each dome, following the dome contour
 *   5. FIRE COLOUR VARIES — different domes/depths produce different hues
 *      (ruby red, burnt orange, amber, occasional green)
 *   6. CHALCEDONY IS AMBER/HONEY — not pale blue; ranges from smoky brown
 *      to warm amber depending on thickness
 *
 * Generation algorithm:
 *   1. Place 4–8 dome centres within the specimen volume
 *   2. Each dome has its own radius, position, and fire colour
 *   3. For each voxel, find the nearest dome and compute distance to its surface
 *   4. Assign material based on distance from the dome surface:
 *      - Far outside all domes → air (if outside specimen) or matrix (if inside)
 *      - Just outside a dome → matrix (ridge between domes)
 *      - Dome surface → chalcedony
 *      - At specific depths within dome → fire bands
 *      - Deep inside dome → more chalcedony / inner matrix core
 */

import type { Voxel, MaterialType } from '../types';
import { GRID_SIZE } from '../constants';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random helpers (no dependencies)
// ---------------------------------------------------------------------------

function hash3d(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

/** Seeded random number generator for reproducible specimens. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Smooth noise via trilinear interpolation. */
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

  const lerp = (a: number, b: number, t: number) => a + t * (b - a);

  const c000 = hash3d(x0, y0, z0);
  const c100 = hash3d(x0 + 1, y0, z0);
  const c010 = hash3d(x0, y0 + 1, z0);
  const c110 = hash3d(x0 + 1, y0 + 1, z0);
  const c001 = hash3d(x0, y0, z0 + 1);
  const c101 = hash3d(x0 + 1, y0, z0 + 1);
  const c011 = hash3d(x0, y0 + 1, z0 + 1);
  const c111 = hash3d(x0 + 1, y0 + 1, z0 + 1);

  const c00 = lerp(c000, c100, fx);
  const c10 = lerp(c010, c110, fx);
  const c01 = lerp(c001, c101, fx);
  const c11 = lerp(c011, c111, fx);
  const c0 = lerp(c00, c10, fy);
  const c1 = lerp(c01, c11, fy);
  return lerp(c0, c1, fz);
}

// ---------------------------------------------------------------------------
// Dome definition — each dome is a botryoidal chalcedony hemisphere
// ---------------------------------------------------------------------------

interface Dome {
  /** Centre position in grid coordinates */
  cx: number;
  cy: number;
  cz: number;
  /** Outer radius of the dome (chalcedony surface) */
  radius: number;
  /** How many fire bands this dome contains (1–3) */
  fireBandCount: number;
  /** Base fire hue for this dome (0–1 in HSL space) */
  baseFireHue: number;
  /** Unique ID for this dome */
  id: number;
}

// ---------------------------------------------------------------------------
// Fire band depths — where fire layers sit relative to dome surface
// ---------------------------------------------------------------------------

/**
 * Fire bands sit at specific depths below the dome's outer surface.
 * Each band is ~1 voxel thick. In real stones, these are nano-thin
 * iron oxide layers deposited during formation.
 *
 * Band depths per dome (distance inward from dome surface in grid units):
 *   Band 0: 2–3 units in (shallow — first to be exposed)
 *   Band 1: 4–5 units in (mid-depth)
 *   Band 2: 6–7 units in (deep — rarely reached without destroying upper bands)
 */
function getFireBandDepths(dome: Dome, rng: () => number): number[] {
  const depths: number[] = [];
  for (let i = 0; i < dome.fireBandCount; i++) {
    depths.push(2 + i * 2.2 + rng() * 0.8);
  }
  return depths;
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

export function generateSpecimen(): Voxel[] {
  const grid: Voxel[] = new Array(GRID_SIZE * GRID_SIZE * GRID_SIZE);
  const half = GRID_SIZE / 2;
  const rng = seededRandom(42);

  // ---- Step 1: Generate dome cluster ----
  // Place domes in a cluster. One large primary dome + several smaller ones.
  const domes: Dome[] = [];

  // Primary dome — large, central, this is the showcase
  domes.push({
    cx: half + (rng() - 0.5) * 3,
    cy: half + (rng() - 0.5) * 2,
    cz: half + (rng() - 0.5) * 3,
    radius: 8 + rng() * 2,   // 8–10 grid units
    fireBandCount: 3,
    baseFireHue: 0.02 + rng() * 0.04,  // deep red to orange-red
    id: 0,
  });

  // Secondary domes — medium, clustered around the primary
  const numSecondary = 3 + Math.floor(rng() * 3); // 3–5
  for (let i = 0; i < numSecondary; i++) {
    const angle = rng() * Math.PI * 2;
    const tilt = rng() * Math.PI * 0.6 + 0.2;
    const dist = 6 + rng() * 5;
    domes.push({
      cx: half + dist * Math.sin(tilt) * Math.cos(angle),
      cy: half + dist * Math.cos(tilt) * 0.7,
      cz: half + dist * Math.sin(tilt) * Math.sin(angle),
      radius: 4 + rng() * 3,  // 4–7 grid units
      fireBandCount: 1 + Math.floor(rng() * 2), // 1–2
      baseFireHue: rng() * 0.12,  // red through orange
      id: i + 1,
    });
  }

  // Tiny bubble domes — small, scattered
  const numBubbles = 3 + Math.floor(rng() * 4); // 3–6
  for (let i = 0; i < numBubbles; i++) {
    const angle = rng() * Math.PI * 2;
    const tilt = rng() * Math.PI;
    const dist = 4 + rng() * 8;
    domes.push({
      cx: half + dist * Math.sin(tilt) * Math.cos(angle),
      cy: half + dist * Math.cos(tilt),
      cz: half + dist * Math.sin(tilt) * Math.sin(angle),
      radius: 2 + rng() * 2.5, // 2–4.5 grid units
      fireBandCount: 1,
      baseFireHue: rng() < 0.15 ? 0.28 + rng() * 0.08 : rng() * 0.1, // rare green, usually red/orange
      id: numSecondary + i + 1,
    });
  }

  // Pre-compute fire band depths for each dome
  const domeBandDepths = domes.map(d => getFireBandDepths(d, rng));

  // ---- Step 2: Determine the specimen outer boundary ----
  // The outer boundary is an irregular shape that encloses all domes
  // plus a shell of matrix. Uses noise for organic variation.
  const OUTER_RADIUS = 14;     // max extent from centre
  const MATRIX_SHELL = 2.5;    // matrix thickness over dome surfaces

  // ---- Step 3: Fill the grid ----
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        const idx = x * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + z;

        // Distance from grid centre (for outer boundary)
        const dx = x - half;
        const dy = y - half;
        const dz = z - half;
        const distFromCentre = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Organic noise for outer boundary
        const outerNoise = smoothNoise(x, y, z, 5) * 3 - 1.5;
        const outerBound = OUTER_RADIUS + outerNoise;

        // Outside the specimen entirely → air
        if (distFromCentre > outerBound) {
          grid[idx] = { material: 'air', roughness: 0, integrity: 0, depth: 0, domeId: -1, fireHue: 0 };
          continue;
        }

        // ---- Find relationship to nearest dome ----
        let nearestDomeId = -1;
        let nearestDomeDist = Infinity;  // distance from dome surface (negative = inside)
        let nearestDome: Dome | null = null;

        for (let di = 0; di < domes.length; di++) {
          const d = domes[di];
          const ddx = x - d.cx;
          const ddy = y - d.cy;
          const ddz = z - d.cz;
          const distToCentre = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);

          // Distance from dome surface (positive = outside dome, negative = inside)
          const distFromSurface = distToCentre - d.radius;

          if (distFromSurface < nearestDomeDist) {
            nearestDomeDist = distFromSurface;
            nearestDomeId = di;
            nearestDome = d;
          }
        }

        // ---- Assign material based on position relative to domes ----
        let material: MaterialType;
        let depth = 0;
        let domeId = -1;
        let fireHue = 0;

        // Add per-voxel noise for organic layer boundaries
        const layerNoise = smoothNoise(x * 2, y * 2, z * 2, 4) * 1.0 - 0.5;

        if (nearestDome && nearestDomeDist < MATRIX_SHELL) {
          // This voxel is within or near a dome
          domeId = nearestDomeId;
          const surfaceDist = -nearestDomeDist + layerNoise * 0.5; // depth into dome
          depth = Math.max(0, surfaceDist);

          if (nearestDomeDist > 0.5) {
            // Outside the dome surface but within matrix shell → matrix between domes
            material = 'matrix';
          } else if (nearestDomeDist > -0.5) {
            // Right at the dome surface → outer chalcedony
            material = 'chalcedony';
          } else {
            // Inside the dome — check for fire bands
            const depthIntoDome = -nearestDomeDist;
            material = 'chalcedony'; // default: chalcedony inside dome

            // Check if we're at a fire band depth
            const bands = domeBandDepths[nearestDomeId];
            for (let bi = 0; bi < bands.length; bi++) {
              const bandDepth = bands[bi];
              const distFromBand = Math.abs(depthIntoDome - bandDepth + layerNoise * 0.3);

              if (distFromBand < 0.6) {
                // On a fire band!
                material = 'fire';
                // Fire hue shifts slightly with depth and position
                fireHue = nearestDome.baseFireHue + bi * 0.03 + layerNoise * 0.02;
                // Clamp to valid range and wrap
                fireHue = ((fireHue % 1) + 1) % 1;
                break;
              }
            }

            // Deep inside dome → inner core matrix
            if (depthIntoDome > nearestDome.radius * 0.85) {
              material = 'matrix';
            }
          }
        } else {
          // Far from any dome → matrix (fill between domes)
          material = 'matrix';
          domeId = -1;
        }

        // Roughness: matrix is rough, chalcedony starts semi-rough (needs polishing)
        const roughness = material === 'matrix' ? 0.85 + hash3d(x, y, z) * 0.15
          : material === 'fire' ? 0.3
          : 0.5; // chalcedony

        grid[idx] = {
          material,
          roughness,
          integrity: 1.0,
          depth,
          domeId,
          fireHue,
        };
      }
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Utilities (unchanged API, used throughout the codebase)
// ---------------------------------------------------------------------------

export function voxelIndex(x: number, y: number, z: number): number {
  return x * GRID_SIZE * GRID_SIZE + y * GRID_SIZE + z;
}

export function inBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE && z >= 0 && z < GRID_SIZE;
}
