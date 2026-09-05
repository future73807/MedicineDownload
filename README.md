# 医学影像查看器（本地版）

复刻「无极云影像」2D 影像查看器的本地程序 + Android app。数据与程序分离，无密码，
支持把数据 zip 直接放入数据目录，开屏可选择 zip 解析或输入网址+密码下载。

## 目录结构（程序与数据分离）

```
MedicineDownload/
├── app/                 # 网页程序（双击 index.html 可用基础功能，启动.bat 全功能）
│   ├── index.html
│   ├── assets/          # 前端资源（cornerstone/dicom-parser/jpeg-lossless 等开源库）
│   ├── server.mjs       # 零依赖 Node 服务器（静态/数据列表/解压/下载任务/导出zip）
│   └── 启动.bat
├── data/                # 数据目录：zip 或解压后的文件夹都可直接放入
│   └── *.zip 对应的解压文件夹
├── tools/
│   ├── download.mjs     # CLI 下载器（node tools/download.mjs [--only 1,2]）
│   └── download-core.mjs# 下载核心（CLI 与服务器共用）
└── android/             # Android 工程（WebView 复用同一套前端）
    └── app/build/outputs/apk/debug/app-debug.apk
```

## 使用

### 网页版

1. 双击 `app\启动.bat`（需 Node.js），浏览器自动打开 `http://127.0.0.1:8230`
2. 开屏三种打开方式：
   - **数据包列表**：点击任意数据包直接查看（zip 自动解压）
   - **选择本地 Zip 解析**：从本地文件选择数据 zip
   - **输入网址和密码下载**：粘贴 kayicloud 分享链接 + 4位密码，自动全量下载并打包 zip 存入 data 目录

### Android app

- APK：`android\app\build\outputs\apk\debug\app-debug.apk`（已装模拟器实测）
- app 数据目录：`Android/data/com.medicine.viewer/files/data/`，放入数据 zip 后重启 app 即可识别
- app 内同样支持：选择本地 zip（SAF）、输入网址+密码下载（原生下载引擎，进度实时显示）、
  导出 zip 到系统「下载」目录

## 启动 / 打包命令

```bash
# —— 网页版启动 ——
cd app
node server.mjs            # 默认 http://127.0.0.1:8230，自动开浏览器
node server.mjs 9000       # 指定端口
# Windows 也可直接双击 app\启动.bat

# —— 下载数据（CLI，可选；app/网页内也可下载）——
node tools/download.mjs                 # 下载全部3个研究
node tools/download.mjs --only 1,2      # 指定研究编号
node tools/refresh-meta.mjs             # 刷新 study.json 的序列时间等元数据

# —— Android APK 打包 ——
cd android
gradle wrapper --gradle-version 8.10.2   # 首次（本机已有 wrapper 可跳过）
gradlew.bat assembleDebug                # 产物: app/build/outputs/apk/debug/app-debug.apk
adb install -r app\build\outputs\apk\debug\app-debug.apk

# —— 交付打包（输出到 out 目录，2×2 组合：web/apk × 含/不含数据）——
node tools/package.mjs --web            # web 程序包（zip）
node tools/package.mjs --web --data    # web 程序包 + 数据
node tools/package.mjs --apk           # 仅 APK（直接输出 影像查看器.apk，不套 zip）
node tools/package.mjs --apk --data    # APK + 数据 zip 一并输出
node tools/package.mjs                 # web + apk 全打（不含数据）
```

## 数据包格式（文件夹与 zip 内部一致）

```
<数据包名>/
├── study.json            # 患者/研究/序列/每帧索引
└── series/<序列号3位>/<序号5位>.dcm   # 原始 DICOM
```

## 复刻范围

- **2D Viewer 完整复刻**：翻页/缩放/平移/窗宽窗位/旋转/伪彩、长度/点/椭圆/矩形/角度/Cobb角/
  多边形/文本/十字线/心胸比测量、序列布局(1×1~3×3)、图像工具(旋转/镜像/反色)、图像播放(2~30FPS)、
  图像定位线、序列对比同步(图像Id/自动位置/手动位置/缩放平移/窗宽窗位)、
  四角覆盖信息(Name/PatId/机构/设备/Zoom/WW/WL/FS/Th/RT/TE/Im/Se)、方位标记、10cm 标尺、
  序列缩略图、底部播放条、桌面/移动端双布局（与原站一致）
- **MPR/3D**：原站 3D 依赖其云端重建服务，本地版提供基于开源自绘渲染的 MPR 与 MIP（菜单中切换）
- 不复刻：发送到手机、分享二维码（按需求改为导出数据包 zip）、云端内镜/血管分析

## 技术说明

- 前端：cornerstone-core 2.3 + cornerstoneTools 6 + dicom-parser + jpeg-lossless-decoder + fflate
  （全部 MIT 开源；自绘渲染器，绕开环境相关的 cornerstone 内置渲染问题）
- DICOM：全部为 JPEG-Lossless 无损压缩 (1.2.840.10008.1.2.4.70)，浏览器端解码
- 下载链路（实测 8176 张 0 失败）：
  `GetShareInfo`(密码验证) → `GetStudies`(清单) → 每序列 `GetDicomSeriesInfo`(唤醒) →
  `GetImage`(完整参数: imageObjKey/patId/expires/signature/studyuid/seriesuid/imageUid/lossless/iq)
- Android：Java + WebView，`@JavascriptInterface` 桥（listDataPackages/prepareZip/exportZip/downloadStudy）

## 已知说明

- 分享签名有效期约 60 天（expires 字段），过期后重新用链接+密码走下载流程即可
- 下载失败自动重试（签名刷新 + 指数退避），中断后重跑续传
