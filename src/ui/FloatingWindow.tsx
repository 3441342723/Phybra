import { useRef, type PointerEvent, type ReactNode } from 'react';
import { clampRect, type WindowRect } from '../state/layout';

type Gesture = { mode: 'move' | 'resize'; pointerId: number; x: number; y: number; rect: WindowRect };

export function FloatingWindow({ title, rect, z, children, onChange, onFocus, onClose }: {
  title: string;
  rect: WindowRect;
  z: number;
  children: ReactNode;
  onChange: (rect: WindowRect) => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  const gesture = useRef<Gesture | null>(null);

  function begin(e: PointerEvent, mode: Gesture['mode']) {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus();
    gesture.current = { mode, pointerId: e.pointerId, x: e.clientX, y: e.clientY, rect };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有活动指针时仍可通过同一处理器测试拖动 */
    }
  }

  function move(e: PointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const host = e.currentTarget.closest('.workspace')?.getBoundingClientRect();
    const width = host?.width ?? window.innerWidth;
    const height = host?.height ?? window.innerHeight;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const next = g.mode === 'move'
      ? { ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy }
      : { ...g.rect, w: g.rect.w + dx, h: g.rect.h + dy };
    onChange(clampRect(next, width, height));
  }

  function end(e: PointerEvent) {
    if (gesture.current?.pointerId === e.pointerId) gesture.current = null;
  }

  return (
    <section
      className="floating-window"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z + 10 }}
      onPointerDown={onFocus}
      aria-label={title}
    >
      <div className="floating-title" onPointerDown={(e) => begin(e, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <strong>{title}</strong>
        <span className="hint">拖动移动</span>
        <button className="mini window-close" title="关闭窗口" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>×</button>
      </div>
      <div className="floating-body">{children}</div>
      <div className="resize-handle" title="拖动调整大小" onPointerDown={(e) => begin(e, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
    </section>
  );
}
