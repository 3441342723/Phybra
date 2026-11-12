import type { SnapSettings } from '../model/snap';
import type { Action, ToolId } from '../state/store';
import type { WindowId, WindowLayout } from '../state/layout';

const GROUPS: { id: string; label: string; tools: { id: ToolId; label: string }[] }[] = [
  { id: 'operate', label: '操作', tools: [{ id: 'select', label: '选择 / 拖动' }, { id: 'pan', label: '平移画布' }] },
  { id: 'objects', label: '对象', tools: [{ id: 'block', label: '滑块' }, { id: 'projectile', label: '抛体' }, { id: 'horizontal', label: '水平面' }, { id: 'incline', label: '斜面' }] },
  { id: 'vectors', label: '矢量', tools: [{ id: 'velocity', label: '初速度矢量' }] },
  { id: 'measure', label: '测量', tools: [{ id: 'measure', label: '两点距离' }] },
];

const WINDOW_LABELS: Record<WindowId, string> = { objects: '对象与代数', properties: '属性', result: '答案与推导', charts: '曲线', ai: 'AI 建模' };

export function Toolbar({ tool, snap, layout, dispatch, onOpen, onReset }: {
  tool: ToolId;
  snap: SnapSettings;
  layout: WindowLayout;
  dispatch: (action: Action) => void;
  onOpen: (id: WindowId) => void;
  onReset: () => void;
}) {
  function choose(id: ToolId, target: HTMLElement) {
    dispatch({ type: 'tool', tool: id });
    target.closest('details')?.removeAttribute('open');
  }

  return (
    <div className="toolbar">
      {GROUPS.map((group) => {
        const current = group.tools.find((item) => item.id === tool);
        return (
          <details className="toolbar-menu" key={group.id}>
            <summary className={current ? 'active' : ''}>{group.label}{current ? ` · ${current.label}` : ''}</summary>
            <div className="menu-popover">
              {group.tools.map((item) => (
                <button key={item.id} className={tool === item.id ? 'active' : ''} onClick={(e) => choose(item.id, e.currentTarget)}>{item.label}</button>
              ))}
            </div>
          </details>
        );
      })}
      <details className="toolbar-menu">
        <summary>视图 · 吸附 {snap.enabled ? snap.step : '关'}</summary>
        <div className="menu-popover view-menu">
          <button className={snap.enabled ? 'active' : ''} onClick={() => dispatch({ type: 'snap', snap: { ...snap, enabled: !snap.enabled } })}>{snap.enabled ? '✓ 网格吸附' : '开启网格吸附'}</button>
          <label>吸附步长（米）</label>
          <select value={snap.step} onChange={(e) => dispatch({ type: 'snap', snap: { ...snap, step: Number(e.target.value) } })}>
            {[1, 0.5, 0.25, 0.1].map((step) => <option key={step} value={step}>{step} m</option>)}
          </select>
          <span className="hint">只影响放置与拖动，不修改缩放和平移</span>
        </div>
      </details>
      <details className="toolbar-menu">
        <summary>窗口</summary>
        <div className="menu-popover">
          {(Object.keys(WINDOW_LABELS) as WindowId[]).map((id) => (
            <button key={id} onClick={() => onOpen(id)}>{layout.open[id] ? '✓ ' : ''}{WINDOW_LABELS[id]}</button>
          ))}
          <button onClick={onReset}>重置窗口布局</button>
        </div>
      </details>
    </div>
  );
}
