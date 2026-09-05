// 打包交付物到 out/
// 2×2 组合：目标(web/apk) × 是否含数据(--data)
// 用法:
//   node tools/package.mjs                 # 全部：web包 + apk包（均不含数据）
//   node tools/package.mjs --web           # 仅 web 程序包
//   node tools/package.mjs --apk           # 仅 apk 包
//   node tools/package.mjs --data          # 全部 + 含数据
//   node tools/package.mjs --web --data    # web + 数据
//   node tools/package.mjs --apk --data    # apk + 数据
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipWriter } from "./ziplib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const args = process.argv.slice(2);
const doWeb = args.includes("--web") || (!args.includes("--web") && !args.includes("--apk"));
const doApk = args.includes("--apk") || (!args.includes("--web") && !args.includes("--apk"));
const withData = args.includes("--data");

const APK = path.join(ROOT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
fs.mkdirSync(OUT, { recursive: true });

let totalFiles = 0;
async function pack(outZip, entries) {
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  console.log("打包:", outZip);
  const zw = new ZipWriter(outZip, 1);
  for (const [arc, disk] of entries) {
    if (!fs.existsSync(disk)) { console.warn("  跳过(不存在):", disk); continue; }
    await zw.addFile(arc, disk);
    if (++totalFiles % 20 === 0) process.stdout.write(`\r  已打包 ${totalFiles} 个文件...`);
  }
  const bytes = zw.close();
  console.log(`\n  ✔ ${path.basename(outZip)}: 完成 (${(bytes / 1048576).toFixed(1)} MB)`);
}

const webEntries = [];
{
  const SKIP = new Set(["libs-src", "node_modules", "build", ".gradle"]);
  async function walk(disk, arc) {
    for (const f of fs.readdirSync(disk)) {
      if (SKIP.has(f)) continue;
      const fp = path.join(disk, f), ap = arc ? `${arc}/${f}` : f;
      if (fs.statSync(fp).isDirectory()) await walk(fp, ap);
      else webEntries.push([ap, fp]);
    }
  }
  await walk(path.join(ROOT, "app"), "app");
  await walk(path.join(ROOT, "tools"), "tools");
  webEntries.push(["README.md", path.join(ROOT, "README.md")]);
}

const dataEntries = [];
if (withData && fs.existsSync(path.join(ROOT, "data"))) {
  for (const f of fs.readdirSync(path.join(ROOT, "data"))) {
    if (f.toLowerCase().endsWith(".zip")) dataEntries.push([`data/${f}`, path.join(ROOT, "data", f)]);
  }
}

totalFiles = 0;
if (doWeb) {
  const tag = withData ? "完整包" : "程序包";
  await pack(path.join(OUT, `影像查看器_web${tag}_${stamp}.zip`), [...webEntries, ...dataEntries]);
}
if (doApk) {
  if (!fs.existsSync(APK)) {
    console.warn("未找到 APK，请先执行: cd android && gradlew.bat assembleDebug");
  } else {
    const apkEntries = [["apk/影像查看器.apk", APK], ...dataEntries];
    await pack(path.join(OUT, `影像查看器_apk${withData ? "数据包" : "包"}_${stamp}.zip`), apkEntries);
  }
}
console.log(`\n全部完成 (web=${doWeb}, apk=${doApk}, 数据=${withData})`);
