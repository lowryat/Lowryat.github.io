/**
 * Metrics Panel
 * =============
 * Displays real-time simulation metrics:
 *   - Fire Visibility score
 *   - Undercut Risk level
 *   - Fire Exposure percentage
 *   - Light Path Clearance
 *   - Material removed count
 *   - Fire destroyed count
 *
 * Colour-coded bars give at-a-glance status.
 */

import type { SimulationMetrics } from '../types';

interface MetricsPanelProps {
  metrics: SimulationMetrics;
}

/**
 * Colour for a metric bar based on value and whether higher is better or worse.
 */
function barColor(value: number, higherIsBetter: boolean): string {
  if (higherIsBetter) {
    if (value > 60) return '#4caf50'; // green
    if (value > 30) return '#ff9800'; // orange
    return '#f44336'; // red
  } else {
    if (value < 30) return '#4caf50';
    if (value < 60) return '#ff9800';
    return '#f44336';
  }
}

function MetricBar({
  label,
  value,
  higherIsBetter,
  suffix = '%',
}: {
  label: string;
  value: number;
  higherIsBetter: boolean;
  suffix?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = barColor(clamped, higherIsBetter);

  return (
    <div className="metric-row">
      <div className="metric-label">{label}</div>
      <div className="metric-bar-bg">
        <div
          className="metric-bar-fill"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </div>
      <div className="metric-value">{Math.round(value)}{suffix}</div>
    </div>
  );
}

export function MetricsPanel({ metrics }: MetricsPanelProps) {
  return (
    <div className="panel metrics-panel">
      <h3>Metrics</h3>

      <MetricBar
        label="Fire Visibility"
        value={metrics.fireVisibility}
        higherIsBetter={true}
      />

      <MetricBar
        label="Undercut Risk"
        value={metrics.undercutRisk}
        higherIsBetter={false}
      />

      <MetricBar
        label="Fire Exposure"
        value={metrics.fireExposure * 100}
        higherIsBetter={true}
      />

      <MetricBar
        label="Light Clearance"
        value={metrics.lightPathClearance * 100}
        higherIsBetter={true}
      />

      <div className="metric-row metric-counter">
        <span>Material removed:</span>
        <span className="metric-number">{metrics.materialRemoved}</span>
      </div>

      <div className="metric-row metric-counter">
        <span>Fire destroyed:</span>
        <span
          className="metric-number"
          style={{ color: metrics.fireDestroyed > 0 ? '#f44336' : '#aaa' }}
        >
          {metrics.fireDestroyed}
        </span>
      </div>
    </div>
  );
}
