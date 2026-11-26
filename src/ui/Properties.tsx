import type { FieldKind, FieldPlayback, FieldShape, Num, UnitKind } from '../model/types';
import { supportDir, supportLength } from '../model/geometry';
import { getAt, resolveBindings } from '../model/paths';
import { fmtWith } from '../model/units';
import { DEFAULT_COLLISION, makeContact } from '../model/factory';
import { SUPPORTED_TYPES } from '../model/validate';
import { fieldValue, withBinding, withField } from '../state/editing';
import type { FieldEdit } from '../state/editing';
import type { Action, Store } from '../state/store';
import { NumericField } from './NumericField';
import { DEFAULT_FIELD_PLAYBACK, defaultShape, electricVector, fieldLabel, FIELD_LABELS, hasGradient, isCharged, isPointSource, shapeCenter, validPolygon } from '../model/fields';

function BindingSelect({ store, path, dispatch }: { store: Store; path: string; dispatch: (a: Action) => void }) {
  const scene = store.present;
  const value = scene.bindings[path] ?? '';
  const shared = value && Object.values(scene.bindings).filter((name) => name === value).length > 1;
  return (
    <>
      <select className="binding-select" value={value} onChange={(e) => dispatch({ type: 'apply', scene: withBinding(scene, path, e.target.value) })} title="绑定到命名参数">
        <option value="">不绑定参数</option>
        {scene.params.map((p) => <option key={p.name} value={p.name}>绑定 {p.name}</option>)}
      </select>
      {shared && <div className="hint">共享参数：冲突拖动不修改，请用单字段/参数。</div>}
    </>
  );
}

export function Properties({ store, dispatch, fields }: { store: Store; dispatch: (a: Action) => void; fields: FieldEdit }) {
  const scene = store.present;
  const twoBalls=scene.bodies.length===2&&scene.bodies.every(b=>b.kind==='ball');
  const id = store.selection;
  const body = scene.bodies.find((b) => b.id === id);
  const sup = scene.supports.find((s) => s.id === id);
  const contact = scene.contacts.find((c) => c.id === id);
  const field = scene.fields?.find(f=>f.id===id);
  const link = scene.links?.find(l=>l.id===id);
  const playback = { ...DEFAULT_FIELD_PLAYBACK, ...scene.fieldPlayback };
  const eligible = (scene.fields??[]).filter(f=>f.enabled&&f.shape.kind!=='global');
  const setPlayback = (part: Partial<FieldPlayback>) => fields.commit('fieldPlayback',{...playback,...part});
  const sceneControls = () => <>
    <h4>场运动</h4>
    <NumericField label="演示 / 数值求解时长（留空使用默认值）" value={scene.fieldPlayback?.duration ?? null} unitKind="time"
      onCommit={(duration)=>setPlayback({duration:duration??DEFAULT_FIELD_PLAYBACK.duration})} onTransient={()=>{}} />
    <label className="field-control">出场策略
      <select value={playback.exit} onChange={e=>setPlayback({exit:e.target.value as FieldPlayback['exit'],fieldId:playback.fieldId??eligible[0]?.id??null})}>
        <option value="continue">继续穿越（记录并集首次出口）</option>
        <option value="field" disabled={!eligible.length}>首次离开指定场区</option>
        <option value="union" disabled={!eligible.length}>首次离开所有有限场区</option>
      </select>
    </label>
    {playback.exit==='field'&&<label className="field-control">指定场区
      <select value={playback.fieldId??''} onChange={e=>setPlayback({fieldId:e.target.value||null})}>
        <option value="">选择场区</option>
        {eligible.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </label>}
    {playback.exit!=='continue'&&<>
      <label className="field-control"><input type="checkbox" checked={playback.afterExit>0} onChange={e=>setPlayback({afterExit:e.target.checked?3:0})} />出场后续播</label>
      {playback.afterExit>0&&<NumericField label="出场后续播时长" value={playback.afterExit} unitKind="time"
        onCommit={(afterExit)=>setPlayback({afterExit:afterExit??0})} onTransient={()=>{}} />}
    </>}
  </>;

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

  const collisionControls=()=>{
    const settings=scene.collision??DEFAULT_COLLISION;
    const editSetting=(key:'restitution'|'afterCollision',value:Num)=>{
      if(scene.collision) fields.commit('collision.'+key,value);
      else fields.commit('collision',{...settings,[key]:value});
    };
    return <section><h3>双球碰撞</h3>
      <NumericField label="恢复系数 e（0～1）" value={scene.collision?fieldValue(scene,'collision.restitution'):settings.restitution} unitKind="none"
        onCommit={value=>editSetting('restitution',value)} onTransient={()=>{}} />
      {scene.collision&&<BindingSelect store={store} path="collision.restitution" dispatch={dispatch} />}
      <NumericField label="碰后播放时长" value={scene.collision?fieldValue(scene,'collision.afterCollision'):settings.afterCollision} unitKind="time"
        onCommit={value=>editSetting('afterCollision',value)} onTransient={()=>{}} />
      <div>e=1 弹性；0&lt;e&lt;1 非弹性；e=0 正碰后共速。两球在无外场下自由运动，忽略自转和切向摩擦。</div>
    </section>;
  };

  if (!id) {
    return (
      <div className="panel-content">
        <section>
          <h3>场景</h3>
          <input className="title-input" value={scene.title} onChange={(e) => dispatch({ type: 'apply', scene: { ...scene, title: e.target.value, rev: scene.rev + 1 } })} />
          {twoBalls ? collisionControls() : scene.bodies.some(b=>b.kind==='ball') || scene.fields?.length ? sceneControls()
            : num('重力加速度 g', 'gravity', 'accel', 1, 25, 0.1, '默认 9.8 属于明示假设，可在结果区核对')}
        </section>
        <section>
          <h3>首版支持题型</h3>
          {SUPPORTED_TYPES.map((t) => <div className="hint" key={t.id}>· {t.label}</div>)}
          <div className="hint">未选对象时显示本页。选中画布或左侧列表中的对象可编辑其属性。</div>
        </section>
      </div>
    );
  }

  if(field){
    const path=`fields.${field.id}`;
    const shape=field.shape;
    const changeField = (patch: Partial<typeof field>, clear: string[] = []) => {
      const next = {...field,...patch};
      const name = fieldLabel(field);
      if (!patch.name && (field.name === name || field.name.startsWith(name+' '))) next.name=fieldLabel(next)+field.name.slice(name.length);
      dispatch({type:'apply',scene:{
        ...scene,rev:scene.rev+1,fields:scene.fields!.map(item=>item.id===field.id?next:item),
        bindings:Object.fromEntries(Object.entries(scene.bindings).filter(([key])=>!clear.some(part=>key.startsWith(path+'.'+part+'.')))),
      }});
    };
    const replaceShape=(next: FieldShape)=>{
      if(field.plates&&next.kind!=='rect') changeField({shape:next,plates:null},['plates']);
      else fields.commit(path+'.shape',next);
    };
    const electric=field.kind==='uniform_electric'?electricVector(getAt(resolveBindings(scene),path) as typeof field):null;
    const gradient=hasGradient(field);
    const gradientUnit=field.kind==='uniform_gravity'?'gravity_gradient':field.kind==='uniform_electric'?'electric_gradient':'magnetic_gradient';
    const canUsePlates=field.kind==='uniform_electric'&&shape.kind==='rect';
    const setVertices=(vertices: {x:number;y:number}[])=>{
      if(!validPolygon(vertices)){dispatch({type:'notice',text:'多边形需要至少三个顶点，且不能自交。'});return;}
      fields.commit(path+'.shape',{kind:'polygon',vertices});
    };
    return <div className="panel-content"><section>
      <h3>场对象</h3>
      <label className="field-control">名称<input aria-label="场名称" value={field.name} onChange={e=>fields.commit(path+'.name',e.target.value)} /></label>
      <label className="field-control"><input type="checkbox" checked={field.enabled} onChange={e=>fields.commit(path+'.enabled',e.target.checked)}/>启用此场</label>
      <label className="field-control">场类型<select value={field.kind} onChange={e=>changeField({kind:e.target.value as FieldKind,gradient:null,plates:null},['gradient','plates'])}>
        {Object.entries(FIELD_LABELS).map(([k,label])=><option key={k} value={k}>{label.replace('匀强','')}</option>)}
      </select></label>
      <label className="field-control">作用范围<select value={shape.kind} onChange={e=>replaceShape(defaultShape(e.target.value as FieldShape['kind'],shapeCenter(shape,field.position)))}>
        <option value="global">全局</option><option value="rect">矩形</option><option value="circle">圆形</option><option value="polygon">多边形</option>
      </select></label>
      {shape.kind==='rect'&&<>{num('宽度',path+'.shape.width','length')}{num('高度',path+'.shape.height','length')}</>}
      {shape.kind==='circle'&&num('半径',path+'.shape.radius','length')}
      {(shape.kind==='rect'||shape.kind==='circle')&&<>{num('场区中心 x',path+'.shape.center.x','length')}{num('场区中心 y',path+'.shape.center.y','length')}</>}
      {shape.kind==='polygon'&&<><h4>多边形顶点</h4>{shape.vertices.map((v,i)=><div className="row" key={i}>
        <span>{i+1} · ({v.x.toPrecision(4)}, {v.y.toPrecision(4)})</span>
        <button className="mini" disabled={shape.vertices.length<=3} aria-label={`删除顶点 ${i+1}`} onClick={()=>setVertices(shape.vertices.filter((_,j)=>i!==j))}>✕</button>
      </div>)}</>}
      {!isPointSource(field)&&<label className="field-control">场强分布
        <select value={gradient?'gradient':field.plates?'plates':'uniform'} onChange={e=>{
          const mode=e.target.value;
          if(mode==='gradient') changeField({gradient:{x:0,y:0},plates:null,...(field.plates&&electric?{vector:electric}:{})},['plates']);
          else if(mode==='plates'&&shape.kind==='rect') {
            const vector=electric??{x:0,y:0};
            const axis=Math.abs(vector.x)>Math.abs(vector.y)?'x':'y';
            const distance=fieldValue(scene,path+(axis==='x'?'.shape.width':'.shape.height'));
            changeField({gradient:null,plates:{axis,voltage:typeof distance==='number'?vector[axis]*distance:null}},['gradient']);
          } else changeField({gradient:null,plates:null,...(field.plates&&electric?{vector:electric}:{})},['gradient','plates']);
        }}>
          <option value="uniform">匀强</option><option value="gradient">线性渐变</option>
          {canUsePlates&&<option value="plates">按平行板电压计算</option>}
        </select>
      </label>}
      {field.kind==='uniform_gravity'&&<>{num(gradient?'参考点 gx':'重力场 gx',path+'.vector.x','accel')}{num(gradient?'参考点 gy':'重力场 gy',path+'.vector.y','accel')}</>}
      {field.kind==='uniform_electric'&&<>
        {field.plates&&shape.kind==='rect'?<>
          <label className="field-control">板的法线方向<select value={field.plates.axis} onChange={e=>fields.commit(path+'.plates.axis',e.target.value)}>
            <option value="x">沿 x（左右两块板）</option>
            <option value="y">沿 y（上下两块板）</option>
          </select></label>
          {num('板间电压 U（负轴侧电势 − 正轴侧电势）',path+'.plates.voltage','voltage')}
          <div>板间距 d = {fmtWith(fieldValue(scene,path+(field.plates.axis==='x'?'.shape.width':'.shape.height')),'m')}</div>
          <div>E = {fmtWith(electric?.[field.plates.axis]??null,'V/m')}（沿 {field.plates.axis} 轴）</div>
        </>:<>{num(gradient?'参考点 Ex':'电场 Ex',path+'.vector.x','electric')}{num(gradient?'参考点 Ey':'电场 Ey',path+'.vector.y','electric')}</>}
      </>}
      {field.kind==='uniform_magnetic'&&num(gradient?'参考点 Bz（正值指向纸外）':'磁场 Bz（正值指向纸外）',path+'.bz','magnetic')}
      {gradient&&<>
        {num('参考点 x',path+'.position.x','length')}{num('参考点 y',path+'.position.y','length')}
        {num(field.kind==='uniform_magnetic'?'Bz 沿 x 每米的变化':'x 分量沿 x 每米的变化',path+'.gradient.x',gradientUnit)}
        {num(field.kind==='uniform_magnetic'?'Bz 沿 y 每米的变化':'y 分量沿 y 每米的变化',path+'.gradient.y',gradientUnit)}
      </>}
      {isPointSource(field)&&<>
        <div>{field.kind==='point_mass'?'固定质量源会吸引小球，距离变为两倍时引力减为四分之一。可用于模拟天体附近的轨道。':'固定电荷产生径向电场，距离变为两倍时场强减为四分之一。同号排斥，异号吸引。'}</div>
        {shape.kind!=='global'&&<p className="hint">裁剪点源：仅在所画区域内施力的教学模型。</p>}
        {num('场源 x',path+'.position.x','length')}{num('场源 y',path+'.position.y','length')}
        {num(field.kind==='point_mass'?'源质量':'源电荷',path+'.sourceStrength',field.kind==='point_mass'?'mass':'charge')}
        {num('最小距离',path+'.cutoffRadius','length')}
      </>}
    </section></div>;
  }

  if(link){
    const path=`links.${link.id}`;
    return <div className="panel-content"><section>
      <h3>定点{link.name}</h3>
      <label className="field-control">连接小球<select value={link.bodyId??''} onChange={e=>{
        const ball=scene.bodies.find(b=>b.id===e.target.value), pos=ball?.pos;
        const length=typeof pos?.x==='number'&&typeof pos.y==='number'?Math.hypot(pos.x-link.anchor.x,pos.y-link.anchor.y):link.length;
        fields.commit('links',(scene.links??[]).map(l=>l.id===link.id?{...l,bodyId:ball?.id??null,length:length||link.length}:l));
      }}>
        <option value="">未连接</option>
        {scene.bodies.filter(b=>b.kind==='ball').map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
      </select></label>
      {num('锚点 x',path+'.anchor.x','length')}{num('锚点 y',path+'.anchor.y','length')}{num('长度',path+'.length','length')}
      <p className="hint">{link.kind==='rope'?'绳只能拉，松弛时结束当前求解。':'杆可承受拉力和压力。'}初速度沿锚点圆的切向计算。</p>
    </section></div>;
  }

  if (body) {
    const chargePath = `bodies.${body.id}.charge`;
    const charged = isCharged({ ...body, charge: fieldValue(scene, chargePath) });
    const attachedSup = body.attach ? scene.supports.find((s) => s.id === body.attach!.support) : null;
    const dir = attachedSup ? supportDir(attachedSup) : { x: 1, y: 0 };
    const uPath = `bodies.${body.id}.vel`;
    const vx = fieldValue(scene, `${uPath}.x`) as Num;
    const vy = fieldValue(scene, `${uPath}.y`) as Num;
    const u = vx === null || vy === null ? null : vx * dir.x + vy * dir.y;
    const velocity = (v: Num) => ({ x: v === null ? null : v * dir.x, y: v === null ? null : v * dir.y });
    const omegaPath = `bodies.${body.id}.omega`;
    const radiusPath = `bodies.${body.id}.radius`;
    const omegaEff = fieldValue(scene, omegaPath) as Num;
    const radiusEff = fieldValue(scene, radiusPath) as Num;
    const circularSpeed = omegaEff !== null && radiusEff !== null ? Math.abs(omegaEff) * radiusEff : null;
    const omegaSign = (omegaEff ?? 0) < 0 ? -1 : 1;
    const setCircularSpeed = (v: Num, commit: boolean) => {
      if (v === null || radiusEff === null || radiusEff <= 0) return;
      const nextOmega = (omegaSign * v) / radiusEff;
      if (commit) fields.commit(omegaPath, nextOmega);
      else fields.transient(omegaPath, nextOmega);
    };
    return (
      <div className="panel-content">
        <section>
          <h3>{body.kind==='ball'?'小球':`${body.name}（${body.kind === 'block' ? '物块' : body.kind === 'boat' ? '小船' : body.kind === 'circular' ? '旧圆周运动示例' : '旧抛体场景'}）`}</h3>
          {num('质量 m', `bodies.${body.id}.mass`, 'mass', body.kind==='ball'?undefined:0.1, body.kind==='ball'?undefined:50, 0.1, body.kind === 'ball'?'质量必须为正；电磁加速度取决于荷质比 q/m。':body.kind === 'circular' ? '计算向心力需要正质量；留空则向心力待求' : '计算能量和做功需要正质量')}
          {body.kind==='ball'&&<>
            <label className="field-control">名称<input aria-label="小球名称" value={body.name} onChange={e=>fields.commit(`bodies.${body.id}.name`,e.target.value)} /></label>
            {num('碰撞半径 R',`bodies.${body.id}.collisionRadius`,'length')}
            <label className="field-control">
              <input type="checkbox" checked={charged} onChange={e=>{
                const charged=e.currentTarget.checked;
                const next={...body,charged,charge:charged&&(body.charge===0||body.charge===undefined)?null:body.charge};
                fields.commit('bodies',scene.bodies.map(item=>item.id===body.id?next:item));
              }} />带电
            </label>
            {charged&&num('电荷量 q（正值或负值）',chargePath,'charge')}
            {num('初始位置 x',`bodies.${body.id}.pos.x`,'length')}
            {num('初始位置 y',`bodies.${body.id}.pos.y`,'length')}
            {num('初速度 vx',`bodies.${body.id}.vel.x`,'speed')}
            {num('初速度 vy',`bodies.${body.id}.vel.y`,'speed')}
            {twoBalls ? collisionControls() : sceneControls()}
          </>}
          {body.kind === 'block' && attachedSup && (
            <>
              <div className="prop-field">
                <label>依附支撑面（对象关系）</label>
                <select
                  value={body.attach!.support}
                  onChange={(e) => {
                    const supportId = e.target.value;
                    const target = scene.supports.find((s) => s.id === supportId)!;
                    const s = fieldValue(scene, `bodies.${body.id}.attach.s`) as Num;
                    let next = withField(scene, `bodies.${body.id}.attach`, {
                      support: supportId,
                      s: s === null ? null : Math.min(s, supportLength(target)),
                    });
                    if (!next.contacts.some((c) => c.body === body.id && c.support === supportId)) {
                      next = { ...next, contacts: [...next.contacts, makeContact(body.id, supportId, 0.4, 0.3)] };
                    }
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
                  onTransient={(v) => fields.transient(uPath, velocity(v))}
                  onCommit={(v) => fields.commit(uPath, velocity(v))}
                />
                <div className="hint">也可以拖动画布上的速度箭头；分量 vx={vx ?? '?'}，vy={vy ?? '?'}</div>
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
          {body.kind === 'boat' && (
            <>
              {num('出发点 x', `bodies.${body.id}.pos.x`, 'length', -100, 100, 0.1)}
              {num('出发点 y（近岸）', `bodies.${body.id}.pos.y`, 'length', -100, 100, 0.1)}
              {num('河宽 d（沿 y 渡河距离）', `bodies.${body.id}.width`, 'length', 0.1, 200, 0.1, '船到达对岸即 y 增加一个河宽')}
              {num('船相对水速度 vx', `bodies.${body.id}.vel.x`, 'speed', -50, 50, 0.1, '船头指向决定该分量；垂直渡河时 vx=0')}
              {num('船相对水速度 vy', `bodies.${body.id}.vel.y`, 'speed', -50, 50, 0.1, '合速度沿河宽分量须为正才能到达对岸')}
              {num('水流速度 vx', `bodies.${body.id}.flow.x`, 'speed', -50, 50, 0.1, '沿河岸方向；决定漂移')}
              {num('水流速度 vy', `bodies.${body.id}.flow.y`, 'speed', -50, 50, 0.1)}
            </>
          )}
          {body.kind === 'circular' && (
            <>
              {num('圆心 x', `bodies.${body.id}.pos.x`, 'length', -100, 100, 0.1)}
              {num('圆心 y', `bodies.${body.id}.pos.y`, 'length', -100, 100, 0.1)}
              {num('半径 R', `bodies.${body.id}.radius`, 'length', 0.1, 100, 0.1)}
              <div className="prop-field">
                <NumericField
                  label="线速度 v（=ωR）"
                  value={circularSpeed}
                  unitKind="speed"
                  min={0}
                  max={100}
                  step={0.1}
                  hint="v 与 ω 是同一自由度的两个视图；改 v 会按 ω=v/R 反写角速度（R 与转向不变）"
                  onTransient={(v) => setCircularSpeed(v, false)}
                  onCommit={(v) => setCircularSpeed(v, true)}
                />
              </div>
              {num('角速度 ω（rad/s，逆时针为正）', `bodies.${body.id}.omega`, 'none', -20, 20, 0.1, 'v=ωR，T=2π/|ω|，a=ω²R')}
              {num('初相位 φ（rad，自 +x 逆时针）', `bodies.${body.id}.phase`, 'none', -6.3, 6.3, 0.1)}
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
          {num('长度 L', `supports.${sup.id}.length`, 'length', 0.2, 100, 0.1, '端点与其他支撑面重合时自动连接；物体到达整条轨道的外端点才停止')}
          {num('倾角 θ（0° 为水平面）', `supports.${sup.id}.angleDeg`, 'angle', -80, 80, 1)}
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
