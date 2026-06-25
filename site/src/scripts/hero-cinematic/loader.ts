// Asset loading: a progress-reporting LoadingManager, promisified GLTF/RGBE
// loaders (with meshopt support), PMREM environment build, and manifest fetch.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { PhaseId } from './manifest';

export interface HeroManifest {
  character: string | null;
  creatures: Partial<Record<string, string>>;
  hdris: Partial<Record<PhaseId, string>>;
  models?: Partial<Record<PhaseId, string[]>>;
}

const BASE = import.meta.env.BASE_URL || '/';
const root = (p: string) => (p.startsWith('/') ? BASE.replace(/\/$/, '') + p : p);

export function createManager(onProgress?: (frac: number) => void): THREE.LoadingManager {
  const m = new THREE.LoadingManager();
  if (onProgress) {
    m.onProgress = (_url, loaded, total) => onProgress(total > 0 ? loaded / total : 0);
    m.onLoad = () => onProgress(1);
  }
  return m;
}

export async function fetchManifest(): Promise<HeroManifest> {
  const res = await fetch(root('/hero/manifest.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`hero manifest missing (${res.status})`);
  return (await res.json()) as HeroManifest;
}

export function loadGLTF(manager: THREE.LoadingManager, url: string): Promise<GLTF> {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const { promise, resolve, reject } = Promise.withResolvers<GLTF>();
  loader.load(root(url), resolve, undefined, reject);
  return promise;
}

export function loadHDR(manager: THREE.LoadingManager, url: string): Promise<THREE.DataTexture> {
  const loader = new RGBELoader(manager);
  const { promise, resolve, reject } = Promise.withResolvers<THREE.DataTexture>();
  loader.load(root(url), (tex) => resolve(tex as THREE.DataTexture), undefined, reject);
  return promise;
}

// Equirect HDR → prefiltered PMREM environment map (for scene.environment / IBL).
// Does NOT dispose the input — the caller may reuse it as a skybox background.
export function buildEnv(renderer: THREE.WebGLRenderer, equirect: THREE.DataTexture): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();
  return env;
}
