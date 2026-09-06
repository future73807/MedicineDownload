// 自研手势工具引擎：彻底替代 cornerstoneTools 的交互层
// 支持鼠标+触摸（Pointer Events）；标注存图像坐标，随视口变换渲染
(function () {
  "use strict";

  let App = null;

  // 每个视口的标注容器：App.toolAnno[vpKey] = [ {type, pts:[{x,y}], image:{w,h}, text, meta} ]
  function annoStore(vp) {
    const k = "vp" + App.viewports.indexOf(vp);
    App.toolAnno = App.toolAnno || {};
    App.toolAnno[k] = App.toolAnno[k] || [];
    return App.toolAnno[k];
  }

  // ---------- 坐标换算（与 drawPixels 的变换一致） ----------
  function imgPtFromEvent(vp, ev) {
    const rect = vp.elem.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    return screenToImg(vp, sx, sy);
  }
  function screenToImg(vp, sx, sy) {
    const ee = cornerstone.getEnabledElement(vp.elem);
    const img = ee.image, vpst = ee.viewport;
    const cw = vp.elem.clientWidth, ch = vp.elem.clientHeight;
    let x = (sx - cw / 2 - (vpst.translation ? vpst.translation.x : 0)) / vpst.scale;
    let y = (sy - ch / 2 - (vpst.translation ? vpst.translation.y : 0)) / vpst.scale;
    const rad = -(vpst.rotation || 0) * Math.PI / 180;
    const c = Math.cos(rad), s2 = Math.sin(rad);
    const rx = x * c - y * s2, ry = x * s2 + y * c;
    if (vpst.hflip) rx = -rx;
    if (vpst.vflip) ry = -ry;
    return { x: rx + img.columns / 2, y: ry + img.rows / 2 };
  }
  function imgToScreen(vp, ix, iy) {
    const ee = cornerstone.getEnabledElement(vp.elem);
    const img = ee.image, vpst = ee.viewport;
    const cw = vp.elem.clientWidth, ch = vp.elem.clientHeight;
    let x = ix - img.columns / 2, y = iy - img.rows / 2;
    if (vpst.hflip) x = -x;
    if (vpst.vflip) y = -y;
    const rad = (vpst.rotation || 0) * Math.PI / 180;
    const c = Math.cos(rad), s2 = Math.sin(rad);
    const rx = x * c - y * s2, ry = x * s2 + y * c;
    return {
      x: cw / 2 + (vpst.translation ? vpst.translation.x : 0) + rx * vpst.scale,
      y: ch / 2 + (vpst.translation ? vpst.translation.y : 0) + ry * vpst.scale,
    };
  }

  // ---------- 手势状态 ----------
  const drag = { active: false, tool: null, vp: null, startClient: null, lastClient: null, startVp: null, anno: null, moved: false };

  const NAV = { zoom: 1, pan: 1, wl: 1, scroll: 1, rotate: 1 };

  function currentTool() { return App.currentTool || "scroll"; }

  // ---------- 事件绑定 ----------
  function bindElement(vp) {
    const elem = vp.elem;
    elem.style.touchAction = "none";

    elem.addEventListener("pointerdown", (e) => {
      if (!App.handle) return;
      const tool = currentTool();
      e.preventDefault();
      try { elem.setPointerCapture(e.pointerId); } catch (err) { }
      drag.active = true; drag.tool = tool; drag.vp = vp;
      drag.startClient = { x: e.clientX, y: e.clientY };
      drag.lastClient = { x: e.clientX, y: e.clientY };
      const ee = cornerstone.getEnabledElement(vp.elem);
      drag.startVp = {
        scale: ee.viewport.scale,
        translation: Object.assign({}, ee.viewport.translation),
        voi: Object.assign({}, ee.viewport.voi),
        rotation: ee.viewport.rotation || 0,
      };
      drag.scrollAcc = 0;
      drag.moved = false;
      // 测量类：开始新标注
      if (!NAV[tool]) {
        const ip = imgPtFromEvent(vp, e);
        drag.anno = newAnno(tool, ip, vp);
        if (drag.anno) annoStore(vp).push(drag.anno);
      }
    });

    elem.addEventListener("pointermove", (e) => {
      if (drag.active && drag.vp === vp) {
        e.preventDefault();
        const dx = e.clientX - drag.lastClient.x;
        const dy = e.clientY - drag.lastClient.y;
        if (Math.abs(e.clientX - drag.startClient.x) + Math.abs(e.clientY - drag.startClient.y) > 3) drag.moved = true;
        drag.lastClient = { x: e.clientX, y: e.clientY };
        handleDrag(dx, dy, e);
        return;
      }
      // 未按下时：无操作（hover 提示略）
    });

    const finish = (e) => {
      if (!drag.active || drag.vp !== vp) return;
      e.preventDefault();
      // 测量类：pointerup 完成两点标注
      if (!NAV[drag.tool] && drag.anno && !drag.anno.done) {
        const ip = imgPtFromEvent(vp, e);
        finishAnno(drag.anno, ip);
      }
      drag.active = false; drag.anno = null;
    };
    elem.addEventListener("pointerup", finish);
    elem.addEventListener("pointercancel", finish);

    // 双指捏合缩放
    let pinch0 = null;
    elem.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const t = e.touches;
        pinch0 = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        const ee = cornerstone.getEnabledElement(vp.elem);
        pinch0 = { d: pinch0, scale: ee.viewport.scale };
      }
    }, { passive: true });
    elem.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinch0) {
        const t = e.touches;
        const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        const ee = cornerstone.getEnabledElement(vp.elem);
        ee.viewport.scale = Math.max(0.05, Math.min(20, pinch0.scale * (d / pinch0.d)));
        e.preventDefault();
      }
    }, { passive: false });
  }

  function handleDrag(dx, dy, ev) {
    const vp = drag.vp;
    const ee = cornerstone.getEnabledElement(vp.elem);
    const vpst = ee.viewport;
    switch (drag.tool) {
      case "zoom":
        vpst.scale = Math.max(0.05, Math.min(20, drag.startVp.scale * (1 + (-dy) / 120)));
        break;
      case "pan":
        vpst.translation = vpst.translation || { x: 0, y: 0 };
        vpst.translation.x = drag.startVp.translation.x + (ev.clientX - drag.startClient.x);
        vpst.translation.y = drag.startVp.translation.y + (ev.clientY - drag.startClient.y);
        break;
      case "wl": {
        // 与原版 cornerstoneTools 公式一致：range=(max-min)*slope/1024，水平→WW、垂直→WC
        const img = ee.image;
        const range = ((img.maxPixelValue - img.minPixelValue) * (img.slope || 1)) / 1024;
        vpst.voi.windowWidth = Math.max(1, vpst.voi.windowWidth + dx * range);
        vpst.voi.windowCenter = vpst.voi.windowCenter + dy * range;
        break;
      }
      case "scroll": {
        const ser = App.series[vp.seriesIdx];
        if (!ser) break;
        drag.scrollAcc = (drag.scrollAcc || 0) + dy;
        while (Math.abs(drag.scrollAcc) > 24) {
          const step = drag.scrollAcc > 0 ? 1 : -1;
          drag.scrollAcc -= step * 24;
          const ni = Math.max(0, Math.min(ser.meta.imageCount - 1, vp.index + step));
          if (ni !== vp.index) { vp.index = ni; jumpTo(vp, ni); }
        }
        break;
      }
      case "rotate":
        vpst.rotation = (drag.startVp.rotation + dx * 0.5) % 360;
        break;
      default: {
        // 测量类：更新进行中的标注终点
        if (drag.anno && !drag.anno.done) {
          const ip = imgPtFromEvent(vp, ev);
          updateAnno(drag.anno, ip);
        }
      }
    }
  }

  // ---------- 标注 ----------
  function newAnno(tool, ip, vp) {
    const ee = cornerstone.getEnabledElement(vp.elem);
    const base = { type: tool, image: { w: ee.image.columns, h: ee.image.rows }, pts: [ip], done: false, meta: {} };
    if (tool === "textr") {
      const t = prompt("标注文本：");
      if (t == null) return null;
      base.text = t || " "; base.done = true;
    }
    if (tool === "probe") base.done = true;
    if (tool === "chestratio") base.phase = "heart";
    return base;
  }
  function updateAnno(a, ip) {
    if (a.type === "freehand") { a.pts.push(ip); return; }
    if (a.pts.length < 2) a.pts.push(ip); else a.pts[1] = ip;
  }
  function finishAnno(a, ip) {
    a.pts[1] = ip;
    a.done = true;
  }
  function annoLabel(a) {
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y).toFixed(1) + "px";
    if (a.type === "length") return "长度 " + d(a.pts[0], a.pts[1]);
    if (a.type === "probe") return "标注点";
    if (a.type === "angle" || a.type === "cobb") return "角度标注";
    return "标注完成";
  }
  function toastShort(s) {
    const t = document.getElementById("toast");
    t.textContent = s; t.style.display = "block";
    clearTimeout(t._h2); t._h2 = setTimeout(() => t.style.display = "none", 1600);
  }

  // ---------- 渲染（在 overlay ctx 上，屏幕坐标） ----------
  function render(ctx, vp, App2) {
    App = App2 || App;
    const list = annoStore(vp);
    for (const a of list) {
      if (a.type === "textr") { drawText(ctx, vp, a); continue; }
      if (a.type === "freehand") {
        ctx.strokeStyle = "#7CFC00"; ctx.lineWidth = 1.6; ctx.beginPath();
        a.pts.forEach((p, i) => { const s = imgToScreen(vp, p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        ctx.stroke();
        continue;
      }
      const S = a.pts.map(p => imgToScreen(vp, p.x, p.y));
      ctx.strokeStyle = "#7CFC00"; ctx.fillStyle = "#7CFC00"; ctx.lineWidth = 1.8;
      ctx.font = 'italic 13px "Segoe UI","Microsoft YaHei"';
      if (a.type === "length" && S[1]) {
        line(ctx, S[0], S[1]);
        label(ctx, mid(S[0], S[1]), distLabel(vp, a.pts[0], a.pts[1]));
      } else if (a.type === "probe") {
        ctx.beginPath(); ctx.arc(S[0].x, S[0].y, 4, 0, 7); ctx.fill();
        label(ctx, S[0], `(${Math.round(a.pts[0].x)},${Math.round(a.pts[0].y)})`);
      } else if (a.type === "ellipse" && S[1]) {
        const x = Math.min(S[0].x, S[1].x), y = Math.min(S[0].y, S[1].y);
        const w = Math.abs(S[1].x - S[0].x), h = Math.abs(S[1].y - S[0].y);
        ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); ctx.stroke();
        label(ctx, { x: x + w / 2, y: y }, distLabel(vp, a.pts[0], a.pts[1]));
      } else if (a.type === "rect" && S[1]) {
        const x = Math.min(S[0].x, S[1].x), y = Math.min(S[0].y, S[1].y);
        const w = Math.abs(S[1].x - S[0].x), h = Math.abs(S[1].y - S[0].y);
        ctx.strokeRect(x, y, w, h);
        label(ctx, { x: x + w / 2, y: y }, distLabel(vp, a.pts[0], a.pts[1]));
      } else if (a.type === "angle" && S[1]) {
        line(ctx, S[0], S[1]);
        label(ctx, mid(S[0], S[1]), "角度");
      } else if (a.type === "cobb" && S[1]) {
        line(ctx, S[0], S[1]);
        label(ctx, mid(S[0], S[1]), "Cobb");
      } else if (S[1]) {
        line(ctx, S[0], S[1]);
      }
      // 起止点手柄
      for (const p of S) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); }
    }
  }
  function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function label(ctx, p, t) { ctx.fillText(t, p.x + 6, p.y - 6); }
  function distLabel(vp, p0, p1) {
    const img = cornerstone.getEnabledElement(vp.elem).image;
    const mm = img.rowPixelSpacing || 1;
    return (Math.hypot(p0.x - p1.x, p0.y - p1.y) * mm).toFixed(1) + " mm";
  }
  function angleDeg(a, b, c, d) {
    const v1 = [a.x - b.x, a.y - b.y], v2 = [c.x - d.x, c.y - d.y];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }
  function drawText(ctx, vp, a) {
    const S = imgToScreen(vp, a.pts[0].x, a.pts[0].y);
    ctx.fillStyle = "#FFD54F"; ctx.font = '14px "Segoe UI","Microsoft YaHei"';
    ctx.fillText(a.text || "", S.x, S.y);
  }

  function clearFor(vp) {
    const k = "vp" + App.viewports.indexOf(vp);
    if (App.toolAnno) App.toolAnno[k] = [];
    requestAnimationFrame(() => window.KApp && window.KApp.App && null);
  }

  function init(app) { App = app; }

  window.KTools = { init, bindElement, render, clearFor, screenToImg };
})();
