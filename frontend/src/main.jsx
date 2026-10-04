import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// 主题：localStorage 优先，其次跟随系统
const themeKey = "xuontime_theme";
(function initTheme() {
  let dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved) dark = saved === "dark";
  } catch { /* ignore */ }
  document.documentElement.classList.toggle("dark", dark);
})();

createRoot(document.getElementById("root")).render(<App />);
export { themeKey };
