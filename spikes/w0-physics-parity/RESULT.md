# W0 — Native ↔ Wasm Rapier Physics Parity Probe

**Question:** Does limina's native (FFI) Rapier produce the *same* physics result as
`@dimforge/rapier3d` **wasm** for the same inputs? The answer decides the web‑export
contract: **pure log‑replay parity** vs **snapshot‑keyframe export**.

**Verdict: snapshot‑keyframe export.** Inputs match to float noise on simple scenes,
but contact‑rich scenes diverge macroscopically, and there is no wasm build on the
native core version. Cross‑runtime bit‑replay is not a safe contract.

---

## What was run

| Side | Engine | Scene | Steps |
|------|--------|-------|-------|
| Native | `limina-physics` FFI → **rapier3d 0.33.0** (x86‑64) | ground + 8 dynamic boxes dropped in a stacked pile + 1 impulse | 300 |
| Wasm | `@dimforge/rapier3d-compat@0.19.3` → **rapier core 0.30.0** (wasm) | identical | 300 |

Files:
- `js/test/w0_native_dump.ts` → writes `traces/w0_native.json`, copied to `native.json`
- `wasm_dump.mjs` → `wasm.json`
- `compare.mjs` → per‑body L2 position + quaternion‑angle drift
- `control_native.ts` / `control_wasm.mjs` → single‑box free‑fall control (isolates chaos)

---

## Parameters — matched vs unmatched

Source of truth: `crates/limina-physics/src/lib.rs` +
`rapier3d-0.33.0/src/dynamics/integration_parameters.rs::default()`.

**Matched (mirrored exactly on the wasm side):**

| Parameter | Value |
|-----------|-------|
| gravity | `(0, −9.81, 0)` |
| dt / timestep | `1/60` |
| `num_solver_iterations` | 4 |
| `num_internal_pgs_iterations` | 1 |
| `warmstart_coefficient` | 1.0 |
| `length_unit` | 1.0 |
| `normalized_allowed_linear_error` | 0.001 |
| `normalized_prediction_distance` | 0.002 |
| ground collider | fixed cuboid half‑extents `(100, 0.5, 100)`, centered `(0, −0.5, 0)`, top at y=0 |
| box body | `RigidBodyBuilder::dynamic()` at spawn offset |
| box collider | cuboid half‑extents `(0.5, 0.5, 0.5)` |
| density / mass | default **1.0** → mass 1.0 (1×1×1 box) |
| friction | default **0.5** |
| restitution | default **0.0** |
| CCD | off (dynamic bodies default `ccd_enabled = false`) |
| impulse | `(2, 0, 1)` on body 0, before stepping |
| body order / ids | 0..7 in spawn order (ground is a parent‑less collider, no id) |

**Could NOT match (limits the conclusion):**

1. **Rust rapier core version.** Native is **0.33.0**; the newest *published* wasm
   build (`@dimforge/rapier3d` 0.19.3, and its canary) bundles **0.30.0**. There is
   **no wasm release on 0.33**. Between 0.30 → 0.33 the solver internals changed
   (e.g. `IntegrationParameters` gained `contact_softness: SpringCoefficients` and a
   `friction_model` field in 0.33), so the contact/friction solve is not identical
   even with identical inputs. This is the dominant unmatched variable.
2. **Float backend.** Native x86‑64 f32 vs wasm f32 differ in rounding / FMA / codegen.
   Unavoidable across runtimes; on its own this is float‑noise sized (see control).
3. Sub‑iteration knobs only present in 0.33 (`num_internal_stabilization_iterations`,
   `contact_softness`) have no 0.30 wasm equivalent to set.

---

## Measured drift (8‑box pile, 300 steps)

```
position drift  L2 (meters):  max=4.126942e-1  mean=9.046295e-2
rotation drift  angle (rad):  max=2.238262e+0  mean=4.882591e-1
rotation drift  angle (deg):  max=128.2429     mean=27.9752
```

Per body: bodies 3 and 7 ended in nearly opposite orientations (128° and 91°); the
pile reshuffled differently across runtimes. **This is not float noise.**

## Control (single box free‑fall + rest, 300 steps)

```
control pos L2 drift: 3.044795e-8 m
control rot drift:    0.000000e+0 rad
```

The same two engines, on a **non‑chaotic** scene, agree to **f32 epsilon**. So the
huge pile drift is **chaotic amplification** of (a) tiny f32 rounding differences and
(b) the 0.30↔0.33 solver delta — a toppling contact pile is a chaotic system that
exponentially magnifies any per‑step difference over 300 steps. Both causes are real
and neither can be removed: we cannot get a 0.33 wasm build, and we cannot make two
runtimes share bit‑identical f32.

---

## Recommendation — snapshot‑keyframe export

**Do NOT base web export on pure log‑replay parity** (ship the op/input log and
re‑simulate on wasm expecting the same world). Two independent reasons:

1. **No version parity is even available.** Native rapier 0.33 has no wasm twin; the
   best wasm is 0.30 with a changed solver. Until/unless `@dimforge/rapier3d` ships a
   0.33 build, the cores are different programs.
2. **Even with a matched core, contact simulation is chaotic.** The control proves the
   engines agree to f32 noise on simple scenes, and the pile proves any contact‑rich
   scene amplifies that noise to macroscopic divergence. Cross‑runtime f32 is not
   bit‑identical, so replay parity fails for exactly the scenes games care about
   (stacks, collisions, ragdolls).

**Contract:** simulate authoritatively on the native host, and export the deterministic
**world log as periodic transform keyframes (snapshots)** — body pos+quat at a fixed
cadence — that the web/wasm client *replays/interpolates*, rather than re‑deriving
state from inputs. limina already has the right primitive natively
(`op_physics_snapshot` / `op_physics_restore`, f32 bincode is bit‑exact *within the
same engine*); the export format should carry transform keyframes, not a re‑simulation
seed. Pure log‑replay can remain valid only **within one engine build** (native↔native
determinism, already verified by P0.5), not across the native↔wasm boundary.

**Caveat on certainty:** because the version skew and the f32‑backend difference are
entangled, this probe cannot attribute the pile drift to one cause. It does not need
to: *both* are present and *both* are unfixable today, so the export contract must not
assume cross‑runtime determinism regardless. If a rapier 0.33 wasm build later appears,
re‑run this probe — the *control* parity (3e‑8 m) suggests a matched‑core wasm could
get simple scenes to float noise, but the chaotic‑pile result means snapshot‑keyframe
export stays the safe default for contact‑rich content.
