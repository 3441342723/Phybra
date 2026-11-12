import { useState } from 'react';
import type { CheckReport, Solution } from '../model/types';
import { fmtWith } from '../model/units';
import { describePath } from '../model/paths';
import type { Action, Store } from '../state/store';
import { Latex } from './Latex';

function Answers({ solution }: { solution: Solution }) {
  return (
    <div className="answers">
      {solution.answers.map((a) => (
        <div className="answer-row" key={a.id}>
          <span className="answer-label">{a.label}</span>
          <span className="answer-value">
            {a.text ?? fmtWith(a.value, a.unit)}
            {a.others?.length ? `；其余解 ${a.others.map((o) => fmtWith(o.value, o.unit)).join('，')}` : ''}
          </span>
          {a.note && <span className="hint">{a.note}</span>}
        </div>
      ))}
    </div>
  );
}

function Report({ report, store, dispatch }: { report: CheckReport; store: Store; dispatch: (a: Action) => void }) {
  return (
    <div className="report">
      {report.blockers.map((b) => (
        <div className="blocker" key={b.path + b.message}>
          <button
            className="link"
            onClick={() => {
              const parts = b.path.split('.');
              if (['bodies', 'supports', 'contacts'].includes(parts[0])) dispatch({ type: 'select', id: parts[1] });
            }}
          >
            {describePath(store.present, b.path)}
          </button>
          <span>{b.message}</span>
        </div>
      ))}
      {report.pending.map((p) => (
        <div className="hint" key={p.path + p.label}>· {p.label}</div>
      ))}
    </div>
  );
}

export function ResultPanel({ store, dispatch, solution }: { store: Store; dispatch: (a: Action) => void; solution: Solution | null }) {
  const [open, setOpen] = useState(true);
  const formal = store.formal;
  const showFormal = formal.status === 'ready' && formal.solution;
  const display = showFormal ? formal.solution : solution;
  const report = formal.status === 'stale' && formal.report ? formal.report : store.preview.report;

  return (
    <div className="result-panel">
      <div className="result-head" onClick={() => setOpen(!open)}>
        <strong>{open ? '▾' : '▸'} 答案与推导</strong>
        {formal.status === 'stale' && <span className="badge warn">条件已修改：正式结果待更新</span>}
        {showFormal ? <span className="badge ok">正式结果 · rev {formal.forRev}</span> : display && <span className="badge">实时预览（未确认）</span>}
        {display?.flags.includes('multi') && <span className="badge warn">多解</span>}
      </div>
      {open && (
        <div className="result-body">
          {formal.status === 'stale' && <div className="hint">修改物理条件已使旧的正式答案与推导失效；点击右上角「检查并求解」更新。下方展示的是本地实时预览，不调用 AI。</div>}
          {report && report.blockers.length > 0 && <Report report={report} store={store} dispatch={dispatch} />}
          {display ? (
            <>
              <Answers solution={display} />
              {report && report.pending.length > 0 && <Report report={{ blockers: [], pending: report.pending }} store={store} dispatch={dispatch} />}
              <details className="steps">
                <summary>推导步骤（公式模板 + 数值代入，与答案、曲线同源）</summary>
                {display.steps.map((s, i) => (
                  <div className="step" key={i}>
                    <div className="step-title">{i + 1}. {s.title}</div>
                    <Latex tex={s.formula} block />
                    {s.substitution && <Latex tex={s.substitution} block />}
                    {s.note && <div className="hint">{s.note}</div>}
                  </div>
                ))}
              </details>
            </>
          ) : (
            !report && <div className="hint">搭建场景后自动生成预览；点击「检查并求解」得到正式答案与完整推导</div>
          )}
        </div>
      )}
    </div>
  );
}
