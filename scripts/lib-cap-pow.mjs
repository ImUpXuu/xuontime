// Cap standalone PoW 求解器（Windows Node 可用版）：
// 复刻 @cap.js/solver 的 prng 派生 + pow 逻辑，用 node:crypto + worker_threads 替代 blob worker + wasm。
// 算法：challenge token 作种子 → 第 i 题 salt = prng(token+i, s)，target = prng(token+i+"d", d)；
//      找 nonce 使 sha256(salt + nonce) 的 hex 以 target 开头；redeem { token, solutions: nonces }。
import { Worker } from "node:worker_threads";
import os from "node:os";

function prng(seed, length) {
  function fnv1a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
  let state = fnv1a(seed);
  let result = "";
  function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  while (result.length < length) {
    result += next().toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

const WORKER_SRC = `
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const { salt, target } = workerData;
let n = 0;
for (;;) {
  const h = crypto.createHash("sha256").update(salt + n).digest("hex");
  if (h.startsWith(target)) { parentPort.postMessage(n); break; }
  n++;
}
`;

export async function solveChallenge(token, { c, s, d }) {
  const tasks = Array.from({ length: c }, (_, i) => [
    prng(`${token}${i + 1}`, s),
    prng(`${token}${i + 1}d`, d),
  ]);
  const maxWorkers = Math.min(c, os.cpus().length);
  return new Promise((resolve, reject) => {
    const results = new Array(c);
    let next = 0;
    let active = 0;
    const start = () => {
      while (next < c && active < maxWorkers) {
        const idx = next++;
        const w = new Worker(WORKER_SRC, {
          eval: true,
          workerData: { salt: tasks[idx][0], target: tasks[idx][1] },
        });
        active++;
        w.on("message", (nonce) => {
          results[idx] = nonce;
          w.terminate();
          active--;
          if (next < c) start();
          else if (active === 0) resolve(results);
        });
        w.on("error", reject);
      }
    };
    start();
  });
}
