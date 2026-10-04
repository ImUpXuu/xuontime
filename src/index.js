// Worker 入口：fetch → API 路由；scheduled（每分钟 cron）→ 检测调度
import { route } from "./routes.js";
import { runTick } from "./tick.js";

export default {
  async fetch(request, env, ctx) {
    return route(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};
