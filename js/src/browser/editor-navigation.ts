import * as THREE from "../../build/three.bundle.mjs";

export type EditorNavigationMode = "orbit" | "fly";

export interface EditorCameraPose {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly up: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly mode: EditorNavigationMode;
  readonly speedMps: number;
}

export interface EditorNavigationOptions {
  readonly mode?: EditorNavigationMode;
  readonly speedMps?: number;
  readonly boostMultiplier?: number;
  readonly precisionMultiplier?: number;
  readonly target: readonly [number, number, number];
  readonly minDistanceM: number;
  readonly maxDistanceM: number;
  readonly maxPolarAngleRad: number;
}

export interface EditorNavigationAnchor {
  x: number;
  y: number;
  z: number;
}

export interface RunningEditorNavigation {
  readonly orbitControls: InstanceType<typeof THREE.OrbitControls>;
  mode(): EditorNavigationMode;
  setMode(mode: EditorNavigationMode): void;
  speed(): number;
  setSpeed(speedMps: number): number;
  setEnabled(enabled: boolean): void;
  acquireDisabled(): () => void;
  isCapturingInput(): boolean;
  update(nowMs?: number): void;
  writeAnchor(out: EditorNavigationAnchor): EditorNavigationAnchor;
  residencyCenter(pose: unknown): readonly [number, number];
  snapshot(): Readonly<EditorCameraPose>;
  restore(pose: unknown): void;
  destinationPose(target: readonly [number, number, number], radiusM?: number): Readonly<EditorCameraPose>;
  framePoint(target: readonly [number, number, number], radiusM?: number): Readonly<EditorCameraPose>;
  objectPose(object: InstanceType<typeof THREE.Object3D>, padding?: number): Readonly<EditorCameraPose>;
  frameObject(object: InstanceType<typeof THREE.Object3D>, padding?: number): Readonly<EditorCameraPose>;
  constrainAboveSurface(surfaceHeightM: number, clearanceM?: number): boolean;
  constrainToResidencyGrid(chunkSizeM: number, radius?: number, thresholdChunks?: number): number;
  dispose(): void;
}

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type PointerElement = HTMLElement & {
  ownerDocument: Document;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  requestPointerLock?(): Promise<void> | void;
};

const MIN_SPEED_MPS = 0.1;
const MAX_SPEED_MPS = 5_000;
const MAX_FRAME_SECONDS = 0.1;
const LOOK_RADIANS_PER_PIXEL = 0.0025;
const MIN_FLY_PITCH = -Math.PI / 2 + 0.02;
const MAX_FLY_PITCH = Math.PI / 2 - 0.02;
const MIN_FRAME_RADIUS_M = 0.05;
const DEFAULT_FRAME_PADDING = 1.25;
const DEFAULT_FLY_SURFACE_CLEARANCE_M = 2;

function finiteTuple(value: unknown, size: 3 | 4, label: string): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length !== size || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== size + 1) {
    throw new TypeError(`${label} must be a finite ${size}-tuple`);
  }
  const tuple: number[] = [];
  for (let index = 0; index < size; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)
        || typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) {
      throw new TypeError(`${label} must be a finite ${size}-tuple`);
    }
    tuple.push(Object.is(descriptor.value, -0) ? 0 : descriptor.value);
  }
  return tuple;
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) {
    throw new TypeError(`${label} must be a finite positive number`);
  }
  return value;
}

function navigationMode(value: unknown): EditorNavigationMode {
  if (value !== "orbit" && value !== "fly") throw new TypeError("editor navigation mode must be orbit or fly");
  return value;
}

function boundedSpeed(value: unknown): number {
  return Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, finitePositive(value, "editor navigation speed")));
}

function frozenPose(
  position: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
  up: readonly [number, number, number],
  target: readonly [number, number, number],
  mode: EditorNavigationMode,
  speedMps: number,
): Readonly<EditorCameraPose> {
  return Object.freeze({
    position: Object.freeze([...position] as [number, number, number]),
    quaternion: Object.freeze([...quaternion] as [number, number, number, number]),
    up: Object.freeze([...up] as [number, number, number]),
    target: Object.freeze([...target] as [number, number, number]),
    mode,
    speedMps,
  });
}

function parsedPose(input: unknown): Readonly<{
  position: number[];
  quaternion: number[];
  up: number[];
  target: number[];
  mode: EditorNavigationMode;
  speedMps: number;
}> {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("editor camera pose must be a plain object");
  }
  const pose = input as Record<string, unknown>;
  const required = ["position", "quaternion", "up", "target", "mode", "speedMps"];
  const names = Object.getOwnPropertyNames(pose);
  if (Object.getOwnPropertySymbols(pose).length !== 0 || names.length !== required.length
      || required.some((name) => !names.includes(name))) {
    throw new TypeError("editor camera pose has unsupported or missing fields");
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(pose, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`editor camera pose.${name} must be an enumerable data field`);
    }
  }
  const position = finiteTuple(pose.position, 3, "editor camera pose.position");
  const quaternion = finiteTuple(pose.quaternion, 4, "editor camera pose.quaternion");
  const up = finiteTuple(pose.up, 3, "editor camera pose.up");
  if (Math.hypot(...quaternion) < 1e-8) throw new RangeError("editor camera pose quaternion must be non-zero");
  if (Math.hypot(...up) < 1e-8) throw new RangeError("editor camera pose up vector must be non-zero");
  return {
    position,
    quaternion,
    up,
    target: finiteTuple(pose.target, 3, "editor camera pose.target"),
    mode: navigationMode(pose.mode),
    speedMps: boundedSpeed(pose.speedMps),
  };
}

function editableTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (element?.isContentEditable) return true;
  return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || element?.tagName === "SELECT";
}

/** Local editor camera navigation. It owns view state only and never emits authoring commands. */
export class EditorNavigationController implements RunningEditorNavigation {
  readonly orbitControls: InstanceType<typeof THREE.OrbitControls>;
  readonly #camera: InstanceType<typeof THREE.PerspectiveCamera>;
  readonly #element: PointerElement;
  readonly #keyTarget?: ListenerTarget;
  readonly #documentTarget?: Document;
  readonly #now: () => number;
  readonly #boostMultiplier: number;
  readonly #precisionMultiplier: number;
  readonly #pressed = new Set<string>();
  readonly #forward = new THREE.Vector3();
  readonly #right = new THREE.Vector3();
  readonly #movement = new THREE.Vector3();
  readonly #worldUp = new THREE.Vector3(0, 1, 0);
  readonly #flyEuler = new THREE.Euler(0, 0, 0, "YXZ");
  readonly #frameBox = new THREE.Box3();
  readonly #frameSphere = new THREE.Sphere();
  readonly #frameTarget = new THREE.Vector3();
  readonly #frameOffset = new THREE.Vector3();
  readonly #frameCamera = new THREE.PerspectiveCamera();
  #mode: EditorNavigationMode;
  #speedMps: number;
  #enabled = true;
  readonly #disableLeases = new Set<symbol>();
  #disposed = false;
  #rightPointerId: number | null = null;
  #focusDistanceM: number;
  #lastUpdateMs: number | undefined;
  #configuredMaxDistanceM: number;

  constructor(options: Readonly<{
    camera: InstanceType<typeof THREE.PerspectiveCamera>;
    element: PointerElement;
    keyTarget?: ListenerTarget;
    documentTarget?: Document;
    navigation: EditorNavigationOptions;
    now?: () => number;
  }>) {
    this.#camera = options.camera;
    this.#element = options.element;
    this.#keyTarget = options.keyTarget;
    this.#documentTarget = options.documentTarget ?? options.element.ownerDocument;
    this.#now = options.now ?? (() => performance.now());
    this.#mode = navigationMode(options.navigation.mode ?? "orbit");
    this.#speedMps = boundedSpeed(options.navigation.speedMps ?? 32);
    this.#boostMultiplier = finitePositive(options.navigation.boostMultiplier ?? 4, "editor navigation boost multiplier");
    this.#precisionMultiplier = finitePositive(options.navigation.precisionMultiplier ?? 0.2, "editor navigation precision multiplier");
    if (this.#boostMultiplier < 1 || this.#boostMultiplier > 100) {
      throw new RangeError("editor navigation boost multiplier must be within [1,100]");
    }
    if (this.#precisionMultiplier > 1) {
      throw new RangeError("editor navigation precision multiplier must be within (0,1]");
    }
    const target = finiteTuple(options.navigation.target, 3, "editor navigation target");
    const minDistance = finitePositive(options.navigation.minDistanceM, "editor navigation minimum distance");
    const maxDistance = finitePositive(options.navigation.maxDistanceM, "editor navigation maximum distance");
    if (maxDistance <= minDistance) throw new RangeError("editor navigation maximum distance must exceed its minimum distance");
    const maxPolar = finitePositive(options.navigation.maxPolarAngleRad, "editor navigation maximum polar angle");
    this.#configuredMaxDistanceM = maxDistance;

    this.orbitControls = new THREE.OrbitControls(this.#camera, this.#element);
    this.orbitControls.target.set(target[0]!, target[1]!, target[2]!);
    this.orbitControls.enableRotate = true;
    this.orbitControls.enableZoom = true;
    this.orbitControls.enablePan = true;
    this.orbitControls.enableDamping = true;
    this.orbitControls.minDistance = minDistance;
    this.orbitControls.maxDistance = maxDistance;
    this.orbitControls.minPolarAngle = 0.04;
    this.orbitControls.maxPolarAngle = Math.min(Math.PI - 0.04, maxPolar);
    this.#focusDistanceM = Math.max(minDistance, this.#camera.position.distanceTo(this.orbitControls.target));
    this.#applyEnabledState();
    if (this.#mode === "orbit") this.orbitControls.update();
    else this.#syncFlyTarget();

    this.#element.addEventListener("pointerdown", this.#onPointerDown);
    this.#element.addEventListener("pointermove", this.#onPointerMove);
    this.#element.addEventListener("pointerup", this.#onPointerUp);
    this.#element.addEventListener("pointercancel", this.#onPointerCancel);
    this.#element.addEventListener("contextmenu", this.#onContextMenu);
    this.#keyTarget?.addEventListener("keydown", this.#onKeyDown);
    this.#keyTarget?.addEventListener("keyup", this.#onKeyUp);
    this.#keyTarget?.addEventListener("blur", this.#onBlur);
    this.#documentTarget?.addEventListener("visibilitychange", this.#onVisibilityChange);
    this.#documentTarget?.addEventListener("pointerlockchange", this.#onPointerLockChange);
    this.#documentTarget?.addEventListener("contextmenu", this.#onDocumentContextMenu);
  }

  mode(): EditorNavigationMode { return this.#mode; }

  setMode(mode: EditorNavigationMode): void {
    this.#requireLive();
    const next = navigationMode(mode);
    if (next === this.#mode) return;
    this.#releaseInput();
    if (next === "fly") {
      this.#focusDistanceM = Math.max(this.orbitControls.minDistance, this.#camera.position.distanceTo(this.orbitControls.target));
      this.#flyEuler.setFromQuaternion(this.#camera.quaternion, "YXZ");
      this.#flyEuler.z = 0;
    }
    this.#mode = next;
    this.#applyEnabledState();
    if (next === "orbit") this.orbitControls.update();
    else this.#syncFlyTarget();
  }

  speed(): number { return this.#speedMps; }

  setSpeed(speedMps: number): number {
    this.#requireLive();
    this.#speedMps = boundedSpeed(speedMps);
    return this.#speedMps;
  }

  setEnabled(enabled: boolean): void {
    this.#requireLive();
    this.#enabled = enabled === true;
    if (!this.#enabled) this.#releaseInput();
    this.#applyEnabledState();
  }

  acquireDisabled(): () => void {
    this.#requireLive();
    const lease = Symbol("editor-navigation-disabled");
    this.#disableLeases.add(lease);
    this.#releaseInput();
    this.#applyEnabledState();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#disposed || !this.#disableLeases.delete(lease)) return;
      this.#applyEnabledState();
    };
  }

  isCapturingInput(): boolean {
    return !this.#disposed && this.#effectivelyEnabled() && this.#mode === "fly" && this.#rightPointerId !== null;
  }

  update(nowMs = this.#now()): void {
    if (this.#disposed) return;
    if (!Number.isFinite(nowMs)) return;
    const prior = this.#lastUpdateMs;
    this.#lastUpdateMs = nowMs;
    if (this.#mode === "orbit") {
      if (this.#effectivelyEnabled()) this.orbitControls.update();
      return;
    }
    if (!this.#effectivelyEnabled() || prior === undefined || !this.isCapturingInput()) {
      this.#syncFlyTarget();
      return;
    }
    const elapsed = Math.min(MAX_FRAME_SECONDS, Math.max(0, (nowMs - prior) / 1_000));
    if (elapsed === 0) return;
    let forward = (this.#pressed.has("KeyW") ? 1 : 0) - (this.#pressed.has("KeyS") ? 1 : 0);
    let right = (this.#pressed.has("KeyD") ? 1 : 0) - (this.#pressed.has("KeyA") ? 1 : 0);
    let vertical = (this.#pressed.has("KeyE") ? 1 : 0) - (this.#pressed.has("KeyQ") ? 1 : 0);
    if (forward === 0 && right === 0 && vertical === 0) return;
    const magnitude = Math.hypot(forward, right, vertical);
    forward /= magnitude;
    right /= magnitude;
    vertical /= magnitude;

    this.#camera.getWorldDirection(this.#forward);
    this.#forward.y = 0;
    if (this.#forward.lengthSq() < 1e-8) {
      this.#forward.set(-Math.sin(this.#flyEuler.y), 0, -Math.cos(this.#flyEuler.y));
    } else this.#forward.normalize();
    this.#right.set(1, 0, 0).applyQuaternion(this.#camera.quaternion);
    this.#right.y = 0;
    if (this.#right.lengthSq() < 1e-8) this.#right.crossVectors(this.#forward, this.#worldUp);
    else this.#right.normalize();
    this.#movement.copy(this.#forward).multiplyScalar(forward)
      .addScaledVector(this.#right, right)
      .addScaledVector(this.#worldUp, vertical);
    if (this.#movement.lengthSq() > 0) this.#movement.normalize();
    let speed = this.#speedMps;
    if (this.#pressed.has("ShiftLeft") || this.#pressed.has("ShiftRight")) speed *= this.#boostMultiplier;
    if (this.#pressed.has("AltLeft") || this.#pressed.has("AltRight")) speed *= this.#precisionMultiplier;
    this.#camera.position.addScaledVector(this.#movement, speed * elapsed);
    this.#syncFlyTarget();
  }

  writeAnchor(out: EditorNavigationAnchor): EditorNavigationAnchor {
    if (this.#mode === "orbit") {
      out.x = this.orbitControls.target.x;
      out.y = this.orbitControls.target.y;
      out.z = this.orbitControls.target.z;
    } else {
      out.x = this.#camera.position.x;
      out.y = this.#camera.position.y;
      out.z = this.#camera.position.z;
    }
    return out;
  }

  residencyCenter(input: unknown): readonly [number, number] {
    const pose = parsedPose(input);
    const source = pose.mode === "orbit" ? pose.target : pose.position;
    return Object.freeze([source[0]!, source[2]!] as [number, number]);
  }

  snapshot(): Readonly<EditorCameraPose> {
    this.#requireLive();
    return frozenPose(
      [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z],
      [this.#camera.quaternion.x, this.#camera.quaternion.y, this.#camera.quaternion.z, this.#camera.quaternion.w],
      [this.#camera.up.x, this.#camera.up.y, this.#camera.up.z],
      [this.orbitControls.target.x, this.orbitControls.target.y, this.orbitControls.target.z],
      this.#mode,
      this.#speedMps,
    );
  }

  restore(input: unknown): void {
    this.#requireLive();
    const pose = parsedPose(input);
    const { position, quaternion, up, target, mode } = pose;
    const speed = pose.speedMps;
    const quaternionLength = Math.hypot(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!);
    if (quaternionLength < 1e-8) throw new RangeError("editor camera pose quaternion must be non-zero");
    if (Math.hypot(up[0]!, up[1]!, up[2]!) < 1e-8) throw new RangeError("editor camera pose up vector must be non-zero");

    this.#releaseInput();
    this.#camera.position.set(position[0]!, position[1]!, position[2]!);
    this.#camera.quaternion.set(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!).normalize();
    this.#camera.up.set(up[0]!, up[1]!, up[2]!).normalize();
    this.orbitControls.target.set(target[0]!, target[1]!, target[2]!);
    this.#mode = mode;
    this.#speedMps = speed;
    this.#focusDistanceM = Math.max(this.orbitControls.minDistance, this.#camera.position.distanceTo(this.orbitControls.target));
    this.#flyEuler.setFromQuaternion(this.#camera.quaternion, "YXZ");
    this.#flyEuler.z = 0;
    this.#applyEnabledState();
    if (mode === "orbit") this.orbitControls.update();
    else this.#syncFlyTarget();
  }

  destinationPose(targetInput: readonly [number, number, number], radiusM?: number): Readonly<EditorCameraPose> {
    this.#requireLive();
    const target = finiteTuple(targetInput, 3, "editor navigation destination");
    this.#frameTarget.set(target[0]!, target[1]!, target[2]!);
    this.#frameOffset.copy(this.#camera.position).sub(this.orbitControls.target);
    if (this.#frameOffset.lengthSq() < 1e-8) {
      this.#camera.getWorldDirection(this.#frameOffset).multiplyScalar(-1);
    } else this.#frameOffset.normalize();
    let desiredDistance = this.#mode === "orbit"
      ? this.#camera.position.distanceTo(this.orbitControls.target)
      : this.#focusDistanceM;
    if (radiusM !== undefined) {
      const radius = Math.max(MIN_FRAME_RADIUS_M, finitePositive(radiusM, "editor navigation frame radius"));
      const fovRadians = THREE.MathUtils.degToRad(this.#camera.fov);
      desiredDistance = radius * DEFAULT_FRAME_PADDING / Math.tan(Math.max(0.01, fovRadians * 0.5));
    }
    const distance = Math.min(this.orbitControls.maxDistance, Math.max(this.orbitControls.minDistance, desiredDistance));
    this.#frameCamera.position.copy(this.#frameTarget).addScaledVector(this.#frameOffset, distance);
    this.#frameCamera.up.copy(this.#camera.up);
    this.#frameCamera.lookAt(this.#frameTarget);
    return frozenPose(
      [this.#frameCamera.position.x, this.#frameCamera.position.y, this.#frameCamera.position.z],
      [this.#frameCamera.quaternion.x, this.#frameCamera.quaternion.y, this.#frameCamera.quaternion.z, this.#frameCamera.quaternion.w],
      [this.#frameCamera.up.x, this.#frameCamera.up.y, this.#frameCamera.up.z],
      [this.#frameTarget.x, this.#frameTarget.y, this.#frameTarget.z],
      "orbit",
      this.#speedMps,
    );
  }

  framePoint(target: readonly [number, number, number], radiusM?: number): Readonly<EditorCameraPose> {
    const pose = this.destinationPose(target, radiusM);
    this.restore(pose);
    return pose;
  }

  objectPose(object: InstanceType<typeof THREE.Object3D>, padding = DEFAULT_FRAME_PADDING): Readonly<EditorCameraPose> {
    this.#requireLive();
    if (!(object instanceof THREE.Object3D)) throw new TypeError("editor navigation frame object must be a THREE.Object3D");
    const framePadding = finitePositive(padding, "editor navigation frame padding");
    this.#frameBox.setFromObject(object, true);
    if (this.#frameBox.isEmpty()) throw new Error("editor navigation cannot frame an object with empty bounds");
    this.#frameBox.getBoundingSphere(this.#frameSphere);
    return this.destinationPose(
      [this.#frameSphere.center.x, this.#frameSphere.center.y, this.#frameSphere.center.z],
      Math.max(MIN_FRAME_RADIUS_M, this.#frameSphere.radius * framePadding / DEFAULT_FRAME_PADDING),
    );
  }

  frameObject(object: InstanceType<typeof THREE.Object3D>, padding = DEFAULT_FRAME_PADDING): Readonly<EditorCameraPose> {
    const pose = this.objectPose(object, padding);
    this.restore(pose);
    return pose;
  }

  constrainAboveSurface(surfaceHeightM: number, clearanceM = DEFAULT_FLY_SURFACE_CLEARANCE_M): boolean {
    this.#requireLive();
    if (!Number.isFinite(surfaceHeightM)) throw new TypeError("editor navigation surface height must be finite");
    const clearance = finitePositive(clearanceM, "editor navigation surface clearance");
    const minimumY = surfaceHeightM + clearance;
    if (!Number.isFinite(minimumY)) throw new RangeError("editor navigation minimum surface height is out of range");
    if (this.#mode !== "fly" || this.#camera.position.y >= minimumY) return false;
    this.#camera.position.y = minimumY;
    this.#syncFlyTarget();
    return true;
  }

  constrainToResidencyGrid(chunkSizeM: number, radius = 7, thresholdChunks = 2): number {
    this.#requireLive();
    const chunkSize = finitePositive(chunkSizeM, "editor navigation residency chunk size");
    if (!Number.isSafeInteger(radius) || radius < 1 || radius > 7) throw new RangeError("editor navigation residency radius is invalid");
    if (!Number.isSafeInteger(thresholdChunks) || thresholdChunks < 0 || thresholdChunks >= radius) {
      throw new RangeError("editor navigation residency threshold is invalid");
    }
    const safeChunks = Math.max(1, radius - thresholdChunks - 1);
    const residencyMax = safeChunks * chunkSize;
    this.orbitControls.maxDistance = Math.max(
      this.orbitControls.minDistance + 1,
      Math.min(this.#configuredMaxDistanceM, residencyMax),
    );
    if (this.#mode === "orbit") this.orbitControls.update();
    return this.orbitControls.maxDistance;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disableLeases.clear();
    this.#releaseInput();
    this.#element.removeEventListener("pointerdown", this.#onPointerDown);
    this.#element.removeEventListener("pointermove", this.#onPointerMove);
    this.#element.removeEventListener("pointerup", this.#onPointerUp);
    this.#element.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#element.removeEventListener("contextmenu", this.#onContextMenu);
    this.#keyTarget?.removeEventListener("keydown", this.#onKeyDown);
    this.#keyTarget?.removeEventListener("keyup", this.#onKeyUp);
    this.#keyTarget?.removeEventListener("blur", this.#onBlur);
    this.#documentTarget?.removeEventListener("visibilitychange", this.#onVisibilityChange);
    this.#documentTarget?.removeEventListener("pointerlockchange", this.#onPointerLockChange);
    this.#documentTarget?.removeEventListener("contextmenu", this.#onDocumentContextMenu);
    this.orbitControls.dispose();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (!this.#effectivelyEnabled() || this.#mode !== "fly" || event.button !== 2 || this.#rightPointerId !== null) return;
    this.#rightPointerId = event.pointerId;
    this.#lastUpdateMs = this.#now();
    this.#flyEuler.setFromQuaternion(this.#camera.quaternion, "YXZ");
    this.#flyEuler.z = 0;
    let lockRequested = false;
    try {
      if (this.#element.requestPointerLock !== undefined) {
        const request = this.#element.requestPointerLock();
        lockRequested = true;
        if (request && typeof request.catch === "function") {
          void request.catch(() => {
            if (this.#rightPointerId !== event.pointerId) return;
            try { this.#element.setPointerCapture?.(event.pointerId); } catch { /* fallback is best effort */ }
          });
        }
      }
    } catch { /* pointer capture below remains the fallback */ }
    if (!lockRequested) {
      try { this.#element.setPointerCapture?.(event.pointerId); } catch { /* capture is best effort */ }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.#rightPointerId || !this.isCapturingInput()) return;
    this.#flyEuler.y -= event.movementX * LOOK_RADIANS_PER_PIXEL;
    this.#flyEuler.x = Math.max(MIN_FLY_PITCH, Math.min(MAX_FLY_PITCH,
      this.#flyEuler.x - event.movementY * LOOK_RADIANS_PER_PIXEL));
    this.#flyEuler.z = 0;
    this.#camera.quaternion.setFromEuler(this.#flyEuler);
    this.#syncFlyTarget();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#rightPointerId) return;
    this.#releaseInput();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.#rightPointerId) {
      this.#releaseInput();
      event.stopImmediatePropagation();
    }
  };

  readonly #onContextMenu = (event: Event): void => {
    if (this.#effectivelyEnabled() && this.#mode === "fly") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  readonly #onDocumentContextMenu = (event: Event): void => {
    if (this.isCapturingInput()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  readonly #onKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (!this.isCapturingInput() || editableTarget(key.target) || key.repeat) return;
    if (!this.#isMovementCode(key.code)) return;
    this.#pressed.add(key.code);
    key.preventDefault();
  };

  readonly #onKeyUp = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (!this.#isMovementCode(key.code)) return;
    const removed = this.#pressed.delete(key.code);
    if (removed && this.isCapturingInput()) key.preventDefault();
  };

  readonly #onBlur = (): void => { this.#releaseInput(); };

  readonly #onVisibilityChange = (): void => {
    if (this.#documentTarget?.hidden === true) this.#releaseInput();
  };

  readonly #onPointerLockChange = (): void => {
    if (this.#rightPointerId !== null && this.#documentTarget?.pointerLockElement !== this.#element) {
      this.#releaseInput();
    }
  };

  #isMovementCode(code: string): boolean {
    return code === "KeyW" || code === "KeyA" || code === "KeyS" || code === "KeyD"
      || code === "KeyQ" || code === "KeyE" || code === "ShiftLeft" || code === "ShiftRight"
      || code === "AltLeft" || code === "AltRight";
  }

  #releaseInput(): void {
    const pointerId = this.#rightPointerId;
    this.#rightPointerId = null;
    this.#pressed.clear();
    this.#lastUpdateMs = undefined;
    if (pointerId !== null) {
      try { this.#element.releasePointerCapture?.(pointerId); } catch { /* release is best effort */ }
    }
    if (this.#documentTarget?.pointerLockElement === this.#element) {
      try { this.#documentTarget.exitPointerLock(); } catch { /* lock may already be leaving */ }
    }
  }

  #syncFlyTarget(): void {
    this.#camera.getWorldDirection(this.#forward);
    this.orbitControls.target.copy(this.#camera.position).addScaledVector(this.#forward, this.#focusDistanceM);
  }

  #applyEnabledState(): void {
    this.orbitControls.enabled = this.#effectivelyEnabled() && this.#mode === "orbit";
  }

  #effectivelyEnabled(): boolean { return this.#enabled && this.#disableLeases.size === 0; }

  #requireLive(): void {
    if (this.#disposed) throw new Error("editor navigation controller is disposed");
  }
}
