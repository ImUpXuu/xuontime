export function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function badRequest(msg) {
  return json({ error: msg }, 400);
}

export function unauthorized(msg = "未登录或会话已过期") {
  return json({ error: msg }, 401);
}

export function notFound(msg = "不存在") {
  return json({ error: msg }, 404);
}
