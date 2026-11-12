import type { Num, UnitKind } from '../model/types';
import { supportDir, supportLength } from '../model/geometry';
import { setAt } from '../model/paths';
import { SUPPORTED_TYPES } from '../model/validate';
import { fieldValue, withBinding } from '../state/editing';
import type { FieldEdit } from '../state/editing';
import type { Action, Store } from '../state/store';
import { NumericField } from './NumericField';

function BindingSelect({ store, path, dispatch }: { store: Store; path: string; dispatch: (a: Action) => void }) {
  const scene = store.present;
  const value = scene.bindings[path] ?? '';
  return (
    <select className="binding-select" value={value} onChange={(e) => dispatch({ type: 'apply', scene: withBinding(scene, path, e.target.value) })} title="绑定到命名参数">
      <option value="">不绑定参数</option>
      {scene.params.map((p) => <option key={p.name} value={p.name}>绑定 {p.name}</option>)}
    </select>
  );
}

export function Properties({ store, dispatch, fields }: { store: Store; dispatch: (a: Action) => void; fields: FieldEdit }) {
  const scene = store.present;
  const id = store.selection;
  const body = scene.bodies.find((b) => b.id === id);
  const sup = scene.supports.find((s) => s.id === id);
  const contact = scene.contacts.find((c) => c.id === id);

  const num = (label: string, path: string, unitKind: UnitKind, min?: number, max?: number, step?: number, hint?: string) => (
    <div className="prop-field" key={path}>
      <NumericField
        label={label}
        value={fieldValue(scene, path) as Num}
        unitKind={unitKind}
        min={min}
        max={max}
        step={step}
        boundName={scene.bindings[path]}
        hint={hint}
        onTransient={(v) => fields.transient(path, v)}
        onCommit={(v) => fields.commit(path, v)}
      />
      <BindingSelect store={store} path={path} dispatch={dispatch} />
    </div>
  );

  if (!id) {
    return (
      <div className="panel-content">
        <section>
          <h3>场景</h3>
          <input className="title-input" value={scene.title} onChange={(e) => dispatch({ type: 'apply', scene: { ...scene, title: e.target.value, rev: scene.rev + 1 } })} />
          {num('重力加速度 g', 'gravity', 'accel', 1, 25, 0.1, '默认 9.8 属于明示假设，可在结果区核对')}
        </section>
        <section>
          <h3>首版支持题型</h3>
          {SUPPORTED_TYPES.map((t) => <div className="hint" key={t.id}>· {t.label}</div>)}
          <div className="hint">未选对象时显示本页。选中画布或左侧列表中的对象可编辑其属性。</div>
        </section>
      </div>
    );
  }

  if (body) {
    const attachedSup = body.attach ? scene.supports.find((s) => s.id === body.attach!.support) : null;
    const dir = attachedSup ? supportDir(attachedSup) : { x: 1, y: 0 };
    const u = (body.vel.x ?? 0) * dir.x + (body.vel.y ?? 0) * dir.y;
    const uPath = `bodies.${body.id}.vel`;
    return (
      <div className="panel-content">
        <section>
          <h3>{body.name}（{body.kind === 'block' ? '滑块' : '抛体'}）</h3>
          {num('质量 m', `bodies.${body.id}.mass`, 'mass', 0.1, 50, 0.1, '首批题型中质量会约去，仅用于后续受力扩展')}
          {body.kind === 'block' && attachedSup && (
            <>
              <div className="prop-field">
                <label>依附支撑面（对象关系）</label>
                <select
                  value={body.attach!.support}
                  onChange={(e) => {
                    let next = setAt(scene, `bodies.${body.id}.attach.support`, e.target.value);
                    next = {
                      ...next,
                      contacts: next.contacts.map((c) => (c.body === body.id ? { ...c, support: e.target.value } : c)),
                    };
                    dispatch({ type: 'apply', scene: next });
                  }}
                >
                  {scene.supports.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.kind === 'incline' ? '斜面' : '水平面'}）</option>)}
                </select>
              </div>
              {num('沿面位置 s（自 a 端起）', `bodies.${body.id}.attach.s`, 'length', 0, supportLength(attachedSup), 0.05, '拖动画布上的滑块也会修改此值，且不会脱离斜面')}
              <div className="prop-field">
                <NumericField
                  label={`沿面初速度 u（正方向 a→b）`}
                  value={u}
                  unitKind="speed"
                  min={-20}
                  max={20}
                  step={0.1}
                  onTransient={(v) => {
                    const value = (v ?? 0) as number;
                    fields.transient(uPath, { x: value * dir.x, y: value * dir.y });
                  }}
                  onCommit={(v) => {
                    const value = (v ?? 0) as number;
                    fields.commit(uPath, { x: value * dir.x, y: value * dir.y });
                  }}
                />
                <div className="hint">也可以拖动画布上的速度箭头；分量 vx={body.vel.x ?? '?'}，vy={body.vel.y ?? '?'}</div>
              </div>
              {num('外加加速度 a（留空则由摩擦决定）', `bodies.${body.id}.accel`, 'accel', -20, 20, 0.1, '仅水平直线运动使用；斜面由受力决定')}
            </>
          )}
          {body.kind === 'projectile' && (
            <>
              {num('初始位置 x', `bodies.${body.id}.pos.x`, 'length', -100, 100, 0.1)}
              {num('初始高度 y', `bodies.${body.id}.pos.y`, 'length', 0, 200, 0.1)}
              {num('水平初速度 vx', `bodies.${body.id}.vel.x`, 'speed', -50, 50, 0.1)}
              {num('竖直初速度 vy（平抛为 0）', `bodies.${body.id}.vel.y`, 'speed', -50, 50, 0.1)}
            </>
          )}
        </section>
      </div>
    );
  }

  if (sup) {
    return (
      <div className="panel-content">
        <section>
          <h3>{sup.name}</h3>
          {num('a 端 x', `supports.${sup.id}.a.x`, 'length')}
          {num('a 端 y', `supports.${sup.id}.a.y`, 'length')}
          {num('长度 L', `supports.${sup.id}.length`, 'length', 0.2, 100, 0.1, '物体到达端点即停止（首版约定）')}
          {sup.kind === 'incline'
            ? num('倾角 θ', `supports.${sup.id}.angleDeg`, 'angle', -80, 80, 1, 'a→b 方向与水平线夹角')
            : <div className="hint">水平面倾角固定为 0°</div>}
        </section>
      </div>
    );
  }

  if (contact) {
    return (
      <div className="panel-content">
        <section>
          <h3>摩擦接触</h3>
          {num('静摩擦因数 μ_s', `contacts.${contact.id}.mu_s`, 'none', 0, 1.5, 0.01, '决定能否保持静止：|tanθ| ≤ μ_s')}
          {num('动摩擦因数 μ_k', `contacts.${contact.id}.mu_k`, 'none', 0, 1.5, 0.01, '滑动时使用；未知则保持为空，不会默认成 0')}
        </section>
      </div>
    );
  }

  return <div className="panel-content"><div className="hint">该对象在左侧列表中编辑</div></div>;
}
