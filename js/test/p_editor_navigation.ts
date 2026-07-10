import * as THREE from "../build/three.bundle.mjs";
import { EditorNavigationController } from "../src/browser/editor-navigation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_editor_navigation FAIL: ${message}`);
}

function near(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}

type Listener = (event: Record<string, unknown>) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let bucket = this.listeners.get(type);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Record<string, unknown> = {}): Record<string, unknown> {
    const emitted = {
      target: this,
      defaultPrevented: false,
      preventDefault() { emitted.defaultPrevented = true; },
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(emitted);
    return emitted;
  }

  count(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

class FakeDocument extends FakeTarget {
  hidden = false;
}

class FakeElement extends FakeTarget {
  readonly style: Record<string, string> = {};
  readonly ownerDocument: FakeDocument;
  readonly captured = new Set<number>();
  clientWidth = 1_000;
  clientHeight = 700;

  constructor(document: FakeDocument) {
    super();
    this.ownerDocument = document;
  }

  getRootNode(): FakeDocument { return this.ownerDocument; }
  setPointerCapture(pointerId: number): void { this.captured.add(pointerId); }
  releasePointerCapture(pointerId: number): void { this.captured.delete(pointerId); }
}

let clock = 0;
const documentTarget = new FakeDocument();
const keyTarget = new FakeTarget();
const element = new FakeElement(documentTarget);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2_000);
camera.position.set(0, 10, 20);
camera.lookAt(0, 2, 0);
const navigation = new EditorNavigationController({
  camera,
  element: element as never,
  keyTarget: keyTarget as never,
  documentTarget: documentTarget as never,
  now: () => clock,
  navigation: {
    mode: "orbit",
    speedMps: 10,
    boostMultiplier: 4,
    precisionMultiplier: 0.2,
    target: [0, 2, 0],
    minDistanceM: 2,
    maxDistanceM: 576,
    maxPolarAngleRad: Math.PI / 2 - 0.04,
  },
});

const initial = navigation.snapshot();
assert(Object.isFrozen(initial) && Object.isFrozen(initial.position) && initial.mode === "orbit",
  "snapshot is not deeply immutable or has the wrong mode");
const initialDistance = camera.position.distanceTo(navigation.orbitControls.target);
const cameraBeforeDestination = camera.position.clone();
const goTo = navigation.destinationPose([500, 20, -400]);
near(new THREE.Vector3(...goTo.position).distanceTo(new THREE.Vector3(...goTo.target)), initialDistance, 1e-6,
  "coordinate destination did not preserve the current focus distance");
const plannedDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...goTo.quaternion)).normalize();
const expectedDirection = new THREE.Vector3(...goTo.target).sub(new THREE.Vector3(...goTo.position)).normalize();
near(plannedDirection.dot(expectedDirection), 1, 1e-6, "destination pose camera points away from its target");
assert(camera.position.equals(cameraBeforeDestination), "destinationPose mutated the live camera");
assert(navigation.residencyCenter(goTo)[0] === 500 && navigation.residencyCenter(goTo)[1] === -400,
  "orbit destination residency did not use its target");

const flyPose = { ...goTo, position: [520, 30, -390], mode: "fly" };
assert(navigation.residencyCenter(flyPose)[0] === 520 && navigation.residencyCenter(flyPose)[1] === -390,
  "fly destination residency did not use its camera position");
let strictFailure: unknown;
try { navigation.residencyCenter({ ...goTo, extra: true }); } catch (error) { strictFailure = error; }
assert(strictFailure instanceof TypeError, "residencyCenter accepted an extra pose field");
strictFailure = undefined;
const accessorPose = {};
for (const [key, value] of Object.entries(goTo)) {
  Object.defineProperty(accessorPose, key, key === "target"
    ? { enumerable: true, get: () => value }
    : { enumerable: true, value });
}
try { navigation.residencyCenter(accessorPose); } catch (error) { strictFailure = error; }
assert(strictFailure instanceof TypeError, "residencyCenter invoked or accepted a pose accessor");

navigation.setMode("fly");
assert(navigation.mode() === "fly" && !navigation.orbitControls.enabled, "fly mode left OrbitControls active");
const down = element.emit("pointerdown", { pointerId: 7, button: 2, movementX: 0, movementY: 0 });
assert(navigation.isCapturingInput() && element.captured.has(7) && down.defaultPrevented === true,
  "right-button capture did not engage fly navigation");
for (const code of ["KeyW", "KeyD", "KeyE"]) keyTarget.emit("keydown", { code, repeat: false });
const beforeMove = camera.position.clone();
navigation.update(0);
navigation.update(1_000);
near(camera.position.distanceTo(beforeMove), 1, 1e-6,
  "normalized diagonal/pitched fly movement did not move at speed * capped-dt");

keyTarget.emit("keydown", { code: "ShiftLeft", repeat: false });
const beforeBoost = camera.position.clone();
navigation.update(1_100);
near(camera.position.distanceTo(beforeBoost), 4, 1e-6, "temporary boost multiplier was not applied");
keyTarget.emit("keydown", { code: "AltLeft", repeat: false });
const beforePrecision = camera.position.clone();
navigation.update(1_200);
near(camera.position.distanceTo(beforePrecision), 0.8, 1e-6, "precision modifier was not applied with boost");

const quaternionBeforeLook = camera.quaternion.clone();
element.emit("pointermove", { pointerId: 7, button: 2, movementX: 40, movementY: -20 });
assert(!camera.quaternion.equals(quaternionBeforeLook), "RMB mouse movement did not rotate the fly camera");
keyTarget.emit("blur");
assert(!navigation.isCapturingInput() && !element.captured.has(7), "blur left fly input or pointer capture stuck");
const afterBlur = camera.position.clone();
navigation.update(1_300);
assert(camera.position.equals(afterBlur), "camera moved after blur cleared fly input");

element.emit("pointerdown", { pointerId: 8, button: 2 });
documentTarget.hidden = true;
documentTarget.emit("visibilitychange");
assert(!navigation.isCapturingInput() && !element.captured.has(8), "hidden document left fly input stuck");
documentTarget.hidden = false;

assert(navigation.setSpeed(1e9) === 5_000, "speed did not clamp to its production maximum");
let speedFailure: unknown;
try { navigation.setSpeed(0); } catch (error) { speedFailure = error; }
assert(speedFailure instanceof TypeError, "zero speed was accepted");

navigation.restore(initial);
assert(navigation.mode() === "orbit" && navigation.orbitControls.enabled && navigation.speed() === 10,
  "finite pose restore did not recover mode, controls, or speed");
let restoreFailure: unknown;
try { navigation.restore({ ...initial, position: [NaN, 0, 0] }); } catch (error) { restoreFailure = error; }
assert(restoreFailure instanceof TypeError, "pose restore accepted a non-finite position");
restoreFailure = undefined;
try { navigation.residencyCenter({ ...initial, quaternion: [0, 0, 0, 0] }); } catch (error) { restoreFailure = error; }
assert(restoreFailure instanceof RangeError, "residency planning accepted a zero quaternion before activation");
restoreFailure = undefined;
const sparsePosition = new Array<number>(3);
sparsePosition[0] = 1;
sparsePosition[2] = 3;
try { navigation.restore({ ...initial, position: sparsePosition }); } catch (error) { restoreFailure = error; }
assert(restoreFailure instanceof TypeError, "pose restore accepted a sparse position tuple");
restoreFailure = undefined;
let tupleAccessorInvoked = false;
const accessorPosition = [1, 2, 3];
Object.defineProperty(accessorPosition, "1", {
  enumerable: true,
  get() {
    tupleAccessorInvoked = true;
    return 2;
  },
});
try { navigation.restore({ ...initial, position: accessorPosition }); } catch (error) { restoreFailure = error; }
assert(restoreFailure instanceof TypeError && !tupleAccessorInvoked,
  "pose restore invoked or accepted a tuple accessor");

const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 6, 8), new THREE.MeshBasicMaterial());
mesh.position.set(100, 12, -80);
mesh.updateMatrixWorld(true);
const beforeObjectPose = camera.position.clone();
const plannedObject = navigation.objectPose(mesh);
near(plannedObject.target[0], 100, 1e-6, "objectPose target x is wrong");
near(plannedObject.target[1], 12, 1e-6, "objectPose target y is wrong");
near(plannedObject.target[2], -80, 1e-6, "objectPose target z is wrong");
assert(camera.position.equals(beforeObjectPose), "objectPose mutated the live camera");
navigation.frameObject(mesh);
near(navigation.orbitControls.target.x, 100, 1e-6, "frameObject did not apply its planned target");
mesh.geometry.dispose();
(mesh.material as THREE.Material).dispose();

assert(navigation.constrainToResidencyGrid(64, 7, 2) === 256,
  "radius-7/threshold-2 residency did not preserve a one-chunk camera safety ring");
const releaseFirst = navigation.acquireDisabled();
const releaseSecond = navigation.acquireDisabled();
assert(!navigation.orbitControls.enabled, "disable lease left OrbitControls enabled");
navigation.setEnabled(false);
navigation.setEnabled(true);
assert(!navigation.orbitControls.enabled, "boolean ownership overrode active disable leases");
releaseFirst();
releaseFirst();
assert(!navigation.orbitControls.enabled, "idempotent lease release enabled controls while another lease remained");
releaseSecond();
assert(navigation.orbitControls.enabled, "final disable lease release did not restore OrbitControls");
navigation.setEnabled(false);
assert(!navigation.orbitControls.enabled, "disabled navigation left OrbitControls enabled");
navigation.setEnabled(true);
assert(navigation.orbitControls.enabled, "re-enabled orbit navigation did not restore OrbitControls");

assert(element.count() > 0 && keyTarget.count() > 0 && documentTarget.count() > 0,
  "test harness did not observe navigation listeners");
navigation.dispose();
assert(element.count() === 0 && keyTarget.count() === 0 && documentTarget.count() === 0,
  `dispose leaked listeners (${element.count()}/${keyTarget.count()}/${documentTarget.count()})`);
let disposedFailure: unknown;
try { navigation.setMode("fly"); } catch (error) { disposedFailure = error; }
assert(disposedFailure instanceof Error, "disposed controller accepted a mode mutation");

console.log("[js] p_editor_navigation OK: strict immutable poses, pure destination/object plans, mode-aware residency, leased orbit/fly ownership, normalized dt-capped movement, boost/precision, input-loss recovery, speed/grid bounds, restore, and teardown proven");
