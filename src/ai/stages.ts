import type { SceneDraft, Scene, Vec2 } from '../model/types';
import { solve } from '../solver';
import { resolveBindings } from '../model/paths';

/** Only transfer deterministically solved velocities; never ask the AI to invent stage results. */
export function resolveDraftStage(draft: SceneDraft, stageId: string): Scene {
  const stages=draft.stages??[];
  const stage=stages.find(s=>s.id===stageId);
  if(!stage)throw new Error('阶段不存在。');
  const scene=structuredClone(stage.scene),dep=stage.velocityFrom;
  if(!dep)return scene;
  const prior=resolveDraftStage(draft,dep.stageId),result=solve(prior);
  if(!result.ok)throw new Error('前一阶段条件不足或超出求解范围，不能自动带入后续初速度。');
  if(result.solution.template!=='collision')throw new Error('目前仅支持从碰撞阶段传递碰后速度。');
  const velocity:Partial<Vec2>={};
  for(const key of ['x','y'] as const){
    const answer=result.solution.answers.find(a=>a.id===dep.sourceBodyId+'.after.v'+key);
    if(typeof answer?.value!=='number'||!Number.isFinite(answer.value))throw new Error('前一阶段没有有效的碰后速度。');
    velocity[key]=answer.value;
  }
  const target=scene.bodies.find(b=>b.id===dep.targetBodyId);
  if(!target)throw new Error('后续阶段目标小球不存在。');
  const source=resolveBindings(prior).bodies.find(b=>b.id===dep.sourceBodyId);
  if(!source||target.mass!==source.mass||(target.charge??0)!==(source.charge??0))throw new Error('阶段间同一物体的质量或电荷不一致，请先校对。');
  const prefix='bodies.'+target.id+'.vel';
  if(Object.keys(scene.bindings).some(p=>p===prefix||p.startsWith(prefix+'.')))throw new Error('后续阶段初速度已绑定参数，请解除绑定后再带入碰后速度。');
  target.vel={...target.vel,x:velocity.x!,y:velocity.y!};
  return scene;
}
