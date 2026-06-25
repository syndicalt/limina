# Limina — Phase 5 Plan: Presentation & Audio (Multimodal Output)

> **Status:** ◐ **P5-A (Text/UI rendering) COMPLETE & verified (2026-06-23)** — A1 raster substrate + A2/A3
> styled containers (box/speech/thought/callout/label + screen HUD, billboard + camera-independent anchoring +
> lifecycle) + A4 `ui.*` skill surface (Zod schema, permission-gated, traced).
> showcase (`js/src/demos/ui_showcase.ts`); `build`/`clippy`/`fmt` clean; pure TS (no engine-core Rust).
> **CAPSTONE DELIVERED (visuals-first):** `js/src/demos/forest_conversation.ts` — an agent-controlled humanoid
> walks up to two forest agents and holds a **real, non-deterministic Ollama (`qwen2.5:7b`) conversation** in
> speech bubbles, with a live real agent-ops HUD + fixed camera behind the player; deterministic pipeline test
> `js/test/p5_conversation.ts`; **36/36 headless** + verified live (2 exchanges / 8 lines). **P5-B (Audio) — not
> started** (pull on demand; would add spoken dialogue + ambient). Independent track; depends only on Phase 0.
> **Parent roadmap:** `plans/ROADMAP.md` · **Builds on:** Phase 0 (render + runtime) · Phase 1 (skills/MCP/trace)
> **Principle:** performance-first; the engine provides presentation *capabilities*, agents drive them via skills.

## Outcome

limina can **show text on screen** (world-space labels/speech bubbles + screen-space HUD/overlay panels) and
**play audio** (spatial/positional + ambient), both exposed as typed, permission-checked, traced **skills** so
agents author them the same way they author the world. The acceptance target is a **rich agent-conversation
demo**: humanoid agents hold a real-time, non-deterministic (LLM-driven) conversation rendered as **speech
bubbles**, with a **live on-screen agent-ops HUD**, **audible spoken dialogue**, and **ambient forest audio**.

## Why now (engine gaps — grounded in the current codebase)

- **No text.** There is no text/canvas/font primitive anywhere in the runtime. The ONLY proven texture path is
  `THREE.DataTexture` with raw RGBA pixels: the embedder's WebGPU backend has **no `copyExternalImageToTexture`**,
  so `ImageBitmap`-backed textures upload **black** — glTF textures only work because `three.loadGLTF` re-homes
  them to a `DataTexture` (`queue.writeTexture`). Any on-screen text must therefore be **rasterized to RGBA and
  uploaded as a `DataTexture`** (or drawn as geometry). There is no `FontLoader`/`TextGeometry`/`CanvasTexture`/
  `OffscreenCanvas`/2D canvas in the bundle or runtime.
- **No audio.** Zero audio anywhere (`js/src` + `crates`): no Web Audio, no `AudioContext`, no audio op, no device
  output. Audio is a brand-new subsystem.

## Pillars

### P5-A — Text / UI rendering  *(near-term pull — the conversation demo needs it)*

The capability is an **expressive, in-scene text-container system** — not just glyphs on a quad. Builders and
agents **place and fully style** text boxes, speech bubbles, thought bubbles, labels, callouts, and screen-space
HUD/overlay panels — each authored through a typed `ui.*` / `text.*` skill (permission-checked + traced), plus a
host TS API the demo uses directly.

**Container kinds (placeable anywhere in a scene):**
- **Label** — plain billboard text tracking an entity or world point.
- **Text box / panel** — rectangular container with an optional title/header bar; world- or screen-anchored.
- **Speech bubble** — rounded box + a directional **tail/pointer** aimed at the speaking entity or a world point.
- **Thought bubble** — cloud-puff outline + trailing puffs leading back to the thinker.
- **Callout / annotation** — a **leader line** from the box to a world point (labeling parts of a scene).
- **HUD panel** — screen-anchored (corner/coords, DPI-aware), e.g. a scrolling feed (the live agent-ops trace).

**Builder-controllable style (the expressive surface — one typed, validated style object):**
- **Border:** width, color, style (solid / dashed / none), corner radius.
- **Background:** fill color, opacity/alpha, optional gradient, padding/insets, optional drop shadow.
- **Title / header:** title text, optional header bar with its own background/color, optional **icon/avatar**.
- **Text:** font (family/atlas), size, weight, color, alignment (left / center / right), line-height,
  **word-wrap + max-width**, multi-line, **rich runs** (per-segment color/weight/italic), truncation/ellipsis.
- **Tail / pointer:** for bubbles — direction + anchor toward a target entity or world point; thought-bubble
  trailing puffs.
- **Placement & layout:** world-anchored (attach to entity + offset; **billboard** face-camera, or fixed
  orientation) or screen-anchored; **z-order / layer**; **auto-size to content** or fixed size; max dimensions.
- **Lifecycle & motion:** show / hide, **fade in/out**, optional **typewriter reveal**, time-to-live /
  auto-dismiss, and per-speaker **queue or replace** of successive lines (so a conversation reads naturally).

**Skill / API surface:** a unified `ui.panel({ kind, anchor, style, text, title, tail, ttl, … })` (or per-kind
`ui.speechBubble` / `ui.thoughtBubble` / `ui.textBox` / `ui.label` / `ui.hudPanel`) + `ui.update` / `ui.remove`,
all taking the same **style schema** (Zod-validated). Agent-native, so **builders author expressive UI over MCP**
exactly as they author the world — the conversation demo's bubbles + agent-ops HUD are just consumers of it.

**The rasterization bet (decide at kickoff):** the engine composites each container (border + background + title +
wrapped/styled text + tail) into an RGBA buffer and uploads it as a `DataTexture` on a quad (world billboard or
screen quad). How glyphs are rasterized:
- **(a) TS bitmap/atlas font → `DataTexture`** — simplest, no new Rust dep, proven path now; bitmap scaling is
  blocky. *Recommended first cut* (compositing borders/bg/tails is plain TS pixel/quad work on top).
- **(b) MSDF atlas + `ShaderMaterial`** — crisp text at any scale from one atlas; needs a prebaked atlas + shader.
- **(c) Three `TextGeometry` + `FontLoader`** — geometry text; font JSON, heavier per glyph, no atlas. Reject
  unless geometry text is specifically wanted.
- **(d) Native Rust rasterizer** (`cosmic-text`/`fontdue`) → RGBA → `DataTexture` — real shaping/kerning/i18n,
  rich runs, emoji; a new dep + op. Best long-term; pull when (a)/(b) are insufficient.

Performance-first: cache glyph atlases **and composited container textures**, re-rasterize/re-composite only when
content or style changes, batch quads, billboard via a camera-facing quad; the HUD is a single overlay pass.

### P5-B — Audio rendering

The capability: **play sounds** (one-shots + looping ambience), **positional/spatial audio** (3D panning +
distance attenuation, listener = camera, source attached to an entity), a small **mixer** (voices, per-bus
volume), and asset loading/decoding. Exposed as an `audio.*` skill family (play/attach/stop/volume),
permission-checked + traced like every other capability.

**The output bet (decide at kickoff):**
- **SDL3 audio subsystem** — SDL3 is **already linked** (used in the P4.0b isolation/windowing spikes), so this
  adds no new top-level dependency. *Recommended* unless decode/mixing ergonomics favor rodio.
- **`rodio`/`cpal`** (native Rust) — ergonomic decode (wav/ogg/mp3) + mixing + spatial sink; a new dep but
  batteries-included.
- Codec scope (wav-only first vs ogg/mp3) decided at kickoff.

**Agent speech (optional, pluggable):** a **TTS provider behind a seam** (external service via the existing
`op_http_post`, mirroring the `LLMProvider` pattern) turns agent dialogue lines into audio — the **engine stays
the substrate; the voice is pluggable**, never a runtime dependency. Defer if the first cut is SFX + ambience only.

**Audio input (mic):** out of scope for the first cut; pull on demand for voice-driven agents.

Performance-first: native mixing/decoding off the frame-critical path (async decode, a dedicated audio
thread/callback); never block the render loop on audio I/O.

## Hard-to-reverse decisions (lock at kickoff)

| Decision | Why hard to reverse |
|---|---|
| **Text rasterization mechanism** (TS bitmap/atlas vs MSDF+shader vs native rasterizer) | The glyph/atlas format + the quad/shader contract; downstream UI builds against it |
| **Font/atlas asset format** | Atlases are baked assets; format migration re-bakes everything |
| **Container model + style schema** (the `ui.*` kinds + the typed style object) and the `text.*` skill surface | Builders/agents author every box/bubble/HUD against it — the wire/skill contract *and* the style vocabulary |
| **Audio output backend** (SDL3 vs rodio/cpal) | The device/mixer plumbing; everything routes through it |
| **Spatialization model** (panning law, attenuation curve, listener binding) | Mix reproducibility; content authored against it |
| **`audio.*` skill surface + (optional) TTS seam** | The capability + provider contract agents/voices integrate against |

## Roadmap-level milestones (sketch — firm at kickoff)

- **A1 — Text raster substrate:** font/atlas → RGBA → `DataTexture` → quad; a headless **pixel-readback test**
  (assert rendered glyph texels, à la `p3_textured_gltf`).
- **A2 — Styled containers (world-space):** the composited box (border + background + title + padding) with
  wrapped, styled, multi-line text; **speech & thought bubbles** with tails/puffs; labels + callouts (leader line);
  camera-facing billboards tracking an entity, with fade in/out + per-speaker queue/replace.
- **A3 — Screen-space HUD/overlay:** the same container model screen-anchored (DPI-aware, z-ordered); the **live
  agent-ops trace** feed with auto-size + scroll.
- **A4 — `ui.*` / `text.*` skills + style schema:** agent-native, permission-checked, traced; the full
  builder-controllable style object (border / background / title / text / tail / placement / lifecycle) over MCP.
- **B1 — Audio output + decode:** backend up, load/decode, play a one-shot; headless smoke (no device assert in CI).
- **B2 — Spatial/positional audio:** 3D pan + attenuation, source-on-entity, listener = camera; ambience loop + mixer.
- **B3 — `audio.*` skills:** play/attach/stop/volume, permission-checked + traced.
- **B4 — (optional) TTS seam:** pluggable external voice provider via `op_http_post` for agent speech.

## Capstone acceptance demo (the motivating use case)

A **forest scene** with an agent-controlled **humanoid "player"** and **two other humanoid agents**. The player
(LLM-driven, **non-deterministic**) walks up to an agent, **greets** it, and they hold a **short real-time
conversation rendered as speech bubbles**; a **live HUD** shows agent operations as they happen
(perception → decision → LLM call → action → skill → permission checks, from the trace). With P5-B: the dialogue
is **spoken aloud** (TTS) over **ambient forest audio**. Everything visible is driven through the agent-native
skill pipeline and traced.

## Scope guards / non-goals (first cut)

A rich **styled text-container + overlay** system (boxes, speech/thought bubbles, callouts, labels, HUD panels —
with full border/background/title/text/tail styling) is **in scope**; a general retained-mode UI toolkit is **not**
(no flexbox/grid layout engine; no interactive buttons/inputs/event-routing beyond what a demo needs). Not a DAW/audio-graph
(a small mixer, not arbitrary DSP). No mic/voice **input** yet. No video. i18n/complex shaping only if the native
rasterizer (text option d) is chosen. Browser/wasm parity is Phase 4x's concern, not here.

## Open questions (recommended defaults)

1. **Text mechanism?** — *Rec:* start **(a) TS bitmap/atlas → `DataTexture`** (no new dep, proven path, immediate),
   move to **(b) MSDF** for crisp scalable UI, and **(d) native rasterizer** only if shaping/i18n is needed.
2. **Audio backend?** — *Rec:* **SDL3 audio** (already linked, no new top-level dep); `rodio` if decode/mixing
   ergonomics win at kickoff.
3. **Spatial audio?** — *Rec:* positional source-on-entity, listener = camera, distance attenuation; ambience as a
   non-spatial looping bus.
4. **Agent speech (TTS)?** — *Rec:* a **pluggable external provider via `op_http_post`** (engine stays substrate);
   optional, after SFX + ambience.
5. **Audio input (mic)?** — *Rec:* **defer** (pull on demand for voice agents).
6. **Codec scope?** — *Rec:* **wav first**, add ogg/mp3 at kickoff if assets need it.

## Executable A-track acceptance (P5-A — kicked off 2026-06-23)

Operationalizes A1–A4 into falsifiable, anti-reward-hack acceptance. **Locked defaults:** text via a **TS
prebaked-atlas / embedded bitmap font → composited RGBA → `DataTexture` quad** (offline, decode-free, no DOM, no
heavy new dep; MSDF/native rasterizer deferred). Pure TS expected (no engine-core Rust). Every container
composites border + background + title + wrapped/styled text + tail into ONE RGBA buffer, cached until
content/style changes. **No hacks:** tests assert real composited pixels (read back) and FAIL when the feature
breaks; the windowed path must show LEGIBLE text on screen (not black/blank — the known `DataTexture` +
white-window risk), proven by a screenshot at verification.

- **A1 — raster substrate.** Headless: composite a styled box (known text, border color B, bg color G at opacity,
  padding P) into RGBA; read back and assert (i) glyph-covered texels non-zero where the glyph is + zero in a
  known-empty cell; (ii) a border texel == B; (iii) an interior texel == G (alpha-blended); (iv) the texture
  uploads as a sampled `DataTexture` (non-black). Falsifiable: changing the string changes the glyph texels;
  removing the border drops the B texels.
- **A2 — world containers.** speech bubble (tail points toward the anchor entity/point), thought bubble (puffs),
  text box (title-bar bg ≠ body bg), label, callout (leader line to a world point); multi-line **word-wrap** to a
  max-width yields the expected line count at expected baselines; the quad **billboards** (orientation tracks the
  camera each frame); lifecycle: fade alpha ramps 0→1; per-speaker **queue/replace**. Falsifiable: wrong wrap or a
  tail pointing away fails the assert.
- **A3 — screen HUD/overlay.** a panel screen-anchored to a corner lands in the expected screen-pixel region
  **independent of camera**; DPI-aware; drawn over the scene (z-order); a **scrolling agent-ops feed** shows the
  latest N trace lines (newest in order). Falsifiable: orbiting the camera must NOT move the HUD; appending a line
  scrolls the feed.
- **A4 — `ui.*` / `text.*` skills + style schema.** a builder over MCP calls `ui.speechBubble`/`ui.panel` with a
  full Zod style object (border/background/title/tail/text/placement) → gets a handle; `ui.update` changes text;
  `ui.remove` removes it; **permission-checked** (an un-granted profile is denied `ui.write` with zero effect) and
  **traced** (each call emits an event). Falsifiable: a malformed style is Zod-rejected; the denied call leaves no panel.
- **Verification (Main):** the new `p5_*` headless tests + `cargo build`/`clippy`/`fmt` + a **windowed screenshot**
  of a styled box/bubble proving legible on-screen text.

## P5-A delivered (2026-06-23)

All four A-milestones met against the acceptance above; pure TS, **no engine-core Rust**; `cargo build`/`clippy
--workspace`/`fmt` clean; **35/35 headless tests** pass; `js/src/demos/ui_showcase.ts` runs `--window` clean.

- **A1** — `js/src/ui/{font,layout,compositor,surface,index}.ts` (embedded anti-aliased atlas → composited RGBA →
  `DataTexture` quad; `isDataTexture`→`queue.writeTexture`); `js/test/p5_text_substrate.ts` (CPU readback + GPU
  offscreen non-black, falsifiable).
- **A2/A3** — `js/src/ui/{compositor (rounded/shadow/gradient/rich-runs/tail/puffs/callout), containers, anchor,
  lifecycle}.ts`; world billboard + **camera-independent** screen overlay; `js/test/p5_containers.ts` + `p5_hud.ts`.
- **A4** — `js/src/ui/manager.ts` (`UiManager`: handles + anchor/lifecycle host tick) + `js/src/skills/ui.ts`
  (`ui.panel`/`label`/`textBox`/`speechBubble`/`thoughtBubble`/`callout`/`hudPanel`/`update`/`remove`, `uiStyleSchema`);
  `ui.write` permission on `builder.readWrite`; registered in `registerCoreSkills` (returns `{ packages, ui }`);
  `js/test/p5_ui_skills.ts` (builder-over-MCP create/update/remove + permission-deny zero-effect + Zod-reject + trace).
- **Visual:** `./target/debug/limina --window js/src/demos/ui_showcase.ts` (speech/thought/text/callout billboards +
  screen HUD, all authored via `ui.*` skills). On-screen legibility rests on the A1 GPU readback proof; an OS
  screenshot is pending a free desktop.

**Next:** P5-B (audio) on demand; the agent-conversation forest demo (the capstone) is now unblocked on the
text/UI side — it needs the agent/LLM/locomotion layer (+ optional P5-B audio).

## Deferred runtime follow-up (noted 2026-06-23)

- **Non-blocking windowed event-loop pump (next phase).** The windowed host
  (`crates/limina-runtime/src/windowed.rs`) awaits `poll_event_loop` to *quiescence* once per frame, so an
  in-flight async op — e.g. the conversation demo's Ollama call (`op_http_post` is already async) — stalls the
  frame loop until it resolves (~1.2–2 s freeze per LLM line). Fix: pump the event loop **once per frame,
  non-blocking** (ignore `Pending`, keep rendering) so async ops resolve across frames with the scene live
  ("thinking" without a freeze). Engine-core Rust; benefits any windowed async (audio P5-B, networking).
  **Interim:** the conversation demo moves the camera to its two-shot *before* the first LLM call so the camera
  transition stays smooth, and the Agent Ops HUD is a fixed-size scrolling console.
