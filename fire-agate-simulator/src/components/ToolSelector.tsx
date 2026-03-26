/**
 * Tool Selector Panel
 * ===================
 * Displays the available burr tools and lets the user pick one.
 * Shows tool properties (radius, power) and a brief description.
 */

import type { ToolName } from '../types';
import { TOOLS } from '../constants';

interface ToolSelectorProps {
  activeTool: ToolName;
  onSelectTool: (tool: ToolName) => void;
}

const TOOL_ICONS: Record<ToolName, string> = {
  coarse: '⬤',   // large dot = big burr
  medium: '●',    // medium dot
  fine: '•',      // small dot = fine burr
};

export function ToolSelector({ activeTool, onSelectTool }: ToolSelectorProps) {
  return (
    <div className="panel tool-selector">
      <h3>Tools</h3>
      <div className="tool-list">
        {(Object.keys(TOOLS) as ToolName[]).map((name) => {
          const tool = TOOLS[name];
          const isActive = activeTool === name;
          return (
            <button
              key={name}
              className={`tool-button ${isActive ? 'active' : ''}`}
              onClick={() => onSelectTool(name)}
              title={tool.description}
            >
              <span className="tool-icon">{TOOL_ICONS[name]}</span>
              <span className="tool-label">{tool.label}</span>
              <span className="tool-stats">
                R:{tool.radius} P:{Math.round(tool.power * 100)}%
              </span>
            </button>
          );
        })}
      </div>
      <div className="tool-description">
        {TOOLS[activeTool].description}
      </div>
    </div>
  );
}
