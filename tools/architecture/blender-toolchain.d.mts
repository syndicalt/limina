export const REQUIRED_BLENDER_VERSION: string;
export interface BlenderToolchain { binary: string; version: string; platform: NodeJS.Platform; arch: string; }
export function checkBlender(binary:string):BlenderToolchain;
export function resolveBlender(env?:NodeJS.ProcessEnv):BlenderToolchain;
