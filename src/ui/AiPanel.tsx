import { useState } from 'react';
import { aiMode, MAX_IMAGE_BYTES, readProblem } from '../ai/client';
import { describePath } from '../model/paths';
import type { Action, Store } from '../state/store';

export function AiPanel({ store, dispatch, onClose }: { store: Store; dispatch: (a: Action) => void; onClose: () => void }) {
  const [text, setText] = useState('倾角为 30° 的斜面长 5 m，静摩擦因数为 0.4，物体自斜面顶端由静止释放，求到达底端的时间与速度。');
  const [image, setImage] = useState<File | null>(null);
  const [demo, setDemo] = useState<'incline' | 'flat'>('incline');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draft = store.draft;

  const close = () => {
    dispatch({ type: 'setDraft', draft: null });
    onClose();
  };

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const result = await readProblem({ text, image, demo });
      dispatch({ type: 'setDraft', draft: result });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-panel">
      <div className="ai-mode-row">
        <span className={`badge ${aiMode === 'demo' ? 'warn' : 'ok'}`}>{aiMode === 'demo' ? '本地演示模式（不调用云端 AI）' : '服务端读题'}</span>
      </div>

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
                <select value={demo} onChange={(e) => setDemo(e.target.value as any)}>
                  <option value="incline">斜面（故意缺少 μ_k）</option>
                  <option value="flat">平抛</option>
                </select>
              </div>
            )}
            {error && <div className="hint error">{error}</div>}
            <div className="modal-actions">
              <button className="primary" disabled={busy || (!text && !image)} onClick={generate}>{busy ? '生成中…' : '生成场景草稿'}</button>
              <button onClick={close}>取消</button>
            </div>
          </div>
        )}

        {draft && (
          <div className="modal-body">
            <div className="hint">请逐项检查后再应用。应用会替换当前场景，且整次替换可用撤销恢复；不会自动合并到现有场景。</div>
            {draft.warnings.map((w) => <div className="badge warn" key={w}>{w}</div>)}
            {draft.source.rawText && <pre className="raw-text">{draft.source.rawText}</pre>}
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
                  dispatch({ type: 'apply', scene: { ...draft.scene, rev: store.present.rev + 1 } });
                  dispatch({ type: 'setDraft', draft: null });
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
