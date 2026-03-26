/**
 * Light Control Panel
 * ===================
 * Sliders to adjust the light source position (azimuth and elevation).
 * Moving the light changes which fire voxels are illuminated and
 * visibly demonstrates angle-dependent fire visibility.
 */

import type { LightPosition } from '../types';

interface LightControlProps {
  lightPosition: LightPosition;
  onLightChange: (pos: LightPosition) => void;
}

export function LightControl({ lightPosition, onLightChange }: LightControlProps) {
  return (
    <div className="panel light-control">
      <h3>Light Source</h3>

      <div className="slider-row">
        <label>Azimuth</label>
        <input
          type="range"
          min={-Math.PI}
          max={Math.PI}
          step={0.05}
          value={lightPosition.azimuth}
          onChange={(e) =>
            onLightChange({ ...lightPosition, azimuth: parseFloat(e.target.value) })
          }
        />
        <span className="slider-value">{Math.round((lightPosition.azimuth * 180) / Math.PI)}°</span>
      </div>

      <div className="slider-row">
        <label>Elevation</label>
        <input
          type="range"
          min={0.1}
          max={Math.PI / 2}
          step={0.05}
          value={lightPosition.elevation}
          onChange={(e) =>
            onLightChange({ ...lightPosition, elevation: parseFloat(e.target.value) })
          }
        />
        <span className="slider-value">{Math.round((lightPosition.elevation * 180) / Math.PI)}°</span>
      </div>

      <div className="light-hint">
        Moving the light changes which fire is visible — just like tilting a real fire agate
        under a lamp.
      </div>
    </div>
  );
}
