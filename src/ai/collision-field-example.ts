import { baseScene, makeAsk, makeBall, makeField } from '../model/factory';
import type { SceneDraft } from '../model/types';

export const CORRECTED_COLLISION_FIELD_PROBLEM = `光滑绝缘水平台面距地面高 h=0.8 m。小球 A 的质量 mA=0.1 kg，带电荷 q=+1×10^-4 C，以 v0=5 m/s 向右运动，与静止的不带电小球 B（mB=0.04 kg）发生弹性正碰。碰撞在台面右端 P 附近发生，忽略碰撞点至 P 的距离；碰后两球均从 P 水平向右飞出。以 P 正下方地面为原点，向右为 x 正方向、向上为 y 正方向。台面右侧半空间（x≥0）存在竖直向上的匀强电场 E=1×10^4 N/C 和垂直纸面向里的匀强磁场 B=0.5 T。取 g=10 m/s²，忽略空气阻力、两球间电作用及小球大小，P 右侧轨迹上无其他障碍。求：（1）碰后 A、B 的速度；（2）A 在复合场中的运动性质、轨道半径与周期；（3）B 落地点距 P 正下方的水平距离；（4）A 第一次返回过 P 的竖直线时距地面多高。`;

/** A transparent, deterministic demonstration of the corrected problem; never presented as an AI reply. */
export function collisionFieldDraft(): SceneDraft {
  const impact=baseScene('阶段一：弹性正碰');impact.gravity=10;
  const a=makeBall({x:-.02,y:.8},.0001,5,0),b=makeBall({x:0,y:.8},0,0,0);
  a.id='A';b.id='B';a.name='小球 A';b.name='小球 B';a.mass=.1;b.mass=.04;a.collisionRadius=b.collisionRadius=.01;
  impact.bodies=[a,b];impact.collision={restitution:1,afterCollision:1};impact.asks=[makeAsk('collision')];

  const field=baseScene('阶段二：A 进入复合场');field.gravity=10;
  field.bodies=[{...a,pos:{x:0,y:.8,z:0},vel:{x:null,y:null,z:0}}];
  const gravity=makeField('uniform_gravity',{x:0,y:0},{kind:'global'});gravity.id='g';gravity.vector={x:0,y:-10};
  const electric=makeField('uniform_electric',{x:0,y:0},{kind:'global'});electric.id='E';electric.vector={x:0,y:10000};
  const magnetic=makeField('uniform_magnetic',{x:0,y:0},{kind:'global'});magnetic.id='B0';magnetic.bz=-.5;
  field.fields=[gravity,electric,magnetic];field.fieldPlayback={duration:2000*Math.PI,exit:'continue',fieldId:null,afterExit:0};
  field.asks=[makeAsk('motion_analysis'),makeAsk('return_to_initial_x',{y:0})];

  const flight=baseScene('阶段三：B 平抛落地');flight.gravity=10;
  flight.bodies=[{...b,pos:{x:0,y:.8,z:0},vel:{x:null,y:null,z:0}}];
  flight.fields=[structuredClone(gravity)];flight.asks=[makeAsk('landing')];
  const stages:NonNullable<SceneDraft['stages']>=[
    {id:'impact',title:'1. 弹性正碰',scene:impact},
    {id:'a-field',title:'2. A：复合场圆周与首次返回',scene:field,velocityFrom:{stageId:'impact',sourceBodyId:'A',targetBodyId:'A'}},
    {id:'b-flight',title:'3. B：平抛落地',scene:flight,velocityFrom:{stageId:'impact',sourceBodyId:'B',targetBodyId:'B'}},
  ];
  return {
    source:{rawText:CORRECTED_COLLISION_FIELD_PROBLEM,demo:true},scene:impact,stages,
    known:[
      {path:'bodies.A.mass',label:'A 质量',value:'0.1 kg',quote:'mA=0.1 kg'},
      {path:'bodies.B.mass',label:'B 质量（修订后）',value:'0.04 kg',quote:'mB=0.04 kg'},
      {path:'bodies.A.charge',label:'A 电荷量',value:'+0.0001 C',quote:'q=+1×10^-4 C'},
      {path:'stages.a-field.scene.fields.E.vector.y',label:'向上电场',value:'10000 N/C',quote:'竖直向上'},
      {path:'stages.a-field.scene.fields.B0.bz',label:'磁场（修订后向里）',value:'−0.5 T',quote:'垂直纸面向里'},
      {path:'stages.a-field.scene.bodies.A.pos.y',label:'台面高度',value:'0.8 m',quote:'h=0.8 m'},
    ],
    assumed:[
      {path:'collision',label:'理想瞬时弹性正碰',value:'e=1',basis:'碰撞阶段忽略场力冲量及台面边缘距离；只取碰后速度，碰后自由播放不代表仍在台面上。'},
      {path:'bodies.A.collisionRadius',label:'碰撞示意半径',value:'0.01 m',basis:'用于建立初始相切的接触法线；题目按小球大小可忽略处理，不作为测量值。'},
      {path:'stages.a-field.scene.fields',label:'仅演示 A 首次返回前的场区内轨迹',value:'0≤t≤T/2',basis:'此区间 A 始终满足 x≥0，因而采用全局场局部演示与原半空间等价；不计算返回出场后的运动。'},
    ],
    unknown:stages.flatMap(s=>s.scene.asks.map(a=>({path:'stages.'+s.id+'.scene.asks.'+a.id,label:s.title+' · '+(a.kind==='collision'?'碰后速度':a.kind==='landing'?'落地距离':a.kind==='motion_analysis'?'性质、半径、周期':'返回高度')}))),
    uncertain:[],warnings:[
      '本地修订示例：原题 mB=0.4 kg 会使 A 反弹，改为 0.04 kg；磁场改为向里，使 A 向上绕行，避免原向外磁场导致落地早于返回。',
      '分阶段应用：不把碰撞、台面约束和入场后的运动冒充为一条连续仿真；下游初速度由本地碰撞求解器带入。',
    ],
  };
}
