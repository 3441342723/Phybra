import type { SpatialVector, Vec2, Vec3 } from './types';

export type Rotation = { yaw: number; pitch: number };
export const DEFAULT_ROTATION: Rotation = { yaw: -35, pitch: -25 };

export function projectSpace(p: SpatialVector, rotation: Rotation = DEFAULT_ROTATION): Vec2 {
  const yaw = rotation.yaw * Math.PI / 180, pitch = rotation.pitch * Math.PI / 180;
  const depth = -Math.sin(yaw) * p.x + Math.cos(yaw) * (p.z ?? 0);
  return { x: Math.cos(yaw) * p.x + Math.sin(yaw) * (p.z ?? 0), y: Math.cos(pitch) * p.y + Math.sin(pitch) * depth };
}

/** Invert the orthographic projection on a plane at a fixed z. Rotation controls avoid edge-on planes. */
export function unprojectSpace(p: Vec2, z: number, rotation: Rotation = DEFAULT_ROTATION): Vec3 {
  const yaw = rotation.yaw * Math.PI / 180, pitch = rotation.pitch * Math.PI / 180;
  const x = (p.x - Math.sin(yaw) * z) / Math.cos(yaw);
  return { x, y: (p.y - Math.sin(pitch) * (-Math.sin(yaw) * x + Math.cos(yaw) * z)) / Math.cos(pitch), z };
}
