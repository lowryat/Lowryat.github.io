/**
 * Scene Component
 * ===============
 * Sets up the React Three Fiber canvas with camera, lighting, and controls.
 * This is the 3D viewport where the specimen is rendered and manipulated.
 */

import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Specimen } from './Specimen';
import type { Voxel, ToolName, LightPosition } from '../types';

interface SceneProps {
  grid: Voxel[];
  activeTool: ToolName;
  lightPosition: LightPosition;
  fireIntensityMap: Map<number, number>;
  undercutVoxels: Set<number>;
  onToolApply: (x: number, y: number, z: number) => void;
}

export function Scene({
  grid,
  activeTool,
  lightPosition,
  fireIntensityMap,
  undercutVoxels,
  onToolApply,
}: SceneProps) {
  // Convert spherical light position to Cartesian
  const lx = lightPosition.distance * Math.cos(lightPosition.elevation) * Math.cos(lightPosition.azimuth);
  const ly = lightPosition.distance * Math.sin(lightPosition.elevation);
  const lz = lightPosition.distance * Math.cos(lightPosition.elevation) * Math.sin(lightPosition.azimuth);

  return (
    <div className="scene-container">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 50 }}
        style={{ background: '#1a1a2e' }}
      >
        {/* Warm ambient for natural stone appearance */}
        <ambientLight intensity={0.4} color="#ffe8cc" />

        {/* Main point light (movable by user) — warm white like a desk lamp */}
        <pointLight position={[lx, ly, lz]} intensity={2.0} color="#fff0d0" />

        {/* Subtle warm fill from below — simulates reflected light off hand/surface */}
        <pointLight position={[0, -5, 2]} intensity={0.25} color="#ffe0b0" />

        {/* Cool rim light for edge definition */}
        <pointLight position={[-5, 3, -3]} intensity={0.3} color="#c0d0e0" />

        {/* The specimen mesh */}
        <Specimen
          grid={grid}
          activeTool={activeTool}
          fireIntensityMap={fireIntensityMap}
          undercutVoxels={undercutVoxels}
          onToolApply={onToolApply}
        />

        {/* Mouse/touch orbit controls */}
        <OrbitControls
          enablePan={false}
          minDistance={4}
          maxDistance={15}
          // Right-click to rotate, left-click reserved for tool interaction
          mouseButtons={{
            LEFT: undefined as any,  // tool interaction handled by Specimen
            MIDDLE: 2, // dolly
            RIGHT: 1,  // rotate
          }}
        />
      </Canvas>

      {/* Overlay instruction */}
      <div className="scene-hint">
        Right-drag to rotate · Scroll to zoom · Left-click to sculpt
      </div>
    </div>
  );
}
