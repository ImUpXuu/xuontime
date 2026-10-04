import React from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./admin/AdminApp.jsx";
import "./index.css";

// 渲染错误兜底：出问题显示错误信息，而不是整页白屏
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, fontFamily: "system-ui, sans-serif", color: "#94a3b8" }}>
          <p style={{ color: "#ef4444", fontWeight: 600 }}>页面出错了</p>
          <pre style={{ maxWidth: "80vw", whiteSpace: "pre-wrap", fontSize: 12, color: "#94a3b8" }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button onClick={() => location.reload()} style={{ padding: "6px 16px", borderRadius: 8, border: "1px solid #d4d4d8", background: "transparent", color: "#52525b", cursor: "pointer" }}>刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <AdminApp />
  </ErrorBoundary>,
);
