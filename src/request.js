/**
 * 按实际 UTF-8 字节限制请求体，再解析 JSON，供所有 JSON 接口共用。
 * 返回 { body } 或 { response }，调用方收到 response 时直接结束请求。
 */
export async function readJson(request, limit) {
  // 非数字、负数等无效 Content-Length 不会触发提前拒绝，实际流读取仍是最终限制。
  if (Number(request.headers.get('content-length')) > limit) {
    return { response: Response.json({ error: { code: 'payload_too_large' } }, { status: 413 }) };
  }
  // Content-Length 只能用于提前拒绝；缺失或不准确时仍逐块检查实际大小。
  // 不校验 Content-Type；空正文最终也会进入 JSON 解析并返回 invalid_json。
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return { response: Response.json({ error: { code: 'payload_too_large' } }, { status: 413 }) };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  // 合并后统一解码，避免多字节字符跨分块时被截断。
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { response: Response.json({ error: { code: 'invalid_json' } }, { status: 400 }) };
  }
}
