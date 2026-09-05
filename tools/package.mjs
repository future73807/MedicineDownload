// 打包交付物到 out/：网页程序 + 数据zip + Android APK + 工程 + 文档
// 用法: node tools/package.mjs [--no-data] [--apk <路径>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZipWriter } from "./ziplib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const args = process.argv.slice(2);
const noData = args.includes("--no-data");
const apkIdx = args.indexOf("--apk");
const APK = apkIdx >= 0 ? args[apkIdx + 1]
  : path.join(ROOT, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outZip = path.join(OUT, noData ? `影像查看器_程序包_${stamp}.zip` : `影像查看器_完整包_${stamp}.zip`);
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

console.log("打包:", outZip);
const zw = new ZipWriter(outZip, 1); // 影像已压缩，快速打包
let n = 0;

const add = async (arc, disk) => {
  if (!fs.existsSync(disk)) { console.warn("  跳过(不存在):", disk); return; }
  await zw.addFile(arc, disk);
  if (++n % 20 === 0) process.stdout.write(`\r  已打包 ${n} 个文件...`);
};

// 1. 网页程序（所有层级排除构建产物/依赖目录）
const SKIP = new Set(["libs-src", "node_modules", "build", ".gradle"]);
async function addDir(disk, arc) {
  for (const f of fs.readdirSync(disk)) {
    if (SKIP.has(f)) continue;
    const fp = path.join(disk, f), ap = arc ? `${arc}/${f}` : f;
    if (fs.statSync(fp).isDirectory()) await addDir(fp, ap);
    else await add(ap, fp);
  }
}
await addDir(path.join(ROOT, "app"), "app");

// 2. 工具与文档
await addDir(path.join(ROOT, "tools"), "tools");
await add("README.md", path.join(ROOT, "README.md"));

// 3. 数据 zip（跳过解压后的文件夹——zip 内容相同）
if (!noData) {
  for (const f of fs.readdirSync(path.join(ROOT, "data"))) {
    if (f.toLowerCase().endsWith(".zip")) await add(`data/${f}`, path.join(ROOT, "data", f));
  }
}

// 4. Android APK + 源码工程
if (fs.existsSync(APK)) await add("apk/影像查看器.apk", APK);
await addDir(path.join(ROOT, "android"), "android");

const bytes = zw.close();
console.log(`\n✔ 完成: ${n + 1} 个文件, ${(bytes / 1048576).toFixed(1)} MB`);
console.log("  ", outZip);
