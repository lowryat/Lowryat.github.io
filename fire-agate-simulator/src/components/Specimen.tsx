/**
 * Specimen Component
 * ==================
 * Renders the voxel grid as instanced meshes in Three.js.
 *
 * Performance strategy:
 *   - One InstancedMesh per material type (matrix, chalcedony, fire)
 *   - Only render surface voxels (those adjacent to at least one air voxel)
 *   - Fire voxels get angle-dependent colour via a custom approach
 *
 * Interaction:
 *   - Left-click raycasts to find the clicked voxel
 *   - Calls onToolApply with the voxel coordinates
 */

import { useRef, useMemo, useCallback } from 'react';
import { useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Voxel, ToolName } from '../types';
import { GRID_SIZE, VOXEL_SIZE, MATERIAL_COLORS } from '../constants';
import { voxelIndex, inBounds } from '../simulation/specimenGenerator';

interface SpecimenProps {
  grid: Voxel[];
  activeTool: ToolName;
  fireIntensityMap: Map<number, number>;
  undercutVoxels: Set<number>;
  onToolApply: (x: number, y: number, z: number) => void;
}

// Shared geometry for all voxels
const boxGeometry = new THREE.BoxGeometry(VOXEL_SIZE * 0.92, VOXEL_SIZE * 0.92, VOXEL_SIZE * 0.92);

/**
 * Check if a voxel is on the surface (has at least one air neighbor).
 * We only render surface voxels for performance.
 */
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
 * Convert grid coordinates to world position.
 * Centres the specimen at the origin.
 */
function gridToWorld(x: number, y: number, z: number): [number, number, number] {
  const offset = (GRID_SIZE * VOXEL_SIZE) / 2;
  return [
    x * VOXEL_SIZE - offset,
    y * VOXEL_SIZE - offset,
    z * VOXEL_SIZE - offset,
  ];
}

/**
 * Convert a world position back to the nearest grid coordinates.
 */
function worldToGrid(wx: number, wy: number, wz: number): [number, number, number] {
  const offset = (GRID_SIZE * VOXEL_SIZE) / 2;
  return [
    Math.round((wx + offset) / VOXEL_SIZE),
    Math.round((wy + offset) / VOXEL_SIZE),
    Math.round((wz + offset) / VOXEL_SIZE),
  ];
}

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
    const chalcedonyData: { pos: [number, number, number]; color: THREE.Color }[] = [];
    const fireData: { pos: [number, number, number]; color: THREE.Color; idx: number }[] = [];

    const matrixColor = new THREE.Color(MATERIAL_COLORS.matrix);
    const chalcedonyColor = new THREE.Color(MATERIAL_COLORS.chalcedony);

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let z = 0; z < GRID_SIZE; z++) {
          const idx = voxelIndex(x, y, z);
          const voxel = grid[idx];
          if (voxel.material === 'air') continue;
          if (!isSurface(grid, x, y, z)) continue;

          const pos = gridToWorld(x, y, z);

          if (voxel.material === 'matrix') {
            // Undercut voxels get a reddish tint
            const c = undercutVoxels.has(idx)
              ? new THREE.Color('#8b4040')
              : matrixColor.clone();
            matrixData.push({ pos, color: c });
          } else if (voxel.material === 'chalcedony') {
            const c = undercutVoxels.has(idx)
              ? new THREE.Color('#d4a0a0')
              : chalcedonyColor.clone();
            chalcedonyData.push({ pos, color: c });
          } else if (voxel.material === 'fire') {
            fireData.push({ pos, color: new THREE.Color(MATERIAL_COLORS.fire), idx });
          }
        }
      }
    }

    return { matrixData, chalcedonyData, fireData };
  }, [grid, undercutVoxels, fireIntensityMap]);

  // Create instanced meshes
  const matrixMesh = useMemo(() => {
    if (matrixData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0.1,
      }),
      matrixData.length
    );
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
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

  const chalcedonyMesh = useMemo(() => {
    if (chalcedonyData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.3,
        metalness: 0.1,
        transparent: true,
        opacity: 0.75,
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

  // Animate fire colours based on camera angle (thin-film interference approximation)
  const fireMeshRef = useRef<THREE.InstancedMesh | null>(null);

  const fireMesh = useMemo(() => {
    if (fireData.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      boxGeometry,
      new THREE.MeshStandardMaterial({
        roughness: 0.2,
        metalness: 0.6,
        emissive: new THREE.Color('#ff4400'),
        emissiveIntensity: 0.3,
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

  // Update fire colours each frame based on viewing angle
  useFrame(() => {
    const mesh = fireMeshRef.current;
    if (!mesh || fireData.length === 0) return;

    const camPos = camera.position;
    const tempColor = new THREE.Color();

    fireData.forEach((d, i) => {
      // Direction from voxel to camera
      const dx = camPos.x - d.pos[0];
      const dy = camPos.y - d.pos[1];
      const dz = camPos.z - d.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist === 0) return;

      // Angle between view direction and "up" (Y axis as rough normal)
      const viewDot = Math.abs(dy / dist);

      // Map angle to hue: thin-film interference produces different colours
      // at different angles. We cycle through fire colours:
      // Red → Orange → Yellow → Green → Blue as angle changes
      const hue = 0.0 + viewDot * 0.15; // 0 (red) to 0.15 (yellow-ish)
      const saturation = 0.9;

      // Use fire intensity from the visibility computation
      const intensity = fireIntensityMap.get(d.idx) ?? 0.3;
      const lightness = 0.35 + intensity * 0.3;

      tempColor.setHSL(hue, saturation, lightness);
      mesh.setColorAt(i, tempColor);
    });

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  // Handle click on specimen for tool application
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
