/**
 * Specimen Component — Realistic Fire Agate Rendering
 * ====================================================
 * Renders the voxel grid as instanced meshes in Three.js.
 *
 * Realism features based on real fire agate specimens:
 *
 *   1. CHALCEDONY TRANSLUCENCY — colour varies with depth:
 *      - Thin chalcedony: warm amber, partially see-through
 *      - Medium: honey brown
 *      - Thick: dark smoky brown (fire hidden beneath)
 *      - Polished (low roughness): brighter, glossier amber
 *
 *   2. MULTI-HUE FIRE — each fire voxel has its own hue:
 *      - Deep ruby red (most common)
 *      - Burnt orange
 *      - Amber/gold
 *      - Rare green flash
 *      Colour shifts with viewing angle (thin-film interference)
 *
 *   3. MATRIX VARIATION — cream/tan with darker spots and
 *      iron-stained reddish patches (not uniform dark brown)
 *
 *   4. SPECULAR HIGHLIGHTS — polished surfaces show glassy
 *      reflections like the real stones
 *
 * Performance: InstancedMesh per material, only surface voxels rendered.
 */

import { useRef, useMemo, useCallback } from 'react';
import { useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Voxel, ToolName } from '../types';
import {
  GRID_SIZE,
  VOXEL_SIZE,
  CHALCEDONY_THIN_DEPTH,
  CHALCEDONY_MEDIUM_DEPTH,
  CHALCEDONY_COLORS,
  MATRIX_COLORS,
} from '../constants';
import { voxelIndex, inBounds } from '../simulation/specimenGenerator';

interface SpecimenProps {
  grid: Voxel[];
  activeTool: ToolName;
  fireIntensityMap: Map<number, number>;
  undercutVoxels: Set<number>;
  onToolApply: (x: number, y: number, z: number) => void;
}

// Shared geometry — slightly rounded-looking cubes with small gaps between
const boxGeometry = new THREE.BoxGeometry(
  VOXEL_SIZE * 0.94,
  VOXEL_SIZE * 0.94,
  VOXEL_SIZE * 0.94
);

/** Check if a voxel is on the surface (adjacent to air). */
function isSurface(grid: Voxel[], x: number, y: number, z: number): boolean {
  const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of offsets) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (!inBounds(nx, ny, nz)) return true;
    if (grid[voxelIndex(nx, ny, nz)].material === 'air') return true;
  }
  return false;
}

/**
 * Count how many steps inward (through non-air) before hitting a fire voxel.
 * Used to determine chalcedony visual depth — thin chalcedony over fire
 * should look more amber and show the fire through.
 * Returns 0 if fire is directly adjacent, or a large number if no fire nearby.
 */
function distanceToNearestFire(grid: Voxel[], x: number, y: number, z: number): number {
  // Quick search in a small radius
  const searchR = 5;
  let minDist = searchR + 1;

  for (let dx = -searchR; dx <= searchR; dx++) {
    for (let dy = -searchR; dy <= searchR; dy++) {
      for (let dz = -searchR; dz <= searchR; dz++) {
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= minDist) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        if (grid[voxelIndex(nx, ny, nz)].material === 'fire') {
          minDist = dist;
        }
      }
    }
  }
  return minDist;
}

/** Grid coords → world position (centred at origin). */
function gridToWorld(x: number, y: number, z: number): [number, number, number] {
  const offset = (GRID_SIZE * VOXEL_SIZE) / 2;
  return [
    x * VOXEL_SIZE - offset,
    y * VOXEL_SIZE - offset,
    z * VOXEL_SIZE - offset,
  ];
}

/** World position → nearest grid coords. */
function worldToGrid(wx: number, wy: number, wz: number): [number, number, number] {
  const offset = (GRID_SIZE * VOXEL_SIZE) / 2;
  return [
    Math.round((wx + offset) / VOXEL_SIZE),
    Math.round((wy + offset) / VOXEL_SIZE),
    Math.round((wz + offset) / VOXEL_SIZE),
  ];
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** Deterministic per-voxel variation to avoid flat uniform look. */
function voxelVariation(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0xff) / 255; // 0–1
}

/**
 * Compute realistic matrix colour.
 * Varies between tan, dark brown, and iron-stained reddish patches.
 */
function matrixColor(x: number, y: number, z: number, isUndercut: boolean): THREE.Color {
  if (isUndercut) return new THREE.Color('#8b4040');

  const v = voxelVariation(x, y, z);
  const c = new THREE.Color();

  if (v < 0.3) {
    c.set(MATRIX_COLORS.base);
  } else if (v < 0.55) {
    c.set(MATRIX_COLORS.dark);
  } else if (v < 0.75) {
    c.set(MATRIX_COLORS.light);
  } else {
    c.set(MATRIX_COLORS.ironStain);
  }

  // Slight random brightness variation
  const brightness = 0.9 + v * 0.2;
  c.multiplyScalar(brightness);
  return c;
}

/**
 * Compute realistic chalcedony colour based on:
 *   - depth (how far from surface)
 *   - proximity to fire (fire beneath makes chalcedony glow warmer)
 *   - roughness (polished → brighter amber)
 *   - undercut status
 */
function chalcedonyColor(
  voxel: Voxel,
  x: number, y: number, z: number,
  fireDist: number,
  isUndercut: boolean
): THREE.Color {
  if (isUndercut) return new THREE.Color('#d4a0a0');

  const c = new THREE.Color();
  const depth = voxel.depth;

  // Base colour depends on depth
  if (depth < CHALCEDONY_THIN_DEPTH) {
    c.set(CHALCEDONY_COLORS.thin);
  } else if (depth < CHALCEDONY_MEDIUM_DEPTH) {
    c.set(CHALCEDONY_COLORS.medium);
  } else {
    c.set(CHALCEDONY_COLORS.thick);
  }

  // If fire is close beneath, warm the colour toward amber/orange
  if (fireDist < 3) {
    const fireInfluence = 1 - fireDist / 3;
    const fireGlow = new THREE.Color('#cc6630');
    c.lerp(fireGlow, fireInfluence * 0.4);
  }

  // Polished surfaces are brighter and more saturated
  if (voxel.roughness < 0.3) {
    c.lerp(new THREE.Color(CHALCEDONY_COLORS.polished), 0.3);
  }

  // Per-voxel variation
  const v = voxelVariation(x, y, z);
  c.multiplyScalar(0.85 + v * 0.3);

  return c;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Specimen({
  grid,
  activeTool: _activeTool,
  fireIntensityMap,
  undercutVoxels,
  onToolApply,
}: SpecimenProps) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  // Build instance data for each material type
  const { matrixData, chalcedonyData, fireData } = useMemo(() => {
    const matrixData: { pos: [number, number, number]; color: THREE.Color }[] = [];
    const chalcedonyData: { pos: [number, number, number]; color: THREE.Color; fireDist: number }[] = [];
    const fireData: { pos: [number, number, number]; color: THREE.Color; idx: number; hue: number }[] = [];

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let z = 0; z < GRID_SIZE; z++) {
          const idx = voxelIndex(x, y, z);
          const voxel = grid[idx];
          if (voxel.material === 'air') continue;
          if (!isSurface(grid, x, y, z)) continue;

          const pos = gridToWorld(x, y, z);
          const isUndercut = undercutVoxels.has(idx);

          if (voxel.material === 'matrix') {
            matrixData.push({ pos, color: matrixColor(x, y, z, isUndercut) });

          } else if (voxel.material === 'chalcedony') {
            const fireDist = distanceToNearestFire(grid, x, y, z);
            chalcedonyData.push({
              pos,
              color: chalcedonyColor(voxel, x, y, z, fireDist, isUndercut),
              fireDist,
            });

          } else if (voxel.material === 'fire') {
            // Initial fire colour from hue — will be animated per-frame
            const c = new THREE.Color();
            c.setHSL(voxel.fireHue, 0.85, 0.4);
            fireData.push({ pos, color: c, idx, hue: voxel.fireHue });
          }
        }
      }
    }

    return { matrixData, chalcedonyData, fireData };
  }, [grid, undercutVoxels, fireIntensityMap]);

  // ---- Matrix mesh: rough, matte ----
  const matrixMesh = useMemo(() => {
    if (matrixData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.95,
        metalness: 0.05,
      }),
      matrixData.length
    );
    const dummy = new THREE.Object3D();
    matrixData.forEach((d, i) => {
      dummy.position.set(...d.pos);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, d.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }, [matrixData]);

  // ---- Chalcedony mesh: translucent, glassy when polished ----
  const chalcedonyMesh = useMemo(() => {
    if (chalcedonyData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.15,         // glassy polished surface
        metalness: 0.08,
        transparent: true,
        opacity: 0.82,           // translucent — fire can glow through
        envMapIntensity: 0.5,    // subtle reflections
      }),
      chalcedonyData.length
    );
    const dummy = new THREE.Object3D();
    chalcedonyData.forEach((d, i) => {
      dummy.position.set(...d.pos);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, d.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }, [chalcedonyData]);

  // ---- Fire mesh: emissive, colour-shifting ----
  const fireMeshRef = useRef<THREE.InstancedMesh | null>(null);

  const fireMesh = useMemo(() => {
    if (fireData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.1,
        metalness: 0.7,
        emissive: new THREE.Color('#cc3300'),
        emissiveIntensity: 0.5,
      }),
      fireData.length
    );
    const dummy = new THREE.Object3D();
    fireData.forEach((d, i) => {
      dummy.position.set(...d.pos);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, d.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    fireMeshRef.current = mesh;
    return mesh;
  }, [fireData]);

  // ---- Animate fire colours per-frame based on viewing angle ----
  // Thin-film interference approximation:
  //   As viewing angle changes, fire colour shifts through:
  //   deep red → orange → gold → green (at extreme angles)
  //   This mimics how real fire agate changes colour as you tilt it.
  useFrame(() => {
    const mesh = fireMeshRef.current;
    if (!mesh || fireData.length === 0) return;

    const camPos = camera.position;
    const tempColor = new THREE.Color();

    fireData.forEach((d, i) => {
      const dx = camPos.x - d.pos[0];
      const dy = camPos.y - d.pos[1];
      const dz = camPos.z - d.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist === 0) return;

      // Compute viewing angle factor
      // Use the full 3D direction, not just Y
      const viewDirX = dx / dist;
      const viewDirY = dy / dist;
      const viewDirZ = dz / dist;

      // Approximate surface normal as pointing outward from grid centre
      const half = (GRID_SIZE * VOXEL_SIZE) / 2;
      const nx = d.pos[0]; // already offset from centre
      const ny = d.pos[1];
      const nz = d.pos[2];
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      // Dot product of view direction with outward normal
      const dot = Math.abs(
        viewDirX * (nx / nLen) +
        viewDirY * (ny / nLen) +
        viewDirZ * (nz / nLen)
      );

      // Thin-film interference colour shift:
      // Base hue from the voxel + angle-dependent shift
      // At normal incidence (dot≈1): base hue (red/orange)
      // At grazing angles (dot≈0): hue shifts toward green/blue
      const angleShift = (1 - dot) * 0.15;
      const hue = d.hue + angleShift;

      // Saturation and lightness from fire intensity
      const intensity = fireIntensityMap.get(d.idx) ?? 0.4;
      const saturation = 0.8 + intensity * 0.15;
      const lightness = 0.3 + intensity * 0.25 + dot * 0.1;

      tempColor.setHSL(
        ((hue % 1) + 1) % 1,
        Math.min(1, saturation),
        Math.min(0.65, lightness)
      );
      mesh.setColorAt(i, tempColor);
    });

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  // ---- Click handler for tool application ----
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const point = event.point;
      const [gx, gy, gz] = worldToGrid(point.x, point.y, point.z);
      if (inBounds(gx, gy, gz)) {
        onToolApply(gx, gy, gz);
      }
    },
    [onToolApply]
  );

  return (
    <group ref={groupRef}>
      {matrixMesh && (
        <primitive object={matrixMesh} onClick={handleClick} />
      )}
      {chalcedonyMesh && (
        <primitive object={chalcedonyMesh} onClick={handleClick} />
      )}
      {fireMesh && (
        <primitive object={fireMesh} onClick={handleClick} />
      )}
    </group>
  );
}
