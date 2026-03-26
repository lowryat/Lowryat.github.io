/**
 * Core type definitions for the Fire Agate Simulator.
 *
 * The simulator models a fire agate specimen as a 3D voxel grid.
 * Each voxel represents a small cube of material within the stone.
 */

// ---------------------------------------------------------------------------
// Material types found inside a fire agate
// ---------------------------------------------------------------------------

/** The four possible states for any voxel in the grid. */
export type MaterialType = 'matrix' | 'chalcedony' | 'fire' | 'air';

/**
 * A single voxel in the specimen grid.
 *
 * - `material`: what substance occupies this cube
 * - `roughness`: 0 = polished, 1 = rough (affects light scatter & fire visibility)
 * - `integrity`: 0 = destroyed, 1 = fully intact (decreases as tools grind nearby)
 */
export interface Voxel {
  material: MaterialType;
  roughness: number;
  integrity: number;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Burr tool names ordered from most aggressive to most delicate. */
export type ToolName = 'coarse' | 'medium' | 'fine';

/**
 * Properties that define how a tool interacts with the specimen.
 *
 * - `radius`: how many voxels the brush affects (in grid units)
 * - `power`: base removal strength per interaction tick
 * - `roughnessEffect`: how much roughness the tool leaves on newly-exposed surfaces
 *    (coarse burrs leave rougher surfaces than fine burrs)
 */
export interface ToolProperties {
  radius: number;
  power: number;
  roughnessEffect: number;
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Simulation metrics
// ---------------------------------------------------------------------------

/**
 * Real-time metrics computed each frame (or on interaction).
 *
 * These drive the UI panels and warning toasts.
 */
export interface SimulationMetrics {
  /** 0–100 score: how much fire is visible from the current viewing angle. */
  fireVisibility: number;
  /** 0–100 score: risk that unsupported chalcedony / fire will collapse. */
  undercutRisk: number;
  /** Fraction of fire voxels that are exposed (not covered by matrix). */
  fireExposure: number;
  /** Fraction of light rays that reach fire voxels unblocked. */
  lightPathClearance: number;
  /** Total voxels removed so far. */
  materialRemoved: number;
  /** Count of fire voxels accidentally destroyed. */
  fireDestroyed: number;
}

// ---------------------------------------------------------------------------
// Warning system
// ---------------------------------------------------------------------------

export type WarningSeverity = 'info' | 'warning' | 'danger';

export interface SimulationWarning {
  id: string;
  message: string;
  severity: WarningSeverity;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Light & camera state
// ---------------------------------------------------------------------------

/** Spherical coordinates used for the movable light source. */
export interface LightPosition {
  azimuth: number;   // radians, horizontal angle
  elevation: number; // radians, vertical angle
  distance: number;  // distance from specimen centre
}

// ---------------------------------------------------------------------------
// Snapshot for before / after comparison
// ---------------------------------------------------------------------------

export interface Snapshot {
  metrics: SimulationMetrics;
  timestamp: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Tutorial
// ---------------------------------------------------------------------------

export interface TutorialStep {
  title: string;
  body: string;
  /** Optional: highlight a UI element by CSS selector */
  highlight?: string;
}
