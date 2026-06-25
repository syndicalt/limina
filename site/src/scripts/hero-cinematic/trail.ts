// Observability cue: skill-invocation spark bursts emitted as the agent passes
// "skill props". (The continuous light-trail ribbon was removed per design.)
import * as THREE from 'three';
import { BRAND, BLOOM_LAYER } from './manifest';
import type { SkillProp } from './world';

const MAX_SPARKS = 220;

function sparkTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(120,230,255,0.7)');
  g.addColorStop(1, 'rgba(120,230,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Trail {
  update(dt: number, agentPos: THREE.Vector3, intensity: number, skillProps: SkillProp[]): void;
  dispose(): void;
}

export function createTrail(scene: THREE.Scene): Trail {
  const sparkGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(MAX_SPARKS * 3);
  const sVel = new Float32Array(MAX_SPARKS * 3);
  const sLife = new Float32Array(MAX_SPARKS);
  for (let i = 0; i < MAX_SPARKS; i++) sPos[i * 3 + 1] = -9999;
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  const sparkTex = sparkTexture();
  const sparkMat = new THREE.PointsMaterial({
    size: 0.5,
    map: sparkTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(BRAND.teal),
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.layers.enable(BLOOM_LAYER);
  scene.add(sparks);
  let sparkCursor = 0;
  const firedProps = new Set<THREE.Object3D>();

  function emitBurst(at: THREE.Vector3) {
    for (let k = 0; k < 24; k++) {
      const i = sparkCursor % MAX_SPARKS;
      sparkCursor++;
      sPos[i * 3] = at.x + (Math.random() - 0.5) * 0.6;
      sPos[i * 3 + 1] = at.y + Math.random() * 0.4;
      sPos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.6;
      sVel[i * 3] = (Math.random() - 0.5) * 1.2;
      sVel[i * 3 + 1] = 1.0 + Math.random() * 1.8;
      sVel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
      sLife[i] = 1.0;
    }
  }

  function update(dt: number, agentPos: THREE.Vector3, intensity: number, skillProps: SkillProp[]) {
    void intensity;
    for (const sp of skillProps) {
      if (firedProps.has(sp.object)) continue;
      if (agentPos.distanceTo(sp.position) < 4) {
        emitBurst(sp.position);
        firedProps.add(sp.object);
      }
    }
    if (agentPos.x < 6 && firedProps.size > 0) firedProps.clear();

    for (let i = 0; i < MAX_SPARKS; i++) {
      if (sLife[i] <= 0) {
        sPos[i * 3 + 1] = -9999;
        continue;
      }
      sLife[i] -= dt * 1.1;
      sVel[i * 3 + 1] -= dt * 1.5;
      sPos[i * 3] += sVel[i * 3] * dt;
      sPos[i * 3 + 1] += sVel[i * 3 + 1] * dt;
      sPos[i * 3 + 2] += sVel[i * 3 + 2] * dt;
    }
    sparkGeo.attributes.position.needsUpdate = true;
  }

  function dispose() {
    scene.remove(sparks);
    sparkGeo.dispose();
    sparkMat.dispose();
    sparkTex.dispose();
  }

  return { update, dispose };
}
