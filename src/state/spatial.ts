import type { Scene, SpatialVector } from '../model/types';
import { DEFAULT_ROTATION, projectSpace } from '../model/projection';
import { fitPlaybackCamera, type WindowLayout } from './layout';
import type { Camera } from './store';

export function fitSpatialCamera(camera: Camera, points: SpatialVector[], layout: WindowLayout, width: number, height: number): Camera {
  const rotation=camera.rotation??DEFAULT_ROTATION;
  return fitPlaybackCamera({...camera,rotation},points.map(p=>projectSpace(p,rotation)),layout,width,height,[
    {x:width-140,y:height-128,w:140,h:128},
    {x:0,y:height-52,w:Math.min(280,width-150),h:52},
  ]);
}

/** Explicit zero defaults only for new components; unknown (null) inputs remain unknown. */
export function withDimension(scene: Scene, dimension: '2d' | '3d'): Scene {
  return { ...scene, dimension, rev: scene.rev + 1,
    bodies: scene.bodies.map(b => ({ ...b, pos: { ...b.pos, z: b.pos.z === undefined ? 0 : b.pos.z }, vel: { ...b.vel, z: b.vel.z === undefined ? 0 : b.vel.z } })),
    fields: scene.fields?.map(f => ({ ...f, position: { ...f.position, z: f.position.z === undefined ? 0 : f.position.z }, vector: { ...f.vector, z: f.vector.z === undefined ? 0 : f.vector.z },
      bx: f.bx === undefined ? 0 : f.bx, by: f.by === undefined ? 0 : f.by, gradient: f.gradient ? { ...f.gradient, z: f.gradient.z === undefined ? 0 : f.gradient.z } : f.gradient })),
  };
}
