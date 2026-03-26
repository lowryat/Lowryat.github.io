/**
 * App — Root Component
 * ====================
 * Orchestrates the entire Fire Agate Simulator:
 *   - Manages the voxel grid state
 *   - Runs simulation computations on each interaction
 *   - Coordinates UI panels, 3D scene, and tutorial
 *
 * State management is kept in this single component for MVP simplicity.
 * A production version might use a reducer or state library.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Voxel, ToolName, LightPosition, SimulationMetrics, SimulationWarning, Snapshot } from './types';
import { generateSpecimen } from './simulation/specimenGenerator';
import { applyTool } from './simulation/toolSystem';
import { computeFireVisibility, type FireVisibilityResult } from './simulation/fireVisibility';
import { analyzeUndercut } from './simulation/undercutAnalysis';
import { analyzeLightPaths } from './simulation/lightPath';
import { Scene } from './components/Scene';
import { ToolSelector } from './components/ToolSelector';
import { MetricsPanel } from './components/MetricsPanel';
import { GlossaryPanel } from './components/GlossaryPanel';
import { ComparePanel } from './components/ComparePanel';
import { LightControl } from './components/LightControl';
import { TutorialOverlay } from './components/TutorialOverlay';
import { WarningToast } from './components/WarningToast';

// ---------------------------------------------------------------------------
// Helper: convert spherical light position to a direction vector
// ---------------------------------------------------------------------------
function lightPosToDir(lp: LightPosition): [number, number, number] {
  const x = Math.cos(lp.elevation) * Math.cos(lp.azimuth);
  const y = Math.sin(lp.elevation);
  const z = Math.cos(lp.elevation) * Math.sin(lp.azimuth);
  return [x, y, z];
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
const INITIAL_LIGHT: LightPosition = {
  azimuth: 0.8,
  elevation: 0.7,
  distance: 8,
};

const INITIAL_METRICS: SimulationMetrics = {
  fireVisibility: 0,
  undercutRisk: 0,
  fireExposure: 0,
  lightPathClearance: 0,
  materialRemoved: 0,
  fireDestroyed: 0,
};

export default function App() {
  // ---- Core state ----
  const [grid, setGrid] = useState<Voxel[]>(() => generateSpecimen());
  const [activeTool, setActiveTool] = useState<ToolName>('coarse');
  const [lightPosition, setLightPosition] = useState<LightPosition>(INITIAL_LIGHT);
  const [metrics, setMetrics] = useState<SimulationMetrics>(INITIAL_METRICS);
  const [warnings, setWarnings] = useState<SimulationWarning[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fireVisResult, setFireVisResult] = useState<FireVisibilityResult>({
    score: 0,
    exposureFraction: 0,
    lightClearanceFraction: 0,
    fireIntensityMap: new Map(),
  });
  const [undercutVoxels, setUndercutVoxels] = useState<Set<number>>(new Set());

  // ---- Tutorial state ----
  const [showTutorial, setShowTutorial] = useState(true);
  const [tutorialStep, setTutorialStep] = useState(0);

  // ---- Sidebar tab state ----
  const [activeTab, setActiveTab] = useState<'metrics' | 'glossary' | 'compare'>('metrics');

  // Track cumulative counters across interactions
  const cumulativeRef = useRef({ materialRemoved: 0, fireDestroyed: 0 });

  // ---- Run full simulation recomputation ----
  const recompute = useCallback(
    (currentGrid: Voxel[], lp: LightPosition) => {
      const lightDir = lightPosToDir(lp);
      // Use a default view direction (camera starts at +Z)
      const viewDir: [number, number, number] = [0, 0, 1];

      const fireVis = computeFireVisibility(currentGrid, lightDir, viewDir);
      const undercut = analyzeUndercut(currentGrid);
      const lightPaths = analyzeLightPaths(currentGrid, lightDir);

      setFireVisResult(fireVis);
      setUndercutVoxels(undercut.undercutVoxels);

      setMetrics({
        fireVisibility: fireVis.score,
        undercutRisk: undercut.riskScore,
        fireExposure: fireVis.exposureFraction,
        lightPathClearance: lightPaths.clearance,
        materialRemoved: cumulativeRef.current.materialRemoved,
        fireDestroyed: cumulativeRef.current.fireDestroyed,
      });

      // Collect warnings from undercut analysis
      if (undercut.warnings.length > 0) {
        setWarnings((prev) => [...undercut.warnings, ...prev].slice(0, 5));
      }
    },
    []
  );

  // Run initial computation
  useEffect(() => {
    recompute(grid, lightPosition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Tool application handler ----
  const handleToolApply = useCallback(
    (x: number, y: number, z: number) => {
      // Clone the grid (shallow copy of array, but voxels are mutated in-place)
      const newGrid = [...grid];
      const result = applyTool(newGrid, activeTool, x, y, z);

      // Update cumulative counters
      cumulativeRef.current.materialRemoved += result.removed;
      cumulativeRef.current.fireDestroyed += result.fireDestroyed;

      // Show tool warnings
      if (result.warnings.length > 0) {
        setWarnings((prev) => [...result.warnings, ...prev].slice(0, 5));
      }

      setGrid(newGrid);
      recompute(newGrid, lightPosition);
    },
    [grid, activeTool, lightPosition, recompute]
  );

  // ---- Light change handler ----
  const handleLightChange = useCallback(
    (lp: LightPosition) => {
      setLightPosition(lp);
      recompute(grid, lp);
    },
    [grid, recompute]
  );

  // ---- Snapshot handler ----
  const handleTakeSnapshot = useCallback(() => {
    setSnapshot({
      metrics: { ...metrics },
      timestamp: Date.now(),
      label: new Date().toLocaleTimeString(),
    });
  }, [metrics]);

  // ---- Reset handler ----
  const handleReset = useCallback(() => {
    const newGrid = generateSpecimen();
    cumulativeRef.current = { materialRemoved: 0, fireDestroyed: 0 };
    setGrid(newGrid);
    setSnapshot(null);
    setWarnings([]);
    recompute(newGrid, lightPosition);
  }, [lightPosition, recompute]);

  // ---- Auto-dismiss warnings after 4 seconds ----
  useEffect(() => {
    if (warnings.length === 0) return;
    const timer = setTimeout(() => {
      setWarnings((prev) => prev.slice(0, -1)); // remove oldest
    }, 4000);
    return () => clearTimeout(timer);
  }, [warnings]);

  return (
    <div className="app">
      {/* Tutorial overlay */}
      {showTutorial && (
        <TutorialOverlay
          currentStep={tutorialStep}
          onNext={() => setTutorialStep((s) => s + 1)}
          onPrev={() => setTutorialStep((s) => s - 1)}
          onDismiss={() => setShowTutorial(false)}
        />
      )}

      {/* Warning toasts */}
      <WarningToast warnings={warnings} />

      {/* Header */}
      <header className="app-header">
        <h1>Fire Agate Simulator</h1>
        <div className="header-actions">
          <button className="header-btn" onClick={() => setShowTutorial(true)}>
            Tutorial
          </button>
          <button className="header-btn" onClick={handleReset}>
            Reset
          </button>
        </div>
      </header>

      {/* Main layout */}
      <div className="app-body">
        {/* Left sidebar: tools + light */}
        <aside className="sidebar sidebar-left">
          <ToolSelector activeTool={activeTool} onSelectTool={setActiveTool} />
          <LightControl lightPosition={lightPosition} onLightChange={handleLightChange} />
        </aside>

        {/* Centre: 3D scene */}
        <main className="main-view">
          <Scene
            grid={grid}
            activeTool={activeTool}
            lightPosition={lightPosition}
            fireIntensityMap={fireVisResult.fireIntensityMap}
            undercutVoxels={undercutVoxels}
            onToolApply={handleToolApply}
          />
        </main>

        {/* Right sidebar: metrics / glossary / compare */}
        <aside className="sidebar sidebar-right">
          <div className="tab-bar">
            <button
              className={`tab-btn ${activeTab === 'metrics' ? 'active' : ''}`}
              onClick={() => setActiveTab('metrics')}
            >
              Metrics
            </button>
            <button
              className={`tab-btn ${activeTab === 'glossary' ? 'active' : ''}`}
              onClick={() => setActiveTab('glossary')}
            >
              Glossary
            </button>
            <button
              className={`tab-btn ${activeTab === 'compare' ? 'active' : ''}`}
              onClick={() => setActiveTab('compare')}
            >
              Compare
            </button>
          </div>

          {activeTab === 'metrics' && <MetricsPanel metrics={metrics} />}
          {activeTab === 'glossary' && <GlossaryPanel />}
          {activeTab === 'compare' && (
            <ComparePanel
              currentMetrics={metrics}
              snapshot={snapshot}
              onTakeSnapshot={handleTakeSnapshot}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
