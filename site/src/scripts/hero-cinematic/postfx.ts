// Cinematic post stack: RenderPass → GTAO → Bloom → Bokeh → grade+flash →
// OutputPass (ACES tonemap+sRGB) → Outline → SMAA. SSR is omitted by default
// (heaviest pass; see plan). Grade + flash are driven per-frame by the timeline
// and portal transitions.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import type { Quality } from './quality';
import { BRAND } from './manifest';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
    uVignette: { value: 0.32 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift; uniform vec3 uGamma; uniform vec3 uGain;
    uniform float uFlash; uniform vec3 uFlashColor; uniform float uVignette;
    varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      col = col + uLift;
      col = sign(col) * pow(abs(col), 1.0 / max(uGamma, vec3(0.001)));
      col = col * uGain;
      // vignette
      vec2 q = vUv - 0.5;
      float vig = smoothstep(0.85, 0.2, dot(q, q) * uVignette * 4.0);
      col *= mix(1.0, vig, 0.6);
      // transition flash
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(col, c.a);
    }
  `,
};

export interface PostFX {
  composer: EffectComposer;
  outline: OutlinePass;
  setSize(w: number, h: number): void;
  setGrade(lift: [number, number, number], gamma: [number, number, number], gain: [number, number, number]): void;
  setFlash(v: number): void;
  setBokeh(focus: number, blur: number): void;
  render(): void;
  dispose(): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: Quality,
  w: number,
  h: number,
): PostFX {
  const target = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    samples: quality.tier === 'high' ? 2 : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(quality.dpr);
  composer.setSize(w, h);

  composer.addPass(new RenderPass(scene, camera));

  let gtao: GTAOPass | null = null;
  if (quality.gtao) {
    gtao = new GTAOPass(scene, camera, w, h);
    gtao.output = GTAOPass.OUTPUT.Default;
    composer.addPass(gtao);
  }

  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.5, 1.0);
  composer.addPass(bloom);

  const bokeh = new BokehPass(scene, camera, { focus: 12, aperture: 0.0006, maxblur: 0.0 });
  if (quality.bokeh) composer.addPass(bokeh);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  const outline = new OutlinePass(new THREE.Vector2(w, h), scene, camera);
  outline.edgeStrength = 2.0;
  outline.edgeGlow = 0.5;
  outline.edgeThickness = 1.0;
  outline.visibleEdgeColor.set(BRAND.teal);
  outline.hiddenEdgeColor.set(0x102a30);
  composer.addPass(outline);

  const smaa = new SMAAPass(w, h);
  composer.addPass(smaa);

  function setSize(nw: number, nh: number) {
    composer.setSize(nw, nh);
    bloom.setSize(nw, nh);
    outline.setSize(nw, nh);
    gtao?.setSize(nw, nh);
    (bokeh as unknown as { setSize?: (a: number, b: number) => void }).setSize?.(nw, nh);
  }

  function setGrade(lift: [number, number, number], gamma: [number, number, number], gain: [number, number, number]) {
    (grade.uniforms.uLift.value as THREE.Vector3).set(lift[0], lift[1], lift[2]);
    (grade.uniforms.uGamma.value as THREE.Vector3).set(gamma[0], gamma[1], gamma[2]);
    (grade.uniforms.uGain.value as THREE.Vector3).set(gain[0], gain[1], gain[2]);
  }
  function setFlash(v: number) {
    grade.uniforms.uFlash.value = v;
  }
  function setBokeh(focus: number, blur: number) {
    const u = (bokeh as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
    if (u) {
      u.focus.value = focus;
      u.maxblur.value = blur;
    }
  }
  function render() {
    composer.render();
  }
  function dispose() {
    composer.dispose();
    target.dispose();
  }

  return { composer, outline, setSize, setGrade, setFlash, setBokeh, render, dispose };
}
