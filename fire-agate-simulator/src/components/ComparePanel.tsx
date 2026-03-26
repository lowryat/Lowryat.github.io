/**
 * Compare Panel
 * =============
 * Shows before/after metrics to help the user understand
 * the impact of their sculpting decisions.
 *
 * The user can take a "snapshot" at any point, and the panel
 * will compare current metrics against the saved snapshot.
 */

import type { SimulationMetrics, Snapshot } from '../types';

interface ComparePanelProps {
  currentMetrics: SimulationMetrics;
  snapshot: Snapshot | null;
  onTakeSnapshot: () => void;
}

function DeltaValue({ label, before, after, higherIsBetter }: {
  label: string;
  before: number;
  after: number;
  higherIsBetter: boolean;
}) {
  const delta = after - before;
  const isGood = higherIsBetter ? delta > 0 : delta < 0;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const color = Math.abs(delta) < 1 ? '#aaa' : isGood ? '#4caf50' : '#f44336';

  return (
    <div className="compare-row">
      <span className="compare-label">{label}</span>
      <span className="compare-before">{Math.round(before)}</span>
      <span className="compare-arrow" style={{ color }}>{arrow}</span>
      <span className="compare-after">{Math.round(after)}</span>
      <span className="compare-delta" style={{ color }}>
        ({delta > 0 ? '+' : ''}{Math.round(delta)})
      </span>
    </div>
  );
}

export function ComparePanel({ currentMetrics, snapshot, onTakeSnapshot }: ComparePanelProps) {
  return (
    <div className="panel compare-panel">
      <h3>Compare</h3>

      <button className="snapshot-button" onClick={onTakeSnapshot}>
        Take Snapshot
      </button>

      {snapshot ? (
        <div className="compare-grid">
          <div className="compare-header">
            <span />
            <span>Before</span>
            <span />
            <span>Now</span>
            <span>Delta</span>
          </div>
          <DeltaValue
            label="Fire Vis."
            before={snapshot.metrics.fireVisibility}
            after={currentMetrics.fireVisibility}
            higherIsBetter={true}
          />
          <DeltaValue
            label="Undercut"
            before={snapshot.metrics.undercutRisk}
            after={currentMetrics.undercutRisk}
            higherIsBetter={false}
          />
          <DeltaValue
            label="Exposure"
            before={snapshot.metrics.fireExposure * 100}
            after={currentMetrics.fireExposure * 100}
            higherIsBetter={true}
          />
          <DeltaValue
            label="Light Path"
            before={snapshot.metrics.lightPathClearance * 100}
            after={currentMetrics.lightPathClearance * 100}
            higherIsBetter={true}
          />
          <div className="compare-timestamp">
            Snapshot: {snapshot.label}
          </div>
        </div>
      ) : (
        <div className="compare-empty">
          Take a snapshot to start comparing metrics before and after sculpting.
        </div>
      )}
    </div>
  );
}
