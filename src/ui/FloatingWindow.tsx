import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { clampRect, type WindowRect } from '../state/layout';

type Gesture = { mode: 'move' | 'resize'; pointerId: number; x: number; y: number; rect: WindowRect };

export function FloatingWindow({ title, rect, z, drawer = false, visible = true, children, onChange, onFocus, onClose }: {
  title: string;
  drawer?: boolean;
  visible?: boolean;
  rect: WindowRect;
  z: number;
  children: ReactNode;
  onChange: (rect: WindowRect) => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [hasOpened, setHasOpened] = useState(visible);

  useLayoutEffect(() => {
    const element = dialog.current!;
    if (visible) {
      setHasOpened(true);
      if (drawer) element.showModal();
      else element.show();
    }
    return () => element.close();
  }, [drawer, visible]);

  function close() {
    setHasOpened(false);
    onClose();
  }

  function begin(e: PointerEvent, mode: Gesture['mode']) {
    if (drawer || e.button !== 0) return;
    e.preventDefault();
    onFocus();
    gesture.current = { mode, pointerId: e.pointerId, x: e.clientX, y: e.clientY, rect };
    e.currentTarget.setPointerCapture(e.pointerId);
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
    <dialog ref={dialog} className={drawer ? 'panel-drawer' : 'floating-window'}
      style={drawer ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z + 10 }}
      onPointerDown={() => { if (!drawer) onFocus(); }} aria-label={title}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => {
        if (!drawer || e.target !== e.currentTarget) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) close();
      }}>
      <div className={drawer ? 'drawer-title' : 'floating-title'} onPointerDown={(e) => begin(e, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        <strong>{title}</strong>
        {!drawer && <span className="hint">拖动移动</span>}
        <button className="mini window-close" aria-label={`关闭${title}`} title="关闭窗口" onPointerDown={(e) => e.stopPropagation()} onClick={close} autoFocus={drawer}>×</button>
      </div>
      <div className="floating-body">{(visible || hasOpened) && children}</div>
      {!drawer && <div className="resize-handle" title="拖动调整大小" onPointerDown={(e) => begin(e, 'resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />}
    </dialog>
  );
}
