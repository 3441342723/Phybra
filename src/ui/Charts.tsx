import * as echarts from 'echarts';
import { useEffect, useRef, useState } from 'react';
import type { Solution } from '../model/types';
import { fmt, fmtWith } from '../model/units';

type Mode = 'pos' | 'vel' | 'accel' | 'energy';

const ENERGY_METRICS = [
  { key: 'kinetic', name: '动能', color: '#2563eb' },
  { key: 'potential', name: '重力势能', color: '#047857' },
  { key: 'mechanical', name: '机械能', color: '#7c3aed' },
  { key: 'dissipated', name: '摩擦耗散', color: '#b45309' },
] as const;

export function Charts({ solution, t }: { solution: Solution | null; t: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [mode, setMode] = useState<Mode>('pos');
  const hasAcceleration = solution?.samples.some(s=>s.ax!==undefined&&s.ay!==undefined) ?? false;
  const chartMode = mode==='accel'&&!hasAcceleration?'pos':mode;
  const energy = solution?.energy;
  const message = !solution ? '条件完整后显示曲线' : mode !== 'energy' ? null
    : !energy ? '当前题型暂不支持能量分析。'
      : energy.status === 'mass_required' ? energy.note : null;
  const currentTime = solution ? Math.min(t, solution.tEnd) : 0;

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    if (!solution || message) {
      chart.current.clear();
      return;
    }
    const samples = solution.samples;
    const isEnergy = chartMode === 'energy';
    const twoD = solution.template === 'projectile' || solution.template === 'composition' || solution.template === 'circular' || solution.template === 'field';
    const posSeries = twoD
      ? [
          { name: 'x (m)', data: samples.map((s) => [s.t, s.x]) },
          { name: 'y (m)', data: samples.map((s) => [s.t, s.y]) },
        ]
      : [{ name: solution.template === 'incline-friction' ? '沿面位置 s (m)' : '位置 x (m)', data: samples.map((s) => [s.t, solution.template === 'incline-friction' ? s.s : s.x]) }];
    const velSeries = twoD
      ? [
          { name: 'vx (m/s)', data: samples.map((s) => [s.t, s.vx]) },
          { name: 'vy (m/s)', data: samples.map((s) => [s.t, s.vy]) },
          { name: '|v| (m/s)', data: samples.map((s) => [s.t, Math.hypot(s.vx, s.vy)]) },
        ]
      : solution.template === 'incline-friction'
        ? [{ name: '沿面速度 u (m/s)', data: samples.map((s) => [s.t, s.u ?? 0]) }]
        : [{ name: '速度 v (m/s)', data: samples.map((s) => [s.t, s.vx]) }];
    const curves: { name: string; data: (number | null)[][]; color?: string }[] = isEnergy && energy?.status === 'ready'
      ? ENERGY_METRICS.filter(({ key }) => energy.samples.some((s) => s[key] !== null)).map(({ key, name, color }) => ({
          name: key==='dissipated'&&solution.template==='collision'?'碰撞耗散':key==='kinetic'&&solution.template==='collision'?'系统总动能':key === 'potential' && solution.template === 'field' ? '势能' : name, color, data: energy.samples.map((s) => [s.t, s[key]]),
        }))
      : chartMode === 'accel' ? [
          {name:'ax (m/s²)',data:samples.map(s=>[s.t,s.ax??null])},
          {name:'ay (m/s²)',data:samples.map(s=>[s.t,s.ay??null])},
        ] : solution.bodyTracks ? solution.bodyTracks.flatMap(track=>chartMode==='pos'?[
          {name:track.name+' · x (m)',data:track.samples.map(s=>[s.t,s.x])},
          {name:track.name+' · y (m)',data:track.samples.map(s=>[s.t,s.y])},
        ]:[
          {name:track.name+' · vx (m/s)',data:track.samples.map(s=>[s.t,s.vx])},
          {name:track.name+' · vy (m/s)',data:track.samples.map(s=>[s.t,s.vy])},
        ]) : chartMode === 'pos' ? posSeries : velSeries;
    const tickLabels = { hideOverlap: true, formatter: (value: number) => fmt(value, 4) };
    chart.current.setOption(
      {
        animation: false,
        grid: { left: 8, right: 14, top: 25, bottom: 22, containLabel: true },
        legend: { type: 'scroll', data: curves.map((s) => s.name), left: 5, right: 5, top: 0, textStyle: { fontSize: 11 } },
        tooltip: {
          trigger: 'axis', confine: true,
          valueFormatter: isEnergy ? (value: unknown) => typeof value === 'number' ? fmtWith(value, 'J') : '—' : undefined,
        },
        xAxis: { type: 'value', name: 't / s', nameLocation: 'middle', nameGap: 24, min: 0, max: solution.tEnd || 1, axisLabel: tickLabels },
        yAxis: { type: 'value', name: isEnergy ? 'J' : undefined, nameGap: 3, scale: true, axisLabel: tickLabels },
        series: [
          ...curves.map((s) => ({
            name: s.name,
            data: s.data,
            type: 'line' as const,
            showSymbol: samples.length === 1,
            lineStyle: { width: 2, color: s.color },
            itemStyle: s.color ? { color: s.color } : undefined,
            encode: isEnergy ? { x: 0, y: 1, tooltip: [1] } : undefined,
          })),
          ...(solution.tEnd > 0 ? [{
            id: 'chart-playhead',
            type: 'line' as const,
            data: [],
            silent: true,
            markLine: {
              silent: true,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: '#d97706', type: 'dashed' as const },
              data: [],
            },
          }] : []),
        ],
      },
      { notMerge: true },
    );
  }, [solution, chartMode, energy, message]);

  useEffect(() => {
    if (!message && solution && solution.tEnd > 0) {
      chart.current?.setOption({ series: [{ id: 'chart-playhead', markLine: { data: [{ xAxis: currentTime }] } }] });
    }
  }, [solution, chartMode, message, currentTime]);

  return (
    <div className="charts">
      <div className="charts-tabs">
        <button className={chartMode === 'pos' ? 'active' : ''} aria-pressed={chartMode === 'pos'} onClick={() => setMode('pos')}>位置–时间</button>
        <button className={mode === 'vel' ? 'active' : ''} aria-pressed={mode === 'vel'} onClick={() => setMode('vel')}>速度–时间</button>
        {hasAcceleration && <button className={mode==='accel'?'active':''} aria-pressed={mode==='accel'} onClick={()=>setMode('accel')}>加速度–时间</button>}
        <button className={mode === 'energy' ? 'active' : ''} aria-pressed={mode === 'energy'} onClick={() => setMode('energy')}>能量–时间</button>
        {!message && <span className="chart-time">t = {fmt(currentTime, 4)} s</span>}
      </div>
      {message && <p className="hint chart-energy-note" role="status">{message}</p>}
      {mode === 'energy' && energy?.status === 'ready' && energy.note && (
        <p className="hint chart-energy-note">{energy.note}</p>
      )}
      <div className="chart-body" ref={ref} aria-label={mode === 'energy' ? '能量与时间曲线（J）' : undefined} />
    </div>
  );
}
