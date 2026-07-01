//! limina-audio — native audio output (rodio 0.22 on cpal) for limina.
//!
//! A dedicated audio thread owns the live `MixerDeviceSink` (kept alive for the
//! subsystem lifetime) + the `Mixer` + a registry of per-sound players; the
//! JS-thread ops send commands over an mpsc channel, so nothing blocks the frame
//! loop. The backend is chosen EXPLICITLY: `LIMINA_AUDIO=null` forces a no-op
//! `Null` backend (device-independent tests); a missing device also falls back.
//!
//! Mixer: 4 buses (master/sfx/ambience/voice); effective gain = master·bus·base,
//! re-applied live on a bus change. Sounds are plain (`Player`) or positional
//! (`SpatialPlayer`). rodio applies the 1/d² spatial attenuation; the
//! ear-derivation + the optional max-distance cutoff are limina-owned and live in
//! JS (`js/src/audio/spatial.ts`).
//!
//! Voice (TTS) is RUST-SIDE + fire-and-forget: `op_audio_speak` returns instantly
//! after queueing a command; synthesis runs on a throwaway worker thread (a
//! pluggable `VoiceProvider` — espeak-ng/Piper CLI), and the decoded audio is
//! sent back over the channel to play at the speaker's position. JS never awaits,
//! so a slow voice never freezes the frame (the windowed loop drains the JS event
//! loop to quiescence each frame, so a JS-awaited synth WOULD stall it).

use std::collections::HashMap;
use std::f32::consts::PI;
use std::io::{Cursor, Write};
use std::num::{NonZeroU16, NonZeroU32};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait};
use deno_core::{extension, op2, OpState};
use rodio::buffer::SamplesBuffer;
use rodio::source::Source;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, SpatialPlayer};

const SAMPLE_RATE: u32 = 44_100;
/// Bus volumes: index 0 = master, 1 = sfx, 2 = ambience, 3 = voice.
const N_BUSES: usize = 4;
const BUS_VOICE: usize = 3;
/// Bounded command-channel capacity. A stalled audio thread applies backpressure:
/// once this many commands are queued, further sends are DROPPED (not blocked, not
/// queued), so a stall can never grow memory without bound. Sized to comfortably
/// absorb a frame's worth of listener/emitter/volume updates plus a few one-shots.
const AUDIO_CMD_CAPACITY: usize = 256;

/// Commands sent from the JS-thread ops (and TTS workers) to the audio thread.
enum AudioCmd {
    PlaySfx {
        id: u32,
        freq: f32,
        secs: f32,
        bus: usize,
        volume: f32,
    },
    PlayAmbience {
        id: u32,
        bus: usize,
        volume: f32,
    },
    PlayBuffer {
        id: u32,
        data: Vec<f32>,
        rate: u32,
        channels: u16,
        bus: usize,
        volume: f32,
        looping: bool,
    },
    PlaySpatial {
        id: u32,
        freq: f32,
        secs: f32,
        emitter: [f32; 3],
        bus: usize,
        volume: f32,
    },
    /// Queue a TTS line: synthesized off-thread, then delivered as `PlayDecoded`.
    Speak {
        id: u32,
        text: String,
        emitter: [f32; 3],
        volume: f32,
        pitch: u8,
    },
    /// Decoded TTS audio (from a worker) ready to play positionally.
    PlayDecoded {
        id: u32,
        data: Vec<f32>,
        channels: NonZeroU16,
        rate: NonZeroU32,
        #[allow(dead_code)] // reserved for a future positional voice; the voice is currently non-spatial (full presence over music)
        emitter: [f32; 3],
        bus: usize,
        volume: f32,
    },
    SetEmitter {
        id: u32,
        pos: [f32; 3],
    },
    SetListener {
        left: [f32; 3],
        right: [f32; 3],
    },
    SetVolume {
        id: u32,
        volume: f32,
    },
    Stop {
        id: u32,
    },
    StopAll,
    SetBusVolume {
        bus: usize,
        volume: f32,
    },
    /// Clean-shutdown signal: the audio thread returns, dropping the sink (so the OS
    /// output closes) and letting the thread be joined. Sent from `AudioHandle`'s
    /// `Drop`; delivery is best-effort (dropped if the channel is full), with
    /// sender-drop as the guaranteed fallback that also ends the receive loop.
    Shutdown,
}

/// Host-owned audio handle, stored in `OpState`. `tx` is `None` only for the
/// `Null` backend (forced or no device), so sends no-op; ids still advance so
/// JS-side handle bookkeeping is identical across backends (deterministic). The
/// sender is `Arc`-wrapped: the audio thread holds only a `Weak` for the TTS-back
/// path, so dropping this (the sole strong sender) lets the receive loop end.
struct AudioHandle {
    tx: Option<Arc<SyncSender<AudioCmd>>>,
    join: Option<thread::JoinHandle<()>>,
    /// Count of commands dropped due to a full channel (backpressure); used only to
    /// throttle the warning log. Not world state (never affects determinism).
    dropped: AtomicU64,
    next_id: u32,
}

impl AudioHandle {
    fn alloc(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        id
    }
    fn send(&self, cmd: AudioCmd) {
        if let Some(tx) = self.tx.as_ref() {
            match tx.try_send(cmd) {
                Ok(()) => {}
                // Full = the audio thread is behind; DROP rather than block the V8
                // thread or grow memory. Throttle the warning so a stall can't flood.
                Err(TrySendError::Full(_)) => {
                    let n = self.dropped.fetch_add(1, Ordering::Relaxed);
                    if n.is_multiple_of(256) {
                        eprintln!(
                            "[audio] command channel full; dropping commands (audio thread stalled?) [{}]",
                            n + 1
                        );
                    }
                }
                // Disconnected = the audio thread has exited; nothing to do.
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
    }
}

impl Drop for AudioHandle {
    /// Clean shutdown: signal the audio thread to return, drop our (sole strong)
    /// sender so the receive loop can still end if that signal was dropped (channel
    /// full), then join. Null backend has no thread, so this is a no-op there.
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.try_send(AudioCmd::Shutdown);
            drop(tx);
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// A plain or positional player.
enum Voice {
    Plain(Player),
    Spatial(SpatialPlayer),
}

/// A live sound the audio thread tracks so it can re-gain, move, or stop it.
struct Sound {
    voice: Voice,
    bus: usize,
    base: f32,
}

impl Sound {
    fn set_gain(&self, g: f32) {
        match &self.voice {
            Voice::Plain(p) => p.set_volume(g),
            Voice::Spatial(s) => s.set_volume(g),
        }
    }
    fn empty(&self) -> bool {
        match &self.voice {
            Voice::Plain(p) => p.empty(),
            Voice::Spatial(s) => s.empty(),
        }
    }
    fn stop(self) {
        match self.voice {
            Voice::Plain(p) => p.stop(),
            Voice::Spatial(s) => s.stop(),
        }
    }
}

/// Effective gain for a sound on `bus` with per-sound `base`: master · bus · base.
fn effective(vols: &[f32; N_BUSES], bus: usize, base: f32) -> f32 {
    let bus_gain = vols.get(bus).copied().unwrap_or(1.0);
    vols[0] * bus_gain * base
}

fn ch1() -> NonZeroU16 {
    NonZeroU16::new(1).unwrap()
}
fn rate() -> NonZeroU32 {
    NonZeroU32::new(SAMPLE_RATE).unwrap()
}

/// Synthesize a mono sine with a short attack/decay envelope (click-free).
fn synth_sine(freq: f32, secs: f32) -> Vec<f32> {
    let sr = SAMPLE_RATE as f32;
    let n = (secs.max(0.0) * sr) as usize;
    let mut v = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / sr;
        let attack = (t / 0.01).min(1.0);
        let release = ((secs - t) / 0.05).clamp(0.0, 1.0);
        v.push((2.0 * PI * freq * t).sin() * 0.25 * attack.min(release));
    }
    v
}

/// Synthesize a soft 2 s chord pad. Frequencies (110/165/220 Hz) complete whole
/// cycles in exactly 2 s at 44.1 kHz, so the buffer loops seamlessly (no click).
fn synth_pad() -> Vec<f32> {
    let sr = SAMPLE_RATE as f32;
    let n = (2 * SAMPLE_RATE) as usize;
    let partials = [(110.0f32, 0.10f32), (165.0, 0.08), (220.0, 0.06)];
    let mut v = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / sr;
        let mut s = 0.0;
        for &(f, a) in &partials {
            s += (2.0 * PI * f * t).sin() * a;
        }
        v.push(s);
    }
    v
}

// ---- voice (TTS) -----------------------------------------------------------

/// A pluggable, RUST-SIDE voice: `text -> WAV bytes`. Adapters shell out to a
/// local TTS binary (espeak-ng / Piper), so synthesis stays out-of-process and
/// off the JS frame loop. `Send + Sync` so a worker thread can own a clone.
trait VoiceProvider: Send + Sync {
    fn synth(&self, text: &str, pitch: u8) -> Result<Vec<u8>, String>;
}

/// Unique temp WAV path (pid + nanos) so concurrent syntheses never collide.
fn tts_tmp_path() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("limina_tts_{}_{}.wav", std::process::id(), nanos))
}

/// RAII guard that removes the temp WAV on drop, so a synth that fails on ANY path
/// (non-zero exit, read error, …) never leaks the file.
struct TmpWav {
    path: std::path::PathBuf,
}
impl Drop for TmpWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// espeak-ng: instant formant TTS (`espeak-ng -w <file> <text>`). The dependable
/// zero-install fallback voice.
struct EspeakProvider;
impl VoiceProvider for EspeakProvider {
    fn synth(&self, text: &str, pitch: u8) -> Result<Vec<u8>, String> {
        let tmp = TmpWav {
            path: tts_tmp_path(),
        };
        let mut cmd = Command::new("espeak-ng");
        cmd.arg("-w").arg(&tmp.path);
        if pitch > 0 {
            // Higher pitch + a slightly slower rate -> a cuter, sing-song voice.
            cmd.arg("-p").arg(pitch.min(99).to_string());
            cmd.arg("-s").arg("150");
        }
        let status = cmd
            .arg(text)
            .status()
            .map_err(|e| format!("espeak-ng spawn: {e}"))?;
        if !status.success() {
            return Err("espeak-ng exited non-zero".into());
        }
        // `tmp` drops on return (any path), removing the file.
        std::fs::read(&tmp.path).map_err(|e| e.to_string())
    }
}

/// Piper: neural VITS TTS (`piper --model <m> --output_file <f>`, text on stdin).
/// Higher quality; needs a downloaded voice model.
struct PiperProvider {
    model: String,
}
impl VoiceProvider for PiperProvider {
    fn synth(&self, text: &str, _pitch: u8) -> Result<Vec<u8>, String> {
        let tmp = TmpWav {
            path: tts_tmp_path(),
        };
        let mut child = Command::new("piper")
            .args(["--model", &self.model, "--output_file"])
            .arg(&tmp.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|e| format!("piper spawn: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("piper stdin unavailable")?
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
        if !child.wait().map_err(|e| e.to_string())?.success() {
            return Err("piper exited non-zero".into());
        }
        // `tmp` drops on return (any path), removing the file.
        std::fs::read(&tmp.path).map_err(|e| e.to_string())
    }
}

/// Choose the voice provider from `LIMINA_TTS` (`none` | `espeak` | `piper[:model]`
/// | unset=auto). Auto uses espeak-ng when it is on PATH, else no voice (speak
/// commands are dropped with a log — honest-unavailable).
fn select_voice() -> Option<Arc<dyn VoiceProvider>> {
    match std::env::var("LIMINA_TTS").ok().as_deref() {
        Some("none") => None,
        Some("espeak") => Some(Arc::new(EspeakProvider)),
        Some(s) if s.starts_with("piper:") => Some(Arc::new(PiperProvider {
            model: s["piper:".len()..].to_string(),
        })),
        Some("piper") => Some(Arc::new(PiperProvider {
            model: "en_US-amy-medium.onnx".to_string(),
        })),
        _ => {
            let have_espeak = Command::new("espeak-ng")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if have_espeak {
                eprintln!("[audio] voice: espeak-ng (auto)");
                Some(Arc::new(EspeakProvider))
            } else {
                eprintln!("[audio] voice: none (no TTS provider; set LIMINA_TTS=piper:<model> or install espeak-ng)");
                None
            }
        }
    }
}

/// Decode WAV bytes to `(f32 samples, channels, rate)` via rodio's Symphonia
/// decoder. Runs on the TTS worker thread (off the audio + frame threads).
fn decode_wav(bytes: Vec<u8>) -> Result<(Vec<f32>, NonZeroU16, NonZeroU32), String> {
    let decoder = Decoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let channels = decoder.channels();
    let sample_rate = decoder.sample_rate();
    let data: Vec<f32> = decoder.collect();
    Ok((data, channels, sample_rate))
}

/// Open the OS audio output, PREFERRING the PipeWire/Pulse-routed virtual device
/// over the raw ALSA card. Grabbing the raw card can make the session audio server
/// (PipeWire/wireplumber) flip the card to its "Pro Audio" profile, silencing
/// normal output system-wide. Routing through the "pipewire"/"pulse"/"default"
/// device keeps limina a well-behaved client (like any desktop app).
#[allow(deprecated)] // cpal's Device::name() is deprecated but is the simplest way to match the routed device
fn open_output() -> Result<MixerDeviceSink, String> {
    let host = cpal::default_host();
    let mut chosen: Option<cpal::Device> = None;
    if let Ok(devices) = host.output_devices() {
        let mut fallback: Option<cpal::Device> = None;
        for d in devices {
            let name = d.name().unwrap_or_default().to_ascii_lowercase();
            if name.contains("pipewire") {
                chosen = Some(d);
                break;
            }
            if fallback.is_none() && (name.contains("pulse") || name == "default") {
                fallback = Some(d);
            }
        }
        if chosen.is_none() {
            chosen = fallback;
        }
    }
    match chosen {
        Some(dev) => {
            eprintln!("[audio] output device: {}", dev.name().unwrap_or_default());
            DeviceSinkBuilder::from_device(dev)
                .and_then(|b| b.open_stream())
                .map_err(|e| format!("{e:?}"))
        }
        None => {
            eprintln!("[audio] output device: cpal default (no pipewire/pulse device found)");
            DeviceSinkBuilder::open_default_sink().map_err(|e| format!("{e:?}"))
        }
    }
}

// ---- audio thread ----------------------------------------------------------

/// The dedicated audio thread: owns the live sink + mixer + sound registry +
/// current listener ears, services commands until the channel closes (or a
/// `Shutdown` is received). `back` is a WEAK sender the thread upgrades per-`Speak`
/// to hand a live sender to a TTS worker; holding it weakly (not a self-clone) is
/// what lets the receive loop end once the JS-side sender drops. `voice` is the
/// selected provider (None = no voice).
fn run_audio(
    dev: MixerDeviceSink,
    rx: Receiver<AudioCmd>,
    back: Weak<SyncSender<AudioCmd>>,
    voice: Option<Arc<dyn VoiceProvider>>,
) {
    let mixer = dev.mixer();
    let mut sounds: HashMap<u32, Sound> = HashMap::new();
    let mut vols = [1.0f32; N_BUSES];
    let mut left_ear = [-0.1f32, 0.0, 0.0];
    let mut right_ear = [0.1f32, 0.0, 0.0];
    for cmd in rx {
        match cmd {
            AudioCmd::PlaySfx {
                id,
                freq,
                secs,
                bus,
                volume,
            } => {
                let player = Player::connect_new(mixer);
                player.set_volume(effective(&vols, bus, volume));
                player.append(SamplesBuffer::new(ch1(), rate(), synth_sine(freq, secs)));
                player.play();
                sounds.insert(
                    id,
                    Sound {
                        voice: Voice::Plain(player),
                        bus,
                        base: volume,
                    },
                );
            }
            AudioCmd::PlayAmbience { id, bus, volume } => {
                let player = Player::connect_new(mixer);
                player.set_volume(effective(&vols, bus, volume));
                player.append(SamplesBuffer::new(ch1(), rate(), synth_pad()).repeat_infinite());
                player.play();
                sounds.insert(
                    id,
                    Sound {
                        voice: Voice::Plain(player),
                        bus,
                        base: volume,
                    },
                );
            }
            AudioCmd::PlayBuffer {
                id,
                data,
                rate,
                channels,
                bus,
                volume,
                looping,
            } => {
                let player = Player::connect_new(mixer);
                player.set_volume(effective(&vols, bus, volume));
                let ch = NonZeroU16::new(channels.max(1)).unwrap();
                let sr = NonZeroU32::new(rate.max(1)).unwrap();
                let buf = SamplesBuffer::new(ch, sr, data);
                if looping {
                    player.append(buf.repeat_infinite());
                } else {
                    player.append(buf);
                }
                player.play();
                sounds.insert(
                    id,
                    Sound {
                        voice: Voice::Plain(player),
                        bus,
                        base: volume,
                    },
                );
            }
            AudioCmd::PlaySpatial {
                id,
                freq,
                secs,
                emitter,
                bus,
                volume,
            } => {
                let sp = SpatialPlayer::connect_new(mixer, emitter, left_ear, right_ear);
                sp.set_volume(effective(&vols, bus, volume));
                sp.append(SamplesBuffer::new(ch1(), rate(), synth_sine(freq, secs)));
                sp.play();
                sounds.insert(
                    id,
                    Sound {
                        voice: Voice::Spatial(sp),
                        bus,
                        base: volume,
                    },
                );
            }
            AudioCmd::Speak {
                id,
                text,
                emitter,
                volume,
                pitch,
            } => {
                // Fire-and-forget: synth on a throwaway worker; deliver decoded
                // audio back over the channel. Nothing blocks here or in JS. We
                // upgrade the WEAK sender per line, so a live worker keeps the channel
                // alive only for its own (bounded) lifetime — never the audio thread.
                if let (Some(provider), Some(back)) = (voice.clone(), back.upgrade()) {
                    thread::Builder::new()
                        .name("limina-tts".into())
                        .spawn(
                            move || match provider.synth(&text, pitch).and_then(decode_wav) {
                                Ok((data, channels, rate)) => {
                                    // Backpressure applies here too: a full channel
                                    // drops the decoded line rather than queueing it.
                                    let _ = back.try_send(AudioCmd::PlayDecoded {
                                        id,
                                        data,
                                        channels,
                                        rate,
                                        emitter,
                                        bus: BUS_VOICE,
                                        volume,
                                    });
                                }
                                Err(e) => eprintln!("[audio] tts failed: {e}"),
                            },
                        )
                        .ok();
                }
            }
            AudioCmd::PlayDecoded {
                id,
                data,
                channels,
                rate,
                emitter: _,
                bus,
                volume,
            } => {
                // The voice is NON-spatial (a solo singer / dialogue you want to hear
                // clearly): play it on the voice bus at full presence, not distance-
                // attenuated under rodio's 1/d² (which buries it under music at
                // typical camera distances).
                let player = Player::connect_new(mixer);
                player.set_volume(effective(&vols, bus, volume));
                player.append(SamplesBuffer::new(channels, rate, data));
                player.play();
                sounds.insert(
                    id,
                    Sound {
                        voice: Voice::Plain(player),
                        bus,
                        base: volume,
                    },
                );
            }
            AudioCmd::SetEmitter { id, pos } => {
                if let Some(Sound {
                    voice: Voice::Spatial(s),
                    ..
                }) = sounds.get(&id)
                {
                    s.set_emitter_position(pos);
                }
            }
            AudioCmd::SetListener { left, right } => {
                left_ear = left;
                right_ear = right;
                for s in sounds.values() {
                    if let Voice::Spatial(sp) = &s.voice {
                        sp.set_left_ear_position(left);
                        sp.set_right_ear_position(right);
                    }
                }
            }
            AudioCmd::SetVolume { id, volume } => {
                if let Some(s) = sounds.get_mut(&id) {
                    s.base = volume;
                    s.set_gain(effective(&vols, s.bus, volume));
                }
            }
            AudioCmd::Stop { id } => {
                if let Some(s) = sounds.remove(&id) {
                    s.stop();
                }
            }
            AudioCmd::StopAll => {
                for (_, s) in sounds.drain() {
                    s.stop();
                }
            }
            AudioCmd::SetBusVolume { bus, volume } => {
                if bus < N_BUSES {
                    vols[bus] = volume;
                    for s in sounds.values() {
                        s.set_gain(effective(&vols, s.bus, s.base));
                    }
                }
            }
            // Clean shutdown: return so the sink/sounds drop and the thread joins.
            AudioCmd::Shutdown => return,
        }
        // Reap finished one-shots (looping ambience never empties).
        sounds.retain(|_, s| !s.empty());
    }
}

/// Spawn the audio thread, opening the default output on it. Returns the command
/// sender (the sole strong `Arc`), whether a live device was acquired, and the
/// join handle. The channel is BOUNDED (`AUDIO_CMD_CAPACITY`) so a stalled thread
/// applies backpressure instead of growing memory. On no device the thread keeps
/// draining commands (no-op), so the returned sender is always valid.
fn spawn_audio() -> (Arc<SyncSender<AudioCmd>>, bool, thread::JoinHandle<()>) {
    let (raw_tx, rx) = mpsc::sync_channel::<AudioCmd>(AUDIO_CMD_CAPACITY);
    // The audio thread holds only a `Weak` (for the TTS-back path), so dropping
    // this strong sender is what lets the receive loop terminate.
    let tx = Arc::new(raw_tx);
    let back = Arc::downgrade(&tx);
    let (ready_tx, ready_rx) = mpsc::channel::<bool>();
    let handle = thread::Builder::new()
        .name("limina-audio".into())
        .spawn(move || match open_output() {
            Ok(mut dev) => {
                dev.log_on_drop(false);
                let _ = ready_tx.send(true);
                let voice = select_voice();
                run_audio(dev, rx, back, voice);
            }
            Err(e) => {
                eprintln!("[audio] no output device ({e}); running null");
                let _ = ready_tx.send(false);
                for _ in rx {} // drain so sends stay no-op and never error
            }
        })
        .expect("spawn limina-audio thread");
    let live = ready_rx.recv().unwrap_or(false);
    (tx, live, handle)
}

// ---- ops -------------------------------------------------------------------

/// Initialize the audio backend once. Honors `LIMINA_AUDIO=null` (forced Null,
/// no device opened). Returns 1 if a live device is playing, 0 for Null.
#[op2(fast)]
pub fn op_audio_init(state: &mut OpState) -> u32 {
    let forced_null = std::env::var("LIMINA_AUDIO")
        .map(|v| v.eq_ignore_ascii_case("null"))
        .unwrap_or(false);
    if forced_null {
        state.put(AudioHandle {
            tx: None,
            join: None,
            dropped: AtomicU64::new(0),
            next_id: 0,
        });
        println!("[audio] backend: null (LIMINA_AUDIO=null)");
        return 0;
    }
    let (tx, live, join) = spawn_audio();
    state.put(AudioHandle {
        tx: Some(tx),
        join: Some(join),
        dropped: AtomicU64::new(0),
        next_id: 0,
    });
    println!(
        "[audio] backend: {}",
        if live { "live" } else { "null (no device)" }
    );
    u32::from(live)
}

/// Play a one-shot synthesized SFX blip on `bus` at `volume`. Returns its handle.
#[op2(fast)]
pub fn op_audio_play(state: &mut OpState, freq: f32, secs: f32, bus: u32, volume: f32) -> u32 {
    let Some(h) = state.try_borrow_mut::<AudioHandle>() else {
        return 0;
    };
    let id = h.alloc();
    h.send(AudioCmd::PlaySfx {
        id,
        freq,
        secs,
        bus: bus as usize,
        volume,
    });
    id
}

/// Start a looping synthesized ambience bed on `bus` at `volume`. Returns its handle.
#[op2(fast)]
pub fn op_audio_ambient(state: &mut OpState, bus: u32, volume: f32) -> u32 {
    let Some(h) = state.try_borrow_mut::<AudioHandle>() else {
        return 0;
    };
    let id = h.alloc();
    h.send(AudioCmd::PlayAmbience {
        id,
        bus: bus as usize,
        volume,
    });
    id
}

/// Play a one-shot positional SFX blip emitted at world `(ex,ey,ez)`. Returns its handle.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_audio_play_spatial(
    state: &mut OpState,
    freq: f32,
    secs: f32,
    ex: f32,
    ey: f32,
    ez: f32,
    bus: u32,
    volume: f32,
) -> u32 {
    let Some(h) = state.try_borrow_mut::<AudioHandle>() else {
        return 0;
    };
    let id = h.alloc();
    h.send(AudioCmd::PlaySpatial {
        id,
        freq,
        secs,
        emitter: [ex, ey, ez],
        bus: bus as usize,
        volume,
    });
    id
}

/// Speak a line at world `(ex,ey,ez)` on the voice bus — FIRE-AND-FORGET. Returns
/// a handle immediately; synthesis + playback happen off-thread. No-op if no voice.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_audio_speak(
    state: &mut OpState,
    #[string] text: String,
    ex: f32,
    ey: f32,
    ez: f32,
    volume: f32,
    pitch: u32,
) -> u32 {
    let Some(h) = state.try_borrow_mut::<AudioHandle>() else {
        return 0;
    };
    let id = h.alloc();
    h.send(AudioCmd::Speak {
        id,
        text,
        emitter: [ex, ey, ez],
        volume,
        pitch: pitch.min(99) as u8,
    });
    id
}

/// Play an arbitrary in-memory PCM buffer (mono/stereo f32) on `bus`, optionally
/// looping. The buffer is copied out of V8 (one-time track load). Returns its handle.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_audio_play_buffer(
    state: &mut OpState,
    #[buffer] data: &[f32],
    sample_rate: u32,
    channels: u32,
    bus: u32,
    volume: f32,
    looping: bool,
) -> u32 {
    let Some(h) = state.try_borrow_mut::<AudioHandle>() else {
        return 0;
    };
    let id = h.alloc();
    h.send(AudioCmd::PlayBuffer {
        id,
        data: data.to_vec(),
        rate: sample_rate,
        channels: channels as u16,
        bus: bus as usize,
        volume,
        looping,
    });
    id
}

/// Move a positional sound's emitter (e.g. follow an entity each frame).
#[op2(fast)]
pub fn op_audio_set_emitter(state: &mut OpState, id: u32, x: f32, y: f32, z: f32) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::SetEmitter { id, pos: [x, y, z] });
    }
}

/// Set the listener's two ear positions (JS derives them from the camera each frame).
#[op2(fast)]
pub fn op_audio_set_listener(
    state: &mut OpState,
    lx: f32,
    ly: f32,
    lz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::SetListener {
            left: [lx, ly, lz],
            right: [rx, ry, rz],
        });
    }
}

/// Set one sound's base volume (used by the JS max-distance cutoff + general gain).
#[op2(fast)]
pub fn op_audio_set_volume(state: &mut OpState, id: u32, volume: f32) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::SetVolume { id, volume });
    }
}

/// Stop one sound by handle.
#[op2(fast)]
pub fn op_audio_stop(state: &mut OpState, id: u32) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::Stop { id });
    }
}

/// Stop every sound.
#[op2(fast)]
pub fn op_audio_stop_all(state: &mut OpState) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::StopAll);
    }
}

/// Set a bus volume (0=master, 1=sfx, 2=ambience, 3=voice); re-gains live sounds.
#[op2(fast)]
pub fn op_audio_set_bus_volume(state: &mut OpState, bus: u32, volume: f32) {
    if let Some(h) = state.try_borrow::<AudioHandle>() {
        h.send(AudioCmd::SetBusVolume {
            bus: bus as usize,
            volume,
        });
    }
}

extension!(
    limina_audio,
    ops = [
        op_audio_init,
        op_audio_play,
        op_audio_ambient,
        op_audio_play_spatial,
        op_audio_speak,
        op_audio_play_buffer,
        op_audio_set_emitter,
        op_audio_set_listener,
        op_audio_set_volume,
        op_audio_stop,
        op_audio_stop_all,
        op_audio_set_bus_volume,
    ],
);

#[cfg(test)]
mod tests {
    use super::*;

    /// A full bounded channel must DROP further sends (not block the V8 thread, not
    /// grow memory), and draining must release the backpressure.
    #[test]
    fn bounded_channel_drops_when_full_without_blocking() {
        let (tx, rx) = mpsc::sync_channel::<AudioCmd>(2);
        let h = AudioHandle {
            tx: Some(Arc::new(tx)),
            join: None,
            dropped: AtomicU64::new(0),
            next_id: 0,
        };
        // Fill the capacity (2) — these buffer successfully.
        h.send(AudioCmd::StopAll);
        h.send(AudioCmd::StopAll);
        // Now full: further sends must be dropped (returns immediately, no block)
        // and bump the dropped counter — never queued.
        h.send(AudioCmd::StopAll);
        h.send(AudioCmd::StopAll);
        assert_eq!(h.dropped.load(Ordering::Relaxed), 2);
        // Drain one; a subsequent send succeeds again (backpressure released).
        assert!(matches!(rx.try_recv(), Ok(AudioCmd::StopAll)));
        h.send(AudioCmd::StopAll);
        assert_eq!(h.dropped.load(Ordering::Relaxed), 2);
    }

    /// The receive loop (`for cmd in rx`) must terminate once every sender drops.
    /// The audio thread holds only a `Weak` for the TTS-back path, so it never keeps
    /// the loop alive; a transient worker (an upgraded sender) does, but only until
    /// it finishes.
    #[test]
    fn receive_loop_terminates_when_senders_drop() {
        let (tx, rx) = mpsc::sync_channel::<AudioCmd>(AUDIO_CMD_CAPACITY);
        let tx = Arc::new(tx);
        let back = Arc::downgrade(&tx); // what the audio thread holds
        // A consumer mirroring run_audio's `for cmd in rx { .. }` loop.
        let consumer = thread::spawn(move || {
            let mut n = 0usize;
            for _cmd in rx {
                n += 1;
            }
            n
        });
        // A transient TTS worker upgrades the weak sender and delivers one line.
        let worker_tx = back.upgrade().expect("sender alive");
        worker_tx.try_send(AudioCmd::StopAll).expect("buffered");
        // JS-side drops its (strong) sender: the loop must NOT end yet, because the
        // worker still holds a live clone.
        drop(tx);
        assert!(back.upgrade().is_some());
        // Worker finishes: the last sender drops, so the weak can no longer upgrade
        // and the receive loop terminates.
        drop(worker_tx);
        assert!(back.upgrade().is_none());
        assert_eq!(consumer.join().expect("consumer joined"), 1);
    }
}
