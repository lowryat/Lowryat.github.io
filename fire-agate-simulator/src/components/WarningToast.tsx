/**
 * Warning Toast
 * =============
 * Displays real-time warnings as transient toast notifications.
 * Warnings auto-dismiss after a few seconds.
 */

import type { SimulationWarning } from '../types';

interface WarningToastProps {
  warnings: SimulationWarning[];
}

export function WarningToast({ warnings }: WarningToastProps) {
  if (warnings.length === 0) return null;

  return (
    <div className="warning-toast-container">
      {warnings.map((w) => (
        <div
          key={w.id}
          className={`warning-toast warning-${w.severity}`}
        >
          {w.message}
        </div>
      ))}
    </div>
  );
}
