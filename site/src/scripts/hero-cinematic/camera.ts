// Third-person follow rig: smooth-damped chase camera behind + above the agent.
import * as THREE from 'three';

export interface CameraBeat {
  back: number; // metres behind the agent (along -dir)
  up: number; // metres above
  side: number; // lateral offset
  fov: number;
  lookAhead: number; // metres ahead of the agent the camera aims at
}

// Critically-damped spring (Game Programming Gems "smoothDamp") for one axis.
function smoothDampScalar(
  current: number,
  target: number,
  velRef: { v: number },
  smoothTime: number,
  dt: number,
): number {
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velRef.v + omega * change) * dt;
  velRef.v = (velRef.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

export function createFollowRig(camera: THREE.PerspectiveCamera) {
  const pos = new THREE.Vector3();
  const vel = { x: { v: 0 }, y: { v: 0 }, z: { v: 0 } };
  const desired = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let started = false;

  function update(
    dt: number,
    agentPos: THREE.Vector3,
    agentDir: THREE.Vector3,
    beat: CameraBeat,
    smoothTime = 0.35,
  ) {
    // desired = agent - dir*back + up*up + right*side
    right.crossVectors(agentDir, up).normalize();
    desired
      .copy(agentPos)
      .addScaledVector(agentDir, -beat.back)
      .addScaledVector(up, beat.up)
      .addScaledVector(right, beat.side);

    if (!started) {
      pos.copy(desired);
      started = true;
    } else {
      pos.x = smoothDampScalar(pos.x, desired.x, vel.x, smoothTime, dt);
      pos.y = smoothDampScalar(pos.y, desired.y, vel.y, smoothTime, dt);
      pos.z = smoothDampScalar(pos.z, desired.z, vel.z, smoothTime, dt);
    }
    camera.position.copy(pos);

    lookTarget.copy(agentPos).addScaledVector(agentDir, beat.lookAhead);
    lookTarget.addScaledVector(up, 1.2);
    camera.lookAt(lookTarget);

    if (Math.abs(camera.fov - beat.fov) > 0.01) {
      camera.fov += (beat.fov - camera.fov) * Math.min(1, dt * 3.5);
      camera.updateProjectionMatrix();
    }
    void tmp;
  }

  function snap() {
    started = false;
  }

  return { update, snap };
}
