// Procedural dance-loop synthesizer — composes a seamless looping beat as a
// mono f32 PCM buffer (played via op_audio_play_buffer). No asset files: the whole
// track (kick / snare / hats / bass / arp) is generated from math at load time.
// The loop length is an integer number of beats so it repeats click-free, and the
// demo derives the visual beat clock from the same BPM to dance + sing in time.

export interface DanceLoop {
  pcm: Float32Array;
  sampleRate: number;
  bpm: number;
  beats: number;
  seconds: number;
}

const SR = 44_100;

/** Synthesize a `bars`-long (4/4) dance loop at `bpm`. Returns the PCM + timing. */
export function synthesizeDanceLoop(bpm = 120, bars = 2): DanceLoop {
  const beatsPerBar = 4;
  const beats = bars * beatsPerBar;
  const secPerBeat = 60 / bpm;
  const seconds = beats * secPerBeat;
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);

  // Deterministic LCG noise (drums) so the loop is identical every run.
  let seed = 0x9e3779b9 >>> 0;
  const noise = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  // Mix a voice into `out` from `start` for `dur` seconds; `fn(t, p)` gets the
  // local time and 0..1 progress.
  const mix = (start: number, dur: number, fn: (t: number, p: number) => number): void => {
    const i0 = Math.max(0, Math.floor(start * SR));
    const i1 = Math.min(n, Math.ceil((start + dur) * SR));
    for (let i = i0; i < i1; i++) {
      const t = i / SR - start;
      out[i] += fn(t, t / dur);
    }
  };

  const kick = (start: number, amp: number): void =>
    mix(start, 0.16, (t) => {
      const f = 48 + 92 * Math.exp(-t * 34); // pitch drop ~140 -> 48 Hz
      return Math.sin(2 * Math.PI * f * t) * amp * Math.exp(-t * 21);
    });
  const snare = (start: number, amp: number): void =>
    mix(start, 0.2, (t) => {
      const env = Math.exp(-t * 19);
      return (noise() * 0.9 + Math.sin(2 * Math.PI * 180 * t) * 0.4) * amp * env;
    });
  const hat = (start: number, amp: number, dur: number): void =>
    mix(start, dur, (t) => noise() * amp * Math.exp(-t * (dur < 0.05 ? 90 : 42)));
  const bass = (start: number, freq: number, amp: number, dur: number): void =>
    mix(start, dur, (t, p) => {
      const s = Math.sin(2 * Math.PI * freq * t) + 0.5 * Math.sin(4 * Math.PI * freq * t) + 0.25 * Math.sin(6 * Math.PI * freq * t);
      return s * amp * Math.exp(-t * 5) * (1 - p);
    });
  const lead = (start: number, freq: number, amp: number, dur: number): void =>
    mix(start, dur, (t, p) => {
      const sq = Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.55 + Math.sin(2 * Math.PI * freq * t) * 0.45;
      return sq * amp * Math.exp(-t * 9) * (1 - p * 0.5);
    });

  const sixteenth = secPerBeat / 4;
  const steps = beats * 4;
  // A-minor groove: one bass note per beat (A1/G1/E1), an A-minor-pentatonic arp.
  const bassByBeat = [55.0, 55.0, 49.0, 41.2, 55.0, 49.0, 41.2, 49.0];
  const arp = [440.0, 523.25, 659.25, 880.0, 659.25, 523.25, 587.33, 659.25];

  for (let s = 0; s < steps; s++) {
    const t = s * sixteenth;
    const inBar = s % 16;
    if (s % 4 === 0) kick(t, 0.95); // four-on-the-floor
    if (inBar === 4 || inBar === 12) snare(t, 0.5); // backbeat (2 & 4)
    if (s % 2 === 0) hat(t, 0.12, 0.03); // closed hat on 8ths
    if (s % 4 === 2) hat(t, 0.16, 0.07); // open hat on the "and"
    if (s % 2 === 0) bass(t, bassByBeat[Math.floor(s / 4) % beats], 0.22, sixteenth * 1.8); // 8th-note bass
    lead(t, arp[s % arp.length], 0.1, sixteenth * 0.9); // arp on 16ths
  }

  // Soft-clip with a little headroom so the mix never hard-clips.
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 0.9);
  return { pcm: out, sampleRate: SR, bpm, beats, seconds };
}
