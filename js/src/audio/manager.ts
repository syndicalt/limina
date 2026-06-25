// AudioManager — agent-facing audio handles + the host per-frame listener/emitter
// sync. Wraps the native op_audio_* surface and assigns opaque string handles
// (`snd_N`). The host calls op_audio_init() once at startup, then drives
// syncListener()/follow() each frame; agents drive play/ambient/playAt/stop via
// the audio.* skills. Side-effect-free to construct (no device opened).

import { ops } from "../engine.ts";
import { deriveEars, distance, maxDistanceGain, type Vec3 } from "./spatial.ts";

/** Mixer bus indices shared with the native side (limina-audio). */
export const BUS = { master: 0, sfx: 1, ambience: 2, voice: 3 } as const;
export type BusName = keyof typeof BUS;

interface Tracked {
  id: number;
  spatial: boolean;
  entityId?: string;
  volume: number;
  maxDistance: number;
}

export class AudioManager {
  private readonly sounds = new Map<string, Tracked>();
  private seq = 0;
  private listenerCenter: Vec3 = [0, 0, 0];

  private next(): string {
    return `snd_${this.seq++}`;
  }

  play(freq: number, secs: number, bus: BusName, volume: number): string {
    const handle = this.next();
    const id = ops.op_audio_play(freq, secs, BUS[bus], volume);
    this.sounds.set(handle, { id, spatial: false, volume, maxDistance: 0 });
    return handle;
  }

  ambient(bus: BusName, volume: number): string {
    const handle = this.next();
    const id = ops.op_audio_ambient(BUS[bus], volume);
    this.sounds.set(handle, { id, spatial: false, volume, maxDistance: 0 });
    return handle;
  }

  playAt(
    freq: number,
    secs: number,
    pos: Vec3,
    bus: BusName,
    volume: number,
    maxDistance = 0,
    entityId?: string,
  ): string {
    const handle = this.next();
    const id = ops.op_audio_play_spatial(freq, secs, pos[0], pos[1], pos[2], BUS[bus], volume);
    this.sounds.set(handle, { id, spatial: true, entityId, volume, maxDistance });
    return handle;
  }

  stop(handle: string): boolean {
    const t = this.sounds.get(handle);
    if (t === undefined) return false;
    ops.op_audio_stop(t.id);
    this.sounds.delete(handle);
    return true;
  }

  setVolume(handle: string, volume: number): boolean {
    const t = this.sounds.get(handle);
    if (t === undefined) return false;
    t.volume = volume;
    ops.op_audio_set_volume(t.id, volume);
    return true;
  }

  setBusVolume(bus: BusName, volume: number): void {
    ops.op_audio_set_bus_volume(BUS[bus], volume);
  }

  /** Play an arbitrary PCM buffer (e.g. a procedurally-synthesized music loop) on
   *  a bus, optionally looping. Returns an opaque handle. */
  playBuffer(data: Float32Array, sampleRate: number, channels: number, bus: BusName, volume: number, loop: boolean): string {
    const handle = this.next();
    const id = ops.op_audio_play_buffer(data, sampleRate, channels, BUS[bus], volume, loop);
    this.sounds.set(handle, { id, spatial: false, volume, maxDistance: 0 });
    return handle;
  }

  /** Speak a line at a world position on the voice bus (fire-and-forget TTS).
   *  `pitch` 0 = default voice; higher (≈70-90) = a cuter, sing-song voice. */
  speak(text: string, pos: Vec3, volume = 0.95, pitch = 0): string {
    const handle = this.next();
    const id = ops.op_audio_speak(text, pos[0], pos[1], pos[2], volume, pitch);
    this.sounds.set(handle, { id, spatial: true, volume, maxDistance: 0 });
    return handle;
  }

  /** The entity a spatial handle should follow (host updates its emitter each frame). */
  entityOf(handle: string): string | undefined {
    return this.sounds.get(handle)?.entityId;
  }

  /** Host per-frame: set the listener from the camera (derives two ear positions). */
  syncListener(camPos: Vec3, camRight: Vec3, halfHead = 0.12): void {
    this.listenerCenter = camPos;
    const { left, right } = deriveEars(camPos, camRight, halfHead);
    ops.op_audio_set_listener(left[0], left[1], left[2], right[0], right[1], right[2]);
  }

  /** Host per-frame: move a spatial sound's emitter + apply the max-distance cutoff. */
  follow(handle: string, pos: Vec3): void {
    const t = this.sounds.get(handle);
    if (t === undefined || !t.spatial) return;
    ops.op_audio_set_emitter(t.id, pos[0], pos[1], pos[2]);
    if (t.maxDistance > 0) {
      const g = maxDistanceGain(distance(this.listenerCenter, pos), t.maxDistance, t.volume);
      ops.op_audio_set_volume(t.id, g);
    }
  }
}
