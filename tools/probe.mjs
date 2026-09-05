// 探针：确认 GetStudies 返回的序列/影像字段结构
const IMAGE_SERVER = "https://www.kayicloud.com:11136/";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 120)}`);
  return r.json();
}

const [shareId, password] = process.argv.slice(2);
const share = await getJson(`${IMAGE_SERVER}imageserver/StudyData/GetShareInfo?shareId=${shareId}&password=${password}`);
console.log("GetShareInfo code:", share.code, "ds:", share.data?.ds, "vendorCode:", share.data?.vendorCode);
const d = share.data;
const params = new URLSearchParams({
  dataids: "", studyKeys: "", cloudImage: d.cloudImage ?? "1", dataSource: d.ds,
  signature: d.serverSignature, vendorCode: d.vendorCode, seriesKeys: "",
  isAnony: String(d.isAnony ?? false), getImageInfo: "false", token: "",
  serverAddr: Buffer.from(d.serverAddr, "utf8").toString("base64"),
  expires: String(d.expires),
});
const studies = await getJson(`${IMAGE_SERVER}imageserver/StudyData/GetStudies?${params}`);
console.log("GetStudies code:", studies.code, "studies:", studies.data?.length);
const st = studies.data[0];
console.log("Study fields:", Object.keys(st).join(", "));
console.log("Patient:", st.PatientName, st.PatientId, st.Modality, "series:", st.SeriesCount, "images:", st.ImageCount);
const ser = st.SeriesList[0];
console.log("\nSeries[0] fields:", Object.keys(ser).join(", "));
const imgListName = ["ImageList", "imageList", "Images", "images"].find(k => Array.isArray(ser[k]));
console.log("Image list field:", imgListName, "len:", imgListName ? ser[imgListName].length : "N/A");
if (imgListName) {
  const img = ser[imgListName][0];
  console.log("Image[0] fields:", Object.keys(img).join(", "));
  console.log("Image[0]:", JSON.stringify(img).slice(0, 800));
}
// 打印所有序列概览
console.log("\nAll series:");
for (const s of st.SeriesList) {
  console.log(`  Ser:${s.SeriesNumber} "${s.SeriesDescription || s.Description}" imgs=${s.ImageCount ?? s.InstanceCount} uid=${(s.SeriesInstanceUID || "").slice(0, 30)}`);
}
