// CLI 下载器（复用 download-core）
// 用法: node tools/download.mjs [--only 1,2] [--skip-zip]
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { downloadStudyToDisk } from "./download-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const STUDIES = [
  { id: 1, shareId: "<REDACTED-SHARE-ID>", password: "<REDACTED>", name: "1_<患者>_<ID>_MR" },
  { id: 2, shareId: "<REDACTED-SHARE-ID>", password: "<REDACTED>", name: "2_<患者>_<ID>_PETCT" },
  { id: 3, shareId: "<REDACTED-SHARE-ID>", password: "<REDACTED>", name: "3_<患者>_<ID>_MR" },
];

const args = process.argv.slice(2);
const onlyIdx = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",").map(Number) : null;
const selected = onlyIdx ? STUDIES.filter(s => onlyIdx.includes(s.id)) : STUDIES;

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const stu of selected) {
  console.log(`\n===== 研究 ${stu.id}: ${stu.name} =====`);
  let lastPct = -1;
  try {
    const r = await downloadStudyToDisk(DATA_DIR, stu.shareId, stu.password, stu.name, (stage, cur, total, msg) => {
      if (stage === "file") {
        const pct = Math.floor((cur / total) * 100);
        if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  下载 ${cur}/${total} (${pct}%)   `); }
      } else if (msg) console.log("  " + msg);
    });
    console.log(`\n  ✔ 完成：新下载${r.downloaded} 跳过${r.skipped} 失败${r.failed}` + (r.zipSize ? ` zip=${(r.zipSize / 1048576).toFixed(1)}MB` : "") + ` 用时${r.seconds.toFixed(1)}s`);
  } catch (e) {
    console.error(`\n  ✗ 失败:`, e.message);
  }
}
console.log("\n数据目录:", DATA_DIR);
