import * as echarts from 'echarts';
import { useEffect, useRef, useState } from 'react';
import type { Solution } from '../model/types';

type Mode = 'pos' | 'vel';

export function Charts({ solution, t }: { solution: Solution | null; t: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [mode, setMode] = useState<Mode>('pos');

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
    if (!solution) {
      chart.current.clear();
      return;
    }
    const samples = solution.samples;
    const currentTime = Math.min(t, solution.tEnd);
    const posSeries = solution.template === 'projectile'
      ? [
          { name: 'x (m)', data: samples.map((s) => [s.t, s.x]) },
          { name: 'y (m)', data: samples.map((s) => [s.t, s.y]) },
        ]
      : [{ name: solution.template === 'incline-friction' ? '沿面位置 s (m)' : '位置 x (m)', data: samples.map((s) => [s.t, solution.template === 'incline-friction' ? s.s : s.x]) }];
    const velSeries = solution.template === 'projectile'
      ? [
          { name: 'vx (m/s)', data: samples.map((s) => [s.t, s.vx]) },
          { name: 'vy (m/s)', data: samples.map((s) => [s.t, s.vy]) },
          { name: '|v| (m/s)', data: samples.map((s) => [s.t, Math.hypot(s.vx, s.vy)]) },
        ]
      : solution.template === 'incline-friction'
        ? [{ name: '沿面速度 u (m/s)', data: samples.map((s) => [s.t, s.u ?? 0]) }]
        : [{ name: '速度 v (m/s)', data: samples.map((s) => [s.t, s.vx]) }];
    const curves = mode === 'pos' ? posSeries : velSeries;
    chart.current.setOption(
      {
        animation: false,
        grid: { left: 8, right: 14, top: 25, bottom: 22, containLabel: true },
        legend: { type: 'scroll', data: curves.map((s) => s.name), left: 5, right: 5, top: 0, textStyle: { fontSize: 11 } },
        tooltip: { trigger: 'axis', confine: true },
        xAxis: { type: 'value', name: 't / s', nameLocation: 'middle', nameGap: 24, min: 0, max: solution.tEnd || 1, axisLabel: { hideOverlap: true } },
        yAxis: { type: 'value', scale: true, axisLabel: { hideOverlap: true } },
        series: [
          ...curves.map((s) => ({
            ...s,
            type: 'line' as const,
            showSymbol: samples.length === 1,
            lineStyle: { width: 2 },
          })),
          ...(solution.tEnd > 0 ? [{
            type: 'line' as const,
            data: [],
            silent: true,
            markLine: {
              silent: true,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: '#d97706', type: 'dashed' as const },
              data: [{ xAxis: currentTime }],
            },
          }] : []),
        ],
      },
      { notMerge: true },
    );
  }, [solution, mode, t]);

  return (
    <div className="charts">
      <div className="charts-tabs">
        <button className={mode === 'pos' ? 'active' : ''} onClick={() => setMode('pos')}>位置–时间</button>
        <button className={mode === 'vel' ? 'active' : ''} onClick={() => setMode('vel')}>速度–时间</button>
        {solution
          ? <span className="chart-time">t = {Math.min(t, solution.tEnd).toFixed(2)} s</span>
          : <span className="hint">条件完整后显示曲线</span>}
      </div>
      <div className="chart-body" ref={ref} />
    </div>
  );
}
