import { useMemo } from 'react';
import type { Vec2 } from '../model/types';

type Box = { x: number; y: number; w: number; h: number };
type Tone = 'object' | 'event' | 'moving' | 'measure' | 'velocity';

export type CanvasLabel = {
  id: string;
  at: Vec2;
  text: string;
  tone: Tone;
  priority?: number;
};

const FONT = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const FONT_SIZE = 11;
const PADDING = 5;
const HEIGHT = 18;
const EDGE = 4;
const GAP = 3;

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x
    && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;
}

function fit(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const characters = Array.from(text);
  let lo = 0;
  let hi = characters.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(characters.slice(0, mid).join('') + '…') <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return characters.slice(0, lo).join('') + '…';
}

export function labelObstacle(at: Vec2, radius: number): Box {
  return { x: at.x - radius, y: at.y - radius, w: radius * 2, h: radius * 2 };
}

export function CanvasLabels({ labels, obstacles, size }: {
  labels: CanvasLabel[];
  obstacles: Box[];
  size: { w: number; h: number };
}) {
  const context = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = `${FONT_SIZE}px ${FONT}`;
    return ctx;
  }, []);
  const measure = (s: string) => context?.measureText(s).width ?? s.length * FONT_SIZE;
  const occupied = [...obstacles];
  const maxTextWidth = Math.min(230, size.w - 2 * (EDGE + PADDING));

  // 优先放置当前操作相关的标签；没有安全位置时保留画布标记和提示。
  const placed = [...labels].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).flatMap((label) => {
    const { x, y } = label.at;
    if (x < 0 || y < 0 || x > size.w || y > size.h || maxTextWidth < measure('…') || size.h < HEIGHT + 2 * EDGE) return [];
    const text = fit(label.text, maxTextWidth, measure);
    const w = Math.ceil(measure(text)) + 2 * PADDING;
    for (const offset of [12, 32, 52, 72]) {
      const xs = [x + offset, x - offset - w, x - w / 2];
      const ys = [y - offset - HEIGHT, y + offset, y - HEIGHT / 2];
      for (const [col, row] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2]]) {
        const box = {
          x: Math.max(EDGE, Math.min(size.w - w - EDGE, xs[col])),
          y: Math.max(EDGE, Math.min(size.h - HEIGHT - EDGE, ys[row])),
          w, h: HEIGHT,
        };
        if (occupied.some((other) => intersects(box, other))) continue;
        occupied.push(box);
        return [{ ...label, text, box }];
      }
    }
    return [];
  });

  return (
    <g className="canvas-labels" style={{ fontFamily: FONT, fontSize: FONT_SIZE }}>
      {placed.map(({ id, at, text, tone, box }) => {
        const nearestX = Math.max(box.x, Math.min(box.x + box.w, at.x));
        const nearestY = Math.max(box.y, Math.min(box.y + box.h, at.y));
        return (
          <g key={id} className={`canvas-label label-${tone}`}>
            <line x1={at.x} y1={at.y} x2={nearestX} y2={nearestY} />
            <rect className="canvas-label-box" x={box.x} y={box.y} width={box.w} height={box.h} rx={4} />
            <text x={box.x + PADDING} y={box.y + 13}>{text}</text>
          </g>
        );
      })}
    </g>
  );
}
