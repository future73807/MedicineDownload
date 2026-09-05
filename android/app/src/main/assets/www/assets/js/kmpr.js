// MPR / 3D(MIP) 模块：自绘体渲染（轴/冠/矢三正交 + 最大密度投影）
// 数据：基于当前激活视口的序列，加载全部帧构建 Int16 volume
(function () {
  "use strict";

  let host = null, app = null;
  let volume = null, dim = { x: 0, y: 0, z: 0 }, spacing = { x: 1, y: 1, z: 1 };
  let views = [];       // {name, canvas, ctx, slice, axis}
  let ww = 400, wl = 40, wwRange = [1, 4000], playTimer = null;
  let active = false;

  function log(s) { try { console.log("[KMpr]", s); } catch (e) { } }

  async function buildVolume(App, onProgress) {
    const vp = App.viewports[App.activeVp];
    if (!vp || vp.seriesIdx < 0) throw new Error("请先选择一个序列");
    const ser = App.series[vp.seriesIdx];
    const n = ser.meta.imageCount;
    if (n > 600) throw new Error("序列过大(" + n + "帧)，MPR 请选择 ≤600 帧的序列");
    // 用第0帧确定几何
    const first = await loadParsed(App, ser, 0);
    const W = first.cols, H = first.rows;
    if (!first.pixelSpacing) throw new Error("缺少像素间距");
    const sx = first.pixelSpacing[1], sy = first.pixelSpacing[0];
    const sz = Math.max(0.1, first.sliceThickness || (ser.meta.thickness || sx));
    const vol = new Int16Array(W * H * n);
    const slope = first.rescaleSlope || 1, inter = first.rescaleIntercept || 0;
    const needMod = slope !== 1 || inter !== 0;
    for (let z = 0; z < n; z++) {
      const img = (z === 0) ? first : await loadParsed(App, ser, z);
      const px = img.pixelData;
      const base = z * W * H;
      if (needMod) for (let i = 0; i < W * H; i++) vol[base + i] = px[i] * slope + inter;
      else for (let i = 0; i < W * H; i++) vol[base + i] = px[i];
      if (onProgress && (z % 10 === 0 || z === n - 1)) onProgress(z + 1, n);
    }
    return { vol, W, H, n, sx, sy, sz, ser };
  }

  async function loadParsed(App, ser, idx) {
    const buf = await App.handle.readFile(ser.meta.images[idx].file);
    return window.KDcm.parseDicomFile(buf);
  }

  function enter(mode, App) {
    app = App;
    if (mode !== "mpr" && mode !== "3d") return;
    const vp = App.viewports[App.activeVp];
    const toast = (m) => { const t = document.getElementById("toast"); t.textContent = m; t.style.display = "block"; setTimeout(() => t.style.display = "none", 3000); };
    toast("正在构建体数据...");
    const serMeta = vp && vp.seriesIdx >= 0 ? App.series[vp.seriesIdx].meta : null;
    if (!serMeta) { toast("请先选择一个序列"); return; }
    buildVolume(App, (c, n) => {
      const t = document.getElementById("toast");
      t.textContent = `构建体数据 ${c}/${n}`;
      t.style.display = "block";
    }).then(v => {
      volume = v.vol;
      dim = { x: v.W, y: v.H, z: v.n };
      spacing = { x: v.sx, y: v.sy, z: v.sz };
      // 窗宽窗位初始值（取序列 WW/WL）
      const img0 = app.viewports[app.activeVp] && cornerstone.getEnabledElement(app.viewports[app.activeVp].elem).image;
      ww = (img0 && img0.windowWidth) || 400;
      wl = (img0 && img0.windowCenter) || 40;
      wwRange = [1, Math.max(1000, (img0 && img0.maxPixelValue) || 2000)];
      if (mode === "mpr") buildMprUI();
      else build3dUI();
      document.getElementById("toast").style.display = "none";
    }).catch(e => { toast("MPR/3D: " + e.message); });
  }

  function clearHost() {
    if (host) host.innerHTML = "";
    views = [];
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }

  function setupHost() {
    const area = document.getElementById("viewportArea");
    if (host && host.parentElement === area) { clearHost(); }
    else {
      if (host) host.remove();
      host = document.createElement("div");
      host.id = "mprContainer";
      Object.assign(host.style, { position: "absolute", inset: "0", display: "grid", background: "#000", zIndex: 50, gap: "2px" });
      area.style.position = "relative";
      area.appendChild(host);
    }
    return host;
  }

  function makeView(name, axis, gridArea) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;background:#000;overflow:hidden;outline:1px solid #1a1f27;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block";
    wrap.appendChild(canvas);
    const label = document.createElement("div");
    label.style.cssText = "position:absolute;top:4px;left:8px;color:#9fd0ff;font-size:12px;pointer-events:none";
    label.textContent = name;
    wrap.appendChild(label);
    const info = document.createElement("div");
    info.style.cssText = "position:absolute;bottom:4px;left:8px;color:#cfd5df;font-size:12px;font-style:italic;pointer-events:none";
    wrap.appendChild(info);
    host.appendChild(wrap);
    const view = { name, axis, canvas, ctx: canvas.getContext("2d"), info, slice: 0, wrap };
    views.push(view);
    bindSliceInput(view);
    return view;
  }

  function bindSliceInput(view) {
    const getMax = () => view.axis === "z" ? dim.z - 1 : (view.axis === "y" ? dim.y - 1 : dim.x - 1);
    view.wrap.addEventListener("wheel", (e) => {
      const d = e.deltaY > 0 ? 1 : -1;
      view.slice = Math.max(0, Math.min(getMax(), view.slice + d));
      renderAll();
      e.preventDefault();
    }, { passive: false });
    let dragging = false, lastY = 0;
    view.wrap.addEventListener("mousedown", (e) => { dragging = true; lastY = e.clientY; });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const d = e.clientY - lastY; lastY = e.clientY;
      if (d !== 0) {
        view.slice = Math.max(0, Math.min(getMax(), view.slice + (d > 0 ? 1 : -1)));
        renderAll();
      }
    });
    window.addEventListener("mouseup", () => dragging = false);
    // 触摸滑动切层
    let ty = 0;
    view.wrap.addEventListener("touchstart", (e) => { ty = e.touches[0].clientY; }, { passive: true });
    view.wrap.addEventListener("touchmove", (e) => {
      const y = e.touches[0].clientY;
      if (Math.abs(y - ty) > 24) {
        view.slice = Math.max(0, Math.min(getMax(), view.slice + (y > ty ? 1 : -1)));
        ty = y;
        renderAll();
      }
      e.preventDefault();
    }, { passive: false });
  }

  function buildMprUI() {
    active = true;
    const h = setupHost();
    h.style.gridTemplateColumns = "1fr 1fr";
    h.style.gridTemplateRows = "1fr 1fr";
    // 轴位(z)、冠状(y)、矢状(x) + 定位预览
    const vAx = makeView("Axial (轴位)", "z");  vAx.wrap.style.gridArea = "1/1";
    const vCo = makeView("Coronal (冠状)", "y"); vCo.wrap.style.gridArea = "1/2";
    const vSa = makeView("Sagittal (矢状)", "x"); vSa.wrap.style.gridArea = "2/1";
    // 右下：控制面板
    const panel = document.createElement("div");
    panel.style.cssText = "grid-area:2/2;background:#20252d;padding:14px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:#cfd5df";
    panel.innerHTML = `
      <div style="color:#fff;font-weight:600">MPR 控制</div>
      <label>窗宽 WW: <span id="mprWwV"></span><br><input id="mprWw" type="range" min="${wwRange[0]}" max="${wwRange[1]}" value="${ww}" style="width:100%"></label>
      <label>窗位 WL: <span id="mprWlV"></span><br><input id="mprWl" type="range" min="-1000" max="${wwRange[1]}" value="${wl}" style="width:100%"></label>
      <label>层间隔: <span id="mprSlV"></span><br><input id="mprSl" type="range" min="1" max="5" value="1" style="width:100%"></label>
      <label style="display:flex;align-items:center;gap:8px"><input id="mprCine" type="checkbox">轴位自动播放</label>
      <button id="mprBack" class="btn-plain" style="margin-top:auto;padding:8px">返回 2D</button>`;
    h.appendChild(panel);
    document.getElementById("mprWw").addEventListener("input", e => { ww = +e.target.value; renderAll(); });
    document.getElementById("mprWl").addEventListener("input", e => { wl = +e.target.value; renderAll(); });
    document.getElementById("mprSl").addEventListener("input", e => {
      const step = +e.target.value;
      views.forEach(v => { if (v.axis === "z") v.slice = Math.round(v.slice / step) * step; });
      document.getElementById("mprSlV").textContent = (step * spacing.z).toFixed(1) + "mm";
      renderAll();
    });
    document.getElementById("mprSlV").textContent = (spacing.z).toFixed(1) + "mm";
    document.getElementById("mprCine").addEventListener("change", e => {
      if (playTimer) { clearInterval(playTimer); playTimer = null; }
      if (e.target.checked) playTimer = setInterval(() => {
        const v = views[0];
        v.slice = (v.slice + 1) % dim.z;
        renderAll();
      }, 120);
    });
    document.getElementById("mprBack").addEventListener("click", () => window.KApp.switchMode("2d"));
    // 初始切层位置：各轴中心
    views.forEach(v => {
      v.slice = v.axis === "z" ? (dim.z >> 1) : v.axis === "y" ? (dim.y >> 1) : (dim.x >> 1);
    });
    resizeCanvases();
    renderAll();
  }

  function build3dUI() {
    active = true;
    const h = setupHost();
    h.style.gridTemplateColumns = "2fr 1fr";
    h.style.gridTemplateRows = "1fr";
    const vMip = makeView("3D MIP (最大密度投影·轴位)", "z");
    vMip.wrap.style.gridArea = "1/1";
    views.forEach(v => { v.slice = dim.z - 1; }); // MIP 用全部层
    const panel = document.createElement("div");
    panel.style.cssText = "grid-area:1/2;background:#20252d;padding:14px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:#cfd5df";
    panel.innerHTML = `
      <div style="color:#fff;font-weight:600">3D MIP</div>
      <div style="color:#8b95a3;line-height:1.6">沿轴位方向的最大密度投影。<br>说明：完整体渲染(VR)需 WebGL 体绘制引擎，此版本提供临床常用的 MIP。</div>
      <label>投影层数: <span id="mipN"></span><br><input id="mipDepth" type="range" min="8" max="${dim.z}" value="${dim.z}" style="width:100%"></label>
      <label>窗宽 WW:<br><input id="mipWw" type="range" min="${wwRange[0]}" max="${wwRange[1]}" value="${ww}" style="width:100%"></label>
      <label>窗位 WL:<br><input id="mipWl" type="range" min="-1000" max="${wwRange[1]}" value="${wl}" style="width:100%"></label>
      <button id="mipBack" class="btn-plain" style="margin-top:auto;padding:8px">返回 2D</button>`;
    h.appendChild(panel);
    const renderMip = () => {
      const depth = +document.getElementById("mipDepth").value;
      document.getElementById("mipN").textContent = depth + "层";
      ww = +document.getElementById("mipWw").value;
      wl = +document.getElementById("mipWl").value;
      drawMip(vMip, depth);
    };
    ["mipDepth", "mipWw", "mipWl"].forEach(id =>
      document.getElementById(id).addEventListener("input", renderMip));
    document.getElementById("mipBack").addEventListener("click", () => window.KApp.switchMode("2d"));
    resizeCanvases(renderMip);
  }

  function resizeCanvases(onDone) {
    requestAnimationFrame(() => {
      for (const v of views) {
        const r = v.wrap.getBoundingClientRect();
        if (r.width > 0) { v.canvas.width = Math.round(r.width * (devicePixelRatio || 1)); v.canvas.height = Math.round(r.height * (devicePixelRatio || 1)); }
      }
      if (onDone) onDone(); else renderAll();
    });
  }

  function applyWW(v) {
    let g = (v - wl) * (255 / ww) + 128;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    return g | 0;
  }

  // 绘制某个正交切面
  function drawSlice(view) {
    const { canvas, ctx, axis } = view;
    const W = dim.x, H = dim.y, Z = dim.z;
    let sw, sh, get;
    if (axis === "z") { sw = W; sh = H; get = (r, c) => volume[view.slice * W * H + r * W + c]; }
    else if (axis === "y") { sw = W; sh = Z; get = (r, c) => volume[r * W * H + view.slice * W + c]; }
    else { sw = H; sh = Z; get = (r, c) => volume[r * W * H + c * W + view.slice]; }
    if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; }
    const img = ctx.createImageData(sw, sh);
    for (let r = 0; r < sh; r++) {
      for (let c = 0; c < sw; c++) {
        const g = applyWW(get(r, c));
        const o = ((sh - 1 - r) * sw + c) * 4; // 翻转使解剖方向正确
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    view.info.textContent = `${axis === "z" ? "Z" : axis === "y" ? "Y" : "X"}: ${view.slice + 1}/${(axis === "z" ? dim.z : axis === "y" ? dim.y : dim.x)}`;
  }

  function drawMip(view, depth) {
    const { canvas, ctx } = view;
    const W = dim.x, H = dim.y, Z = dim.z;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const img = ctx.createImageData(W, H);
    const start = Math.max(0, Z - depth);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        let mx = -32768;
        for (let z = start; z < Z; z++) {
          const v = volume[z * W * H + r * W + c];
          if (v > mx) mx = v;
        }
        const g = applyWW(mx);
        const o = ((H - 1 - r) * W + c) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    view.info.textContent = `MIP ${Z - start}层`;
  }

  function renderAll() {
    for (const v of views) {
      if (v.name.startsWith("3D")) continue;
      drawSlice(v);
    }
    // 定位线：在每个视图上画其他两视图的当前切层位置
    drawCrosshair();
  }

  function drawCrosshair() {
    if (views.length < 3) return;
    const [ax, co, sa] = views;
    const lines = [
      [ax, { y: co.slice }],                 // 轴位上画冠状切层线(水平)
      [ax, { x: sa.slice }],                 // 轴位上画矢状切层线(垂直)
      [co, { x: sa.slice }],
      [co, { z: ax.slice }],
      [sa, { y: co.slice }],
      [sa, { z: ax.slice }],
    ];
    const color = "#30d0ff";
    for (const [v, pos] of lines) {
      const ctx = v.ctx;
      const wCss = v.wrap.clientWidth, hCss = v.wrap.clientHeight;
      if (!wCss) continue;
      // canvas 已按原始尺寸绘制，叠加层用第二个绝对定位 canvas？简化：直接画在主 canvas（下一帧重绘会刷新）
      // 使用 CSS 尺寸→canvas 坐标换算
      const sx = v.canvas.width / wCss, sy = v.canvas.height / hCss;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath();
      if (pos.y !== undefined) { const y = v.canvas.height - pos.y * sy; ctx.moveTo(0, y); ctx.lineTo(v.canvas.width, y); }
      if (pos.x !== undefined) { const x = pos.x * sx; ctx.moveTo(x, 0); ctx.lineTo(x, v.canvas.height); }
      if (pos.z !== undefined) { const z = v.canvas.height - pos.z * sy; ctx.moveTo(0, z); ctx.lineTo(v.canvas.width, z); }
      ctx.stroke();
      ctx.restore();
    }
  }

  function leave() {
    active = false;
    if (host) { host.innerHTML = ""; }
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }

  window.KMpr = { init() { }, enter, leave, isActive: () => active };
})();
