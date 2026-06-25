// The agent: RobotExpressive running along the path, with a cyan/magenta energy
// glow (emissive + fresnel rim injected into the standard material).
import * as THREE from 'three';
import { loadGLTF } from './loader';
import { BRAND } from './manifest';

export interface Agent {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  update(dt: number, pos: THREE.Vector3, dir: THREE.Vector3, pulse: number): void;
  setPose(pose: 'run' | 'wave'): void;
}

const FORWARD = new THREE.Vector3(0, 0, 1);

export async function createAgent(
  scene: THREE.Scene,
  manager: THREE.LoadingManager,
  url: string,
): Promise<Agent> {
  const gltf = await loadGLTF(manager, url);
  const root = gltf.scene;

  // Scale to ~1.8u tall (measure only — keep feet at origin).
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = 1.8 / (size.y || 1);
  root.scale.setScalar(s);

  const rimShaders: { uniforms: Record<string, THREE.IUniform> }[] = [];
  const rimA = new THREE.Color(BRAND.teal);
  const rimB = new THREE.Color(BRAND.magenta);

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds drift; avoid pop
    const src = mesh.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({
      color: src.color ? src.color.clone() : new THREE.Color(0xdfe7f5),
      map: src.map ?? null,
      metalness: 0.35,
      roughness: 0.5,
      emissive: new THREE.Color(BRAND.teal),
      emissiveIntensity: 0.7,
      envMapIntensity: 0.6,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimA = { value: rimA };
      shader.uniforms.uRimB = { value: rimB };
      shader.uniforms.uRimT = { value: 0 };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform vec3 uRimA;\nuniform vec3 uRimB;\nuniform float uRimT;\nvoid main() {',
        )
        .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.5);
         vec3 rimCol = mix(uRimA, uRimB, uRimT);
         totalEmissiveRadiance += rimCol * fres * 0.55;`,
      );
      rimShaders.push(shader as unknown as { uniforms: Record<string, THREE.IUniform> });
    };
    mesh.material = mat;
  });

  scene.add(root);

  const mixer = new THREE.AnimationMixer(root);
  const findClip = (name: string) => THREE.AnimationClip.findByName(gltf.animations, name);
  let runClip = findClip('Running');
  if (!runClip) {
    runClip =
      gltf.animations.filter((c) => /run/i.test(c.name)).sort((a, b) => b.duration - a.duration)[0] ??
      gltf.animations.slice().sort((a, b) => b.duration - a.duration)[0];
  }
  const waveClip = findClip('Wave');
  const actions: Partial<Record<'run' | 'wave', THREE.AnimationAction>> = {};
  if (runClip) actions.run = mixer.clipAction(runClip);
  if (waveClip) actions.wave = mixer.clipAction(waveClip);
  let current = actions.run;
  let currentPose: 'run' | 'wave' = 'run';
  current?.play();

  function setPose(pose: 'run' | 'wave') {
    if (pose === currentPose) return;
    currentPose = pose;
    const next = actions[pose] ?? actions.run;
    if (!next || next === current) return;
    current?.fadeOut(0.25);
    next.reset().fadeIn(0.25).play();
    current = next;
  }

  const q = new THREE.Quaternion();
  const flatDir = new THREE.Vector3();
  let emissiveMats: THREE.MeshStandardMaterial[] | null = null;

  function update(dt: number, pos: THREE.Vector3, dir: THREE.Vector3, pulse: number) {
    mixer.update(dt);
    root.position.copy(pos);
    flatDir.set(dir.x, 0, dir.z).normalize();
    if (flatDir.lengthSq() > 1e-6) {
      q.setFromUnitVectors(FORWARD, flatDir);
      root.quaternion.slerp(q, Math.min(1, dt * 8));
    }
    if (!emissiveMats) {
      emissiveMats = [];
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (m && (m as THREE.MeshStandardMaterial).emissive) emissiveMats!.push(m);
      });
    }
    for (const m of emissiveMats) m.emissiveIntensity = 0.05 + 0.08 * pulse;
    const rt = 0.5 + 0.5 * Math.sin(performance.now() * 0.0012);
    for (const sh of rimShaders) if (sh.uniforms.uRimT) sh.uniforms.uRimT.value = rt;
  }

  return { root, mixer, update, setPose };
}
