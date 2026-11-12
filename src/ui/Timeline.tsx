import type { Solution } from '../model/types';
import { fmt } from '../model/units';
import type { Action, Store } from '../state/store';

export function Timeline({ store, dispatch, solution }: { store: Store; dispatch: (a: Action) => void; solution: Solution | null }) {
  const tEnd = solution?.tEnd ?? 0;
  const t = Math.min(store.playback.t, tEnd);
  const playing = store.playback.mode === 'playing';
  return (
    <div className="timeline">
      <button
        className="primary"
        disabled={!solution}
        onClick={() => {
          if (playing) dispatch({ type: 'pause' });
          else {
            if (t >= tEnd) dispatch({ type: 'scrub', t: 0 });
            dispatch({ type: 'play' });
          }
        }}
      >
        {playing ? '暂停' : t > 0 && t < tEnd ? '继续' : '播放'}
      </button>
      <button disabled={!solution} onClick={() => dispatch({ type: 'resetPlayback' })} title="回到初始时刻，不改变已确认的初始条件">重置</button>
      <input
        type="range"
        className="time-slider"
        min={0}
        max={tEnd || 1}
        step={(tEnd || 1) / 600}
        value={t}
        disabled={!solution}
        onChange={(e) => dispatch({ type: 'scrub', t: Number(e.target.value) })}
      />
      <span className="time-readout">t = {fmt(t)} / {fmt(tEnd)} s</span>
      <span className="hint">拖动时间轴只改变观察时刻，不修改初始条件</span>
      {solution?.stages.map((s) => (
        <span key={s.label + s.t0} className="badge" title={s.note}>{s.label} [{fmt(s.t0)}, {fmt(s.t1)}]s</span>
      ))}
    </div>
  );
}
