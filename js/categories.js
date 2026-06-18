// categories.js
// A practical subset of the arXiv taxonomy, grouped by archive.
// Each entry: [code, human-readable label]

export const ARCHIVES = [
  {
    archive: "astro-ph",
    label: "Astrophysics",
    accent: "flare",
    categories: [
      ["astro-ph.SR", "Solar and Stellar Astrophysics"],
      ["astro-ph", "Astrophysics (all)"],
      ["astro-ph.GA", "Astrophysics of Galaxies"],
      ["astro-ph.CO", "Cosmology and Nongalactic Astrophysics"],
      ["astro-ph.EP", "Earth and Planetary Astrophysics"],
      ["astro-ph.HE", "High Energy Astrophysical Phenomena"],
      ["astro-ph.IM", "Instrumentation and Methods for Astrophysics"],
    ],
  },
  {
    archive: "physics",
    label: "Physics",
    accent: "corona",
    categories: [
      ["physics.space-ph", "Space Physics"],
      ["physics.plasm-ph", "Plasma Physics"],
      ["physics.ao-ph", "Atmospheric and Oceanic Physics"],
      ["physics.geo-ph", "Geophysics"],
      ["physics.ins-det", "Instrumentation and Detectors"],
      ["physics.data-an", "Data Analysis, Statistics and Probability"],
      ["physics.optics", "Optics"],
      ["physics.gen-ph", "General Physics"],
    ],
  },
  {
    archive: "gr-qc / hep",
    label: "Gravitation & High Energy",
    accent: "danger",
    categories: [
      ["gr-qc", "General Relativity and Quantum Cosmology"],
      ["hep-ph", "High Energy Physics - Phenomenology"],
      ["hep-th", "High Energy Physics - Theory"],
      ["hep-ex", "High Energy Physics - Experiment"],
      ["nucl-th", "Nuclear Theory"],
    ],
  },
  {
    archive: "cond-mat",
    label: "Condensed Matter",
    accent: "violet",
    categories: [
      ["cond-mat.mtrl-sci", "Materials Science"],
      ["cond-mat.stat-mech", "Statistical Mechanics"],
      ["cond-mat.str-el", "Strongly Correlated Electrons"],
    ],
  },
  {
    archive: "math",
    label: "Mathematics",
    accent: "sage",
    categories: [
      ["math.NA", "Numerical Analysis"],
      ["math.ST", "Statistics Theory"],
      ["math.DS", "Dynamical Systems"],
      ["math.OC", "Optimization and Control"],
    ],
  },
  {
    archive: "cs",
    label: "Computer Science",
    accent: "violet",
    categories: [
      ["cs.LG", "Machine Learning"],
      ["cs.AI", "Artificial Intelligence"],
      ["cs.CV", "Computer Vision"],
      ["cs.CL", "Computation and Language"],
    ],
  },
  {
    archive: "eess / q-bio / stat",
    label: "Engineering, Bio & Stats",
    accent: "muted",
    categories: [
      ["eess.IV", "Image and Video Processing"],
      ["eess.SP", "Signal Processing"],
      ["q-bio.QM", "Quantitative Methods"],
      ["stat.ML", "Machine Learning (Statistics)"],
    ],
  },
];

// Flat lookup for label-by-code
export const CATEGORY_LABELS = Object.fromEntries(
  ARCHIVES.flatMap((a) => a.categories)
);

// Default quick-access chips shown on the Today tab
export const DEFAULT_QUICK_CATEGORIES = [
  "astro-ph.SR",
  "astro-ph.HE",
  "astro-ph.GA",
  "physics.space-ph",
  "physics.plasm-ph",
];

export function categoryLabel(code) {
  return CATEGORY_LABELS[code] || code;
}

export function archiveOf(code) {
  return code.split(".")[0];
}

const ARCHIVE_MAP = {
  "astro-ph": "flare",
  physics: "corona",
  "gr-qc": "danger",
  "hep-ph": "danger",
  "hep-th": "danger",
  "hep-ex": "danger",
  "nucl-th": "danger",
  "cond-mat": "violet",
  math: "sage",
  cs: "violet",
  eess: "muted",
  "q-bio": "muted",
  stat: "muted",
  "q-fin": "muted",
  nlin: "muted",
};

export function categoryAccent(code) {
  const archive = archiveOf(code);
  return ARCHIVE_MAP[archive] || "muted";
}
