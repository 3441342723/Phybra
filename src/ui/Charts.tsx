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
    chart.current.setOption(
      {
        animation: false,
        grid: { left: 56, right: 16, top: 32, bottom: 28 },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', name: 't/s', min: 0, max: solution.tEnd },
        yAxis: { type: 'value', scale: true },
        series: (mode === 'pos' ? posSeries : velSeries).map((s) => ({
          ...s,
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 2 },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { formatter: `t=${t.toFixed(2)}s`, position: 'insideEndTop' },
            lineStyle: { color: '#d97706', type: 'dashed' },
            data: [{ xAxis: t }],
          },
        })),
      },
      { notMerge: true },
    );
  }, [solution, mode, t]);

  return (
    <div className="charts">
      <div className="charts-tabs">
        <button className={mode === 'pos' ? 'active' : ''} onClick={() => setMode('pos')}>位置–时间</button>
        <button className={mode === 'vel' ? 'active' : ''} onClick={() => setMode('vel')}>速度–时间</button>
        <span className="hint">{solution ? '曲线与动画、推导共用同一次求解采样' : '条件完整后显示曲线'}</span>
      </div>
      <div className="chart-body" ref={ref} />
    </div>
  );
}
