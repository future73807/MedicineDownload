// 下载核心模块：分享链接 → data/<name>/study.json + series/*.dcm (+ zip)
// 被 tools/download.mjs (CLI) 和 app/server.mjs (网页下载功能) 共用
import fs from "node:fs";
import path from "node:path";
import { ZipWriter } from "./ziplib.mjs";

export const IMAGE_SERVER = "https://www.kayicloud.com:11136/";
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (n, w = 5) => String(n).padStart(w, "0");

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.code !== 0) throw new Error(`API code=${j.code} ${j.message || ""}`);
      return j;
    } catch (e) {
      if (i === retries - 1) throw new Error(`${e.message} — ${url.slice(0, 120)}`);
      await sleep(1200 * (i + 1));
    }
  }
}

async function getBinary(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.status === 404) throw Object.assign(new Error("HTTP 404"), { permanent: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) throw new Error(`响应过小`);
      return buf;
    } catch (e) {
      if (i === retries - 1 || e.permanent) throw e;
      await sleep(600 * 2 ** i);
    }
  }
}

export function isDicom(buf) {
  return buf.length > 132 && buf.toString("ascii", 128, 132) === "DICM";
}

function buildGetImageUrl(IS, vendorCode, patIdB64, study, ser, img, imageIndex) {
  const q = new URLSearchParams({
    vendorCode,
    patId: patIdB64,
    expires: String(ser.Expires ?? ""),
    signature: img.Signature ?? "",
    studyuid: study.StuInsUID ?? "",
    seriesuid: ser.SeriesInsUID ?? "",
    imageUid: img.SOPInstanceUID ?? "",
    imageid: String(imageIndex),
    lossless: "1",
    iq: "100",
  });
  return `${IS}imageserver/dicomData/GetImage?imageObjKey=${encodeURIComponent(b64(img.ObjectKey))}&${q}`;
}

async function wakeSeries(IS, vendorCode, patIdB64, study, ser) {
  const img0 = ser.ImageList?.[0];
  if (!img0) return;
  const q = new URLSearchParams({
    vendorCode, ds: "rest",
    imageObjKey: b64(img0.ObjectKey),
    expires: String(ser.Expires ?? ""),
    signature: img0.Signature ?? "",
    bucketName: String(ser.BucketName ?? "null"),
    patientId: patIdB64,
    studyuid: study.StuInsUID ?? "",
    seriesuid: ser.SeriesInsUID ?? "",
    imageUid: img0.SOPInstanceUID ?? "",
    aeTitle: "undefined",
    forceDownload: "true",
    getFrames: String(ser.ImageList.length === 1),
  });
  try { await getJson(`${IS}imageserver/StudyData/GetDicomSeriesInfo?${q}`); } catch { /* 唤醒失败不阻塞 */ }
}

async function pooled(items, limit, worker) {
  let i = 0;
  const errors = [];
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx], idx); } catch (e) { errors.push({ item: idx, err: e.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return errors;
}

// 提取分享基本信息（下载前的预览）
export async function fetchShareInfo(shareId, password) {
  const share = await getJson(`${IMAGE_SERVER}imageserver/StudyData/GetShareInfo?shareId=${shareId}&password=${password}`);
  const d = share.data;
  const qs = new URLSearchParams({
    dataids: "", studyKeys: "", cloudImage: d.cloudImage ?? "1", dataSource: d.ds,
    signature: d.serverSignature, vendorCode: d.vendorCode, seriesKeys: "",
    isAnony: String(d.isAnony ?? false), getImageInfo: "false", token: "",
    serverAddr: b64(d.serverAddr), expires: String(d.expires),
  });
  const st = await getJson(`${IMAGE_SERVER}imageserver/StudyData/GetStudies?${qs}`);
  const raw = st.data[0];
  return {
    vendorCode: d.vendorCode,
    patientName: raw.PatientName, patientId: raw.PatientId, modality: raw.Modality,
    date: raw.StuDate, seriesCount: raw.SeriesCount, imageCount: raw.ImageCount,
    description: raw.StuDescription,
    series: raw.SeriesList.map(s => ({ n: s.SeriesNumber, desc: s.SeriesDescription, cnt: s.ImageList?.length ?? s.ImageCount })),
  };
}

// 完整下载：写入 dataDir/<name>/，返回统计。onProgress(stage, cur, total, msg)
export async function downloadStudyToDisk(dataDir, shareId, password, name, onProgress = () => {}) {
  const IS = IMAGE_SERVER;
  const emit = (stage, cur, total, msg) => { try { onProgress(stage, cur, total, msg); } catch { } };
  const t0 = Date.now();
  emit("start", 0, 1, "验证分享密码...");
  const share = await getJson(`${IS}imageserver/StudyData/GetShareInfo?shareId=${shareId}&password=${password}`);
  const d = share.data;
  const qs = () => new URLSearchParams({
    dataids: "", studyKeys: "", cloudImage: d.cloudImage ?? "1", dataSource: d.ds,
    signature: d.serverSignature, vendorCode: d.vendorCode, seriesKeys: "",
    isAnony: String(d.isAnony ?? false), getImageInfo: "false", token: "",
    serverAddr: b64(d.serverAddr), expires: String(d.expires),
  });
  emit("meta", 0, 1, "获取研究清单...");
  const studies = await getJson(`${IS}imageserver/StudyData/GetStudies?${qs()}`);
  const raw = studies.data[0];
  const totalImages = raw.SeriesList.reduce((a, s) => a + (s.ImageList?.length || s.ImageCount || 0), 0);
  const patIdB64 = b64(raw.PatientId || "");
  const studyDir = path.join(dataDir, name);
  fs.mkdirSync(studyDir, { recursive: true });

  const seriesOut = [];
  let downloaded = 0, skipped = 0, totalFail = 0, done = 0;
  for (const ser of raw.SeriesList) {
    const serNum = ser.SeriesNumber ?? ser.Index ?? 0;
    const serDir = path.join(studyDir, "series", pad(serNum, 3));
    fs.mkdirSync(serDir, { recursive: true });
    const images = [...(ser.ImageList || [])].sort((a, b) => (parseInt(a.InstanceNumber) || 0) - (parseInt(b.InstanceNumber) || 0));
    if (!images.length) continue;
    emit("series", serNum, totalImages, `序列 ${serNum} ${ser.SeriesDescription || ""} (${images.length}张)`);
    await wakeSeries(IS, d.vendorCode, patIdB64, raw, ser);

    const jobs = images.map((img, k) => ({
      url: buildGetImageUrl(IS, d.vendorCode, patIdB64, raw, ser, img, k),
      file: path.join(serDir, `${pad(k + 1)}.dcm`), k,
    }));
    const tick = () => { done++; if (done % 10 === 0 || done === totalImages) emit("file", done, totalImages, `已下载 ${downloaded} 张`); };
    let errs = await pooled(jobs, 6, async job => {
      if (fs.existsSync(job.file) && fs.statSync(job.file).size > 100) { skipped++; tick(); return; }
      const buf = await getBinary(job.url);
      fs.writeFileSync(job.file, buf);
      downloaded++; tick();
    });
    if (errs.length) {
      // 刷新签名后重试一轮
      emit("retry", errs.length, totalImages, `重试 ${errs.length} 张...`);
      await getJson(`${IS}imageserver/StudyData/GetShareInfo?shareId=${shareId}&password=${password}`).catch(() => { });
      let ser2 = null;
      try { ser2 = (await getJson(`${IS}imageserver/StudyData/GetStudies?${qs()}`)).data[0].SeriesList.find(s => String(s.SeriesNumber ?? s.Index) === String(serNum)); } catch { }
      if (ser2?.ImageList?.length) {
        Object.assign(ser, { ImageList: ser2.ImageList, Expires: ser2.Expires ?? ser.Expires });
        await wakeSeries(IS, d.vendorCode, patIdB64, raw, ser);
        const retryJobs = errs.map(e => jobs[e.item]).map(job => ({ ...job, url: buildGetImageUrl(IS, d.vendorCode, patIdB64, raw, ser, images[job.k], job.k) }));
        errs = await pooled(retryJobs, 4, async job => {
          if (fs.existsSync(job.file) && fs.statSync(job.file).size > 100) return;
          const buf = await getBinary(job.url);
          fs.writeFileSync(job.file, buf);
          downloaded++; tick();
        });
      }
    }
    totalFail += errs.length;
    seriesOut.push({
      seriesNumber: serNum,
      seriesInstanceUID: ser.SeriesInsUID || "",
      description: ser.SeriesDescription || ser.ProtocolName || "",
      modality: ser.Modality || raw.Modality,
      bodyPart: ser.SeriesBodyPart || "",
      thickness: ser.SliceThickness ?? null,
      ww: ser.WW ?? null, wl: ser.WL ?? null,
      imageCount: images.length,
      images: images.map((img, k) => ({
        file: `series/${pad(serNum, 3)}/${pad(k + 1)}.dcm`,
        instanceNumber: img.InstanceNumber ?? (k + 1),
        sopInstanceUID: img.SOPInstanceUID || "",
        ww: img.WW ?? null, wl: img.WL ?? null,
        width: img.ImageWid ?? null, height: img.ImageHei ?? null,
        photometric: img.Photometric || "MONOCHROME2",
        numberOfFrames: img.NumberOfFrames || 1,
      })),
    });
  }

  const studyJson = {
    format: "kayi-local-v1",
    exportedAt: new Date().toISOString(),
    source: { shareId, imageServer: IS },
    patient: {
      name: raw.PatientName || "", id: raw.PatientId || "", sex: raw.PatientSex || "",
      age: raw.PatientAge || "", birth: raw.PatientBirth || "",
    },
    study: {
      date: raw.StuDate || "", time: raw.StuTime || "",
      description: raw.StuDescription || "", modality: raw.Modality || "",
      institution: raw.Institusion || "", modelName: raw.ManufacturerModelName || "",
      studyInstanceUID: raw.StuInsUID || "", accessionNumber: raw.AccessionNumber || "",
      imageCount: totalImages, seriesCount: raw.SeriesCount,
    },
    series: seriesOut,
  };
  fs.writeFileSync(path.join(studyDir, "study.json"), JSON.stringify(studyJson, null, 1), "utf8");

  let zipSize = 0;
  if (totalFail === 0) {
    emit("zip", 0, 1, "打包 zip...");
    const zipPath = path.join(dataDir, name + ".zip");
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const zw = new ZipWriter(zipPath);
    zw.addFile("study.json", path.join(studyDir, "study.json"));
    for (const ser of seriesOut) for (const img of ser.images) await zw.addFile(img.file, path.join(studyDir, img.file));
    zipSize = zw.close();
  }
  emit("done", 1, 1, `完成：新下载${downloaded} 跳过${skipped} 失败${totalFail}`);
  return { downloaded, skipped, failed: totalFail, zipSize, seconds: (Date.now() - t0) / 1000 };
}
