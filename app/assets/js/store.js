// 数据层：统一的数据包发现与读取
// 来源: 服务器文件夹 / 服务器zip(解压后) / 本地zip(fflate) / 本地文件夹 / Android桥
(function () {
  "use strict";

  const IS_SERVER = location.protocol === "http:" || location.protocol === "https:";
  const hasBridge = () => typeof window.AndroidBridge !== "undefined";

  // 发现可用数据包
  async function discoverPackages() {
    const out = [];
    if (IS_SERVER) {
      try {
        const r = await fetch("/api/studies");
        const j = await r.json();
        for (const p of j.packages || []) {
          out.push({ kind: p.kind === "zip" ? "server-zip" : "server-folder", name: p.name, meta: p.meta || null, size: p.size });
        }
      } catch (e) { console.warn("列表获取失败", e); }
    }
    if (hasBridge()) {
      try {
        const list = JSON.parse(await window.AndroidBridge.listDataPackages());
        for (const p of list) out.push(p); // {kind:'bridge-folder'|'bridge-zip', name, meta?}
      } catch (e) { console.warn("桥列表获取失败", e); }
    }
    return out;
  }

  // 打开数据包 → StudyHandle
  async function openPackage(pkg) {
    if (pkg.kind === "server-zip") {
      // 让服务器解压到 _unzipped（幂等），然后按文件夹读
      const r = await fetch("/api/unzip?name=" + encodeURIComponent(pkg.name));
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "解压失败");
      return openServerFolder(j.name);
    }
    if (pkg.kind === "server-folder") return openServerFolder(pkg.name);
    if (pkg.kind === "local-zip") return openLocalZip(pkg.file);
    if (pkg.kind === "local-folder") return openLocalFolder(pkg.files);
    if (pkg.kind === "bridge-zip") {
      // 原生解压到数据目录后按文件夹打开
      const folderName = await window.AndroidBridge.prepareZip(pkg.name);
      if (!folderName) throw new Error("解压失败");
      return openBridgeFolder({ kind: "bridge-folder", name: folderName });
    }
    if (pkg.kind === "bridge-folder" || pkg.kind === "bridge") return openBridgeFolder(pkg);
    throw new Error("未知数据包类型: " + pkg.kind);
  }

  async function openServerFolder(name) {
    const r = await fetch(`/data/${encodeURIComponent(name)}/study.json`);
    if (!r.ok) throw new Error("study.json 读取失败: " + r.status);
    const meta = await r.json();
    return {
      kind: "server-folder", name, meta,
      fileUrl: (p) => `/data/${encodeURIComponent(name)}/${p}`,
      async readFile(p) {
        const rr = await fetch(`/data/${encodeURIComponent(name)}/${p}`);
        if (!rr.ok) throw new Error("读取失败 " + p);
        return rr.arrayBuffer();
      },
      close() {},
    };
  }

  // 本地 zip → 内存解压
  async function openLocalZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const unzipped = fflate.unzipSync(buf);
    // 找 study.json（可能位于顶层目录下）
    let prefix = "";
    let sjName = Object.keys(unzipped).find(n => n === "study.json" || n.endsWith("/study.json"));
    if (sjName && sjName !== "study.json") prefix = sjName.slice(0, -"study.json".length);
    if (!sjName) throw new Error("zip 中未找到 study.json");
    const meta = JSON.parse(new TextDecoder().decode(unzipped[sjName]));
    return {
      kind: "local-zip", name: file.name.replace(/\.zip$/i, ""), meta, _entries: unzipped, _prefix: prefix,
      async readFile(p) {
        const e = this._entries[this._prefix + p];
        if (!e) throw new Error("zip 中未找到: " + p);
        return e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
      },
      close() { this._entries = null; },
    };
  }

  // 本地文件夹（webkitdirectory File 列表）
  async function openLocalFolder(files) {
    const map = {};
    let sj = null;
    for (const f of files) {
      const rel = f.webkitRelativePath.replace(/^[^/]+\//, "");
      map[rel] = f;
      if (rel === "study.json") sj = f;
    }
    if (!sj) throw new Error("所选文件夹中没有 study.json");
    const meta = JSON.parse(await sj.text());
    return {
      kind: "local-folder", name: "本地文件夹", meta, _map: map,
      async readFile(p) { const f = this._map[p]; if (!f) throw new Error("缺少文件: " + p); return f.arrayBuffer(); },
      close() { this._map = null; },
    };
  }

  // Android 桥：base64 读取（appfile:// fetch 在部分 WebView 被禁，统一走桥）
  async function openBridgeFolder(pkg) {
    let meta;
    if (pkg.meta) meta = typeof pkg.meta === "string" ? JSON.parse(pkg.meta) : pkg.meta;
    else {
      const b64 = await window.AndroidBridge.readFile(pkg.name, "study.json");
      meta = JSON.parse(new TextDecoder().decode(b64ToBytes(b64)));
    }
    return {
      kind: "bridge", name: pkg.name, meta,
      async readFile(p) {
        const b64 = await window.AndroidBridge.readFile(pkg.name, p);
        if (!b64) throw new Error("读取失败 " + p);
        return b64ToBytes(b64).buffer;
      },
      close() { },
    };
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // 生成显示名
  function displayName(pkg) {
    if (pkg.meta) {
      const m = pkg.meta;
      return `${m.patient?.name || "?"} ${m.patient?.id || ""} ${m.study?.modality || ""}`.trim();
    }
    return pkg.name;
  }

  window.KStore = { discoverPackages, openPackage, openServerFolder, displayName, IS_SERVER, hasBridge };
})();
