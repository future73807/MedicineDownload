// 刷新本地 study.json：从上游 API 补充序列级 SeriesTime / SeriesNumber 等
// 用法: node tools/refresh-meta.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const IS = "https://www.kayicloud.com:11136/";
const UA = "Mozilla/5.0";
const b64 = s => Buffer.from(s, "utf8").toString("base64");

// 研究清单从 data/studies.local.json 读取（不入库，避免隐私泄露）
const SOURCES = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "studies.local.json"), "utf8"))
      .map(s => [s.name, s.shareId, s.password]);
  } catch (e) {
    console.error("未找到 data/studies.local.json，请创建（勿提交到 git）");
    process.exit(1);
  }
})();

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`code=${j.code} ${j.message}`);
  return j;
}

for (const [name, shareId, password] of SOURCES) {
  const sj = path.join(DATA_DIR, name, "study.json");
  if (!fs.existsSync(sj)) { console.log("skip", name); continue; }
  try {
    const meta = JSON.parse(fs.readFileSync(sj, "utf8"));
    const share = await getJson(`${IS}imageserver/StudyData/GetShareInfo?shareId=${shareId}&password=${password}`);
    const d = share.data;
    const qs = new URLSearchParams({
      dataids: "", studyKeys: "", cloudImage: "1", dataSource: d.ds,
      signature: d.serverSignature, vendorCode: d.vendorCode, seriesKeys: "",
      isAnony: "false", getImageInfo: "false", token: "",
      serverAddr: b64(d.serverAddr), expires: String(d.expires),
    });
    const raw = (await getJson(`${IS}imageserver/StudyData/GetStudies?${qs}`)).data[0];
    let patched = 0;
    for (const serOut of meta.series) {
      const remote = raw.SeriesList.find(s =>
        String(s.SeriesNumber ?? s.Index) === String(serOut.seriesNumber));
      if (!remote) continue;
      if (remote.SeriesTime && serOut.time !== remote.SeriesTime) { serOut.time = remote.SeriesTime; patched++; }
      if (!serOut.thickness && remote.SliceThickness) serOut.thickness = remote.SliceThickness;
      if (!serOut.ww && remote.WW) serOut.ww = remote.WW;
      if (!serOut.wl && remote.WL) serOut.wl = remote.WL;
    }
    fs.writeFileSync(sj, JSON.stringify(meta, null, 1), "utf8");
    console.log(`✔ ${name}: 补充 ${patched} 个序列时间`);
  } catch (e) {
    console.error(`✗ ${name}:`, e.message);
  }
}
