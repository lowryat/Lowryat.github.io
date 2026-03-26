/**
 * Tutorial Overlay
 * ================
 * A step-by-step guided tutorial that introduces the user to the simulator.
 * Appears on first load and can be dismissed or navigated step by step.
 */

import { TUTORIAL_STEPS } from '../constants';

interface TutorialOverlayProps {
  currentStep: number;
  onNext: () => void;
  onPrev: () => void;
  onDismiss: () => void;
}

export function TutorialOverlay({
  currentStep,
  onNext,
  onPrev,
  onDismiss,
}: TutorialOverlayProps) {
  const step = TUTORIAL_STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === TUTORIAL_STEPS.length - 1;

  return (
    <div className="tutorial-overlay">
      <div className="tutorial-card">
        <div className="tutorial-header">
          <h2>{step.title}</h2>
          <button className="tutorial-close" onClick={onDismiss} title="Close tutorial">
            ×
          </button>
        </div>

        <div className="tutorial-body">
          {step.body.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>

        <div className="tutorial-footer">
          <span className="tutorial-progress">
            {currentStep + 1} / {TUTORIAL_STEPS.length}
          </span>

          <div className="tutorial-buttons">
            {!isFirst && (
              <button className="tutorial-btn" onClick={onPrev}>
                Back
              </button>
            )}
            {isLast ? (
              <button className="tutorial-btn tutorial-btn-primary" onClick={onDismiss}>
                Start Sculpting!
              </button>
            ) : (
              <button className="tutorial-btn tutorial-btn-primary" onClick={onNext}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
