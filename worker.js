/* AURA クラウド保存：素材・プロジェクトを Cloudflare R2 に置いて、誰が開いても同じものが見えるようにする */
const OK_KEY=/^(lib|media|proj)\/[A-Za-z0-9_\-.]{1,80}$/;
const MAX=95*1024*1024; // 無料プランの1回のアップロード上限(100MB)より少し小さく
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.BUCKET) return json({ error: "R2のバケットがつながっていません" }, 503);
    try { return await api(req, env, url); }
    catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  }
};

async function api(req, env, url) {
  const p = url.pathname;
  if (p === "/api/ping") return json({ ok: true });

  if (p === "/api/list" && req.method === "GET") {
    const prefix = url.searchParams.get("prefix") || "";
    if (!/^(lib|media|proj)\/$/.test(prefix)) return json({ error: "bad prefix" }, 400);
    const out = []; let cursor;
    do {
      const r = await env.BUCKET.list({ prefix, cursor, limit: 1000, include: ["customMetadata", "httpMetadata"] });
      for (const o of r.objects) out.push({ key: o.key, size: o.size, up: o.uploaded, meta: o.customMetadata || {}, type: (o.httpMetadata || {}).contentType || "" });
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor && out.length < 20000);
    return json(out);
  }

  if (p.startsWith("/api/o/")) {
    const key = decodeURIComponent(p.slice(7));
    if (!OK_KEY.test(key)) return json({ error: "bad key" }, 400);

    if (req.method === "GET" || req.method === "HEAD") {
      const obj = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
      if (!obj) return json({ error: "not found" }, 404);
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("etag", obj.httpEtag);
      h.set("accept-ranges", "bytes");
      h.set("cache-control", key.startsWith("proj/") ? "no-store" : "public, max-age=31536000, immutable");
      if (!("body" in obj)) return new Response(null, { status: 304, headers: h });
      let status = 200;
      if (obj.range && req.headers.get("range")) {
        const r = obj.range, off = r.offset ?? (r.suffix != null ? obj.size - r.suffix : 0), len = r.length ?? (obj.size - off);
        h.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`); h.set("content-length", String(len)); status = 206;
      }
      return new Response(req.method === "HEAD" ? null : obj.body, { status, headers: h });
    }

    if (req.method === "PUT") {
      const len = +(req.headers.get("content-length") || 0);
      if (len > MAX) return json({ error: "too large" }, 413);
      let meta = {};
      try { meta = JSON.parse(decodeURIComponent(req.headers.get("x-meta") || "%7B%7D")); } catch (e) {}
      const cm = {};
      for (const [k, v] of Object.entries(meta)) if (typeof v === "string" || typeof v === "number") cm[String(k).slice(0, 20)] = String(v).slice(0, 300);
      const ct = key.startsWith("proj/") ? "application/json" : (req.headers.get("content-type") || "application/octet-stream");
      await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: ct }, customMetadata: cm });
      return json({ ok: true, key });
    }

    if (req.method === "DELETE") { await env.BUCKET.delete(key); return json({ ok: true }); }
  }
  return json({ error: "not found" }, 404);
}
