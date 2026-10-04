import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent, MarkAreaComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, MarkAreaComponent, CanvasRenderer]);

// 通用 ECharts 包装：随容器自适应、随 option 更新、随主题切换重绘
export default function Echart({ option, height = 200, dark = false }) {
  const ref = useRef(null);
  const chart = useRef(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = echarts.init(el, null, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  // 主题切换时强制重建（echarts 主题在 init 时确定）
  useEffect(() => {
    const el = ref.current;
    if (!el || !chart.current) return;
    const opt = option;
    chart.current.dispose();
    const c = echarts.init(el);
    chart.current = c;
    c.setOption(opt);
  }, [dark]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} style={{ height, width: "100%" }} />;
}
