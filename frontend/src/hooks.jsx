import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// 全局滴答：相对时间自动刷新
export function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("xuontime_theme", next ? "dark" : "light"); } catch { /* ignore */ }
  };
  return { dark, toggle };
}

// 浮动提示：跟随鼠标的全局定位卡片
export function useFloatTip() {
  const [tip, setTip] = useState(null); // { x, y, node }
  const show = (node) => (e) => {
    setTip({ x: e.clientX, y: e.clientY, node });
  };
  const move = (e) => {
    setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
  };
  const hide = () => setTip(null);
  return { tip, show, move, hide };
}

export function FloatTip({ tip }) {
  if (!tip) return null;
  // 必须 portal 到 body：任何祖先带 transform 都会让 fixed 相对该祖先定位（悬浮卡乱飘的根因）
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-zinc-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
      style={{
        left: Math.min(tip.x, window.innerWidth - 150),
        top: tip.y,
        transform: "translate(-50%, calc(-100% - 12px))",
      }}
    >
      {tip.node}
    </div>,
    document.body,
  );
}
