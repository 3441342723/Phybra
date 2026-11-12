import type { AskKind, Solution } from '../model/types';
import { askLabel } from '../model/validate';
import { makeAsk } from '../model/factory';
import { fieldValue, newParamName } from '../state/editing';
import type { FieldEdit } from '../state/editing';
import type { Action, Store } from '../state/store';
import { Latex } from './Latex';
import { NumericField } from './NumericField';

const ASK_KINDS: AskKind[] = ['at_time', 'at_position', 'at_velocity', 'at_height', 'landing', 'apex', 'rest', 'end_of_support', 'friction_state'];
const ASK_TARGET: Partial<Record<AskKind, { key: 't' | 'x' | 'y' | 'v'; label: string; unit: 'time' | 'length' | 'speed' }>> = {
  at_time: { key: 't', label: '时刻', unit: 'time' },
  at_position: { key: 'x', label: '位置（斜面/连续轨道为沿轨 s）', unit: 'length' },
  at_velocity: { key: 'v', label: '速度（沿面 u）', unit: 'speed' },
  at_height: { key: 'y', label: '高度', unit: 'length' },
};

export function ObjectList({ store, dispatch, fields, solution }: { store: Store; dispatch: (a: Action) => void; fields: FieldEdit; solution: Solution | null }) {
  const scene = store.present;
  const sel = store.selection;
  const select = (id: string) => dispatch({ type: 'select', id });

  return (
    <div className="panel-content">
      <section>
        <h3>对象</h3>
        {scene.bodies.length + scene.supports.length === 0 && <div className="hint">用顶部工具栏在画布上放置物体或支撑面</div>}
        {[...scene.bodies, ...scene.supports].map((obj: any) => (
          <div key={obj.id} className={`row selectable${sel === obj.id ? ' active' : ''}`} onClick={() => select(obj.id)}>
            <span className="row-icon">{obj.kind === 'block' ? '▪' : obj.kind === 'projectile' ? '●' : obj.kind === 'incline' ? '◺' : '▬'}</span>
            <span className="row-main">{obj.name}</span>
            <span className="row-sub">{obj.kind === 'projectile' ? '抛体' : obj.kind === 'block' ? '滑块' : obj.kind === 'incline' ? '斜面' : '水平面'}</span>
            <button className="mini danger" title="删除（存在依赖时会先列出受影响项）" onClick={(e) => { e.stopPropagation(); dispatch({ type: 'confirmDelete', id: obj.id }); }}>✕</button>
          </div>
        ))}
      </section>

      <section>
        <h3>命名参数
          <button className="mini" onClick={() => {
            const name = newParamName(scene);
            fields.commit('params', [...scene.params, { name, value: 1, unit: 'none', min: 0, max: 10, step: 0.1, note: '' }]);
          }}>＋</button>
        </h3>
        {scene.params.length === 0 && <div className="hint">参数可绑定到对象属性，实现滑块驱动</div>}
        {scene.params.map((p) => (
          <div key={p.name} className="param-block">
            <NumericField
              label={`${p.name}${p.note ? `（${p.note}）` : ''}`}
              value={fieldValue(scene, `params.${p.name}.value`)}
              unitKind={p.unit}
              min={p.min}
              max={p.max}
              step={p.step}
              onTransient={(v) => fields.transient(`params.${p.name}.value`, v)}
              onCommit={(v) => fields.commit(`params.${p.name}.value`, v)}
            />
            <div className="range-row">
              <label>范围</label>
              <input value={p.min} onChange={(e) => fields.commit(`params.${p.name}.min`, Number(e.target.value))} />
              <input value={p.max} onChange={(e) => fields.commit(`params.${p.name}.max`, Number(e.target.value))} />
              <label>步长</label>
              <input value={p.step} onChange={(e) => fields.commit(`params.${p.name}.step`, Number(e.target.value))} />
              <button className="mini danger" onClick={() => fields.commit('params', scene.params.filter((x) => x.name !== p.name))}>✕</button>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3>约束（摩擦接触）</h3>
        {scene.contacts.length === 0 && <div className="hint">滑块放置时自动建立；光滑请把 μ 填 0</div>}
        {scene.contacts.map((c) => {
          const body = scene.bodies.find((b) => b.id === c.body);
          const sup = scene.supports.find((s) => s.id === c.support);
          return (
            <div key={c.id} className={`row selectable${sel === c.id ? ' active' : ''}`} onClick={() => select(c.id)}>
              <span className="row-main">{body?.name ?? c.body} ↔ {sup?.name ?? c.support}</span>
              <span className="row-sub">μs={c.mu_s ?? '?'} μk={c.mu_k ?? '?'}</span>
            </div>
          );
        })}
      </section>

      <section>
        <h3>待求量</h3>
        {scene.asks.map((ask) => {
          const target = ASK_TARGET[ask.kind];
          return (
            <div key={ask.id} className="ask-block">
              <div className="row">
                <select value={ask.kind} onChange={(e) => fields.commit(`asks.${ask.id}.kind`, e.target.value)}>
                  {ASK_KINDS.map((k) => <option key={k} value={k}>{askLabel({ ...ask, kind: k })}</option>)}
                </select>
                <button className="mini danger" onClick={() => fields.commit('asks', scene.asks.filter((a) => a.id !== ask.id))}>✕</button>
              </div>
              {target && (
                <NumericField
                  label={target.label}
                  value={ask[target.key]}
                  unitKind={target.unit}
                  onTransient={(v) => fields.transient(`asks.${ask.id}.${target.key}`, v)}
                  onCommit={(v) => fields.commit(`asks.${ask.id}.${target.key}`, v)}
                />
              )}
            </div>
          );
        })}
        <div className="row">
          <select id="new-ask-kind" defaultValue="at_time">
            {ASK_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button className="mini" onClick={() => {
            const el = document.getElementById('new-ask-kind') as HTMLSelectElement;
            const kind = el.value as AskKind;
            const target = ASK_TARGET[kind];
            fields.commit('asks', [...scene.asks, makeAsk(kind, target ? { [target.key]: target.key === 't' ? 1 : target.key === 'v' ? 2 : 1 } : {})]);
          }}>＋添加待求</button>
        </div>
      </section>

      <section>
        <h3>派生公式（只读）</h3>
        {!solution && <div className="hint">条件完整且受支持时显示；由本地求解器生成，不调用 AI</div>}
        {solution?.formulas.map((f) => (
          <div key={f.label} className="formula-row">
            <span className="row-sub">{f.label}</span>
            <Latex tex={f.latex} block />
          </div>
        ))}
      </section>
    </div>
  );
}
