// Shared deterministic, tileable RGBA8 detail texture used by procedural triplanar relief and
// stochastic material sampling. Kept dependency-neutral so those two node builders never form an
// ESM import cycle.

import * as THREE from "../../build/three.bundle.mjs";
import { hashLattice } from "../terrain/procedural.ts";

const DETAIL_RES = 256;
const DETAIL_CELLS = 8;
const DETAIL_OCTAVES = 5;
const DETAIL_SEED = 0x9e3779b1 | 0;

let SHARED_DETAIL: THREE.DataTexture | null = null;

function smoothstep01(t: number): number { return t * t * (3 - 2 * t); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function periodicValueNoise(seed: number, x: number, z: number, period: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const wrap = (n: number) => ((n % period) + period) % period;
  const x0 = wrap(ix), x1 = wrap(ix + 1), z0 = wrap(iz), z1 = wrap(iz + 1);
  const v00 = hashLattice(seed, x0, z0), v10 = hashLattice(seed, x1, z0);
  const v01 = hashLattice(seed, x0, z1), v11 = hashLattice(seed, x1, z1);
  const ux = smoothstep01(fx), uz = smoothstep01(fz);
  return lerp(lerp(v00, v10, ux), lerp(v01, v11, ux), uz);
}

function periodicFbm(x: number, z: number, baseCells: number, octaves: number): number {
  let amp = 1, sum = 0, norm = 0, cells = baseCells;
  for (let octave = 0; octave < octaves; octave++) {
    const seed = (DETAIL_SEED + Math.imul(octave, 0x85ebca6b)) | 0;
    sum += amp * periodicValueNoise(seed, x * cells, z * cells, cells);
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return sum / norm;
}

function bakeDetailNoise(): THREE.DataTexture {
  const res = DETAIL_RES;
  const height = new Float32Array(res * res);
  for (let row = 0; row < res; row++) {
    for (let column = 0; column < res; column++) {
      height[row * res + column] = periodicFbm(column / res, row / res, DETAIL_CELLS, DETAIL_OCTAVES);
    }
  }
  const gradientX = new Float32Array(res * res);
  const gradientY = new Float32Array(res * res);
  let maxGradient = 1e-6;
  for (let row = 0; row < res; row++) {
    for (let column = 0; column < res; column++) {
      const left = (column - 1 + res) % res, right = (column + 1) % res;
      const up = (row - 1 + res) % res, down = (row + 1) % res;
      const dx = (height[row * res + right] - height[row * res + left]) * 0.5;
      const dy = (height[down * res + column] - height[up * res + column]) * 0.5;
      gradientX[row * res + column] = dx;
      gradientY[row * res + column] = dy;
      maxGradient = Math.max(maxGradient, Math.abs(dx), Math.abs(dy));
    }
  }
  const data = new Uint8Array(res * res * 4);
  const inverseGradient = 1 / maxGradient;
  for (let index = 0; index < height.length; index++) {
    const offset = index * 4;
    data[offset] = Math.round(Math.min(1, Math.max(0, gradientX[index] * inverseGradient * 0.5 + 0.5)) * 255);
    data[offset + 1] = Math.round(Math.min(1, Math.max(0, gradientY[index] * inverseGradient * 0.5 + 0.5)) * 255);
    data[offset + 2] = Math.round(Math.min(1, Math.max(0, height[index])) * 255);
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function sharedDetailTexture(): THREE.DataTexture {
  if (SHARED_DETAIL === null) SHARED_DETAIL = bakeDetailNoise();
  return SHARED_DETAIL;
}
