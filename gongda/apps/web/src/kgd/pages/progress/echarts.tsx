import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export function EChart({ option, className, style, theme = 'light' }: { option: echarts.EChartsCoreOption; className?: string; style?: CSSProperties; theme?: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.EChartsType | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (!chartRef.current) chartRef.current = echarts.init(ref.current, theme === 'dark' ? 'dark' : undefined);
    chartRef.current.setOption(option, true);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
    ro?.observe(ref.current);
    // 初次挂载时容器可能尚未完成布局，下一帧再 resize 一次避免空白饼图。
    requestAnimationFrame(() => chartRef.current?.resize());
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [option, theme]);
  useEffect(() => () => { chartRef.current?.dispose(); chartRef.current = null; }, []);
  return <div ref={ref} className={className} style={{ minHeight: 200, ...style }} />;
}
