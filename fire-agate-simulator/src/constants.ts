/**
 * Constants and configuration for the Fire Agate Simulator.
 *
 * Tweak these values to adjust difficulty, appearance, and behaviour.
 */

import type { ToolProperties, ToolName, TutorialStep } from './types';

// ---------------------------------------------------------------------------
// Grid dimensions
// ---------------------------------------------------------------------------

/** Number of voxels along each axis. Total voxels = GRID_SIZE^3. */
export const GRID_SIZE = 32;

/** World-space size of one voxel cube (in Three.js units). */
export const VOXEL_SIZE = 0.15;

// ---------------------------------------------------------------------------
// Material properties
// ---------------------------------------------------------------------------

/**
 * Hardness determines how resistant a material is to removal.
 * Higher = harder to remove.  Range 0–1.
 *
 * Matrix is sofite relatively (it's the host rock you want to remove).
 * Chalcedony is moderately hard.
 * Fire layer is extremely delicate — easy to accidentally destroy.
 */
export const MATERIAL_HARDNESS: Record<string, number> = {
  matrix: 0.3,
  chalcedony: 0.6,
  fire: 0.15, // very fragile — small power destroys it
  air: 0,
};

/**
 * Visual colours for each material type.
 * Based on real fire agate specimens:
 *   - Matrix: cream/tan rough host rock (not dark — real matrix is often light)
 *   - Chalcedony: amber/honey translucent (NOT pale blue — real fire agate
 *     chalcedony is warm-toned due to iron content)
 *   - Fire: deep ruby-red base (actual colour is angle-dependent and varies per dome)
 */
export const MATERIAL_COLORS: Record<string, string> = {
  matrix: '#8b7355',      // warm tan/cream (real matrix between domes)
  chalcedony: '#a0723c',  // amber/honey translucent
  fire: '#cc2200',         // deep ruby-red (base — actual colour per-voxel)
  air: '#000000',          // not rendered
};

/**
 * Extended colour palette for realistic rendering.
 * Chalcedony colour depends on depth/thickness — thinner = more transparent amber,
 * thicker = darker smoky brown.
 */
export const CHALCEDONY_COLORS = {
  thin: '#c4944a',       // warm amber (thin chalcedony, fire visible through)
  medium: '#8b6b3e',     // honey brown (medium thickness)
  thick: '#5a4028',      // smoky dark brown (thick, fire hidden)
  polished: '#d4a060',   // bright amber when polished (low roughness)
};

/**
 * Matrix colour variations — real matrix isn't uniform.
 * Includes rough tan, darker spots, and reddish iron-stained areas.
 */
export const MATRIX_COLORS = {
  base: '#8b7355',       // warm tan
  dark: '#6b5540',       // darker brown spots
  ironStain: '#8b5a3a',  // reddish iron staining
  light: '#a89070',      // lighter cream areas
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: Record<ToolName, ToolProperties> = {
  coarse: {
    radius: 3,
    power: 0.35,
    roughnessEffect: 0.8,
    label: 'Coarse Burr',
    description: 'Aggressive removal. Good for bulk matrix, but dangerous near fire layers.',
  },
  medium: {
    radius: 2,
    power: 0.2,
    roughnessEffect: 0.4,
    label: 'Medium Burr',
    description: 'Balanced removal. Suitable for approaching the chalcedony layer.',
  },
  fine: {
    radius: 1,
    power: 0.1,
    roughnessEffect: 0.15,
    label: 'Fine Burr',
    description: 'Delicate touch. Use near fire layers to expose without destroying.',
  },
};

// ---------------------------------------------------------------------------
// Specimen generation parameters
// ---------------------------------------------------------------------------

/** Outer radius of the specimen (in grid units from centre). */
export const SPECIMEN_RADIUS = 14;

/** Max depth (in voxels) for chalcedony "thin" rendering threshold. */
export const CHALCEDONY_THIN_DEPTH = 2;

/** Max depth for chalcedony "medium" rendering threshold. */
export const CHALCEDONY_MEDIUM_DEPTH = 4;

// ---------------------------------------------------------------------------
// Simulation thresholds
// ---------------------------------------------------------------------------

/** Undercut risk above this value triggers a warning. */
export const UNDERCUT_WARNING_THRESHOLD = 40;

/** Undercut risk above this value triggers a danger alert. */
export const UNDERCUT_DANGER_THRESHOLD = 70;

/** Fire visibility improvement that triggers a positive notification. */
export const FIRE_IMPROVEMENT_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Tutorial steps
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: 'Welcome to the Fire Agate Simulator!',
    body: `Fire agate is a gemstone with thin layers of iron oxide (the "fire layer")
trapped between layers of chalcedony inside a host matrix. Lapidary artists
carefully grind away the matrix to reveal the fire beneath.

In this simulator you'll learn to sculpt a virtual fire agate specimen.
Your goal: expose as much fire as possible without destroying it or
undercutting the support structure.`,
  },
  {
    title: 'Rotate the Specimen',
    body: `Click and drag on the 3D view to rotate the specimen.
Look at the layers: the dark outer shell is **matrix**, the pale band
is **chalcedony**, and the bright inner layer is the **fire layer**.

Use the scroll wheel to zoom in and out.`,
  },
  {
    title: 'Choose a Tool',
    body: `Select a burr tool from the toolbar on the left.

• **Coarse burr** — removes material quickly but leaves a rough surface.
• **Medium burr** — balanced; good for approaching the chalcedony.
• **Fine burr** — delicate; use this near the fire layer.

Start with the coarse burr to remove bulk matrix.`,
  },
  {
    title: 'Remove Material',
    body: `Click on the specimen surface to grind away material.
Each click removes voxels within the tool's brush radius.

Watch the metrics panel on the right — it shows fire visibility,
undercut risk, and other statistics in real time.`,
  },
  {
    title: 'Watch for Warnings',
    body: `As you sculpt, the simulator will warn you about:

• **Undercut risk** — removing too much support under chalcedony domes
• **Dome thinning** — the chalcedony layer getting dangerously thin
• **Blocked light** — matrix still blocking the light path to fire
• **Fire destroyed** — accidentally grinding through the fire layer

Try to expose fire while keeping warnings under control. Good luck!`,
  },
];

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export const GLOSSARY: { term: string; definition: string }[] = [
  {
    term: 'Matrix',
    definition:
      'The host rock (usually basalt or rhyolite) that surrounds the fire agate. It must be carefully removed to reveal the fire layers beneath. Matrix is opaque and blocks light.',
  },
  {
    term: 'Chalcedony',
    definition:
      'A translucent microcrystalline quartz that forms the protective dome over fire layers. It transmits light and acts as a natural lens. Preserving chalcedony thickness is essential for structural support.',
  },
  {
    term: 'Fire Layer',
    definition:
      'Ultra-thin layers of iron oxide (limonite/goethite) deposited between chalcedony bands. These layers produce iridescent colours through thin-film interference — the same physics that creates colours in soap bubbles.',
  },
  {
    term: 'Undercut',
    definition:
      'When material is removed from beneath a dome or overhang, leaving it unsupported. In fire agate work, undercutting can cause chalcedony domes to crack or fire layers to collapse.',
  },
  {
    term: 'Support',
    definition:
      'The structural material (usually matrix or chalcedony) that holds fire-bearing zones in place. A lapidary must balance removing matrix for visibility while preserving enough support.',
  },
  {
    term: 'Dome',
    definition:
      'The rounded, botryoidal (grape-like) shapes that chalcedony naturally forms inside fire agate. These domes act as tiny lenses that concentrate and display the fire colours.',
  },
  {
    term: 'Light Path',
    definition:
      'The route light travels from source → through the stone → to the viewer\'s eye. For fire to be visible, the light path must pass through the fire layer without being blocked by remaining matrix.',
  },
];
