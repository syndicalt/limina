// Capability + quality detection and accessibility gating for the hero cinematic.

export interface Quality {
  tier: 'high' | 'med' | 'low';
  dpr: number;
  ssr: boolean;
  gtao: boolean;
  bokeh: boolean;
  shadowMapSize: number;
  /** Multiplier on procedural instance counts. */
  instanceScale: number;
  reduceMotion: boolean;
  webgl: boolean;
}

export function detectQuality(): Quality {
  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Probe WebGL2 on a throwaway canvas.
  let webgl = false;
  try {
    const c = document.createElement('canvas');
    webgl = !!c.getContext('webgl2');
  } catch {
    webgl = false;
  }

  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const dprRaw = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const cores = navigator.hardwareConcurrency ?? 4;

  let tier: Quality['tier'] = 'low';
  if (mem >= 8 && cores >= 8) tier = 'high';
  else if (mem >= 4 && cores >= 4) tier = 'med';

  const dpr = Math.min(dprRaw, tier === 'high' ? 2 : 1.5);

  return {
    tier,
    dpr,
    // SSR is the heaviest pass and is off by default even on high (see plan
    // contingency); GTAO + bloom + bokeh + SMAA carry the cinematic look.
    ssr: false,
    gtao: tier !== 'low',
    bokeh: tier !== 'low',
    shadowMapSize: tier === 'high' ? 2048 : 1024,
    instanceScale: tier === 'high' ? 1 : tier === 'med' ? 0.6 : 0.35,
    reduceMotion,
    webgl,
  };
}
