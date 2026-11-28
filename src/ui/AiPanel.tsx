import { useEffect, useRef, useState } from 'react';
import { AiDraftError, aiMode, MAX_IMAGE_BYTES, readProblem } from '../ai/client';
import { PLATES_PROBLEM, type DemoKind } from '../ai/demo';
import { describePath } from '../model/paths';
import type { Action, Store } from '../state/store';
import { resolveDraftStage } from '../ai/stages';
import { collisionFieldDraft, CORRECTED_COLLISION_FIELD_PROBLEM } from '../ai/collision-field-example';

export function AiPanel({ store, dispatch, onClose }: { store: Store; dispatch: (a: Action) => void; onClose: () => void }) {
  const [text, setText] = useState('倾角为 30° 的斜面长 5 m，静摩擦因数为 0.4，物体自斜面顶端由静止释放，求到达底端的时间与速度。');
  const [image, setImage] = useState<File | null>(null);
  const [demo, setDemo] = useState<DemoKind>('incline');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [stageId,setStageId]=useState('');
  const [canRegenerate, setCanRegenerate] = useState(false);
  const retryRef = useRef<{ text: string; image: File | null; generationId: string } | null>(null);
  const requestRef = useRef<{ controller: AbortController; id: number } | null>(null);
  const requestId = useRef(0);
  const draft = store.draft;

  useEffect(() => () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const close = () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    // generate()'s finally only clears busy for its own request id, so cancelling
    // here must reset it or the panel stays disabled after reopening.
    setBusy(false);
    dispatch({ type: 'setDraft', draft: null });
    onClose();
  };

  async function generate() {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const id = ++requestId.current;
    requestRef.current = { controller, id };
    setBusy(true);
    setError('');
    setProgress('');
    const retry = retryRef.current;
    const generationId = retry?.text === text && retry.image === image ? retry.generationId : undefined;
    if (!generationId) retryRef.current = null;
    try {
      const result = await readProblem({
        text, image, demo, signal: controller.signal, generationId,
        onProgress: ({ elapsedMs, phase }) => {
          if (requestRef.current?.id === id) setProgress(phase === 'repairing'
            ? `正在自动修正场景格式（最多一次），已等待 ${Math.round(elapsedMs / 1000)} 秒；原题文字与题图保持不变`
            : `云端读题中，已等待 ${Math.round(elapsedMs / 1000)} 秒；复杂题可能需要数分钟，关闭面板不会中断云端生成，重新提交同一题面可续取结果`);
        },
      });
      if (requestRef.current?.id === id && !controller.signal.aborted) {
        retryRef.current = null; setCanRegenerate(false);
        setStageId(''); dispatch({ type: 'setDraft', draft: result });
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError') && requestRef.current?.id === id) {
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof AiDraftError) {
          retryRef.current = { text, image, generationId: crypto.randomUUID() };
          setCanRegenerate(true);
        }
      }
    } finally {
      if (requestRef.current?.id === id) {
        requestRef.current = null;
        setBusy(false);
        setProgress('');
      }
    }
  }

  return (
    <div className="ai-panel">
      <div className="ai-mode-row">
        <span className={`badge ${aiMode === 'demo'||draft?.source.demo ? 'warn' : 'ok'}`}>{draft?.source.demo&&aiMode!=='demo'?'本地修订示例（非 AI 识别）':aiMode === 'demo' ? '本地演示模式（不调用云端 AI）' : '服务端读题'}</span>
      </div>
      {!draft&&!busy&&<button onClick={()=>{setStageId('');setError('');setText(CORRECTED_COLLISION_FIELD_PROBLEM);dispatch({type:'setDraft',draft:collisionFieldDraft()});}}>载入碰撞与复合场修订示例（本地）</button>}

        {!draft && (
          <div className="modal-body">
            {aiMode === 'demo' && (
              <div className="hint">尚未接入 Sites 服务端函数（VITE_AI_ENDPOINT 未配置）。下方用内置样例生成草稿，仅用于验证审阅与替换流程；物理求解始终是本地确定性计算。</div>
            )}
            <label>题目文字</label>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴题目文字，或上传题图" />
            <label>题图（≤ 4 MB）</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > MAX_IMAGE_BYTES) setError('图片超过 4 MB，请压缩后再上传');
                else {
                  setError('');
                  setImage(f);
                }
              }}
            />
            {aiMode === 'demo' && (
              <div className="row">
                <label>演示样例</label>
                <select value={demo} onChange={(e) => {
                  const kind = e.target.value as DemoKind;
                  setDemo(kind);
                  if (kind === 'plates') setText(PLATES_PROBLEM);
                }}>
                  <option value="incline">斜面（故意缺少 μ_k）</option>
                  <option value="flat">平抛</option>
                  <option value="plates">电磁学：平行板加速</option>
                  <option value="collision-fields">碰撞与复合场（修订示例）</option>
                </select>
              </div>
            )}
            {busy && progress && <div className="hint">{progress}</div>}
            {error && <div className="hint error">{error}</div>}
            <div className="modal-actions">
              <button className="primary" disabled={busy || (!text && !image)} onClick={generate}>{busy ? '生成中…' : canRegenerate ? '重新生成草稿' : '生成场景草稿'}</button>
              {busy && <button onClick={close}>取消请求</button>}
              <button onClick={close}>取消</button>
            </div>
          </div>
        )}

        {draft && (
          <div className="modal-body">
            <div className="hint">请逐项检查后再应用。应用会替换当前场景，且整次替换可用撤销恢复；不会自动合并到现有场景。</div>
            {draft.warnings.map((w) => <div className="badge warn" key={w}>{w}</div>)}
            {draft.source.rawText && <pre className="raw-text">{draft.source.rawText}</pre>}
            {!!draft.stages?.length&&<label className="field-control">选择要查看的阶段（分别应用，可撤销）
              <select className="draft-stage-select" aria-label="AI 草稿阶段" value={stageId} onChange={e=>{setStageId(e.target.value);setError('');}}>
                <option value="">主场景</option>
                {draft.stages.map(s=><option key={s.id} value={s.id}>{s.title}{s.velocityFrom?'（自动带入前阶段碰后速度）':''}</option>)}
              </select>
            </label>}
            {error&&<div className="hint error">{error}</div>}
            <h4>识别到的已知量（含原文依据）</h4>
            {draft.known.map((k) => (
              <div className={`draft-row${draft.uncertain.includes(k.path) ? ' uncertain' : ''}`} key={k.path}>
                <span>{k.label}</span><strong>{k.value}</strong>
                {k.quote && <span className="hint">依据：{k.quote}</span>}
                {draft.uncertain.includes(k.path) && <span className="badge warn">不确定</span>}
              </div>
            ))}
            <h4>明示假设</h4>
            {draft.assumed.map((k) => (
              <div className="draft-row" key={k.path}><span>{k.label}</span><strong>{k.value}</strong><span className="hint">{k.basis}</span></div>
            ))}
            <h4>待求 / 待补充</h4>
            {draft.unknown.map((u) => (
              <div className="draft-row uncertain" key={u.path}>
                <span>{u.label}</span>
                <span className="hint">{describePath(draft.scene, u.path)}</span>
              </div>
            ))}
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  let scene=draft.scene;
                  try {if(stageId)scene=resolveDraftStage(draft,stageId);}catch(e){setError(e instanceof Error?e.message:'阶段无法应用');return;}
                  dispatch({ type: 'apply', scene: { ...scene, rev: store.present.rev + 1 } });
                  if(!draft.stages?.length)dispatch({ type: 'setDraft', draft: null });
                  dispatch({ type: 'resetPlayback' });
                }}
              >
                应用替换场景（可撤销）
              </button>
              <button onClick={close}>取消</button>
            </div>
          </div>
        )}
    </div>
  );
}
