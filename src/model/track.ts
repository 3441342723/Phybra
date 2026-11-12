import { supportDir, supportEnd, supportLength } from './geometry';
import type { Scene, Support, Vec2 } from './types';

const CONNECT_EPS = 0.02;

export type TrackSegment = {
  support: Support;
  sign: 1 | -1;
  offset: number;
  length: number;
  dir: Vec2;
  origin: Vec2;
};

export type SurfaceTrack = {
  segments: TrackSegment[];
  length: number;
  junctions: number[];
  componentSize: number;
  problems: Array<{ path: string; message: string }>;
};

type Link = { support: Support; end: 'a' | 'b' };

export function buildSurfaceTrack(scene: Scene, supportId: string): SurfaceTrack {
  const empty: SurfaceTrack = { segments: [], length: 0, junctions: [], componentSize: 0, problems: [] };
  const initial = scene.supports.find((s) => s.id === supportId);
  if (!initial) return { ...empty, problems: [{ path: `supports.${supportId}`, message: '依附的支撑面不存在' }] };

  const nodes: Array<{ p: Vec2; links: Link[] }> = [];
  const endpointNodes: Record<string, { a: number; b: number }> = {};
  const nodeFor = (p: Vec2): number => {
    const found = nodes.findIndex((n) => Math.hypot(n.p.x - p.x, n.p.y - p.y) <= CONNECT_EPS);
    if (found >= 0) return found;
    nodes.push({ p, links: [] });
    return nodes.length - 1;
  };

  for (const support of scene.supports) {
    const a = nodeFor(support.a);
    const b = nodeFor(supportEnd(support));
    endpointNodes[support.id] = { a, b };
    nodes[a].links.push({ support, end: 'a' });
    nodes[b].links.push({ support, end: 'b' });
  }

  const startNode = endpointNodes[supportId].a;
  const seenNodes = new Set<number>();
  const componentSupports = new Set<string>();
  const queue = [startNode];
  while (queue.length) {
    const node = queue.shift()!;
    if (seenNodes.has(node)) continue;
    seenNodes.add(node);
    for (const link of nodes[node].links) {
      componentSupports.add(link.support.id);
      const other = endpointNodes[link.support.id][link.end === 'a' ? 'b' : 'a'];
      if (!seenNodes.has(other)) queue.push(other);
    }
  }

  const problems: SurfaceTrack['problems'] = [];
  const componentNodes = [...seenNodes];
  if (componentNodes.some((n) => nodes[n].links.length > 2)) {
    problems.push({ path: 'supports', message: '支撑面连接出现分叉；首版只支持单条连续轨道' });
  }
  const endpoints = componentNodes.filter((n) => nodes[n].links.length === 1);
  if (componentSupports.size > 1 && endpoints.length !== 2) {
    problems.push({ path: 'supports', message: '支撑面形成闭合回路；首版只支持有端点的连续轨道' });
  }
  if (problems.length) return { ...empty, componentSize: componentSupports.size, problems };

  const start = endpoints.sort((a, b) => nodes[a].p.x - nodes[b].p.x || nodes[a].p.y - nodes[b].p.y)[0] ?? startNode;
  const segments: TrackSegment[] = [];
  let node = start;
  let previous: string | null = null;
  let offset = 0;
  while (segments.length <= componentSupports.size) {
    const link = nodes[node].links.find((l) => l.support.id !== previous);
    if (!link) break;
    const support = link.support;
    const sign: 1 | -1 = link.end === 'a' ? 1 : -1;
    const baseDir = supportDir(support);
    const length = supportLength(support);
    segments.push({
      support,
      sign,
      offset,
      length,
      dir: { x: baseDir.x * sign, y: baseDir.y * sign },
      origin: nodes[node].p,
    });
    offset += length;
    previous = support.id;
    node = endpointNodes[support.id][link.end === 'a' ? 'b' : 'a'];
  }

  return {
    segments,
    length: offset,
    junctions: segments.slice(1).map((s) => s.offset),
    componentSize: componentSupports.size,
    problems,
  };
}

export function trackSegmentAt(track: SurfaceTrack, s: number, u = 0): TrackSegment {
  const clamped = Math.min(track.length, Math.max(0, s));
  if (u > 1e-9) {
    return track.segments.find((seg) => clamped < seg.offset + seg.length - 1e-9) ?? track.segments[track.segments.length - 1];
  }
  if (u < -1e-9) {
    return [...track.segments].reverse().find((seg) => clamped > seg.offset + 1e-9) ?? track.segments[0];
  }
  return track.segments.find((seg) => clamped >= seg.offset - 1e-9 && clamped <= seg.offset + seg.length + 1e-9) ?? track.segments[track.segments.length - 1];
}

export function trackWorld(track: SurfaceTrack, s: number, u: number): { x: number; y: number; vx: number; vy: number } {
  const seg = trackSegmentAt(track, s, u);
  const along = Math.min(seg.length, Math.max(0, s - seg.offset));
  return {
    x: seg.origin.x + seg.dir.x * along,
    y: seg.origin.y + seg.dir.y * along,
    vx: u * seg.dir.x,
    vy: u * seg.dir.y,
  };
}

export function trackLocalToGlobal(track: SurfaceTrack, supportId: string, s: number): number | null {
  const seg = track.segments.find((item) => item.support.id === supportId);
  if (!seg) return null;
  return seg.offset + (seg.sign > 0 ? s : seg.length - s);
}
