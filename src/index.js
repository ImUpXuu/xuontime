// Worker 入口：fetch → /status/* 回退到状态页应用 + API 路由；scheduled（每分钟 cron）→ 检测调度
import { route } from "./routes.js";
import { runTick } from "./tick.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // /status/<slug> 没有对应静态文件，回退到状态页 React 应用（App 按 pathname 取数）。
    // 注意不能 fetch /index.html：assets 的 html_handling 会把它 301 到 /，
    // 导致所有状态页都跳回根页面；"/" 本身就是 index.html 的规范路径，200 直出。
    if (url.pathname === "/status" || url.pathname.startsWith("/status/")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return route(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};
