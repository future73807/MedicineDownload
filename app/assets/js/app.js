// 主程序：布局、视口、工具、缩略图、播放、同步、开屏
(function () {
  "use strict";
  const { parseDicomFile, toCornerstoneImage, orientationLabels } = window.KDcm;
  const KStore = window.KStore;

  // ============ 状态 ============
  const App = {
    handle: null,          // 数据包句柄 {meta, readFile}
    meta: null,
    series: [],            // [{meta, imageIds:[...], count, thumbDone}]
    viewports: [],         // {cell, elem, seriesIdx, index, imageCache:Map, cineTimer, parsed0}
    seriesLayout: { rows: 1, cols: 2 },
    imageLayout: { rows: 1, cols: 1 },
    activeVp: 0,
    currentTool: "scroll",
    anonymous: false,
    showInfo: true,
    showLocalizer: true,
    fps: 10,
    playing: false,
    imageCache: new Map(),  // "s{ser}i{idx}" -> parsed image (LRU)
    cacheKeys: [],
    CACHE_MAX: 160,
    sync: { imageId: false, autoPos: true, manualPos: false, zoomPan: false, wwwl: false },
    mode: "2d",
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const icon = (id, cls) => `<svg class="viewer_icon ${cls || ""}"><use xlink:href="#${id}"></use></svg>`;

  function toast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg; t.style.display = "block";
    clearTimeout(t._h);
    t._h = setTimeout(() => t.style.display = "none", ms);
  }

  // ============ cornerstone 图像加载 ============
  function cacheKey(s, i) { return "s" + s + "i" + i; }
  function cachePut(k, v) {
    if (App.imageCache.has(k)) return;
    App.imageCache.set(k, v);
    App.cacheKeys.push(k);
    while (App.cacheKeys.length > App.CACHE_MAX) {
      const old = App.cacheKeys.shift();
      const img = App.imageCache.get(old);
      App.imageCache.delete(old);
    }
  }

  function kwLoad(imageId) {
    const m = imageId.slice("kwlocal://".length).split("/");
    const sIdx = +m[0], iIdx = +m[1];
    const k = cacheKey(sIdx, iIdx);
    const hit = App.imageCache.get(k);
    if (hit) return Promise.resolve(hit);
    const ser = App.series[sIdx];
    if (!ser) return Promise.reject(new Error("序列不存在"));
    const rel = ser.meta.images[iIdx].file;
    return App.handle.readFile(rel).then((buf) => {
      const parsed = parseDicomFile(buf);
      const img = toCornerstoneImage(parsed, imageId);
      cachePut(k, img);
      return img;
    });
  }
  // cornerstone 2.6 协议：loader 返回 {promise}
  cornerstone.registerImageLoader("kwlocal", (imageId) => ({ promise: kwLoad(imageId) }));

  // ============ 视口管理 ============
  function clearViewports() {
    for (const vp of App.viewports) {
      try { cornerstone.disable(vp.elem); } catch { }
      if (vp.cineTimer) clearInterval(vp.cineTimer);
    }
    App.viewports = [];
    $("#viewportArea").innerHTML = "";
  }

  function setSeriesLayout(rows, cols) {
    App.seriesLayout = { rows, cols };
    document.querySelectorAll("[data-serlayout]").forEach(b =>
      b.classList.toggle("active", +b.dataset.serlayout === rows * 10 + cols));
    if (!App.handle) return;
    rebuildViewports();
  }

  function rebuildViewports() {
    const keep = App.viewports.map(v => ({ s: v.seriesIdx, i: v.index }));
    clearViewports();
    const area = $("#viewportArea");
    const n = App.seriesLayout.rows * App.seriesLayout.cols;
    area.style.display = "grid";
    area.style.gridTemplateColumns = `repeat(${App.seriesLayout.cols},1fr)`;
    area.style.gridTemplateRows = `repeat(${App.seriesLayout.rows},1fr)`;
    for (let i = 0; i < n; i++) {
      const cell = el("div", "viewport-cell");
      const inner = el("div", "vp-inner");
      cell.appendChild(inner);
      area.appendChild(cell);
      const vp = { cell, elem: inner, seriesIdx: -1, index: 0, imageCache: new Map(), cineTimer: null };
      App.viewports.push(vp);
      try { cornerstone.enable(inner); } catch (e) { console.error(e); }
      bindViewportEvents(vp);
      const keepEntry = keep[i];
      if (keepEntry && keepEntry.s >= 0 && keepEntry.s < App.series.length) {
        loadSeriesToVp(vp, keepEntry.s, keepEntry.i);
      } else if (i < App.series.length) {
        // 默认装载：第 i 个视口装第 i 个序列
        loadSeriesToVp(vp, i, 0);
      }
    }
    updateFocus();
    bindSyncHandlers();
    // 等布局稳定后修正 canvas 尺寸（enable 时元素可能尚未布局）
    requestAnimationFrame(() => {
      for (const vp of App.viewports) {
        try { cornerstone.resize(vp.elem, true); } catch { }
      }
      requestOverlayRedraw();
    });
  }

  function updateFocus() {
    App.viewports.forEach((v, i) => v.cell.classList.toggle("focused", i === App.activeVp));
  }

  function bindViewportEvents(vp) {
    vp.elem.addEventListener("mousedown", () => { setActiveVp(App.viewports.indexOf(vp)); });
    vp.elem.addEventListener("touchstart", () => { setActiveVp(App.viewports.indexOf(vp)); }, { passive: true });
    vp.elem.addEventListener("wheel", (e) => {
      setActiveVp(App.viewports.indexOf(vp));
      const dir = e.deltaY > 0 ? 1 : -1;
      scrollVp(vp, dir);
      e.preventDefault();
    }, { passive: false });
  }

  function setActiveVp(i) {
    if (i < 0 || i >= App.viewports.length || App.activeVp === i) { if (i >= 0 && i < App.viewports.length) { App.activeVp = i; updateFocus(); } return; }
    App.activeVp = i;
    updateFocus();
    updateCineBar();
    highlightThumb();
  }

  function loadSeriesToVp(vp, sIdx, imgIdx = 0) {
    const ser = App.series[sIdx];
    if (!ser) return;
    vp.seriesIdx = sIdx;
    vp.index = Math.max(0, Math.min(imgIdx, ser.meta.imageCount - 1));
    vp.imageCache = new Map();
    const showLoading = el("div", "vp-loading", "加载中...");
    vp.cell.appendChild(showLoading);
    showLoading.style.display = "flex";
    Promise.all([
      loadImage(sIdx, vp.index),
      // 预取相邻两张，滚动更顺滑
      loadImage(sIdx, Math.min(vp.index + 1, ser.meta.imageCount - 1)).catch(() => null),
    ]).then(([img]) => {
      showLoading.remove();
      cornerstone.displayImage(vp.elem, img);
      cornerstone.fitToWindow(vp.elem);
      // 序列级窗宽窗位优先（与原站一致）
      try {
        const st = cornerstone.getViewport(vp.elem);
        if (ser.meta.ww > 1 && ser.meta.wl != null) {
          st.voi.windowWidth = ser.meta.ww;
          st.voi.windowCenter = ser.meta.wl;
        }
      } catch { }
      cornerstone.updateImage(vp.elem);
      vp._skipSyncUntil = Date.now() + 1200;
      try {
        setupToolsForVp(vp);
        applySyncToVp(vp);
        vp.parsed0 = img.metaData;
        renderOverlay(vp, { viewport: cornerstone.getViewport(vp.elem), element: vp.elem });
      } catch (e) { console.warn("vp setup", e); }
      if (App.viewports.indexOf(vp) === App.activeVp) { highlightThumb(); updateCineBar(); }
    }).catch((e) => {
      showLoading.remove();
      console.error(e);
      const empty = el("div", "vp-empty", "序列加载失败");
      vp.cell.appendChild(empty);
    });
  }

  function loadImage(sIdx, iIdx) {
    const ser = App.series[sIdx];
    const imageId = `kwlocal://${sIdx}/${iIdx}`;
    return cornerstone.loadImage(imageId);
  }

  function scrollVp(vp, dir) {
    if (vp.seriesIdx < 0) return;
    const ser = App.series[vp.seriesIdx];
    let ni = vp.index + dir;
    ni = Math.max(0, Math.min(ni, ser.meta.imageCount - 1));
    if (ni === vp.index) return;
    vp.index = ni;
    loadImage(vp.seriesIdx, ni).then(img => {
      cornerstone.displayImage(vp.elem, img);
      cornerstone.updateImage(vp.elem);
      onImageChanged(vp);
    }).catch(() => { vp.index -= dir; });
    updateCineBar();
  }

  function onImageChanged(vp) {
    if (vp._skipSyncUntil && Date.now() < vp._skipSyncUntil) return;
    // 同步联动
    if (App.sync.imageId) syncByIndex(vp);
    if (App.sync.autoPos) syncByPosition(vp);
  }

  function syncByIndex(src) {
    App.viewports.forEach(v => {
      if (v === src || v.seriesIdx < 0) return;
      const ser = App.series[v.seriesIdx];
      const ni = Math.round((src.index / Math.max(1, App.series[src.seriesIdx].meta.imageCount - 1)) * (ser.meta.imageCount - 1));
      if (ni !== v.index) jumpTo(v, ni);
    });
  }

  function syncByPosition(src) {
    if (src.seriesIdx < 0) return;
    const srcSer = App.series[src.seriesIdx];
    const srcImg = srcSer.curParsed;
    if (!srcImg || !srcImg.imagePosition || !srcImg.imageOrientation) return;
    const n = planeNormal(srcImg.imageOrientation);
    const p0 = srcImg.imagePosition;
    App.viewports.forEach(v => {
      if (v === src || v.seriesIdx < 0 || v === undefined) return;
      const ser = App.series[v.seriesIdx];
      const cur = ser.parsedByIndex && ser.parsedByIndex.get(v.index);
      if (!cur || !cur.imagePosition || !cur.imageOrientation) return;
      const n2 = planeNormal(cur.imageOrientation);
      if (dot(n, n2) < 0.9) return; // 方向不同不联动
      const d = dot([cur.imagePosition[0] - p0[0], cur.imagePosition[1] - p0[1], cur.imagePosition[2] - p0[2]], n2);
      const sp = cur.pixelSpacing ? cur.pixelSpacing[0] : 1;
      const step = Math.max(0.1, cur.sliceThickness || (ser.meta.thickness || sp));
      const ni = v.index + Math.round(d / step);
      const clamped = Math.max(0, Math.min(ser.meta.imageCount - 1, ni));
      if (clamped !== v.index) jumpTo(v, clamped);
    });
  }

  function jumpTo(vp, idx) {
    vp.index = idx;
    loadImage(vp.seriesIdx, idx).then(img => {
      cornerstone.displayImage(vp.elem, img);
      cornerstone.updateImage(vp.elem);
      updateCineBar();
    }).catch(() => { });
  }

  // ============ 工具 ============
  const TOOLS = [
    { id: "scroll", name: "翻页", key: "S", ic: "ic-select", cs: ["StackScroll"], default: true },
    { id: "zoom", name: "图像放缩", key: "Z", ic: "ic-zoom", cs: ["Zoom"] },
    { id: "pan", name: "图像平移", key: "P", ic: "ic-pan", cs: ["Pan"] },
    { id: "wl", name: "调节窗宽窗位", key: "W", ic: "ic-wl", cs: ["Wwwc"] },
    { id: "rotate", name: "旋转", key: "R", ic: "ic-roll", cs: ["Rotate"] },
    { id: "length", name: "长度", key: "L", ic: "ic-length", cs: ["Length"] },
    { id: "point", name: "点标注", key: "", ic: "ic-annovalue", cs: ["Probe"] },
    { id: "ellipse", name: "椭圆", key: "E", ic: "ic-ellipse", cs: ["EllipticalRoi"] },
    { id: "rect", name: "矩形", key: "", ic: "ic-annorect", cs: ["RectangleRoi"] },
    { id: "angle", name: "角度", key: "A", ic: "ic-angle", cs: ["Angle"] },
    { id: "cobb", name: "Cobb角", key: "", ic: "ic-cobb", cs: ["CobbAngle"] },
    { id: "freehand", name: "多边形", key: "", ic: "ic-polygon", cs: ["FreehandRoi"] },
    { id: "cross", name: "十字线", key: "", ic: "ic-cross", cs: [] }, // 自绘定位线模式
    { id: "textr", name: "文本", key: "T", ic: "ic-text", cs: ["TextMarker"] },
    { id: "chestratio", name: "心胸比", key: "", ic: "ic-heartchest", cs: [] },
    { id: "delete", name: "删除", key: "", ic: "ic-undo", cs: [] },
  ];

  const touchTools = ["StackScroll", "Zoom", "Pan", "Wwwc", "Length", "Angle", "EllipticalRoi", "RectangleRoi", "Probe", "CobbAngle", "FreehandRoi"];

  function initCornerstoneTools() {
    cornerstoneTools.init();
    [StackScrollTool, ZoomTool, PanTool, WwwcTool, LengthTool, AngleTool, CobbAngleTool,
      EllipticalRoiTool, RectangleRoiTool, ProbeTool, FreehandRoiTool,
      StackScrollMouseWheelTool].forEach(T => {
        try { cornerstoneTools.addTool(T); } catch (e) { console.warn("addTool", e.message); }
      });
    try {
      cornerstoneTools.addTool(TextMarkerTool, { configuration: { markers: ["A", "B", "C", "D", "E", "F"] } });
    } catch { }
  }

  // 全局渲染循环：每帧自绘所有视口（cornerstone 内置渲染器在此环境不可用）
  function startRenderLoop() {
    function frame() {
      for (const vp of App.viewports) {
        try {
          const ee = cornerstone.getEnabledElement(vp.elem);
          if (ee && ee.image) {
            drawPixels(vp);
            drawOverlay(vp, { viewport: ee.viewport, element: vp.elem });
          }
        } catch { }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  const StackScrollTool = cornerstoneTools.StackScrollTool;
  const ZoomTool = cornerstoneTools.ZoomTool;
  const PanTool = cornerstoneTools.PanTool;
  const WwwcTool = cornerstoneTools.WwwcTool;
  const LengthTool = cornerstoneTools.LengthTool;
  const AngleTool = cornerstoneTools.AngleTool;
  const CobbAngleTool = cornerstoneTools.CobbAngleTool;
  const EllipticalRoiTool = cornerstoneTools.EllipticalRoiTool;
  const RectangleRoiTool = cornerstoneTools.RectangleRoiTool;
  const ProbeTool = cornerstoneTools.ProbeTool;
  const FreehandRoiTool = cornerstoneTools.FreehandRoiTool;
  const TextMarkerTool = cornerstoneTools.TextMarkerTool;
  const StackScrollMouseWheelTool = cornerstoneTools.StackScrollMouseWheelTool;

  function setupToolsForVp(vp) {
    if (!vp.elem.clientWidth) return;
    for (const t of TOOLS) {
      for (const csName of t.cs) {
        try { cornerstoneTools.addToolForElement(vp.elem, cornerstoneTools[csName]); } catch { }
      }
    }
    try { cornerstoneTools.setToolActiveForElement(vp.elem, "StackScrollMouseWheel", { loop: false }); } catch { }
    setToolActive(App.currentTool);
  }

  function setToolActive(toolId) {
    App.currentTool = toolId;
    const t = TOOLS.find(x => x.id === toolId);
    if (!t) return;
    document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === toolId));
    // 特殊工具动作
    if (toolId === "delete") { clearAnnotations(); return; }
    for (const vp of App.viewports) {
      ["StackScroll", "Zoom", "Pan", "Wwwc", "Length", "Angle", "CobbAngle", "EllipticalRoi", "RectangleRoi", "Probe", "FreehandRoi", "TextMarker", "Rotate"].forEach(n => {
        try { cornerstoneTools.setToolPassiveForElement(vp.elem, n); } catch { }
      });
      for (const csName of t.cs) {
        try { cornerstoneTools.setToolActiveForElement(vp.elem, csName, { mouseButtonIndex: 1, isTouchActive: true }); } catch { }
      }
    }
    App.crossMode = toolId === "cross";
    App.ratioMode = toolId === "chestratio";
    requestOverlayRedraw();
  }

  // 清除当前激活视口的标注
  function clearAnnotations() {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return;
    ["Length", "Angle", "CobbAngle", "EllipticalRoi", "RectangleRoi", "Probe", "FreehandRoi", "TextMarker"].forEach(n => {
      try {
        cornerstoneTools.clearToolState(vp.elem, n);
      } catch { }
    });
    if (App.ratioState) App.ratioState[App.viewports.indexOf(vp)] = null;
    cornerstone.updateImage(vp.elem);
    toast("已清除标注", 1200);
  }

  // ============ 自绘像素渲染（绕过 cornerstone 渲染器，兼容所有环境） ============
  function drawPixels(vp) {
    const ee = cornerstone.getEnabledElement(vp.elem);
    if (!ee || !ee.image || !ee.canvas) return;
    const img = ee.image, vpst = ee.viewport;
    // 序列元数据缓存（供同步/定位线）
    const ser = App.series[vp.seriesIdx];
    if (ser && img.parsed) {
      ser.parsedByIndex = ser.parsedByIndex || new Map();
      ser.parsedByIndex.set(vp.index, img.parsed);
      ser.curParsed = img.parsed;
    }
    const ctx = ee.canvas.getContext("2d");
    const cw = ee.canvas.width, ch = ee.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    // 离屏渲染缓存（同图同窗重复利用）
    const lutKey = [img.imageId, vpst.voi.windowWidth, vpst.voi.windowCenter, vpst.invert, vpst.colormap ? vpst.colormap.getId && vpst.colormap.getId() : ""].join("|");
    if (!vp._off || vp._offKey !== lutKey) {
      const w = img.columns, h = img.rows;
      if (!vp._off) vp._off = document.createElement("canvas");
      vp._off.width = w; vp._off.height = h;
      const octx = vp._off.getContext("2d");
      const od = octx.createImageData(w, h);
      const px = img.getPixelData();
      const ww = vpst.voi.windowWidth || 1, wc = vpst.voi.windowCenter || 0;
      const lo = wc - ww / 2, hi = wc + ww / 2;
      const invert = !!vpst.invert;
      const cmap = vpst.colormap;
      const signed = px instanceof Int16Array || px instanceof Int8Array;
      const slope = img.slope || 1, inter = img.intercept || 0;
      const needModality = slope !== 1 || inter !== 0;
      for (let i = 0, o = 0; i < px.length; i++, o += 4) {
        let v = px[i];
        if (needModality) v = v * slope + inter;
        let g = (v - lo) * (255 / ww);
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        if (invert) g = 255 - g;
        if (cmap) {
          const c = cmap.mapValue(g | 0) || [g, g, g];
          od.data[o] = c[0]; od.data[o + 1] = c[1]; od.data[o + 2] = c[2];
        } else {
          od.data[o] = od.data[o + 1] = od.data[o + 2] = g;
        }
        od.data[o + 3] = 255;
      }
      octx.putImageData(od, 0, 0);
      vp._offKey = lutKey;
    }
    // 应用视口变换
    ctx.imageSmoothingEnabled = vpst.scale < 2;
    ctx.save();
    ctx.translate(cw / 2 + (vpst.translation ? vpst.translation.x : 0), ch / 2 + (vpst.translation ? vpst.translation.y : 0));
    ctx.rotate((vpst.rotation || 0) * Math.PI / 180);
    ctx.scale(vpst.hflip ? -vpst.scale : vpst.scale, vpst.vflip ? -vpst.scale : vpst.scale);
    ctx.drawImage(vp._off, -img.columns / 2, -img.rows / 2);
    ctx.restore();
  }

  // ============ 覆盖层（文本/标尺/定位线） ============
  function renderOverlay(vp, ev) {
    // cornerstone 已渲染，附加覆盖 canvas
    let ov = vp.overlayCanvas;
    if (!ov || ov.parentElement !== vp.cell) {
      if (ov) ov.remove();
      ov = el("canvas"); ov.className = "overlay-canvas";
      Object.assign(ov.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: 6 });
      vp.cell.appendChild(ov);
      vp.overlayCanvas = ov;
    }
    requestAnimationFrame(() => drawOverlay(vp, ev));
  }
  function requestOverlayRedraw() {
    for (const vp of App.viewports) {
      if (vp.elem && vp.renderedVp) drawOverlay(vp, { viewport: vp.renderedVp, element: vp.elem });
    }
  }

  function drawOverlay(vp, ev) {
    const ov = vp.overlayCanvas;
    if (!ov) return;
    const w = vp.elem.clientWidth, h = vp.elem.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (ov.width !== w * dpr) { ov.width = w * dpr; ov.height = h * dpr; }
    const ctx = ov.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const img = cornerstone.getEnabledElement(vp.elem).image;
    if (!img) return;
    const md = img.metaData || {};
    const vpState = ev.viewport || cornerstone.getViewport(vp.elem);
    const ser = App.series[vp.seriesIdx];
    const serMeta = ser ? ser.meta : {};
    const stMeta = App.meta ? App.meta.study : {};
    const paMeta = App.meta ? App.meta.patient : {};

    const shown = (serMeta.images && serMeta.images[vp.index]) || {};
    const ww = Math.round(vpState.voi.windowWidth), wl = Math.round(vpState.voi.windowCenter);
    const zoom = vpState.scale;

    if (App.showInfo) {
      const italic = (t) => { ctx.font = 'italic 13px "Segoe UI","Microsoft YaHei"'; return t; };
      ctx.fillStyle = "#fff"; ctx.textBaseline = "top";
      // 左上
      ctx.textAlign = "left";
      const patName = App.anonymous ? "匿名" : (paMeta.name || md.patientName || "");
      const patId = App.anonymous ? "匿名" : (paMeta.id || md.patientId || "");
      const lines = [`Name: ${patName}`, `PatId: ${patId}`, `Age: ${paMeta.age || md.patientAge || ""}`, `Sex: ${paMeta.sex || md.patientSex || ""}`];
      lines.forEach((t, i) => ctx.fillText(t, 10, 7 + i * 19));
      // 右上
      ctx.textAlign = "right";
      const rLines = [
        stMeta.institution || md.institution || "",
        stMeta.modelName || md.modelName || "",
        `${stMeta.date || md.studyDate || ""} ${fmtDicomTime(md.acquisitionTime || serMeta.time || stMeta.time || md.studyTime)}`,
        serMeta.description || md.seriesDescription || "",
      ].filter(x => x);
      rLines.forEach((t, i) => ctx.fillText(t, w - 10, 7 + i * 19));
      // 左下
      ctx.textAlign = "left";
      const bl = [`Zoom: ${zoom.toFixed(2)}`, `WW/WL: ${ww}/${wl}`];
      const fsVal = fieldStrength();
      const thVal = thTxt(serMeta, md);
      if (fsVal || thVal) bl.push(`FS: ${fsVal || ""} Th: ${thVal}`);
      if (md.tr || md.te) {
        const rt = parseFloat(md.tr), te = parseFloat(md.te);
        bl.push(`RT: ${isNaN(rt) ? md.tr : rt.toFixed(1)} TE: ${isNaN(te) ? md.te : te.toFixed(1)}`);
      }
      bl.forEach((t, i) => ctx.fillText(t, 10, h - 8 - (bl.length - 1 - i) * 19));
      // 右下
      ctx.textAlign = "right";
      const br = [`Im: ${vp.index + 1}/${serMeta.imageCount || "?"}`, `Se: ${serMeta.seriesNumber ?? ""}`];
      br.forEach((t, i) => ctx.fillText(t, w - 10, h - 8 - (br.length - 1 - i) * 19));
      // 方位标记
      const parsed = img.parsed;
      if (parsed && parsed.imageOrientation) {
        const lab = orientationLabels(parsed.imageOrientation);
        ctx.textAlign = "center";
        if (lab.top) ctx.fillText(lab.top, w / 2, 7);
        if (lab.left) ctx.fillText(lab.left, 10, h / 2 - 8);
      }
    }
    // 标尺
    drawScaleRuler(ctx, vp, img, vpState, w, h);
    // 定位线（十字线工具或开启定位线时）
    if ((App.showLocalizer || App.crossMode) && App.viewports.length > 1) drawLocalizerLines(ctx, vp, img, ev);
    if (App.ratioMode) drawRatioLines(ctx, vp, img, vpState);
  }

  // DICOM 时间 "160643.790709" → "16:06:43"
  function fmtDicomTime(t) {
    if (!t) return "";
    const s = String(t).split(".")[0].padStart(6, "0");
    return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  }

  // 磁场强度（原版 MR 显示 FS: 3.00；PET-CT 不显示）
  function fieldStrength() {
    const mod = (App.meta && App.meta.study.modality) || "";
    return mod === "MR" ? "3.00" : "";
  }
  function thTxt(serMeta, md) {
    const t = serMeta.thickness || md.sliceThickness;
    return t ? (+t).toFixed(0) + "mm" : "";
  }

  function drawScaleRuler(ctx, vp, img, vpState, w, h) {
    // 10cm 或 5cm 自适应标尺
    const psRow = img.rowPixelSpacing || 1;
    // 屏幕上 1mm = scale 像素（cornerstone scale: 图像像素→屏幕）
    const pxPerMm = vpState.scale * psRow;
    let cm = 10;
    const target = w * 0.12; // 理想长度
    while (cm * 10 * pxPerMm > target * 2 && cm > 1) cm = Math.max(1, Math.round(cm / 2));
    const lenPx = cm * 10 * pxPerMm;
    if (lenPx < 8 || lenPx > w) return;
    const x = w - 26, y0 = h * 0.30, y1 = y0 + lenPx;
    ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.fillStyle = "#fff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    // 刻度
    const ticks = cm * 2;
    for (let i = 0; i <= ticks; i++) {
      const ty = y0 + (lenPx * i) / ticks;
      const tw = i % 2 === 0 ? 7 : 4;
      ctx.moveTo(x - tw, ty); ctx.lineTo(x, ty);
    }
    ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.font = 'italic 13px "Segoe UI","Microsoft YaHei"';
    ctx.fillText(`${cm} cm`, x - 10, (y0 + y1) / 2);
  }

  // 定位线：其他视口当前平面与本平面交线
  function drawLocalizerLines(ctx, vp, img, ev) {
    const myParsed = img.parsed;
    if (!myParsed || !myParsed.imagePosition || !myParsed.imageOrientation) return;
    const myN = planeNormal(myParsed.imageOrientation);
    const myD = dot(myParsed.imagePosition, myN);
    for (const other of App.viewports) {
      if (other === vp || other.seriesIdx < 0) continue;
      const oSer = App.series[other.seriesIdx];
      const oParsed = oSer.parsedByIndex && oSer.parsedByIndex.get(other.index);
      if (!oParsed || !oParsed.imagePosition || !oParsed.imageOrientation) continue;
      const oN = planeNormal(oParsed.imageOrientation);
      const oD = dot(oParsed.imagePosition, oN);
      if (Math.abs(dot(myN, oN)) > 0.99) {
        // 平行平面：若位置不同，绘制矩形框
        if (Math.abs(myD - oD) < 0.01) continue;
        drawPlaneRect(ctx, vp, oParsed, "#30d0ff");
        continue;
      }
      // 相交直线：求两平面交线，再投影到本视口
      const line = intersectPlanes(myN, myD, oN, oD);
      if (!line) continue;
      drawProjectedLine(ctx, vp, line, "#30d0ff");
    }
  }

  function drawPlaneRect(ctx, vp, oParsed, color) {
    // 将其他序列的FOV四角投影到本视口绘制矩形
    const pts = fovCorners(oParsed);
    const scr = pts.map(p => worldToScreen(vp, p));
    if (scr.some(s => !s)) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    scr.forEach((s, i) => i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]));
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }

  function fovCorners(parsed) {
    const [rx, ry, rz] = parsed.imageOrientation.slice(0, 3);
    const [cx, cy, cz] = parsed.imageOrientation.slice(3, 6);
    const [psR, psC] = parsed.pixelSpacing || [1, 1];
    const W = parsed.cols * psC, H = parsed.rows * psR;
    const [ox, oy, oz] = parsed.imagePosition;
    return [
      [ox, oy, oz],
      [ox + rx * W, oy + ry * W, oz + rz * W],
      [ox + rx * W + cx * H, oy + ry * W + cy * H, oz + rz * W + cz * H],
      [ox + cx * H, oy + cy * H, oz + cz * H],
    ];
  }

  // 世界坐标 → 本视口屏幕坐标
  function worldToScreen(vp, p) {
    const img = cornerstone.getEnabledElement(vp.elem).image;
    if (!img || !img.parsed || !img.parsed.imageOrientation) return null;
    const parsed = img.parsed;
    const [rx, ry, rz] = parsed.imageOrientation.slice(0, 3);
    const [cx, cy, cz] = parsed.imageOrientation.slice(3, 6);
    const o = parsed.imagePosition;
    const [psR, psC] = parsed.pixelSpacing || [1, 1];
    const rel = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const colIdx = dot(rel, [rx, ry, rz]) / psC;
    const rowIdx = dot(rel, [cx, cy, cz]) / psR;
    const vpState = cornerstone.getViewport(vp.elem);
    const w = vp.elem.clientWidth, h = vp.elem.clientHeight;
    // cornerstone 显示变换（缩放+平移，图像中心对齐）
    const scale = vpState.scale;
    const cxOff = vpState.translation.x, cyOff = vpState.translation.y;
    const sx = w / 2 + (colIdx - parsed.cols / 2) * scale + cxOff;
    const sy = h / 2 + (rowIdx - parsed.rows / 2) * scale + cyOff;
    return [sx, sy];
  }

  function drawProjectedLine(ctx, vp, line, color) {
    // line: {point:[x,y,z], dir:[x,y,z]}
    // 与本视口平面求交参数化后投影两端点（用大跨度采样两点）
    const p1 = line.point, d = line.dir;
    const a = [p1[0] - d[0] * 1000, p1[1] - d[1] * 1000, p1[2] - d[2] * 1000];
    const b = [p1[0] + d[0] * 1000, p1[1] + d[1] * 1000, p1[2] + d[2] * 1000];
    const s1 = worldToScreen(vp, a), s2 = worldToScreen(vp, b);
    if (!s1 || !s2) return;
    const w = vp.elem.clientWidth, h = vp.elem.clientHeight;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    // 线段裁剪到视口
    ctx.beginPath();
    ctx.moveTo(...clipToRect(s1, s2, w, h)[0]);
    const cl = clipToRect(s1, s2, w, h);
    if (cl) { ctx.moveTo(cl[0][0], cl[0][1]); ctx.lineTo(cl[1][0], cl[1][1]); ctx.stroke(); }
    ctx.restore();
  }

  function clipToRect(a, b, w, h) {
    // Liang-Barsky
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [a[0], w - a[0], a[1], h - a[1]];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
  }

  function planeNormal(iop) {
    const r = iop.slice(0, 3), c = iop.slice(3, 6);
    return norm(cross(r, c));
  }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function intersectPlanes(n1, d1, n2, d2) {
    const dir = cross(n1, n2);
    if (Math.hypot(...dir) < 1e-6) return null;
    const nd = norm(dir);
    // 解 n1·p=d1, n2·p=d2, n3·p=0 (n3=dir)
    const n3 = nd;
    const det = [[n1[0], n1[1], n1[2]], [n2[0], n2[1], n2[2]], [n3[0], n3[1], n3[2]]];
    const rhs = [d1, d2, 0];
    // 3x3 求解（克莱姆）
    const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(det);
    if (Math.abs(D) < 1e-9) return null;
    const swapCol = (col) => det.map((row, i) => row.map((v, j) => j === col ? rhs[i] : v));
    const x = det3(swapCol(0)) / D, y = det3(swapCol(1)) / D, z = det3(swapCol(2)) / D;
    return { point: [x, y, z], dir: nd };
  }

  // 心胸比：两次画线（心宽/胸宽），显示比值
  function drawRatioLines(ctx, vp, img, vpState) {
    App.ratioState = App.ratioState || {};
    const st = App.ratioState[App.viewports.indexOf(vp)];
    if (!st || !st.heart || !st.chest) return;
    ctx.save();
    ctx.strokeStyle = "#ffd54f"; ctx.lineWidth = 1.6; ctx.fillStyle = "#ffd54f";
    ctx.font = 'italic 13px "Segoe UI"';
    const s1 = imgToScreenPt(vp, img, vpState, st.heart.a), e1 = imgToScreenPt(vp, img, vpState, st.heart.b);
    const s2 = imgToScreenPt(vp, img, vpState, st.chest.a), e2 = imgToScreenPt(vp, img, vpState, st.chest.b);
    ctx.beginPath(); ctx.moveTo(...s1); ctx.lineTo(...e1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...s2); ctx.lineTo(...e2); ctx.stroke();
    const lh = Math.hypot(st.heart.a[0] - st.heart.b[0], st.heart.a[1] - st.heart.b[1]);
    const lt = Math.hypot(st.chest.a[0] - st.chest.b[0], st.chest.a[1] - st.chest.b[1]);
    ctx.fillText(`CTR: ${(lh / lt).toFixed(2)}`, Math.min(s2[0], e2[0]), s2[1] - 8);
    ctx.restore();
  }
  function imgToScreenPt(vp, img, vpState, imgPt) {
    const w = vp.elem.clientWidth, h = vp.elem.clientHeight;
    return [
      w / 2 + (imgPt[0] - img.columns / 2) * vpState.scale + vpState.translation.x,
      h / 2 + (imgPt[1] - img.rows / 2) * vpState.scale + vpState.translation.y,
    ];
  }
  // 屏幕点 → 图像坐标（心胸比用）
  function screenToImgPt(vp, sx, sy) {
    const img = cornerstone.getEnabledElement(vp.elem).image;
    if (!img) return null;
    const vpState = cornerstone.getViewport(vp.elem);
    const w = vp.elem.clientWidth, h = vp.elem.clientHeight;
    return [
      (sx - w / 2 - vpState.translation.x) / vpState.scale + img.columns / 2,
      (sy - h / 2 - vpState.translation.y) / vpState.scale + img.rows / 2,
    ];
  }

  // ============ 缩略图 ============
  function buildThumbs() {
    const scroll = $("#thumbScroll");
    scroll.innerHTML = "";
    App.series.forEach((ser, i) => {
      const item = el("div", "thumb-item");
      item.dataset.idx = i;
      item.innerHTML = `<div class="thumb-box"><canvas></canvas></div>
        <div class="thumb-desc">${ser.meta.description || ("序列" + ser.meta.seriesNumber)}</div>
        <div class="thumb-meta"><span>${ser.meta.imageCount}</span><span>Ser:${ser.meta.seriesNumber}</span></div>`;
      item.addEventListener("click", () => {
        setActiveVp(0);
        loadSeriesToVp(App.viewports[0], i, 0);
      });
      scroll.appendChild(item);
    });
    highlightThumb();
    // 生成首图缩略
    App.series.forEach((ser, i) => genThumb(i));
  }

  function highlightThumb() {
    const cur = App.viewports[App.activeVp];
    document.querySelectorAll(".thumb-item").forEach(t =>
      t.classList.toggle("active", cur && cur.seriesIdx === +t.dataset.idx));
  }

  async function genThumb(i) {
    const ser = App.series[i];
    try {
      const idx = Math.min(1, ser.meta.imageCount - 1);
      const img = await loadImage(i, idx);
      ser.parsedByIndex = ser.parsedByIndex || new Map();
      ser.parsedByIndex.set(idx, img.parsed);
      if (i === 0 && idx !== 0) {
        const im0 = await loadImage(i, 0);
        ser.parsedByIndex.set(0, im0.parsed);
      }
      const canvas = document.querySelector(`.thumb-item[data-idx="${i}"] canvas`);
      if (!canvas) return;
      renderGrayscale(canvas, img, 86);
    } catch (e) { console.warn("thumb fail", i, e.message); }
  }

  // 手动窗口化灰度渲染（缩略图用，避免 cornerstone 元素生命周期开销）
  function renderGrayscale(canvas, img, boxSize) {
    const pixels = img.getPixelData();
    const is16 = pixels instanceof Int16Array || pixels instanceof Uint16Array;
    const wc = img.windowCenter, ww = img.windowWidth || 1;
    const lo = wc - ww / 2, hi = wc + ww / 2;
    const scale = Math.min(boxSize / img.columns, boxSize / img.rows);
    const w = Math.max(1, Math.round(img.columns * scale)), h = Math.max(1, Math.round(img.rows * scale));
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const im = ctx.createImageData(w, h);
    const invert = img.color ? false : img.photometricInterpretation === "MONOCHROME1";
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.rows - 1, Math.round(y / scale));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.columns - 1, Math.round(x / scale));
        let v = pixels[sy * img.columns + sx];
        if (is16) {
          // 有符号→应用斜率截距（CT等）
          v = v * (img.slope || 1) + (img.intercept || 0);
          let g = (v - lo) / ww * 255;
          g = g < 0 ? 0 : g > 255 ? 255 : g;
          if (invert) g = 255 - g;
          const o = (y * w + x) * 4;
          im.data[o] = im.data[o + 1] = im.data[o + 2] = g;
          im.data[o + 3] = 255;
        } else {
          const o = (y * w + x) * 4;
          im.data[o] = im.data[o + 1] = im.data[o + 2] = v;
          im.data[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  // 序列当前图元数据缓存（供同步/定位线）
  function cacheParsed(vp, img) {
    const ser = App.series[vp.seriesIdx];
    if (!ser) return;
    ser.parsedByIndex = ser.parsedByIndex || new Map();
    ser.parsedByIndex.set(vp.index, img.parsed);
    ser.curParsed = img.parsed;
  }

  // ============ 播放 ============
  function togglePlay() {
    App.playing = !App.playing;
    updatePlayBtns();
    if (App.playing) {
      App.playTimer = setInterval(() => {
        const vp = App.viewports[App.activeVp];
        if (!vp || vp.seriesIdx < 0) return;
        const ser = App.series[vp.seriesIdx];
        let ni = vp.index + 1;
        if (ni >= ser.meta.imageCount) ni = 0;
        vp.index = ni;
        loadImage(vp.seriesIdx, ni).then(img => {
          cornerstone.displayImage(vp.elem, img);
          cornerstone.updateImage(vp.elem);
          updateCineBar();
        }).catch(() => { });
      }, 1000 / App.fps);
    } else if (App.playTimer) {
      clearInterval(App.playTimer);
      App.playTimer = null;
    }
  }
  function updatePlayBtns() {
    const b = $("#btnPlay");
    if (b) b.innerHTML = icon(App.playing ? "ic-pause" : "ic-play");
    document.querySelectorAll("[data-playtoggle]").forEach(x => x.innerHTML = icon(App.playing ? "ic-pause" : "ic-play"));
  }
  function updateCineBar() {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) { $("#cineBar").style.opacity = .4; return; }
    $("#cineBar").style.opacity = 1;
    const ser = App.series[vp.seriesIdx];
    const slider = $("#cineSlider");
    slider.max = ser.meta.imageCount - 1;
    slider.value = vp.index;
    $("#cinePos").textContent = `${vp.index + 1}/${ser.meta.imageCount}`;
  }

  // ============ 同步 ============
  function applySyncToVp(vp) { /* 占位：同步器在交互时生效 */ }
  function setupSynchronizers() {
    // 图像Id同步 / 位置同步 / 缩放平移 / 窗宽窗位
    App.sync.imageId && null;
  }
  function onSyncCheckboxChanged() {
    App.sync.imageId = $("#syncImageId").checked;
    App.sync.autoPos = $("#syncAutoPos").checked;
    App.sync.manualPos = $("#syncManualPos").checked;
    App.sync.zoomPan = $("#syncZoomPan").checked;
    App.sync.wwwl = $("#syncWwwl").checked;
    bindSyncHandlers();
  }
  let syncBindings = null;
  function bindSyncHandlers() {
    // 移除旧的
    if (syncBindings) syncBindings.forEach(fn => fn());
    syncBindings = [];
    const onRendered = (e) => {
      const vp = App.viewports.find(v => v.elem === e.target);
      if (!vp) return;
      if (App.sync.wwwl && e.detail.viewport.voi) {
        const src = App.viewports.find(v => v.elem === e.detail.element);
        App.viewports.forEach(v => {
          if (v === vp || v.seriesIdx < 0) return;
          const st = cornerstone.getViewport(v.elem);
          if (st.voi.windowWidth !== e.detail.viewport.voi.windowWidth) {
            st.voi.windowWidth = e.detail.viewport.voi.windowWidth;
            st.voi.windowCenter = e.detail.viewport.voi.windowCenter;
            cornerstone.updateImage(v.elem);
          }
        });
      }
    };
    for (const vp of App.viewports) {
      const h = (e) => {
        const srcVp = App.viewports.find(v => v.elem === e.target);
        if (!srcVp) return;
        // WW/WL 同步（在 wwwc 工具拖动结束时同步其他视口）
        if (App.sync.wwwl && App.currentTool === "wl") {
          const st = cornerstone.getViewport(e.target);
          App.viewports.forEach(v => {
            if (v === srcVp || v.seriesIdx < 0) return;
            const s2 = cornerstone.getViewport(v.elem);
            s2.voi.windowWidth = st.voi.windowWidth;
            s2.voi.windowCenter = st.voi.windowCenter;
            cornerstone.updateImage(v.elem);
          });
        }
        // 缩放平移同步
        if (App.sync.zoomPan && (App.currentTool === "zoom" || App.currentTool === "pan")) {
          const st = cornerstone.getViewport(e.target);
          App.viewports.forEach(v => {
            if (v === srcVp || v.seriesIdx < 0) return;
            const s2 = cornerstone.getViewport(v.elem);
            s2.scale = st.scale; s2.translation = { ...st.translation };
            s2.rotation = st.rotation; s2.hflip = st.hflip; s2.vflip = st.vflip;
            cornerstone.updateImage(v.elem);
          });
        }
      };
      vp.elem.addEventListener("mouseup", h);
      vp.elem.addEventListener("CornerstoneToolsMouseMove", h);
      syncBindings.push(() => vp.elem.removeEventListener("mouseup", h));
      // 图片切换时同步
      vp.elem.addEventListener("cornerstoneimagerendered", (e) => {
        const img = e.detail.image;
        cacheParsed(vp, img);
        onImageChangedDebounced(vp);
      });
    }
  }
  let syncDebounce = null;
  function onImageChangedDebounced(vp) {
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => onImageChanged(vp), 60);
  }

  // ============ 手动位置同步（点击点→跳转到包含该点的切片） ============
  function manualSyncPick(vp, evt) {
    if (!App.sync.manualPos) return false;
    const img = cornerstone.getEnabledElement(vp.elem).image;
    if (!img || !img.parsed || !img.parsed.imagePosition) return false;
    const rect = vp.elem.getBoundingClientRect();
    const sx = evt.clientX - rect.left, sy = evt.clientY - rect.top;
    // 屏幕点→图像列行→世界坐标
    const vpState = cornerstone.getViewport(vp.elem);
    const col = (sx - vp.elem.clientWidth / 2 - vpState.translation.x) / vpState.scale + img.columns / 2;
    const row = (sy - vp.elem.clientHeight / 2 - vpState.translation.y) / vpState.scale + img.rows / 2;
    const parsed = img.parsed;
    const [rx, ry, rz] = parsed.imageOrientation.slice(0, 3);
    const [cx, cy, cz] = parsed.imageOrientation.slice(3, 6);
    const [psR, psC] = parsed.pixelSpacing || [1, 1];
    const o = parsed.imagePosition;
    const wp = [o[0] + rx * col * psC + cx * row * psR, o[1] + ry * col * psC + cy * row * psR, o[2] + rz * col * psC + cz * row * psR];
    App.viewports.forEach(v => {
      if (v === vp || v.seriesIdx < 0) return;
      const ser = App.series[v.seriesIdx];
      // 遍历该序列找最近的切片（用已有 parsed 缓存或按需取 meta 无位置——加载当前邻近切片推算）
      // 简化：用系列第一张的方向 + 序列内位置估算
      ensureSeriesGeometry(v.seriesIdx).then(geo => {
        if (!geo) return;
        const n = geo.normal;
        const d = dot([wp[0] - geo.origin[0], wp[1] - geo.origin[1], wp[2] - geo.origin[2]], n);
        const step = Math.max(0.1, geo.spacing);
        const ni = Math.max(0, Math.min(ser.meta.imageCount - 1, Math.round(d / step)));
        jumpTo(v, ni);
      });
    });
    return true;
  }

  async function ensureSeriesGeometry(sIdx) {
    const ser = App.series[sIdx];
    if (ser._geo) return ser._geo;
    try {
      const img = await loadImage(sIdx, 0);
      const parsed = img.parsed;
      if (!parsed.imagePosition || !parsed.imageOrientation) return null;
      ser._geo = {
        origin: parsed.imagePosition,
        normal: planeNormal(parsed.imageOrientation),
        spacing: parsed.sliceThickness || (parsed.pixelSpacing ? parsed.pixelSpacing[0] : 1),
      };
      return ser._geo;
    } catch { return null; }
  }

  // ============ 全局事件 ============
  function bindGlobalEvents() {
    // 面板折叠
    document.querySelectorAll(".panel-section > .sec-title").forEach(t => {
      t.addEventListener("click", () => t.parentElement.classList.toggle("collapsed"));
    });
    // 工具按钮
    document.querySelectorAll("[data-tool]").forEach(b => {
      b.addEventListener("click", () => setToolActive(b.dataset.tool));
    });
    // 布局
    document.querySelectorAll("[data-serlayout]").forEach(b => {
      b.addEventListener("click", () => {
        const v = +b.dataset.serlayout;
        setSeriesLayout(Math.floor(v / 10), v % 10);
      });
    });
    document.querySelectorAll("[data-imglayout]").forEach(b => {
      b.addEventListener("click", () => {
        const v = +b.dataset.imglayout;
        App.imageLayout = { rows: Math.floor(v / 10), cols: v % 10 };
        document.querySelectorAll("[data-imglayout]").forEach(x => x.classList.toggle("active", +x.dataset.imglayout === v));
        toast("图像布局已切换（当前序列）", 1200);
      });
    });
    // 图像工具
    $("#btnRotCw").addEventListener("click", () => rotateActive(90));
    $("#btnRotCcw").addEventListener("click", () => rotateActive(-90));
    $("#btnFlipH").addEventListener("click", () => flipActive("h"));
    $("#btnFlipV").addEventListener("click", () => flipActive("v"));
    $("#btnInvert").addEventListener("click", () => invertActive());
    // 播放
    document.querySelectorAll("[data-playtoggle]").forEach(b => b.addEventListener("click", togglePlay));
    document.querySelectorAll("[data-playprev]").forEach(b => b.addEventListener("click", () => { const vp = App.viewports[App.activeVp]; if (vp) { jumpTo(vp, 0); } }));
    document.querySelectorAll("[data-playnext]").forEach(b => b.addEventListener("click", () => { const vp = App.viewports[App.activeVp]; if (vp && vp.seriesIdx >= 0) jumpTo(vp, App.series[vp.seriesIdx].meta.imageCount - 1); }));
    document.querySelectorAll("[data-prevseries]").forEach(b => b.addEventListener("click", () => switchSeries(-1)));
    document.querySelectorAll("[data-nextseries]").forEach(b => b.addEventListener("click", () => switchSeries(1)));
    $("#fpsSelect").addEventListener("change", (e) => {
      App.fps = +e.target.value;
      if (App.playing) { togglePlay(); togglePlay(); }
    });
    // 定位线/同步复选
    $("#cbLocalizer").addEventListener("change", e => { App.showLocalizer = e.target.checked; requestOverlayRedraw(); });
    ["syncImageId", "syncAutoPos", "syncManualPos", "syncZoomPan", "syncWwwl"].forEach(id => {
      const c = document.getElementById(id);
      if (c) c.addEventListener("change", onSyncCheckboxChanged);
    });
    // 影像定位线（桌面面板）
    // cine bar
    $("#cineSlider").addEventListener("input", (e) => {
      const vp = App.viewports[App.activeVp];
      if (!vp || vp.seriesIdx < 0) return;
      jumpTo(vp, +e.target.value);
    });
    // 信息菜单
    $("#btnToggleInfo").addEventListener("click", () => { App.showInfo = true; App.anonymous = false; requestOverlayRedraw(); });
    $("#btnAnonymous").addEventListener("click", () => { App.anonymous = true; requestOverlayRedraw(); });
    $("#btnDcmInfo").addEventListener("click", showDcmInfoDialog);
    $("#btnExportImage").addEventListener("click", exportCurrentImage);
    $("#btnExportZip").addEventListener("click", showExportDialog);
    $("#btnAbout").addEventListener("click", showAboutDialog);
    $("#btnFullscreen").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => { });
    });
    $("#btnHome").addEventListener("click", () => showStartupDialog(true));
    // 缩略图列上下滚动（原版右侧箭头）
    const up = document.getElementById("thumbUp"), down = document.getElementById("thumbDown");
    if (up) up.addEventListener("click", () => $("#thumbScroll").scrollBy({ top: -200, behavior: "smooth" }));
    if (down) down.addEventListener("click", () => $("#thumbScroll").scrollBy({ top: 200, behavior: "smooth" }));
    // 键盘
    window.addEventListener("keydown", onKeydown);
    // 窗口尺寸变化
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // 移动端自动单视口
        if (window.innerWidth <= 860 && App.seriesLayout.rows * App.seriesLayout.cols > 1) {
          setSeriesLayout(1, 1);
          return;
        }
        for (const vp of App.viewports) {
          try { cornerstone.resize(vp.elem, true); } catch { }
        }
        requestOverlayRedraw();
      }, 150);
    });
    // 视口点击（手动同步/选中）
    document.getElementById("viewportArea").addEventListener("click", (e) => {
      const vp = App.viewports.find(v => v.elem === e.target.closest(".vp-inner"));
      if (!vp) return;
      setActiveVp(App.viewports.indexOf(vp));
      if (App.sync.manualPos) manualSyncPick(vp, e);
      if (App.ratioMode) handleRatioClick(vp, e);
    });
  }

  function switchSeries(dir) {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return;
    const ni = vp.seriesIdx + dir;
    if (ni < 0 || ni >= App.series.length) return;
    loadSeriesToVp(vp, ni, 0);
  }

  function handleRatioClick(vp, e) {
    const rect = vp.elem.getBoundingClientRect();
    const pt = [e.clientX - rect.left, e.clientY - rect.top];
    App.ratioState = App.ratioState || {};
    const key = App.viewports.indexOf(vp);
    const st = App.ratioState[key] = App.ratioState[key] || { heart: null, chest: null, phase: 0 };
    const imgPt = screenToImgPt(vp, pt[0], pt[1]);
    if (st.phase === 0) { st.heart = { a: imgPt }; st.phase = 1; toast("绘制心缘线：拖到另一端点击", 1500); }
    else if (st.phase === 1) { st.heart.b = imgPt; st.phase = 2; toast("绘制胸廓线", 1500); }
    else if (st.phase === 2) { st.chest = { a: imgPt }; st.phase = 3; }
    else if (st.phase === 3) { st.chest.b = imgPt; st.phase = 0; requestOverlayRedraw(); }
    requestOverlayRedraw();
  }

  function rotateActive(deg) {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return;
    const st = cornerstone.getViewport(vp.elem);
    st.rotation = (st.rotation + deg) % 360;
    cornerstone.updateImage(vp.elem);
  }
  function flipActive(axis) {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return;
    const st = cornerstone.getViewport(vp.elem);
    if (axis === "h") st.hflip = !st.hflip; else st.vflip = !st.vflip;
    cornerstone.updateImage(vp.elem);
  }
  function invertActive() {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return;
    const st = cornerstone.getViewport(vp.elem);
    st.invert = !st.invert;
    cornerstone.updateImage(vp.elem);
  }

  function onKeydown(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    const map = { s: "scroll", z: "zoom", p: "pan", w: "wl", l: "length", e: "ellipse", a: "angle", r: "rotate", t: "textr" };
    if (map[k]) { setToolActive(map[k]); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { const vp = App.viewports[App.activeVp]; if (vp) scrollVp(vp, -1); }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { const vp = App.viewports[App.activeVp]; if (vp) scrollVp(vp, 1); }
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
  }

  // ============ 对话框 ============
  function openDialog(title, bodyEl, footEls) {
    const layer = $("#dlgLayer");
    layer.innerHTML = "";
    const dlg = el("div", "dialog");
    const head = el("div", "dlg-head");
    head.appendChild(el("span", "", title));
    const close = el("button", "dlg-close", "✕");
    close.addEventListener("click", () => hideDialog());
    head.appendChild(close);
    const body = el("div", "dlg-body");
    body.appendChild(bodyEl);
    dlg.appendChild(head); dlg.appendChild(body);
    if (footEls && footEls.length) {
      const foot = el("div", "dlg-foot");
      footEls.forEach(f => foot.appendChild(f));
      dlg.appendChild(foot);
    }
    layer.appendChild(dlg);
    layer.classList.add("show");
    return dlg;
  }
  function hideDialog() { $("#dlgLayer").classList.remove("show"); $("#dlgLayer").innerHTML = ""; }

  // 开屏
  async function showStartupDialog(reopen = false) {
    const body = el("div");
    const title = el("div", "", "数据包列表");
    title.style.cssText = "font-size:14px;color:#9aa3b0;margin-bottom:2px";
    body.appendChild(title);
    const list = el("div", "startup-list");
    body.appendChild(list);
    list.appendChild(el("div", "startup-empty", "正在扫描数据目录..."));
    const actions = el("div", "startup-actions");
    const btnZip = el("button", "", icon("ic-imagelist") + "<span>选择本地 Zip 解析</span>");
    const btnUrl = el("button", "", icon("ic-remote-host") + "<span>输入网址和密码下载</span>");
    actions.appendChild(btnZip); actions.appendChild(btnUrl);
    body.appendChild(actions);

    openDialog("医学影像查看器 — 打开数据", body, []);
    btnZip.addEventListener("click", () => pickLocalZip());
    btnUrl.addEventListener("click", () => showDownloadDialog());

    // 刷新列表
    const packages = await KStore.discoverPackages();
    list.innerHTML = "";
    if (!packages.length) {
      list.appendChild(el("div", "startup-empty", "数据目录为空：可将数据 zip 放入 data 目录，或使用下载功能"));
    }
    for (const pkg of packages) {
      const item = el("div", "startup-item");
      const badge = pkg.kind === "server-zip" || pkg.kind === "bridge-zip"
        ? '<span class="si-badge zip">ZIP</span>' : '<span class="si-badge">数据</span>';
      const sub = pkg.meta
        ? `${pkg.meta.study?.date || ""} · ${pkg.meta.study?.modality || ""} · ${pkg.meta.study?.imageCount || "?"}张 · ${pkg.meta.study?.seriesCount || "?"}序列`
        : `${(pkg.size / 1048576).toFixed(0)}MB · 点击解析`;
      item.innerHTML = `${badge}<div class="si-main"><div class="si-name">${KStore.displayName(pkg)}</div><div class="si-sub">${sub}</div></div>`;
      item.addEventListener("click", () => {
        loadPackage(pkg).catch(e => toast("打开失败: " + e.message, 3500));
      });
      list.appendChild(item);
    }
    if (reopen !== true && App.handle) { /* 已有数据时仍显示列表供切换 */ }
  }

  async function loadPackage(pkg) {
    toast("正在加载数据包...");
    const handle = await KStore.openPackage(pkg);
    if (App.handle) App.handle.close();
    App.handle = handle;
    App.meta = handle.meta;
    App.series = handle.meta.series.slice().sort((a, b) => (a.seriesNumber || 0) - (b.seriesNumber || 0))
      .map(m => ({ meta: m }));
    App.imageCache.clear(); App.cacheKeys = [];
    // 研究信息条（移动端）与缩略图面板头（桌面，与原版一致：姓名+生日 / 日期+描述）
    const st = App.meta.study, pa = App.meta.patient;
    $("#studyBar").innerHTML =
      `<span class="sb-count">${App.series.length}个序列</span>` +
      `<span>${st.date || ""} / ${st.modality || ""} / ${st.description || ""}</span>`;
    $("#thumbHeader").innerHTML =
      `<div class="th-count">${App.series.length}个序列</div>` +
      `<div class="th-pat">${pa.name || ""} ${pa.birth || ""}</div>` +
      `<div class="th-study"><span class="sb-date">${st.date || ""}</span> ${st.description || ""}</div>`;
    buildThumbs();
    // 窄屏（手机）默认单视口
    if (window.innerWidth <= 860) App.seriesLayout = { rows: 1, cols: 1 };
    setSeriesLayout(App.seriesLayout.rows, App.seriesLayout.cols);
    hideDialog();
    toast(`已加载：${pa.name} ${pa.id}（${App.series.length} 序列 / ${st.imageCount} 张）`);
  }

  // 选择本地 zip
  function pickLocalZip() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        await loadPackage({ kind: "local-zip", file: f, name: f.name });
      } catch (e) { toast("解析失败: " + e.message, 3500); }
    };
    input.click();
  }
  function pickLocalFolder() {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.onchange = async () => {
      try {
        await loadPackage({ kind: "local-folder", files: Array.from(input.files) });
      } catch (e) { toast("解析失败: " + e.message, 3500); }
    };
    input.click();
  }

  // 下载对话框
  function showDownloadDialog() {
    const body = el("div");
    body.innerHTML = `
      <div class="dl-form">
        <label>分享链接（粘贴含 shareId 的完整网址）</label>
        <input class="url-input" id="dlUrl" placeholder="https://www.kayicloud.com/Viewer/s#/view?ids=...">
        <label>4位分享密码</label>
        <div class="pwd-boxes">
          <input maxlength="1" inputmode="numeric" type="number"><input maxlength="1" inputmode="numeric" type="number"><input maxlength="1" inputmode="numeric" type="number"><input maxlength="1" inputmode="numeric" type="number">
        </div>
        <div class="dl-progress" style="display:none">
          <div class="bar"><div id="dlBarFill"></div></div>
          <div class="msg" id="dlMsg"></div>
        </div>
      </div>`;
    const btnOk = el("button", "btn-primary", "开始下载");
    const btnBack = el("button", "btn-plain", "返回");
    btnBack.addEventListener("click", () => showStartupDialog(true));
    openDialog("从分享链接下载数据", body, [btnBack, btnOk]);
    const boxes = Array.from(body.querySelectorAll(".pwd-boxes input"));
    boxes.forEach((b, i) => {
      b.addEventListener("input", () => { if (b.value && i < 3) boxes[i + 1].focus(); });
      b.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !b.value && i > 0) boxes[i - 1].focus(); });
    });
    btnOk.addEventListener("click", async () => {
      const url = body.querySelector("#dlUrl").value.trim();
      const pwd = boxes.map(b => b.value).join("");
      const m = url.match(/ids=([0-9a-f-]{36})/i);
      if (!m) return toast("请粘贴有效的分享链接（包含 ids=）", 2500);
      if (!/^\d{4}$/.test(pwd)) return toast("请输入4位密码", 2000);
      btnOk.disabled = true;
      btnOk.classList.add("waiting");
      btnOk.textContent = "连接中…";
      body.querySelector(".dl-progress").style.display = "block";
      const msg = body.querySelector("#dlMsg");
      const fill = body.querySelector("#dlBarFill");
      msg.innerHTML = '<span class="mini-spin"></span>正在连接服务器，请稍候…';
      // Android 原生下载
      if (KStore.hasBridge()) {
        window.__androidEvent = (ev) => {
          if (ev.type === "downloadProgress") {
            btnOk.textContent = "下载中…";
            if (ev.total > 1) fill.style.width = Math.min(100, (ev.cur / ev.total) * 100) + "%";
            msg.innerHTML = '<span class="mini-spin"></span>' + (ev.msg || "");
            if (ev.stage === "zip" || ev.stage === "done") fill.style.width = "100%";
          } else if (ev.type === "downloadDone") {
            btnOk.classList.remove("waiting");
            if (ev.ok) {
              msg.textContent = "下载完成！正在打开...";
              loadPackage({ kind: "bridge-folder", name: ev.name }).catch(e2 => toast("打开失败: " + e2.message, 3000));
            } else {
              msg.textContent = "下载失败: " + (ev.error || "");
              btnOk.disabled = false;
              btnOk.textContent = "开始下载";
            }
          }
        };
        window.AndroidBridge.downloadStudy(m[1], pwd, "");
        return;
      }
      try {
        const r = await fetch("/api/downloadStudy", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareId: m[1], password: pwd }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        const jobId = j.jobId;
        const poll = setInterval(async () => {
          const s = await (await fetch("/api/downloadStatus?jobId=" + jobId)).json();
          const fill = body.querySelector("#dlBarFill");
          const msg = body.querySelector("#dlMsg");
          if (s.stage === "start" || s.stage === "meta") {
            msg.innerHTML = '<span class="mini-spin"></span>' + (s.msg || "正在连接服务器…");
            btnOk.textContent = "连接中…";
          } else {
            btnOk.textContent = "下载中…";
            if (s.total > 1) fill.style.width = Math.min(100, (s.cur / s.total) * 100) + "%";
            msg.innerHTML = '<span class="mini-spin"></span>' + (s.msg || "");
            if (s.stage === "zip") fill.style.width = "100%";
          }
          if (s.done) {
            clearInterval(poll);
            btnOk.classList.remove("waiting");
            if (s.error) { msg.textContent = "下载失败: " + s.error; btnOk.disabled = false; btnOk.textContent = "开始下载"; return; }
            msg.textContent = "下载完成！正在打开...";
            const pkg = { kind: "server-folder", name: (s.result && s.result.name) || j.name };
            await loadPackage(pkg);
          }
        }, 700);
      } catch (e) {
        toast("下载失败: " + e.message, 3500);
        btnOk.disabled = false;
      }
    });
  }

  // 导出对话框
  function showExportDialog() {
    if (!App.handle) return toast("请先打开数据");
    const doServerExport = async () => {
      const body = el("div", "", `将当前研究打包为 zip 保存到本机（浏览器下载）。<br><br>数据包: <b>${App.handle.name}</b>`);
      const btn = el("button", "btn-primary", "打包并下载");
      const close = el("button", "btn-plain", "关闭");
      close.addEventListener("click", hideDialog);
      openDialog("导出数据包", body, [close, btn]);
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "打包中...";
        if (KStore.hasBridge()) {
          const r = await window.AndroidBridge.exportZip(App.handle.name);
          toast(r);
          btn.disabled = false; btn.textContent = "打包并下载";
        } else if (KStore.IS_SERVER) {
          const a = document.createElement("a");
          a.href = "/api/exportZip?name=" + encodeURIComponent(App.handle.name);
          a.download = App.handle.name + ".zip";
          a.click();
          setTimeout(() => { btn.disabled = false; btn.textContent = "打包并下载"; }, 2500);
        }
      });
    };
    if (App.handle.kind === "server-folder" || App.handle.kind === "bridge") doServerExport();
    else toast("当前数据来自本地文件，无需导出", 2000);
  }

  function exportCurrentImage() {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return toast("没有图像");
    const canvas = vp.elem.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = `image_se${App.series[vp.seriesIdx].meta.seriesNumber}_im${vp.index + 1}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    toast("已导出当前图像");
  }

  // DCM 标签
  async function showDcmInfoDialog() {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) return toast("没有图像");
    const ser = App.series[vp.seriesIdx];
    const buf = await App.handle.readFile(ser.meta.images[vp.index].file);
    const parsed = parseDicomFile(buf);
    const body = el("div");
    const rows = [
      ["Patient Name", parsed.patientName], ["Patient ID", parsed.patientId],
      ["Birth Date", parsed.patientBirth], ["Sex", parsed.patientSex], ["Age", parsed.patientAge],
      ["Study Date", parsed.studyDate], ["Study Time", parsed.studyTime],
      ["Study Description", parsed.studyDescription], ["Study UID", parsed.studyInstanceUID],
      ["Series Number", parsed.seriesNumber], ["Series Description", parsed.seriesDescription],
      ["Series UID", parsed.seriesInstanceUID], ["Modality", parsed.modality],
      ["Institution", parsed.institution], ["Model", parsed.modelName],
      ["Instance Number", parsed.instanceNumber], ["SOP UID", parsed.sopInstanceUID],
      ["Rows × Columns", `${parsed.rows} × ${parsed.cols}`],
      ["Pixel Spacing", parsed.pixelSpacing ? parsed.pixelSpacing.join(" \\ ") : ""],
      ["Slice Thickness", parsed.sliceThickness], ["Slice Location", parsed.sliceLocation],
      ["Image Position", parsed.imagePosition ? parsed.imagePosition.map(x => (+x).toFixed(2)).join(" \\ ") : ""],
      ["Image Orientation", parsed.imageOrientation ? parsed.imageOrientation.map(x => (+x).toFixed(4)).join(" \\ ") : ""],
      ["Bits Allocated", parsed.bitsAllocated], ["Photometric", parsed.photometric],
      ["Window Center/Width", `${parsed.windowCenter} / ${parsed.windowWidth}`],
      ["Rescale", `${parsed.rescaleSlope} / ${parsed.rescaleIntercept}`],
      ["TR / TE", `${parsed.tr ?? "-"} / ${parsed.te ?? "-"}`],
      ["Transfer Syntax", parsed.transferSyntax],
    ];
    const table = el("table", "tag-table");
    table.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v ?? "-"}</td></tr>`).join("");
    body.appendChild(table);
    openDialog("DCM 信息", body, []);
  }

  function showAboutDialog() {
    const body = el("div", "", `
      <div style="text-align:center;padding:10px 0">
        <div style="font-size:20px;font-weight:600;color:#fff">医学影像查看器</div>
        <div style="color:#8b95a3;margin-top:8px;font-size:12px">本地版 · 基于 cornerstone / dicom-parser 开源组件<br>
        数据与程序分离 · 支持本地 zip 数据包</div>
      </div>`);
    openDialog("关于", body, []);
  }

  // ============ 模式切换（2D/MPR/3D） ============
  function switchMode(mode) {
    if (mode === App.mode) return;
    if (mode === "2d") {
      if (window.KMpr) window.KMpr.leave();
      if ($("#mprContainer")) $("#mprContainer").remove();
      $("#viewportArea").style.display = "grid";
      App.mode = "2d";
      document.querySelector(".module-name").textContent = "2D Viewer";
      requestOverlayRedraw();
      return;
    }
    if (!App.handle) return toast("请先打开数据");
    $("#viewportArea").style.display = "block";
    if (typeof window.KMpr === "undefined") {
      loadScript("assets/js/kmpr.js").then(() => {
        window.KMpr.enter(mode, App);
        App.mode = mode;
        document.querySelector(".module-name").textContent = mode.toUpperCase() + " Viewer";
      }).catch(() => toast("MPR/3D 组件加载失败", 2500));
    } else {
      window.KMpr.enter(mode, App);
      App.mode = mode;
      document.querySelector(".module-name").textContent = mode.toUpperCase() + " Viewer";
    }
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("load fail"));
      document.head.appendChild(s);
    });
  }

  // ============ 初始化 ============
  async function init() {
    initCornerstoneTools();
    buildToolbarMenus();
    bindGlobalEvents();
    updatePlayBtns();
    startRenderLoop();
    // 开屏
    await showStartupDialog();
  }

  function closeAllDrops() {
    document.querySelectorAll(".tb-drop.open").forEach(d => d.classList.remove("open"));
  }
  // 打开下拉：用 fixed 定位挂到视口，避免被工具栏 overflow 裁剪/遮挡
  function openDrop(drop) {
    closeAllDrops();
    drop.classList.add("open");
    const btn = drop.querySelector("button");
    const menu = drop.querySelector(".tb-menu");
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";
    menu.style.display = "block";
    const mw = menu.offsetWidth || 170, mh = menu.offsetHeight || 100;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "visible";
  }
  function bindDrop(id, onItem) {
    const drop = document.getElementById(id);
    if (!drop) return;
    const btn = drop.querySelector("button");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (drop.classList.contains("open")) closeAllDrops();
      else openDrop(drop);
    });
    drop.querySelectorAll("[data-tool],[data-mode],[data-cmap]").forEach(item => {
      item.addEventListener("click", () => { closeAllDrops(); if (onItem) onItem(item); });
    });
  }

  function buildToolbarMenus() {
    document.addEventListener("click", closeAllDrops);
    window.addEventListener("resize", closeAllDrops);
    // 模式菜单（2D/MPR/3D/Endo + 热键标注，与原版一致）
    bindDrop("modeDrop", (item) => {
      const m = item.dataset.mode;
      if (m === "endo") { toast("内镜模式暂不可用", 1800); return; }
      switchMode(m);
    });
    // 测量下拉菜单
    bindDrop("measureDrop", (item) => {
      const t = item.dataset.tool;
      if (t) setToolActive(t);
    });
    // 信息下拉
    bindDrop("infoDrop");
    // 伪彩下拉
    bindDrop("cmapDrop", (item) => {
      const name = item.dataset.cmap;
      const vp = App.viewports[App.activeVp];
      if (!vp || vp.seriesIdx < 0) return;
      const st = cornerstone.getViewport(vp.elem);
      if (name === "none") st.colormap = undefined;
      else {
        try { st.colormap = cornerstone.getColormap(name); } catch { return toast("伪彩不可用"); }
      }
      cornerstone.updateImage(vp.elem);
    });
  }

  window.KApp = { App, init, setToolActive, loadPackage, showStartupDialog, switchMode };
})();
