// 本地服务器：静态文件 + 数据目录(zip/文件夹) + kayicloud 下载代理 + 导出打包
// 零第三方依赖。仅监听 127.0.0.1。
// 用法: node server.mjs [端口] （默认 8123，自动向后寻找空闲端口）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = path.join(ROOT, "data");
const UNZIP_DIR = path.join(DATA_DIR, "_unzipped");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".dcm": "application/dicom", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function send(res, code, body, headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(code, { "Content-Length": buf.length, ...headers });
  res.end(buf);
}
function sendJson(res, obj) { send(res, 200, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" }); }

// ---------- zip 中央目录解析（只读 listing，按需解压单文件） ----------
function zipListRaw(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(66000, size);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { fs.closeSync(fd); throw new Error("无效的zip(无EOCD)"); }
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOfs = tail.readUInt32LE(eocd + 16);
  if (cdOfs === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) if (tail.readUInt32LE(i) === 0x07064b50) {
      cdSize = Number(tail.readBigUInt64LE(i + 4)); cdOfs = Number(tail.readBigUInt64LE(i + 8)); break;
    }
  }
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cd.length, cdOfs);
  fs.closeSync(fd);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && entries.length < count) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const lho = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    if (csize === 0xffffffff || usize === 0xffffffff) {
      let xp = p + 46 + nameLen;
      const xend = xp + extraLen;
      while (xp + 4 <= xend) {
        const hid = cd.readUInt16LE(xp), hsz = cd.readUInt16LE(xp + 2);
        if (hid === 0x0001) {
          let op = xp + 4;
          if (usize === 0xffffffff && op + 8 <= xp + 4 + hsz) { usize = Number(cd.readBigUInt64LE(op)); op += 8; }
          if (csize === 0xffffffff && op + 8 <= xp + 4 + hsz) { csize = Number(cd.readBigUInt64LE(op)); op += 8; }
          break;
        }
        xp += 4 + hsz;
      }
    }
    entries.push({ name, method, usize, csize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipExtract(zipPath, entry) {
  const fd = fs.openSync(zipPath, "r");
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, entry.lho);
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const dataOfs = entry.lho + 30 + nameLen + extraLen;
  fs.closeSync(fd);
  const comp = Buffer.alloc(entry.csize);
  const fd2 = fs.openSync(zipPath, "r");
  fs.readSync(fd2, comp, 0, entry.csize, dataOfs);
  fs.closeSync(fd2);
  if (entry.method === 0) return comp;
  return zlib.inflateRawSync(comp);
}

// ---------- 数据包发现 ----------
function listDataPackages() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = [];
  for (const name of fs.readdirSync(DATA_DIR)) {
    const full = path.join(DATA_DIR, name);
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (fs.existsSync(path.join(full, "study.json"))) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(full, "study.json"), "utf8"));
          out.push({ kind: "folder", name, meta });
        } catch { /* 忽略坏json */ }
      }
    } else if (/\.zip$/i.test(name)) {
      out.push({ kind: "zip", name, size: st.size });
    }
  }
  return out;
}

// ---------- kayicloud 下载任务（复用 tools/download-core.mjs） ----------
import { downloadStudyToDisk, fetchShareInfo } from "../tools/download-core.mjs";
const downloadJobs = new Map(); // id -> {stage, cur, total, msg, done, error, result}
let jobSeq = 1;

// ---------- 请求路由 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => { b += c; if (b.length > 5 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = decodeURIComponent(u.pathname);

  try {
    // API: 数据包列表
    if (p === "/api/studies") return sendJson(res, { ok: true, packages: listDataPackages() });

    // API: 分享信息预览（输密码后展示研究概要）
    if (p === "/api/shareInfo") {
      const body = JSON.parse(await readBody(req));
      try {
        const info = await fetchShareInfo(body.shareId, body.password);
        sendJson(res, { ok: true, ...info });
      } catch (e) { sendJson(res, { ok: false, error: e.message }); }
      return;
    }

    // API: 启动下载任务
    if (p === "/api/downloadStudy") {
      const body = JSON.parse(await readBody(req));
      if (!/^[0-9a-f-]{36}$/i.test(body.shareId || "") || !/^\d{4}$/.test(body.password || ""))
        return sendJson(res, { ok: false, error: "参数不合法" });
      let name = (body.name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
      if (!name) {
        try {
          const info = await fetchShareInfo(body.shareId, body.password);
          name = `${info.patientName || "study"}_${info.patientId || ""}_${info.modality || ""}`.replace(/\s+/g, "_");
        } catch { name = "study_" + Date.now(); }
      }
      const jobId = String(jobSeq++);
      const job = { stage: "start", cur: 0, total: 1, msg: "开始...", done: false, error: null, result: null };
      downloadJobs.set(jobId, job);
      downloadStudyToDisk(DATA_DIR, body.shareId, body.password, name, (stage, cur, total, msg) => {
        job.stage = stage; job.cur = cur; job.total = total; job.msg = msg;
      }).then(r => { job.done = true; job.result = { ...r, name }; })
        .catch(e => { job.done = true; job.error = e.message; });
      return sendJson(res, { ok: true, jobId, name });
    }
    if (p === "/api/downloadStatus") {
      const job = downloadJobs.get(u.searchParams.get("jobId"));
      if (!job) return sendJson(res, { ok: false, error: "任务不存在" });
      return sendJson(res, { ok: true, ...job });
    }

    // API: 把数据文件夹打成 zip 下载
    if (p === "/api/exportZip") {
      const name = u.searchParams.get("name") || "";
      if (!/^[^\\/]+$/.test(name) || name.includes("..")) return send(res, 400, "bad name");
      const zipPath = path.join(DATA_DIR, name + ".zip");
      if (!fs.existsSync(zipPath)) {
        const dir = path.join(DATA_DIR, name);
        if (!fs.existsSync(path.join(dir, "study.json"))) return send(res, 404, "study not found");
        const { ZipWriter } = await import("../tools/ziplib.mjs");
        const zw = new ZipWriter(zipPath);
        // 遍历目录
        const walk = (d, rel) => {
          for (const f of fs.readdirSync(d)) {
            const fp = path.join(d, f);
            if (fs.statSync(fp).isDirectory()) walk(fp, rel ? rel + "/" + f : f);
            else zw.addFile(rel ? rel + "/" + f : f, fp);
          }
        };
        walk(dir, "");
        zw.close();
      }
      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}.zip"`,
      });
      fs.createReadStream(zipPath).pipe(res);
      return;
    }

    // API: 解压服务端 zip 到 _unzipped（幂等）
    if (p === "/api/unzip") {
      const name = u.searchParams.get("name") || "";
      if (!/^[^\\/]+\.zip$/i.test(name) || name.includes("..")) return send(res, 400, "bad name");
      const zipPath = path.join(DATA_DIR, name);
      if (!fs.existsSync(zipPath)) return send(res, 404, "zip not found");
      const target = path.join(UNZIP_DIR, name.replace(/\.zip$/i, ""));
      if (!fs.existsSync(path.join(target, "study.json"))) {
        fs.mkdirSync(target, { recursive: true });
        const entries = zipListRaw(zipPath);
        let n = 0;
        for (const e of entries) {
          if (e.name.endsWith("/")) continue;
          const dest = path.join(target, e.name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, zipExtract(zipPath, e));
          if (++n % 500 === 0) console.log("  解压中:", n);
        }
        console.log("已解压", name, "->", target, `(${n}个文件)`);
      }
      return sendJson(res, { ok: true, name: path.basename(target) });
    }

    // 静态文件（app 目录）与数据文件（data 目录）
    let base = APP_DIR, rel = p === "/" ? "/index.html" : p;
    if (p.startsWith("/data/")) { base = DATA_DIR; rel = p.slice("/data".length); }
    const full = path.join(base, rel);
    if (!path.resolve(full).startsWith(path.resolve(base))) return send(res, 403, "forbidden");
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      const stat = fs.statSync(full);
      // Range 支持（大 dcm 文件分段读取场景）
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = parseInt(m[1]);
        const end = m[2] ? parseInt(m[2]) : stat.size - 1;
        const buf = Buffer.alloc(end - start + 1);
        const fd = fs.openSync(full, "r");
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes", "Content-Length": buf.length,
          "Content-Type": MIME[ext] || "application/octet-stream",
        });
        return res.end(buf);
      }
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Accept-Ranges": "bytes", "Cache-Control": "no-store",
      });
      fs.createReadStream(full).pipe(res);
      return;
    }
    send(res, 404, "not found: " + p);
  } catch (e) {
    console.error("ERR", p, e.message);
    send(res, 500, "server error: " + e.message);
  }
});

// 找空闲端口启动
function tryListen(port, attempts = 20) {
  server.once("error", e => {
    if ((e.code === "EADDRINUSE" || e.code === "EACCES") && attempts > 0) tryListen(port + 1, attempts - 1);
    else { console.error("端口占用且重试失败:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log("==============================================");
    console.log("  医学影像本地查看器已启动");
    console.log("  地址: " + url);
    console.log("  数据目录: " + DATA_DIR);
    console.log("  按 Ctrl+C 停止");
    console.log("==============================================");
    // Windows 下自动打开浏览器
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", url], () => {});
    }
  });
}
tryListen(Number(process.argv[2]) || 8230);
