// DICOM 解码层：基于 dicom-parser + jpegLossless
// 输出 cornerstone 图像对象 + 覆盖信息所需的 tag 元数据
(function () {
  "use strict";

  const VR_BINARY = { OB: 1, OW: 1, OF: 1, OD: 1, US: 1, SS: 1, UL: 1, SL: 1, FL: 1, FD: 1, AT: 1 };

  // 字节级标签搜索兜底：部分文件（如 Siemens swi）含不规范的未定长 SQ，
  // dicomParser 遍历会错位丢掉其后的标签，这里直接按 tag 字节模式查找
  function byteTagSearch(bytes, group, elem, stopOffset) {
    const g0 = group & 0xff, g1 = (group >> 8) & 0xff, e0 = elem & 0xff, e1 = (elem >> 8) & 0xff;
    const end = stopOffset || bytes.length - 8;
    for (let i = 132; i < end; i++) {
      if (bytes[i] === g0 && bytes[i + 1] === g1 && bytes[i + 2] === e0 && bytes[i + 3] === e1) {
        const vrOk = { DS: 1, IS: 1, TM: 1, CS: 1, LO: 1, SH: 1, DA: 1, PN: 1, UI: 1, ST: 1, LT: 1, UT: 1, AE: 1, AS: 1 }[String.fromCharCode(bytes[i + 4], bytes[i + 5])];
        if (!vrOk) continue;
        const len = bytes[i + 6] | (bytes[i + 7] << 8);
        if (len <= 0 || len > 512) continue;
        let str = "";
        for (let k = 0; k < len; k++) str += String.fromCharCode(bytes[i + 8 + k]);
        return str.trim();
      }
    }
    return null;
  }
  function pixelDataOffset(bytes) {
    for (let i = 132; i < bytes.length - 8; i++) {
      if (bytes[i] === 0xe0 && bytes[i + 1] === 0x7f && bytes[i + 2] === 0x10 && bytes[i + 3] === 0x00) return i;
    }
    return bytes.length - 8;
  }

  // 解析单个 DICOM 文件（ArrayBuffer）→ 结构化对象
  function parseDicomFile(buffer) {
    const bytes = new Uint8Array(buffer);
    // 处理 Deflated TS（罕见，先膨胀再解）
    let ds;
    try {
      ds = dicomParser.parseDicom(bytes);
    } catch (e) {
      // 尝试 inflate 整个数据集
      const raw = fflate.inflateSync(bytes.subarray(132));
      ds = dicomParser.parseDicom(new Uint8Array(raw.buffer, 128, raw.length + 128));
    }
    const s = (t) => safeStr(ds, t);
    const n = (t) => { const v = s(t); const f = parseFloat(v); return isNaN(f) ? null : f; };

    const image = {
      transferSyntax: s("x00020010"),
      sopClassUID: s("x00080016"),
      sopInstanceUID: s("x00080018"),
      modality: s("x00080060"),
      // 患者层
      patientName: s("x00100010"), patientId: s("x00100020"),
      patientBirth: s("x00100030"), patientSex: s("x00100040"), patientAge: s("x00101010"),
      // 研究层
      studyDate: s("x00080020"), studyTime: s("x00080030"),
      studyDescription: s("x00081030"), studyInstanceUID: s("x0020000d"),
      accessionNumber: s("x00080050"), institution: s("x00080080"),
      // 序列层
      seriesNumber: n("x00200011"), seriesInstanceUID: s("x0020000e"),
      seriesDescription: s("x0008103e"), protocolName: s("x00181030"),
      manufacturer: s("x00080070"), modelName: s("x00081090"),
      bodyPart: s("x00180015"), laterality: s("x00200062"),
      // 图像层
      instanceNumber: n("x00200013"),
      imagePosition: parseDoubles(s("x00200032")),
      imageOrientation: parseDoubles(s("x00200037")),
      pixelSpacing: parseDoubles(s("x00280030")),
      sliceThickness: n("x00180050"),
      sliceLocation: n("x00201041"),
      rows: n("x00280010"), cols: n("x00280011"),
      samplesPerPixel: n("x00280002") || 1,
      bitsAllocated: n("x00280100") || 16,
      bitsStored: n("x00280101") || 16,
      highBit: n("x00280102"),
      pixelRepresentation: n("x00280103"), // 0=无符号 1=有符号
      photometric: s("x00280004") || "MONOCHROME2",
      planarConfiguration: n("x00280006") || 0,
      windowCenter: parseFirstFloat(s("x00281050")),
      windowWidth: parseFirstFloat(s("x00281051")),
      rescaleSlope: n("x00281053") ?? 1,
      rescaleIntercept: n("x00281052") ?? 0,
      smallestImage: n("x00280106"),
      largestImage: n("x00280107"),
      tr: s("x00180080"), te: s("x00180081"), // 保留原始字符串（原版显示 TE: 3.0）
      acquisitionTime: s("x00080032"), // 帧级采集时间（原版覆盖行显示的就是它）
      numberOfFrames: n("x00280008"),
      lossyCompression: s("x00282110") || "",
    };

    // 字节级兜底：dicomParser 在不规范未定长 SQ（如部分 Siemens swi）后错位丢标签时，
    // 对覆盖信息/渲染必需的帧级标签直接按字节搜索
    {
      const pxOff = pixelDataOffset(bytes);
      const rescue = (t, key, isNum) => {
        if (image[key] != null && image[key] !== "") return;
        const g = parseInt(t.slice(1, 5), 16), e = parseInt(t.slice(5, 9), 16);
        const str = byteTagSearch(bytes, g, e, pxOff);
        if (str == null) return;
        if (isNum) { const f = parseFloat(str); if (!isNaN(f)) image[key] = f; }
        else image[key] = str;
      };
      // WC/WW 无条件取文件中第一组标签（DICOM 语义：第一组为默认窗值）——
      // 错位解析可能把数据区伪标签当窗值（如 swi 的 -132/6440）
      {
        const wcStr = byteTagSearch(bytes, 0x0028, 0x1050, pxOff);
        const wwStr = byteTagSearch(bytes, 0x0028, 0x1051, pxOff);
        if (wcStr != null) { const f = parseFloat(wcStr); if (!isNaN(f)) image.windowCenter = f; }
        if (wwStr != null) { const f = parseFloat(wwStr); if (!isNaN(f)) image.windowWidth = f; }
      }
      rescue("x00180080", "tr", false);
      rescue("x00180081", "te", false);
      rescue("x00080032", "acquisitionTime", false);
      rescue("x00200013", "instanceNumber", true);
      if (image.imagePosition == null) {
        const ipp = byteTagSearch(bytes, 0x0020, 0x0032, pxOff);
        image.imagePosition = ipp ? ipp.split("\\").map(parseFloat) : null;
      }
      if (image.imageOrientation == null) {
        const iop = byteTagSearch(bytes, 0x0020, 0x0037, pxOff);
        image.imageOrientation = iop ? iop.split("\\").map(parseFloat) : null;
      }
      if (image.pixelSpacing == null) {
        const psp = byteTagSearch(bytes, 0x0028, 0x0030, pxOff);
        image.pixelSpacing = psp ? psp.split("\\").map(parseFloat) : null;
      }
      if (image.sliceThickness == null) {
        rescue("x00180050", "sliceThickness", true);
      }
      if (!image.acquisitionTime) rescue("x00080032", "acquisitionTime", false);
    }

    // 像素数据
    const pxEl = ds.elements.x7fe00010;
    if (!pxEl) throw new Error("无像素数据(7FE0,0010)");
    let pixelData;
    if (pxEl.encapsulatedPixelData) {
      pixelData = decodeEncapsulated(bytes, pxEl, image);
    } else {
      pixelData = readNativePixels(ds, pxEl, image);
    }
    // 符号修正：部分厂商 signed 数据的 (0028,0103) 缺失/为0，补码值被读成大正数
    if (pixelData instanceof Uint16Array) {
      const n = pixelData.length;
      const step = Math.max(1, Math.floor(n / 20000));
      let cnt = 0, tot = 0;
      for (let i = 0; i < n; i += step) { tot++; if (pixelData[i] > 32767) cnt++; }
      if (image.pixelRepresentation === 1 || cnt / tot > 0.01) {
        pixelData = new Int16Array(pixelData.buffer, pixelData.byteOffset, n);
      }
    }
    image.pixelData = pixelData;
    return image;
  }

  function safeStr(ds, tag) {
    try { const v = ds.string(tag); return v === undefined ? "" : v; } catch { return ""; }
  }
  function parseDoubles(str) {
    if (!str) return null;
    const arr = str.split("\\").map(parseFloat).filter(x => !isNaN(x));
    return arr.length ? arr : null;
  }
  function parseFirstFloat(str) {
    if (!str) return null;
    const f = parseFloat(str.split("\\")[0]);
    return isNaN(f) ? null : f;
  }

  // 本地（未压缩）像素读取
  function readNativePixels(ds, pxEl, image) {
    const numPixels = image.rows * image.cols * image.samplesPerPixel * (image.numberOfFrames || 1);
    const b = image.bitsAllocated;
    let data;
    const offset = pxEl.dataOffset, len = pxEl.length;
    if (b === 16) {
      data = new Int16Array(numPixels);
      const u16 = new Uint16Array(bytesView(ds.byteArray.buffer, offset, len));
      // 字节序（小端为主）
      if (image.pixelRepresentation === 1) { for (let i = 0; i < numPixels; i++) data[i] = u16[i] | 0; }
      else { for (let i = 0; i < numPixels; i++) data[i] = u16[i]; }
      image._unsigned = data;
    } else if (b === 8) {
      data = new Uint8Array(bytesView(ds.byteArray.buffer, offset, len));
    } else {
      throw new Error("不支持位深: " + b);
    }
    return data;
  }
  function bytesView(buffer, offset, len) {
    // byteArray 可能是 Uint8Array
    return new Uint8Array(buffer, offset, len);
  }

  // 封装像素（JPEG-Lossless 等）
  function decodeEncapsulated(bytes, pxEl, image) {
    // 拼接所有 fragment（单帧取第一段，多帧逐段）
    const fragments = pxEl.fragments;
    if (!fragments) throw new Error("无像素片段");
    const dec = (typeof JpegLossless !== "undefined") ? JpegLossless : null;
    if (!dec) throw new Error("缺少 JPEG-Lossless 解码器");

    const decodeFrame = (fragIdx) => {
      const f = fragments[fragIdx];
      const js = bytes.subarray(f.position, f.position + f.length);
      const decoder = new dec.Decoder(js);
      const out = decoder.decode();
      // 解码器对部分流（如 Siemens mosaic）的尺寸报告不可靠：输出像素数足够时以 DICOM 头为准
      const needPx = image.rows * image.cols;
      if (image.rows && image.cols && out.length >= needPx) {
        image.bitsAllocated = decoder.frame.precision <= 8 ? 8 : 16;
      } else {
        image.rows = decoder.frame.dimY; image.cols = decoder.frame.dimX;
        image.bitsAllocated = decoder.frame.precision <= 8 ? 8 : 16;
      }
      return out; // Uint8Array 或 Uint16Array
    };
    if (fragments.length === 1 || !(image.numberOfFrames > 1)) {
      return decodeFrame(0);
    }
    // 多帧：逐帧解码拼接
    const frames = [];
    let w = 0, h = 0;
    for (let i = 0; i < fragments.length; i++) {
      const fr = decodeFrame(i);
      w = image.cols; h = image.rows;
      frames.push(fr);
    }
    const perFrame = w * h * (frames[0] instanceof Uint16Array ? 2 : 1);
    const total = new Uint16Array(w * h * frames.length);
    for (let i = 0; i < frames.length; i++) {
      const src = frames[i] instanceof Uint16Array ? frames[i] : new Uint16Array(frames[i].buffer, frames[i].byteOffset, frames[i].length / 2);
      total.set(src, i * w * h);
    }
    image.numberOfFrames = frames.length;
    return total;
  }

  // → cornerstone 图像对象
  function toCornerstoneImage(parsed, imageId) {
    const signed = parsed.pixelRepresentation === 1;
    let pixelData = parsed.pixelData;
    let min = Infinity, max = -Infinity;
    const slope = parsed.rescaleSlope || 1;
    const intercept = parsed.rescaleIntercept || 0;
    const needModality = slope !== 1 || intercept !== 0;
    const step = Math.max(1, Math.floor(pixelData.length / 50000));
    // 采样时应用 slope/intercept（物理值域），保证窗宽窗位 fallback 正确
    for (let i = 0; i < pixelData.length; i += step) {
      let v = pixelData[i];
      if (needModality) v = v * slope + intercept;
      if (v < min) min = v; if (v > max) max = v;
    }
    // 有符号 16bit 采样可能漏掉负数边界，用标签兜底
    if (parsed.smallestImage != null) min = Math.min(min, parsed.smallestImage);
    if (parsed.largestImage != null) max = Math.max(max, parsed.largestImage);
    if (!isFinite(min)) { min = 0; max = 0; }

    const wc = parsed.windowCenter != null ? parsed.windowCenter : (max + min) / 2;
    const ww = parsed.windowWidth != null && parsed.windowWidth > 1 ? parsed.windowWidth : (max - min || 1);

    const img = {
      imageId: imageId || "local://" + (parsed.sopInstanceUID || Math.random()),
      minPixelValue: min,
      maxPixelValue: max,
      slope: parsed.rescaleSlope || 1,
      intercept: parsed.rescaleIntercept || 0,
      windowCenter: wc,
      windowWidth: ww,
      render: undefined,
      rows: parsed.rows,
      columns: parsed.cols,
      height: parsed.rows,
      width: parsed.cols,
      color: parsed.photometric.indexOf("COLOR") >= 0 || parsed.samplesPerPixel === 3,
      columnPixelSpacing: parsed.pixelSpacing ? parsed.pixelSpacing[1] : 1,
      rowPixelSpacing: parsed.pixelSpacing ? parsed.pixelSpacing[0] : 1,
      sizeInBytes: pixelData.byteLength,
      photometricInterpretation: parsed.photometric,
      stats: {}, // cornerstone 2.6 渲染计时需要
      getPixelData() { return pixelData; },
      // 附加元数据（供覆盖层/定位线/MPR使用）
      metaData: {
        patientName: parsed.patientName, patientId: parsed.patientId,
        patientAge: parsed.patientAge, patientSex: parsed.patientSex, patientBirth: parsed.patientBirth,
        studyDate: parsed.studyDate, studyTime: parsed.studyTime,
        studyDescription: parsed.studyDescription, institution: parsed.institution,
        modelName: parsed.modelName, manufacturer: parsed.manufacturer,
        seriesNumber: parsed.seriesNumber, seriesDescription: parsed.seriesDescription,
        instanceNumber: parsed.instanceNumber, modality: parsed.modality,
        sliceThickness: parsed.sliceThickness, sliceLocation: parsed.sliceLocation,
        imagePosition: parsed.imagePosition, imageOrientation: parsed.imageOrientation,
        pixelSpacing: parsed.pixelSpacing, tr: parsed.tr, te: parsed.te,
        acquisitionTime: parsed.acquisitionTime,
        bodyPart: parsed.bodyPart, laterality: parsed.laterality,
        protocolName: parsed.protocolName, sopInstanceUID: parsed.sopInstanceUID,
      },
      parsed,
    };
    return img;
  }

  // 方位字母（DICOM 显示惯例：患者 R 在图像左）
  // 屏幕上方 = -列方向，屏幕左方 = -行方向
  function orientationLabels(iop) {
    if (!iop || iop.length < 6) return { top: "", left: "" };
    const row = [-iop[0], -iop[1], -iop[2]];
    const col = [-iop[3], -iop[4], -iop[5]];
    const labels = (v) => {
      const axes = [["L", "R", v[0]], ["P", "A", v[1]], ["H", "F", v[2]]];
      axes.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
      const [pos, neg, val] = axes[0];
      return val >= 0 ? pos : neg;
    };
    return { top: labels(col), left: labels(row) };
  }

  window.KDcm = { parseDicomFile, toCornerstoneImage, orientationLabels };
})();
