const CACHE = "walker-models-v1";

export type Progress = (file: string, got: number, total: number) => void;

export async function fetchCached(url: string, onProgress?: Progress): Promise<Uint8Array> {
  const name = url.split("/").pop()!;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) {
    const buf = new Uint8Array(await hit.arrayBuffer());
    onProgress?.(name, buf.length, buf.length);
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} fetching ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(name, got, total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  try { await cache.put(url, new Response(bytes)); } catch (e) { console.warn("model cache write failed", e); }
  return bytes;
}
