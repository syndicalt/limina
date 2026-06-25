// Deterministic 28s timeline. Worlds are isolated: the agent runs a local path
// (localU 0→1) inside each world, then a white wash cuts to the next world.
// Output drives everything; world switching happens at the wash peak.
import { PHASES, type PhaseId } from './manifest';
import type { CameraBeat } from './camera';

export const DURATION = 28;

// Sequence of worlds (last = return home for the climax).
const WORLD_SEQ: PhaseId[] = ['builder', 'fantasy', 'western', 'scifi', 'sim', 'builder'];
const WINDOWS: [number, number][] = [
  [0, 4.5],
  [4.5, 9.5],
  [9.5, 14.5],
  [14.5, 19.5],
  [19.5, 24],
  [24, 28],
];
// Boundary times where the world switches (wash peaks here). 0/28 is the loop seam.
const BOUNDARIES = [4.5, 9.5, 14.5, 19.5, 24];

export interface TimelineState {
  elapsed: number;
  worldIndex: number;
  phase: PhaseId;
  localU: number;
  isReturn: boolean;
  beat: CameraBeat;
  grade: { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number] };
  fogColor: number;
  fogDensity: number;
  trailIntensity: number;
  brandingOpacity: number;
  composite: number;
  agentU: number;
  pose: 'run' | 'wave';
  faceBack: boolean;
  flash: number;
  emissivePulse: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const BEATS: Record<PhaseId, CameraBeat> = {
  builder: { back: 7.5, up: 3.4, side: 1.0, fov: 52, lookAhead: 4.5 },
  fantasy: { back: 6.6, up: 4.4, side: 0.0, fov: 52, lookAhead: 5.5 },
  western: { back: 9.0, up: 4.0, side: 1.4, fov: 55, lookAhead: 6 },
  scifi: { back: 7.0, up: 3.4, side: -1.0, fov: 48, lookAhead: 4.5 },
  sim: { back: 8.0, up: 3.7, side: 1.1, fov: 52, lookAhead: 5 },
};
const RETURN_BEAT: CameraBeat = { back: 9.5, up: 4.2, side: 0, fov: 56, lookAhead: 3 };

// Wash half-widths in seconds: full white within H_HOLD, ramp out to H_RAMP.
const H_HOLD = 0.12;
const H_RAMP = 0.5;

function phaseGrade(id: PhaseId) {
  return (PHASES.find((p) => p.id === id) ?? PHASES[0]).grade;
}
function phaseFog(id: PhaseId) {
  return (PHASES.find((p) => p.id === id) ?? PHASES[0]).fog;
}

export function createTimeline() {
  function update(elapsed: number): TimelineState {
    const e = ((elapsed % DURATION) + DURATION) % DURATION;

    let wi = WINDOWS.length - 1;
    for (let i = 0; i < WINDOWS.length; i++) {
      if (e < WINDOWS[i][1]) {
        wi = i;
        break;
      }
    }
    const [t0, t1] = WINDOWS[wi];
    const localU = clamp01((e - t0) / (t1 - t0));
    const isReturn = wi === WORLD_SEQ.length - 1;
    const phase = WORLD_SEQ[wi];

    const beat = isReturn ? RETURN_BEAT : BEATS[phase];

    const grade = phaseGrade(phase);
    const fog = phaseFog(phase);

    // Return-home choreography: run into the room → stop, turn & wave at the
    // viewer → turn back and run into the portal (loop). The camera keeps the
    // path-forward direction so it stays behind while the agent faces it.
    let agentU = localU;
    let pose: 'run' | 'wave' = 'run';
    let faceBack = false;
    if (isReturn) {
      if (localU < 0.28) {
        agentU = (localU / 0.28) * 0.42; // run in to centre stage
      } else if (localU < 0.7) {
        agentU = 0.42; // hold, face the viewer, wave
        pose = 'wave';
        faceBack = true;
      } else {
        agentU = 0.42 + ((localU - 0.7) / 0.3) * 0.58; // run back into the portal
      }
    }

    // white wash: nearest boundary (circular over the loop seam at 0/28)
    let flash = 0;
    for (const tb of [...BOUNDARIES, 0, DURATION]) {
      const d = Math.abs(e - tb);
      let f = 0;
      if (d < H_HOLD) f = 1;
      else if (d < H_RAMP) f = 1 - smoothstep(H_HOLD, H_RAMP, d);
      if (f > flash) flash = f;
    }

    const trailIntensity = lerpRamp(e);
    const brandingOpacity = smoothstep(24.6, 26.5, e);
    const composite = 0; // final scene is the clean builder room (no recap cards)
    const emissivePulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(elapsed * 3.0));

    return {
      elapsed: e,
      worldIndex: wi,
      phase,
      localU,
      isReturn,
      beat,
      grade,
      fogColor: fog.color,
      fogDensity: fog.density,
      trailIntensity,
      brandingOpacity,
      composite,
      agentU,
      pose,
      faceBack,
      flash,
      emissivePulse,
    };
  }

  return { update, duration: DURATION };
}

function lerpRamp(e: number): number {
  // trail sparks brighten toward the late worlds
  return 0.5 + 0.5 * smoothstep(14, 24, e);
}
