/**
 * Glossary Panel
 * ==============
 * Integrated educational glossary with expandable term definitions.
 * Teaches key lapidary and geological concepts.
 */

import { useState } from 'react';
import { GLOSSARY } from '../constants';

export function GlossaryPanel() {
  const [expandedTerm, setExpandedTerm] = useState<string | null>(null);

  return (
    <div className="panel glossary-panel">
      <h3>Glossary</h3>
      <div className="glossary-list">
        {GLOSSARY.map(({ term, definition }) => (
          <div
            key={term}
            className={`glossary-item ${expandedTerm === term ? 'expanded' : ''}`}
            onClick={() => setExpandedTerm(expandedTerm === term ? null : term)}
          >
            <div className="glossary-term">
              <span>{term}</span>
              <span className="glossary-chevron">
                {expandedTerm === term ? '▾' : '▸'}
              </span>
            </div>
            {expandedTerm === term && (
              <div className="glossary-definition">{definition}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
