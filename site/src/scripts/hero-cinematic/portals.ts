// The gateway portal: one portal near the end of the shared local path. It fades
// in as the agent approaches the end of each world, then the white wash (driven by
// the timeline) cuts to the next world. The wash hides the actual pass + swap.
import * as THREE from 'three';
import { BRAND, BLOOM_LAYER } from './manifest';

const MEMBRANE_FRAG = `
  uniform float uTime;
  uniform float uFade;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uAccent;
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
    vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
  }
  void main(){
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float ang = atan(c.y, c.x);
    float swirl = noise(vec2(ang*1.6 + uTime*0.6, r*3.0 - uTime*0.9));
    float ring = smoothstep(1.0, 0.2, r);
    float edge = smoothstep(0.7, 1.0, r);
    vec3 col = mix(uColorA, uColorB, swirl);
    col = mix(col, uAccent, edge * 0.6);
    float alpha = ring * (0.55 + 0.45 * swirl) * uFade;
    gl_FragColor = vec4(col * (1.2 + swirl), alpha);
  }
`;
const MEMBRANE_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

export interface PortalSystem {
  group: THREE.Group;
  update(dt: number, localU: number, elapsed: number): void;
  place(path: THREE.CatmullRomCurve3): void;
  dispose(): void;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function createPortals(scene: THREE.Scene, path: THREE.CatmullRomCurve3): PortalSystem {
  const group = new THREE.Group();
  scene.add(group);

  const radius = 3.2;
  const place = (pth: THREE.CatmullRomCurve3) => {
    const pp = pth.getPointAt(0.985, new THREE.Vector3());
    const tt = pth.getTangentAt(0.985, new THREE.Vector3()).normalize();
    group.position.copy(pp);
    group.position.y = radius;
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tt);
  };
  place(path);

  const torusGeo = new THREE.TorusGeometry(radius, 0.32, 12, 40);
  const torusMat = new THREE.MeshStandardMaterial({
    color: BRAND.violet,
    emissive: BRAND.violet,
    emissiveIntensity: 1.6,
    metalness: 0.4,
    roughness: 0.3,
    transparent: true,
    opacity: 0,
  });
  const torus = new THREE.Mesh(torusGeo, torusMat);
  torus.layers.enable(BLOOM_LAYER);
  group.add(torus);

  const memGeo = new THREE.CircleGeometry(radius - 0.1, 48);
  const memMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uColorA: { value: new THREE.Color(BRAND.violet) },
      uColorB: { value: new THREE.Color(BRAND.cyan) },
      uAccent: { value: new THREE.Color(BRAND.amber) },
    },
    vertexShader: MEMBRANE_VERT,
    fragmentShader: MEMBRANE_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const membrane = new THREE.Mesh(memGeo, memMat);
  membrane.layers.enable(BLOOM_LAYER);
  group.add(membrane);

  function update(_dt: number, localU: number, elapsed: number) {
    memMat.uniforms.uTime.value = elapsed;
    // gateway is present in the latter half of each world's run, full near the end
    const fade = smoothstep(0.5, 0.85, localU);
    memMat.uniforms.uFade.value = fade;
    torusMat.opacity = fade;
    group.visible = fade > 0.002;
  }

  function dispose() {
    scene.remove(group);
    torusGeo.dispose();
    torusMat.dispose();
    memGeo.dispose();
    memMat.dispose();
  }

  return { group, update, dispose, place };
}
