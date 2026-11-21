import { useEffect, useId, useState } from 'react';
import type { Solution } from '../model/types';
import { fmt } from '../model/units';
import { isPlaybackRate, type Action, type Store } from '../state/store';

const TIME_DIVISIONS = 600;

export function Timeline({ store, dispatch, solution, onPlay }: { store: Store; dispatch: (a: Action) => void; solution: Solution | null; onPlay: () => void }) {
  const tEnd = solution?.tEnd ?? 0;
  const t = Math.min(store.playback.t, tEnd);
  const playing = store.playback.mode === 'playing';
  const [rate, setRate] = useState(String(store.playbackRate));
  const options = useId();
  useEffect(() => setRate(String(store.playbackRate)), [store.playbackRate]);
  const commitRate = () => {
    const parsed = Number(rate);
    if (isPlaybackRate(parsed)) dispatch({ type: 'playbackRate', rate: parsed });
    setRate(String(isPlaybackRate(parsed) ? parsed : store.playbackRate));
  };
  return (
    <div className="timeline">
      <button
        className="primary"
        disabled={tEnd <= 0}
        onClick={() => {
          if (playing) dispatch({ type: 'pause' });
          else onPlay();
        }}
      >
        {playing ? '暂停' : t > 0 && t < tEnd ? '继续' : '播放'}
      </button>
      <button disabled={!solution} onClick={() => dispatch({ type: 'resetPlayback' })} title="回到初始时刻，不改变已确认的初始条件">重置</button>
      <label className="playback-rate" title="0.1× 表示每过 1 秒，场景时间走 0.1 秒；可输入 1e-6 等任意正倍率。">
        播放倍率
        <input type="number" step="any" list={options} value={rate} onChange={e=>setRate(e.target.value)}
          onBlur={commitRate} onKeyDown={e=>{if(e.key==='Enter') e.currentTarget.blur();}} /> ×
      </label>
      <datalist id={options}>{[0.001, 0.01, 0.1, 0.25, 0.5, 1, 2, 4].map(value=><option key={value} value={value} />)}</datalist>
      <input
        type="range"
        className="time-slider"
        min={0}
        max={TIME_DIVISIONS}
        step={1}
        value={tEnd > 0 ? Math.round((t / tEnd) * TIME_DIVISIONS) : 0}
        aria-label="运动时间"
        aria-valuetext={`${fmt(t)} 秒`}
        disabled={tEnd <= 0}
        onChange={(e) => dispatch({ type: 'scrub', t: (Number(e.target.value) / TIME_DIVISIONS) * tEnd })}
      />
      <span className="time-readout">t = {fmt(t)} / {fmt(tEnd)} s</span>
      <span className="hint">拖动时间轴只改变观察时刻，不修改初始条件</span>
      {!!solution?.stages.length && (
        <div className="timeline-stages" role="region" aria-label="运动阶段" tabIndex={0}>
          {solution.stages.map((s) => (
            <span key={s.label + s.t0} className="badge" title={s.note}>{s.label} [{fmt(s.t0)}, {fmt(s.t1)}]s</span>
          ))}
        </div>
      )}
    </div>
  );
}
