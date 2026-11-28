import { describe, expect, it } from 'vitest';
import { COLLISION_EXAMPLES, ELECTROMAGNETIC_EXAMPLES, EXAMPLES, SPATIAL_EXAMPLES, makeAsk } from '../src/model/factory';
import { parseScene, parseSceneDraft } from '../src/model/runtime';
import { collisionFieldDraft } from '../src/ai/collision-field-example';
import { demoDraft } from '../src/ai/demo';
import { resolveDraftStage } from '../src/ai/stages';
import { validateSceneDraft } from '../functions/draft-schema';
import { SYSTEM_PROMPT } from '../functions/scene-prompt';
import { solve } from '../src/solver';
import { answer, ok } from './helpers';

describe('AI 场景契约与手动编辑器一致',()=>{
  it.each([...EXAMPLES,...ELECTROMAGNETIC_EXAMPLES,...COLLISION_EXAMPLES,...SPATIAL_EXAMPLES])('$title 完整保留，不剥离场和碰撞参数',example=>{
    const scene=JSON.parse(JSON.stringify(example.build()));
    const draft={source:{},scene,known:[],assumed:[],unknown:[],uncertain:[],warnings:[]};
    expect(parseScene(scene)).toEqual(scene);
    expect(parseSceneDraft(validateSceneDraft(draft))).toEqual(draft);
  });
  it.each(['incline','flat','plates','collision-fields'] as const)('内置 %s 草稿能够通过前后端同一校验',kind=>{
    const draft=demoDraft(kind,'题目');expect(parseSceneDraft(validateSceneDraft(draft))).toEqual(draft);
  });
  it('电荷与场证据可以指向阶段内对象，未知的初速度仍为 null',()=>{
    const draft=parseSceneDraft(collisionFieldDraft()),a=draft.stages![1].scene;
    expect(a.bodies[0].charge).toBe(.0001);expect(a.bodies[0].vel.x).toBeNull();
    expect(a.fields!.find(f=>f.id==='E')?.vector.y).toBe(10000);expect(a.fields!.find(f=>f.id==='B0')?.bz).toBe(-.5);
    expect(a.asks.map(a=>a.kind)).toEqual(['motion_analysis','return_to_initial_x']);
  });
  it.each(['bad-field-ref','bad-stage','cycle','unknown-field','bad-unit','bad-energy','bad-charge','unknown-z'] as const)('拒绝错误的结构或引用：%s',kind=>{
    const draft=collisionFieldDraft() as any;
    if(kind==='bad-field-ref')draft.stages[1].scene.asks.push(makeAsk('field_exit',{fieldId:'missing'}));
    if(kind==='bad-stage')draft.stages[1].velocityFrom.sourceBodyId='missing';
    if(kind==='cycle')draft.stages[1].velocityFrom.stageId='a-field';
    if(kind==='unknown-field')draft.stages[1].scene.fields[0].electricField=100;
    if(kind==='bad-unit')draft.scene.params=[{name:'q',value:1,unit:'fake',min:0,max:10,step:1}];
    if(kind==='bad-energy')draft.scene.asks[0].energyFrom={kind:'event',event:'fake'};
    if(kind==='bad-charge')draft.scene.bodies[0].charge='0.0001';
    if(kind==='unknown-z')draft.scene.bodies[0].pos.z=Infinity;
    expect(()=>parseSceneDraft(draft)).toThrow();expect(()=>validateSceneDraft(draft)).toThrow();
  });
  it('prototype 路径被剔除且不污染原型（DEF-042）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.known[0].path='constructor.prototype';
    const out=parseSceneDraft(draft) as any;
    expect(out.known.some((k:any)=>k.path==='constructor.prototype')).toBe(false);
    expect(out.warnings.some((w:string)=>w.includes('无法定位'))).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
  });
  it('不能把新版 fields 作为旧版额外字段透传后在浏览器丢弃',()=>{
    const draft=collisionFieldDraft();draft.stages![1].scene.fields![0].kind='unknown' as any;
    expect(()=>parseSceneDraft(draft)).toThrow(/kind/);
  });
  it('碰撞示意半径为 0 被前后端拒绝，null 允许（DEF-013）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.scene.bodies[0].collisionRadius=0;
    expect(()=>parseSceneDraft(draft)).toThrow(/collisionRadius/);
    expect(()=>validateSceneDraft(draft)).toThrow(/collisionRadius/);
    draft.scene.bodies[0].collisionRadius=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
  });
  it('水流速度 flow 为 null 允许（无水流），非对象非 null 拒绝（DEF-021）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.scene.bodies[0].flow=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
    draft.scene.bodies[0].flow=3;
    expect(()=>parseSceneDraft(draft)).toThrow(/flow/);
    expect(()=>validateSceneDraft(draft)).toThrow(/flow/);
    draft.scene.bodies[0].flow={x:1,y:0};
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
  });
  it('可选对象设置 fieldPlayback/collision 为 null 允许（回退默认），非对象非 null 拒绝（DEF-021）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.scene.fieldPlayback=null;draft.scene.collision=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
    draft.scene.fieldPlayback='fast';
    expect(()=>parseSceneDraft(draft)).toThrow(/fieldPlayback/);
    expect(()=>validateSceneDraft(draft)).toThrow(/fieldPlayback/);
    draft.scene.fieldPlayback=null;draft.scene.collision=1;
    expect(()=>parseSceneDraft(draft)).toThrow(/collision/);
    expect(()=>validateSceneDraft(draft)).toThrow(/collision/);
  });
  it('ask 能量参考点与 bindings 为 null 允许（缺省语义），非法值仍拒绝（DEF-021）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.scene.asks[0].energyFrom=null;draft.scene.asks[0].energyTo=null;draft.scene.bindings=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
    expect((validateSceneDraft(draft).scene as any).bindings).toEqual({});
    draft.scene.asks[0].energyFrom={kind:'bogus'};
    expect(()=>parseSceneDraft(draft)).toThrow(/energyFrom/);
    expect(()=>validateSceneDraft(draft)).toThrow(/energyFrom/);
  });
  it('提示词要求碰撞示意半径为正、两球沿接近方向分离、播放时长给数值（DEF-013）',()=>{
    for(const term of ['collisionRadius 必须是正的小示意值','间距不小于两半径之和','碰后播放时长'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('附着 vel:null 归 0、mu_k:null 取 mu_s 并明示（DEF-047）',()=>{
    const draft=collisionFieldDraft() as any;
    const sc=draft.scene;
    sc.supports=[{id:'s',name:'斜面',kind:'incline',a:{x:0,y:0},length:5,angleDeg:30}];
    sc.bodies=[{id:'b',kind:'block',name:'物块',attach:{support:'s',s:5},pos:null,vel:{x:null,y:null},mass:null,accel:null,charge:null,charged:false}];
    sc.contacts=[{id:'c',body:'b',support:'s',mu_s:0.4,mu_k:null}];
    sc.fields=[];sc.links=[];sc.gravity=10;
    sc.asks=[{id:'a1',kind:'end_of_support',t:null,x:null,y:null,v:null}];
    sc.params=[];sc.bindings={};
    draft.stages=null;draft.known=[];draft.assumed=[];draft.unknown=[];draft.uncertain=[];
    const out=parseSceneDraft(draft) as any;
    expect(out.scene.bodies[0].vel).toEqual({x:0,y:0});
    expect(out.scene.contacts[0].mu_k).toBe(0.4);
    expect(out.warnings.some((w:string)=>w.includes('mu_k=mu_s'))).toBe(true);
    expect(solve(out.scene).ok).toBe(true);
  });
  it('水平圆周忽略重力 g=0 允许，斜面 g=0 仍拒绝（DEF-046）',()=>{
    const draft=collisionFieldDraft() as any;
    const sc=draft.scene;
    sc.bodies=[{id:'b',kind:'circular',name:'球',attach:null,pos:{x:2,y:0},vel:{x:0,y:4},mass:null,accel:null,charge:null,charged:false,radius:2,omega:2,phase:0}];
    sc.supports=[];sc.contacts=[];sc.fields=[];sc.links=[];sc.gravity=0;
    sc.asks=[{id:'a1',kind:'motion_analysis',t:null,x:null,y:null,v:null}];
    sc.params=[];sc.bindings={};
    draft.stages=null;draft.known=[];draft.assumed=[];draft.unknown=[];draft.uncertain=[];
    const parsed=parseSceneDraft(draft) as any;
    expect(solve(parsed.scene).ok).toBe(true);
    sc.bodies[0].kind='block';
    sc.supports=[{id:'s',name:'面',kind:'horizontal',a:{x:0,y:0},length:5,angleDeg:0}];
    sc.bodies[0].attach={support:'s',s:0};
    sc.contacts=[{id:'c',body:'b',support:'s',mu_s:0,mu_k:0}];
    const bad=solve((parseSceneDraft(draft) as any).scene);
    expect(bad.ok).toBe(false);
    expect(bad.ok===false && bad.report.blockers.some((b:{path:string})=>b.path==='gravity')).toBe(true);
  });
  it('提示词要求圆周用 circular+radius+omega、忽略重力写 0（DEF-045）',()=>{
    for(const term of ['匀速圆周运动用 kind=circular 并写 radius 与 omega','忽略重力时写 scene.gravity=0'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('提示词明确纯重力运动可省略质量，能量/带电结果仍需质量（DEF-048）',()=>{
    for(const term of ['纯重力运动学且质量不影响所求时','不列为待补条件','能量/功、碰撞结果或带电轨迹确实依赖质量'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('提示词要求斜面顶端 attach.s=length（DEF-044）',()=>{
    expect(SYSTEM_PROMPT).toContain('物块从斜面顶端释放时 attach.s 写 length');
  });
  it('支撑面题型全局重力场迁移为 scene.gravity（DEF-043）',()=>{
    const draft=collisionFieldDraft() as any;
    const sc=draft.scene;
    sc.supports=[{id:'incline',name:'斜面',kind:'incline',a:{x:0,y:0},length:10,angleDeg:30}];
    sc.bodies=[{id:'block',kind:'block',name:'物块',attach:{support:'incline',s:0},pos:null,vel:{x:0,y:0},mass:null,accel:null,charge:null,charged:false}];
    sc.contacts=[{id:'c1',body:'block',support:'incline',mu_s:0,mu_k:0}];
    sc.fields=[{id:'g',name:'重力场',kind:'uniform_gravity',enabled:true,shape:{kind:'global'},position:{x:0,y:0},vector:{x:0,y:-10}}];
    sc.links=[];sc.asks=[{id:'a1',kind:'end_of_support',t:null,x:null,y:null,v:null}];
    sc.params=[];sc.bindings={};sc.gravity=null;
    draft.stages=null;draft.known=[];draft.assumed=[];draft.unknown=[];draft.uncertain=[];
    const out=parseSceneDraft(draft) as any;
    expect(out.scene.gravity).toBe(10);
    expect(out.scene.fields).toHaveLength(0);
    expect(out.warnings.some((w:string)=>w.includes('迁移'))).toBe(true);
  });
  it('附着物体 pos:null 由支撑面与 s 导出（DEF-041）',()=>{
    const draft=collisionFieldDraft() as any;
    const sc=draft.scene;
    sc.supports=[{id:'incline',name:'斜面',kind:'incline',a:{x:0,y:0},length:10,angleDeg:30}];
    sc.bodies=[{id:'block',kind:'block',name:'物块',attach:{support:'incline',s:0},pos:null,vel:{x:0,y:0},mass:null,accel:null,charge:null,charged:false}];
    sc.contacts=[{id:'c1',body:'block',support:'incline',mu_s:0,mu_k:0}];
    sc.fields=[];sc.links=[];sc.asks=[{id:'a1',kind:'end_of_support',t:null,x:null,y:null,v:null}];
    sc.params=[];sc.bindings={};
    draft.stages=null;draft.known=[];draft.assumed=[];draft.unknown=[];draft.uncertain=[];
    const out=parseSceneDraft(draft) as any;
    expect(out.scene.bodies[0].pos).toEqual({x:0,y:0});
  });
  it('单阶段题 stages:null 视同缺省（DEF-040）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.stages=null;
    for(const key of ['known','assumed','unknown'])draft[key]=draft[key].filter((r:any)=>!String(r.path).startsWith('stages.'));
    draft.uncertain=draft.uncertain.filter((p:string)=>!p.startsWith('stages.'));
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
  });
  it('平行板缺电压退化为矢量场并明示警告（DEF-039）',()=>{
    const draft=collisionFieldDraft() as any;
    const sc=draft.stages[1].scene;
    const e=sc.fields.find((f:any)=>f.kind==='uniform_electric');
    e.plates={axis:'y',voltage:null};
    const out=parseSceneDraft(draft) as any;
    const e2=out.stages[1].scene.fields.find((f:any)=>f.kind==='uniform_electric');
    expect(e2.plates).toBeUndefined();
    expect(out.warnings.some((w:string)=>w.includes('平行板模式缺电压'))).toBe(true);
  });
  it('提示词要求重力矢量 y 为负、禁止正 g 绑定到重力矢量（DEF-036）',()=>{
    for(const term of ['重力场矢量 y 分量必须为负','禁止把正的 g 大小绑定到重力矢量 y'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('场可选标量 bz/bx/by/sourceStrength/cutoffRadius 缺省允许（DEF-035）',()=>{
    const draft=collisionFieldDraft() as any;
    const scenes=[draft.scene,...(draft.stages||[]).map((s:any)=>s.scene)];
    for(const sc of scenes)for(const f of sc.fields||[]){delete f.bz;delete f.bx;delete f.by;delete f.sourceStrength;delete f.cutoffRadius;}
    const dropped=/\.(bz|bx|by|sourceStrength|cutoffRadius)$/;
    draft.known=draft.known.filter((k:any)=>!dropped.test(k.path));
    draft.assumed=draft.assumed.filter((k:any)=>!dropped.test(k.path));
    draft.unknown=draft.unknown.filter((k:any)=>!dropped.test(k.path));
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
  });
  it('提示词要求半空间多边形覆盖轨迹尺度或改用 global 场（DEF-034）',()=>{
    for(const term of ['范围必须覆盖预期轨迹的数倍尺度','禁止用百米量级多边形近似半空间'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('unknown/known 无效路径在兼容模式剔除并明示，服务端严格模式拒绝（DEF-033）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.unknown.push({path:'bodies.A.vel.x_after',label:'碰后速度'});
    const strictDraft = structuredClone(draft);
    const out=parseSceneDraft(draft) as any;
    expect(out.unknown.some((u:any)=>u.path==='bodies.A.vel.x_after')).toBe(false);
    expect(out.warnings.some((w:string)=>w.includes('待求标记'))).toBe(true);
    draft.known.push({path:'bodies.A.vel.x_after',label:'x',value:'1'});
    const out2=parseSceneDraft(draft) as any;
    expect(out2.known.some((k:any)=>k.path==='bodies.A.vel.x_after')).toBe(false);
    expect(out2.warnings.some((w:string)=>w.includes('无法定位的已知'))).toBe(true);
    expect(()=>validateSceneDraft(strictDraft, { strictReferences: true })).toThrow(/draft 路径不存在/);
  });
  it('不存在的 asks.<kind> 不应被伪造为有效溯源路径', () => {
    const draft = collisionFieldDraft() as any;
    draft.known.push({ path: 'asks.apex', label: '不存在的最高点问题', value: 'x' });
    expect(() => validateSceneDraft(draft, { strictReferences: true })).toThrow(/draft 路径不存在/);
  });
  it('严格模式拒绝路径形态的无效 uncertain 条目，但保留自然语言说明', () => {
    const draft = collisionFieldDraft() as any;
    draft.uncertain = ['bodies.A.vel.x_after'];
    expect(() => validateSceneDraft(draft, { strictReferences: true })).toThrow(/draft 路径不存在/);
    const prose = collisionFieldDraft() as any;
    prose.uncertain = ['无法确认题图中的边界是否足够大'];
    expect(() => validateSceneDraft(prose, { strictReferences: true })).not.toThrow();
  });
  it('阶段内 ask/场路径漏写 stages 前缀时自动定位并重写（DEF-031）',()=>{
    const draft=collisionFieldDraft() as any;
    const stageAsk=draft.stages[1].scene.asks[0].id;
    draft.known.push({path:`asks.${stageAsk}`,label:'阶段问题',value:'x'});
    const out=parseSceneDraft(draft) as any;
    expect(out.known.at(-1).path).toBe(`stages.${draft.stages[1].id}.scene.asks.${stageAsk}`);
  });
  it('场 position 缺省/null、磁场 vector null、矢量 z:null 均允许；电场 vector null 仍拒绝（DEF-030）',()=>{
    const draft=collisionFieldDraft() as any;
    const fields=draft.stages[1].scene.fields;
    for(const f of fields){delete f.position;f.vector={...f.vector,z:null};}
    const magnetic=fields.find((f:any)=>f.kind==='uniform_magnetic');
    magnetic.vector=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
    const electric=fields.find((f:any)=>f.kind==='uniform_electric');
    electric.vector=null;
    expect(()=>parseSceneDraft(draft)).toThrow(/vector/);
    expect(()=>validateSceneDraft(draft)).toThrow(/vector/);
  });
  it('uncertain 中的散文转入 warnings 保留，路径条目保留（DEF-029）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.uncertain=['是否穿过 y 轴左侧的说明文字', draft.known[0].path];
    const out=parseSceneDraft(draft) as any;
    expect(out.uncertain).toEqual([draft.known[0].path]);
    expect(out.warnings.some((w:string)=>w.includes('是否穿过 y 轴左侧'))).toBe(true);
  });
  it('首阶段 velocityFrom 为 null 等价无注入（DEF-028）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.stages[0].velocityFrom=null;
    expect(()=>parseSceneDraft(draft)).not.toThrow();
    expect(()=>validateSceneDraft(draft)).not.toThrow();
  });
  it('velocityFrom 引用 main 时主 scene 物化为 stages[0] 且可注入碰后速度（DEF-027）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.stages=draft.stages.slice(1);
    for(const s of draft.stages)s.velocityFrom.stageId='main';
    for(const row of [...draft.known,...draft.assumed,...draft.unknown])row.path=row.path.replace('stages.impact.','stages.main.');
    draft.uncertain=draft.uncertain.map((p:string)=>p.replace('stages.impact.','stages.main.'));
    const out=parseSceneDraft(draft) as any;
    expect(out.stages[0].id).toBe('main');
    expect(out.stages[0].scene.bodies).toHaveLength(2);
    const injected=resolveDraftStage(out,out.stages[1].id) as any;
    expect(injected.bodies[0].vel.x).toBeCloseTo(15/7,9);
  });
  it('无效参数绑定被剔除并明示警告，有效绑定保留（DEF-026）',()=>{
    const draft=collisionFieldDraft() as any;
    draft.scene.params=[{name:'mA',unit:'mass',min:0,max:1,step:0.01,value:0.1}];
    draft.scene.bindings={'bodies.A.mass':'mA','bodies.A.vel.x':'不存在的参数','bogus.path':'mA'};
    const out=parseSceneDraft(draft) as any;
    expect(out.scene.bindings).toEqual({'bodies.A.mass':'mA'});
    expect(out.warnings.some((w:string)=>w.includes('无效参数绑定'))).toBe(true);
  });
  it('提示词禁止 projectile 搭配独立场，平抛阶段用 ball 加重力场（DEF-025）',()=>{
    for(const term of ['搭配独立场（重力/电场/磁场）或绳杆的物体必须 kind=ball','禁止 projectile 搭配独立场'])expect(SYSTEM_PROMPT).toContain(term);
  });
  it('没有专用求解的问题仍结构化保留并明确标记未求解',()=>{
    const scene=EXAMPLES[0].build();scene.asks.push(makeAsk('custom',{question:'第九次经过某点时的条件？'}));
    expect(parseScene(scene).asks.at(-1)?.question).toBe('第九次经过某点时的条件？');
    const sol=ok(solve(scene));const a=answer(sol,scene.asks.at(-1)!.id);expect(a.value).toBeNull();expect(a.label).toContain('第九次');expect(a.note).toContain('没有对应');
  });
  it('场区进出场已覆盖的 custom 待求项改为引用结构化结果',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const ask=makeAsk('custom',{question:'出场时的竖直位移和速度方向？'});
    scene.asks.push(ask);
    const sol=ok(solve(scene));
    const a=answer(sol,ask.id);
    expect(a.value).toBeNull();
    expect(a.note).toContain('场区进出场结果覆盖');
  });
  it('F3：出场时间 custom 直接引用 field_exit 结果',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const ask=makeAsk('custom',{question:'出场时间'});
    scene.asks.push(ask);
    const a=answer(ok(solve(scene)),ask.id);
    expect(a.note).toContain('场区进出场结果覆盖');
  });
  it('F3：离开电场时的竖直位移 custom 直接引用 field_exit 结果',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const ask=makeAsk('custom',{question:'离开电场时的竖直位移'});
    scene.asks.push(ask);
    const a=answer(ok(solve(scene)),ask.id);
    expect(a.note).toContain('场区进出场结果覆盖');
  });
  it('F3：出场后继续上升到最高点的速度保留为未专用求解',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const ask=makeAsk('custom',{question:'出场后继续上升到最高点的速度'});
    scene.asks.push(ask);
    const a=answer(ok(solve(scene)),ask.id);
    expect(a.note).toContain('没有对应的专用求解');
    expect(a.note).not.toContain('场区进出场结果覆盖');
  });
  it('F3：场区内速度不应被误判为出场结果',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const ask=makeAsk('custom',{question:'场区内速度随时间的变化'});
    scene.asks.push(ask);
    const a=answer(ok(solve(scene)),ask.id);
    expect(a.note).toContain('没有对应的专用求解');
    expect(a.note).not.toContain('场区进出场结果覆盖');
  });
  it('F3：只有 field_entry 时，“出场时间”不能被误说成已有结果',()=>{
    const scene=ELECTROMAGNETIC_EXAMPLES.find(example=>example.id==='electric-field')!.build();
    const entry=scene.asks.find(a=>a.kind==='field_exit')!;
    entry.kind='field_entry';
    const ask=makeAsk('custom',{question:'出场时间'});
    scene.asks.push(ask);
    const a=answer(ok(solve(scene)),ask.id);
    expect(a.note).toContain('没有对应的专用求解');
    expect(a.note).not.toContain('场区进出场结果覆盖');
  });
  it('提示词采用新格式、分阶段传值与题意冲突检查，不再宣称没有场字段',()=>{
    for(const term of ['charge','uniform_electric','uniform_magnetic','motion_analysis','return_to_initial_x','velocityFrom','0.0001','A 会反弹'])expect(SYSTEM_PROMPT).toContain(term);
    expect(SYSTEM_PROMPT).not.toContain('只有 projectile 才允许 attach 为 null');
  });
  it('模型误加 scene. 前缀的 bindings 键与证据路径被归一化而非整份拒绝',()=>{
    const draft=demoDraft('incline','题目') as any;
    const [key,param]=Object.entries(draft.scene.bindings)[0] as [string,string];
    const knownPath=draft.known[0].path as string;
    draft.scene.bindings={['scene.'+key]:param};
    draft.known[0].path='scene.'+knownPath;
    draft.uncertain=['scene.'+knownPath];
    const validated=validateSceneDraft(draft) as any;
    expect(Object.keys(validated.scene.bindings)).toEqual([key]);
    expect(validated.known[0].path).toBe(knownPath);
    expect(validated.uncertain).toEqual([knownPath]);
    expect(parseSceneDraft(validated)).toEqual(validated);
  });
  it('归一化后重复的 bindings 键被剔除并明示警告（DEF-026）',()=>{
    const draft=demoDraft('incline','题目') as any;
    const [key,param]=Object.entries(draft.scene.bindings)[0] as [string,string];
    draft.scene.bindings['scene.'+key]=param;
    const validated=validateSceneDraft(draft) as any;
    expect(Object.keys(validated.scene.bindings)).toEqual([key]);
    expect(validated.warnings.some((w:string)=>w.includes('无效参数绑定'))).toBe(true);
    expect(parseSceneDraft(validated)).toEqual(validated);
  });
  it('提示词明确禁止 scene. 前缀并给出 bindings 示例',()=>{
    expect(SYSTEM_PROMPT).toContain('{"bodies.A.mass":"mA"}');
    expect(SYSTEM_PROMPT).toContain('禁止加 scene. 前缀');
  });
});

describe('修订后的碰撞、平抛与复合场题',()=>{
  it('原质量导致 A 反弹，修订质量后两球都向右且动量动能守恒',()=>{
    const d=collisionFieldDraft(),sc=structuredClone(d.scene);sc.bodies[1].mass=.4;
    const old=ok(solve(sc));expect(answer(old,'A.after.vx').value).toBeCloseTo(-3);expect(answer(old,'B.after.vx').value).toBeCloseTo(2);
    const fixed=ok(solve(d.scene));expect(answer(fixed,'A.after.vx').value).toBeCloseTo(15/7);expect(answer(fixed,'B.after.vx').value).toBeCloseTo(50/7);
    expect(answer(fixed,'momentum_before.x').value).toBeCloseTo(answer(fixed,'momentum_after.x').value!);
    expect(answer(fixed,'kinetic_before').value).toBeCloseTo(answer(fixed,'kinetic_after').value!);
  });
  it('本地碰后速度注入到各阶段，不修改 AI 草稿、质量或电荷',()=>{
    const draft=collisionFieldDraft(),snapshot=structuredClone(draft),a=resolveDraftStage(draft,'a-field'),b=resolveDraftStage(draft,'b-flight');
    expect(a.bodies[0].vel.x).toBeCloseTo(15/7);expect(b.bodies[0].vel.x).toBeCloseTo(50/7);expect(a.bodies[0].charge).toBe(.0001);
    expect(draft).toEqual(snapshot);
    draft.scene.bodies[1].mass=.4;draft.stages![0].scene.bodies[1].mass=.4;
    expect(resolveDraftStage(draft,'a-field').bodies[0].vel.x).toBeCloseTo(-3);
  });
  it('A 的电力抵消重力，磁力向上，半径、周期、返回高度与公式吻合',()=>{
    const scene=resolveDraftStage(collisionFieldDraft(),'a-field'),sol=ok(solve(scene));
    const motion=scene.asks[0].id,returnId=scene.asks[1].id;
    expect(answer(sol,motion).text).toContain('匀速圆周');
    expect(answer(sol,motion+'.radius').value).toBeCloseTo(30000/7,7);
    expect(answer(sol,motion+'.period').value).toBeCloseTo(4000*Math.PI,7);
    expect(sol.evalAt(0).ay).toBeGreaterThan(0);
    expect(answer(sol,returnId).value).toBeCloseTo(2000*Math.PI,7);
    expect(answer(sol,returnId+'.y').value).toBeCloseTo(.8+60000/7,7);
    for(const sample of sol.samples){expect(sample.x).toBeGreaterThan(-1e-7);expect(sample.y).toBeGreaterThanOrEqual(.8-1e-7);}
  });
  it('B 平抛 0.4 s 后落地，水平距离 20/7 m',()=>{
    const sol=ok(solve(resolveDraftStage(collisionFieldDraft(),'b-flight')));
    expect(answer(sol,'land_t').value).toBeCloseTo(.4);expect(answer(sol,'land_range').value).toBeCloseTo(20/7);
  });
  it('原磁场向外时先撞地，拒绝输出穿地后的返回答案',()=>{
    const sc=resolveDraftStage(collisionFieldDraft(),'a-field');sc.fields!.find(f=>f.id==='B0')!.bz=.5;
    const sol=ok(solve(sc)),a=answer(sol,sc.asks[1].id);expect(a.value).toBeNull();expect(a.note).toContain('地面以下');
  });
  it('前序缺条件、传值绑定冲突或两阶段质量不同都不能静默注入',()=>{
    const draft=collisionFieldDraft();draft.stages![0].scene.bodies[0].vel.x=null;
    expect(()=>resolveDraftStage(draft,'a-field')).toThrow(/前一阶段/);
    const d=collisionFieldDraft();d.stages![1].scene.bodies[0].mass=4;
    expect(()=>resolveDraftStage(d,'a-field')).toThrow(/质量或电荷/);
  });
});
