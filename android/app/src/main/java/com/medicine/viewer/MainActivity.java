package com.medicine.viewer;

import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private android.webkit.ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_WEB_FILE_CHOOSER = 1004;
    private File dataDir;
    private static final int REQ_IMPORT_ZIP = 1001;
    private static final int REQ_STORAGE = 1002;
    private static final int REQ_SAF_EXPORT = 1003;
    private String pendingExportName = null;
    private String pendingExportZipPath = null;
    private static final String IMAGE_SERVER = "https://www.kayicloud.com:11136/";
    private static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
    private static final int CONCURRENCY = 6;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF000000);
        getWindow().setNavigationBarColor(0xFF262C36);

        dataDir = new File(getExternalFilesDir(null), "data");
        if (!dataDir.exists()) dataDir.mkdirs();

        webView = new WebView(this);
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.addView(webView, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        ws.setUserAgentString(UA);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            // appfile://<name>/<path> → 应用数据目录文件流（DICOM读取主通道）
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appfile".equals(u.getScheme())) {
                    String name = u.getHost();
                    String path = u.getPath();
                    if (path != null && path.startsWith("/")) path = path.substring(1);
                    if (name != null && path != null && !name.contains("..") && !path.contains("..")) {
                        File f = new File(dataDir, name + File.separator + path);
                        if (f.exists() && f.isFile()) {
                            try {
                                WebResourceResponse resp = new WebResourceResponse(
                                        "application/octet-stream", null, new FileInputStream(f));
                                resp.getResponseHeaders().put("Access-Control-Allow-Origin", "*");
                                resp.getResponseHeaders().put("Cache-Control", "no-store");
                                return resp;
                            } catch (Exception ignored) { }
                        }
                        return new WebResourceResponse("text/plain", "utf-8", 404, "not found", null, new java.io.ByteArrayInputStream(new byte[0]));
                    }
                }
                return null;
            }
        });

        // WebChromeClient：让网页里的 <input type=file> 能弹出系统文件选择器
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                                             android.webkit.WebChromeClient.FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    String[] mimes = params.getAcceptTypes();
                    if (mimes != null && mimes.length > 0 && mimes[0] != null && mimes[0].contains("zip")) {
                        i.setType("application/zip");
                    }
                    startActivityForResult(Intent.createChooser(i, "选择数据 zip 包"), REQ_WEB_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    toast("无法打开文件选择器: " + e.getMessage());
                    return false;
                }
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.loadUrl("file:///android_asset/www/index.html");

        // edge-to-edge：内容避开状态栏/导航栏（Android 15 默认透明系统栏会盖住 WebView）
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        android.view.WindowInsets.Type.statusBars()
                                | android.view.WindowInsets.Type.displayCutout()
                                | android.view.WindowInsets.Type.navigationBars());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            }
            return android.view.WindowInsets.CONSUMED;
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    // JS回调：下载进度
    private void jsCallback(final String json) {
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.__androidEvent && window.__androidEvent(" + json + ")", null));
    }

    private void progress(String stage, int cur, int total, String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "downloadProgress");
            o.put("stage", stage);
            o.put("cur", cur);
            o.put("total", total);
            o.put("msg", msg);
            jsCallback(o.toString());
        } catch (Exception ignored) { }
    }

    private void exportZipAsync(String name) {
        pendingExportName = name;
        new Thread(() -> {
            String result;
            try {
                File dir = new File(dataDir, name);
                if (!new File(dir, "study.json").exists()) { result = "数据不存在"; throw new Exception(result); }
                progressMsg("正在打包 zip...");
                File zipPath = new File(dataDir, name + ".zip");
                if (zipPath.exists()) zipPath.delete();
                zipFolder(dir, zipPath);
                progressMsg("正在保存到 Download 目录...");
                String displayName = name + ".zip";
                File downloadDir = android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS);
                if (!downloadDir.exists()) downloadDir.mkdirs();
                File zipOut = new File(downloadDir, displayName);
                FileOutputStream fo = new FileOutputStream(zipOut);
                FileInputStream in = new FileInputStream(zipPath);
                copy(in, fo);
                in.close();
                fo.close();
                pendingExportZipPath = zipOut.getAbsolutePath();
                result = "已保存到 Download/" + displayName + " (" + (zipOut.length() / 1048576) + "MB)";
                jsCallback("{\"type\":\"exportDone\",\"ok\":true,\"msg\":" + org.json.JSONObject.quote(result) + "}");
            } catch (Exception e) {
                // MediaStore 写入失败 → 兜底：弹系统保存对话框（默认下载目录，无需权限）
                if (pendingExportZipPath != null && new File(pendingExportZipPath).exists()) {
                    jsCallback("{\"type\":\"exportFallback\",\"msg\":\"自动保存失败，请在弹出的窗口中选择保存位置\"}");
                    runOnUiThread(() -> {
                        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("application/zip");
                        i.putExtra(Intent.EXTRA_TITLE, (pendingExportName != null ? pendingExportName : "study") + ".zip");
                        startActivityForResult(i, REQ_SAF_EXPORT);
                    });
                } else {
                    jsCallback("{\"type\":\"exportDone\",\"ok\":false,\"msg\":" + org.json.JSONObject.quote("导出失败: " + e.getMessage()) + "}");
                }
            }
        }).start();
    }

    // ============ JS 桥 ============
    class Bridge {

        /** 数据包列表 JSON: [{kind:'bridge-folder'|'bridge-zip', name, meta?}] */
        @JavascriptInterface
        public String listDataPackages() {
            JSONArray arr = new JSONArray();
            String dbg = "";
            try {
                File[] files = dataDir.listFiles();
                dbg = "dataDir=" + dataDir.getAbsolutePath() + " exists=" + dataDir.exists()
                        + " n=" + (files == null ? "null" : files.length);
                if (files != null) {
                    Arrays.sort(files, Comparator.comparing(File::getName));
                    for (File f : files) {
                        if (f.getName().startsWith("_") || f.getName().startsWith(".")) continue;
                        JSONObject o = new JSONObject();
                        if (f.isDirectory()) {
                            File sj = new File(f, "study.json");
                            if (!sj.exists()) continue;
                            o.put("kind", "bridge-folder");
                            o.put("name", f.getName());
                            try (FileInputStream in = new FileInputStream(sj)) {
                                o.put("meta", new JSONObject(readAll(in)));
                            } catch (Exception ignored) { }
                        } else if (f.getName().toLowerCase().endsWith(".zip")) {
                            o.put("kind", "bridge-zip");
                            o.put("name", f.getName());
                            o.put("size", f.length());
                        } else continue;
                        arr.put(o);
                    }
                }
            } catch (Exception e) {
                dbg += " EX=" + e;
            }
            android.util.Log.i("MedViewer", "listDataPackages " + dbg + " -> " + arr);
            return arr.toString();
        }

        /** 读取小文件（study.json 等），base64 返回 */
        @JavascriptInterface
        public String readFile(String name, String path) {
            try {
                File f = safeFile(name, path);
                if (f == null || !f.exists()) return "";
                FileInputStream in = new FileInputStream(f);
                byte[] all = readAllBytes(in);
                in.close();
                return Base64.encodeToString(all, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        /** 打开系统文件选择器导入 zip */
        @JavascriptInterface
        public void openImportZip() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/zip");
                startActivityForResult(Intent.createChooser(i, "选择数据 zip 包"), REQ_IMPORT_ZIP);
            });
        }

        /** 全屏沉浸开关（隐藏/显示系统状态栏与导航栏） */
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                    var c = getWindow().getInsetsController();
                    if (c != null) {
                        if (on) {
                            c.hide(android.view.WindowInsets.Type.systemBars());
                            c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        } else {
                            c.show(android.view.WindowInsets.Type.systemBars());
                        }
                    }
                } else {
                    android.view.View decor = getWindow().getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (on) flags |= android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
                    else flags &= ~(android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
                    decor.setSystemUiVisibility(flags);
                }
            });
        }

        /** 解压数据 zip（幂等），返回文件夹名 */
        @JavascriptInterface
        public String prepareZip(String zipName) {
            try {
                if (zipName == null || !zipName.toLowerCase().endsWith(".zip") || zipName.contains("..")) return null;
                File zipPath = new File(dataDir, zipName);
                if (!zipPath.exists()) return null;
                String folder = zipName.replaceAll("(?i)\\.zip$", "");
                File target = new File(dataDir, folder);
                if (!new File(target, "study.json").exists()) {
                    target.mkdirs();
                    ZipInputStream zi = new ZipInputStream(new FileInputStream(zipPath));
                    ZipEntry e;
                    while ((e = zi.getNextEntry()) != null) {
                        if (e.isDirectory()) continue;
                        File out = new File(target, e.getName().replace("..", ""));
                        out.getParentFile().mkdirs();
                        FileOutputStream fo = new FileOutputStream(out);
                        copy(zi, fo);
                        fo.close();
                    }
                    zi.close();
                }
                return folder;
            } catch (Exception e) {
                return null;
            }
        }

        /** 导出数据包 zip：立即返回。需先授予“所有文件访问”权限（跳转系统设置页开启） */
        @JavascriptInterface
        public void exportZip(String name) {
            runOnUiThread(() -> {
                if (hasAllFilesAccess()) {
                    exportZipAsync(name);
                } else {
                    pendingExportName = name;
                    toast("请在接下来的页面中开启“所有文件访问”权限");
                    requestAllFilesAccess();
                }
            });
        }

        /** 从分享链接下载数据（同网页版链路）。立即返回，取名/下载全在后台线程，前端即时进入等待态 */
        @JavascriptInterface
        public void downloadStudy(String shareId, String password, String name) {
            progress("start", 0, 1, "正在连接服务器...");
            new Thread(() -> {
                try {
                    final String fName = (name == null || name.trim().isEmpty())
                            ? autoStudyName(shareId, password) : name;
                    progress("start", 0, 1, "验证分享密码...");
                    JSONObject result = downloadStudySync(shareId, password, fName);
                    JSONObject out = new JSONObject();
                    out.put("type", "downloadDone");
                    out.put("ok", result.getBoolean("ok"));
                    out.put("name", result.optString("name", name));
                    if (result.has("error")) out.put("error", result.getString("error"));
                    out.put("name", fName);
                    jsCallback(out.toString());
                } catch (Exception e) {
                    try {
                        JSONObject out = new JSONObject();
                        out.put("type", "downloadDone");
                        out.put("ok", false);
                        out.put("error", e.getMessage());
                        jsCallback(out.toString());
                    } catch (Exception ignored) { }
                }
            }).start();
        }

    }

    // ============ 下载实现（与 tools/download-core.mjs 相同链路） ============
    /** 用分享信息自动生成数据包名：患者名_患者ID_模态 */
    private String autoStudyName(String shareId, String password) {
        try {
            JSONObject share = httpGetJson(IMAGE_SERVER + "imageserver/StudyData/GetShareInfo?shareId=" + shareId + "&password=" + password);
            JSONObject study = httpGetJson(IMAGE_SERVER + "imageserver/StudyData/GetStudies?dataids=&studyKeys=&cloudImage=1&dataSource=rest&signature="
                    + url(share.getJSONObject("data").getString("serverSignature")) + "&vendorCode=" + share.getJSONObject("data").getString("vendorCode")
                    + "&seriesKeys=&isAnony=false&getImageInfo=false&token=&serverAddr="
                    + url(Base64.encodeToString(share.getJSONObject("data").getString("serverAddr").getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP))
                    + "&expires=" + share.getJSONObject("data").getLong("expires"))
                    .getJSONArray("data").getJSONObject(0);
            String n = (study.optString("PatientName", "study") + "_" + study.optString("PatientId", "")
                    + "_" + study.optString("Modality", "")).replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
            return n.isEmpty() ? "study_" + System.currentTimeMillis() : n;
        } catch (Exception e) {
            return "study_" + System.currentTimeMillis();
        }
    }

    private JSONObject downloadStudySync(String shareId, String password, String name) throws Exception {
        JSONObject out = new JSONObject();
        doneSync.set(0);
        try {
            progress("start", 0, 1, "验证分享密码...");
            JSONObject share = httpGetJson(IMAGE_SERVER + "imageserver/StudyData/GetShareInfo?shareId=" + shareId + "&password=" + password);
            JSONObject d = share.getJSONObject("data");
            String vendorCode = d.getString("vendorCode");
            String serverSignature = d.getString("serverSignature");
            String serverAddrB64 = Base64.encodeToString(d.getString("serverAddr").getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            long expires = d.getLong("expires");
            String ds = d.optString("ds", "rest");

            progress("meta", 0, 1, "获取研究清单...");
            StringBuilder qs = new StringBuilder("dataids=&studyKeys=&cloudImage=1&dataSource=").append(ds)
                    .append("&signature=").append(url(serverSignature))
                    .append("&vendorCode=").append(vendorCode)
                    .append("&seriesKeys=&isAnony=false&getImageInfo=false&token=")
                    .append("&serverAddr=").append(url(serverAddrB64))
                    .append("&expires=").append(expires);
            JSONObject studies = httpGetJson(IMAGE_SERVER + "imageserver/StudyData/GetStudies?" + qs);
            JSONObject study = studies.getJSONArray("data").getJSONObject(0);
            JSONArray seriesList = study.getJSONArray("SeriesList");
            String patIdB64 = Base64.encodeToString(
                    study.optString("PatientId", "").getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String studyUid = study.optString("StuInsUID", "");

            File studyDir = new File(dataDir, name);
            if (!studyDir.exists()) studyDir.mkdirs();

            JSONArray seriesOut = new JSONArray();
            int totalImages = 0;
            List<JSONObject> serMetas = new ArrayList<>();
            for (int i = 0; i < seriesList.length(); i++) {
                JSONObject ser = seriesList.getJSONObject(i);
                JSONArray il = ser.optJSONArray("ImageList");
                int cnt = il == null ? ser.optInt("ImageCount", 0) : il.length();
                totalImages += cnt;
            }
            int done = 0;

            for (int i = 0; i < seriesList.length(); i++) {
                JSONObject ser = seriesList.getJSONObject(i);
                int serNum = ser.optInt("SeriesNumber", i + 1);
                JSONArray il = ser.optJSONArray("ImageList");
                if (il == null || il.length() == 0) continue;
                progress("series", serNum, totalImages, "序列 " + serNum + " " + ser.optString("SeriesDescription", "") + " (" + il.length() + "张)");
                // 唤醒
                try {
                    JSONObject img0 = il.getJSONObject(0);
                    StringBuilder wq = new StringBuilder("vendorCode=").append(vendorCode)
                            .append("&ds=").append(ds)
                            .append("&imageObjKey=").append(url(b64(img0.optString("ObjectKey", ""))))
                            .append("&expires=").append(ser.optLong("Expires", expires))
                            .append("&signature=").append(url(img0.optString("Signature", "")))
                            .append("&bucketName=").append(url(ser.optString("BucketName", "null")))
                            .append("&patientId=").append(url(patIdB64))
                            .append("&studyuid=").append(url(studyUid))
                            .append("&seriesuid=").append(url(ser.optString("SeriesInsUID", "")))
                            .append("&imageUid=").append(url(img0.optString("SOPInstanceUID", "")))
                            .append("&aeTitle=undefined&forceDownload=true&getFrames=false");
                    httpGetJson(IMAGE_SERVER + "imageserver/StudyData/GetDicomSeriesInfo?" + wq);
                } catch (Exception ignored) { }

                File serDir = new File(studyDir, "series" + File.separator + pad(serNum, 3));
                if (!serDir.exists()) serDir.mkdirs();

                ExecutorService pool = Executors.newFixedThreadPool(CONCURRENCY);
                final AtomicInteger ok = new AtomicInteger(0);
                final AtomicInteger skip = new AtomicInteger(0);
                final int totalImg = totalImages;
                final String vc = vendorCode, pb = patIdB64, su = studyUid;
                final long exp = expires;
                List<Future<?>> futures = new ArrayList<>();
                for (int k = 0; k < il.length(); k++) {
                    final int kk = k;
                    final JSONObject img = il.getJSONObject(kk);
                    futures.add(pool.submit(() -> {
                        try {
                            File f = new File(serDir, pad(kk + 1, 5) + ".dcm");
                            if (f.exists() && f.length() > 100) {
                                skip.incrementAndGet();
                            } else {
                                String u = buildGetImageUrl(vc, pb, su, ser, img, kk, exp);
                                byte[] buf = httpGetBinary(u);
                                if (buf.length < 100) throw new RuntimeException("响应过小");
                                FileOutputStream fo = new FileOutputStream(f);
                                fo.write(buf);
                                fo.close();
                                ok.incrementAndGet();
                            }
                        } catch (Exception e) {
                            throw new RuntimeException(e);
                        }
                        int dn = doneSync.incrementAndGet();
                        if (dn % 10 == 0) progress("file", dn, totalImg, "已下载 " + ok.get() + " 张");
                    }));
                }
                for (Future<?> f : futures) f.get();
                pool.shutdown();
                done += il.length();
                progress("file", done, totalImages, "已下载 " + ok.get() + " 张");

                JSONObject serOut = new JSONObject();
                serOut.put("seriesNumber", serNum);
                serOut.put("seriesInstanceUID", ser.optString("SeriesInsUID", ""));
                serOut.put("description", ser.optString("SeriesDescription", ser.optString("ProtocolName", "")));
                serOut.put("modality", ser.optString("Modality", study.optString("Modality", "")));
                serOut.put("bodyPart", ser.optString("SeriesBodyPart", ""));
                serOut.put("thickness", ser.optDouble("SliceThickness", Double.NaN));
                serOut.put("ww", ser.optDouble("WW", Double.NaN));
                serOut.put("wl", ser.optDouble("WL", Double.NaN));
                serOut.put("imageCount", il.length());
                JSONArray imgs = new JSONArray();
                for (int k = 0; k < il.length(); k++) {
                    JSONObject img = il.getJSONObject(k);
                    JSONObject im = new JSONObject();
                    im.put("file", "series/" + pad(serNum, 3) + "/" + pad(k + 1, 5) + ".dcm");
                    im.put("instanceNumber", img.opt("InstanceNumber"));
                    im.put("sopInstanceUID", img.optString("SOPInstanceUID", ""));
                    im.put("ww", img.optDouble("WW", Double.NaN));
                    im.put("wl", img.optDouble("WL", Double.NaN));
                    im.put("width", img.optInt("ImageWid", 0));
                    im.put("height", img.optInt("ImageHei", 0));
                    im.put("photometric", img.optString("Photometric", "MONOCHROME2"));
                    im.put("numberOfFrames", img.optInt("NumberOfFrames", 1));
                    imgs.put(im);
                }
                serOut.put("images", imgs);
                seriesOut.put(serOut);
                serMetas.add(serOut);
            }

            // study.json
            JSONObject meta = new JSONObject();
            meta.put("format", "kayi-local-v1");
            meta.put("exportedAt", new java.util.Date().toString());
            JSONObject src = new JSONObject();
            src.put("shareId", shareId);
            src.put("imageServer", IMAGE_SERVER);
            meta.put("source", src);
            JSONObject pa = new JSONObject();
            pa.put("name", study.optString("PatientName", ""));
            pa.put("id", study.optString("PatientId", ""));
            pa.put("sex", study.optString("PatientSex", ""));
            pa.put("age", study.optString("PatientAge", ""));
            pa.put("birth", study.optString("PatientBirth", ""));
            meta.put("patient", pa);
            JSONObject st = new JSONObject();
            st.put("date", study.optString("StuDate", ""));
            st.put("time", study.optString("StuTime", ""));
            st.put("description", study.optString("StuDescription", ""));
            st.put("modality", study.optString("Modality", ""));
            st.put("institution", study.optString("Institusion", ""));
            st.put("modelName", study.optString("ManufacturerModelName", ""));
            st.put("studyInstanceUID", studyUid);
            st.put("accessionNumber", study.optString("AccessionNumber", ""));
            st.put("imageCount", totalImages);
            st.put("seriesCount", study.optInt("SeriesCount", seriesList.length()));
            meta.put("study", st);
            meta.put("series", seriesOut);
            writeFileString(new File(studyDir, "study.json"), meta.toString());

            // 打包 zip
            progress("zip", 0, 1, "打包 zip...");
            File zipPath = new File(dataDir, name + ".zip");
            if (zipPath.exists()) zipPath.delete();
            zipFolder(studyDir, zipPath);

            out.put("ok", true);
            out.put("name", name);
        } catch (Exception e) {
            out.put("ok", false);
            out.put("error", e.getMessage());
        }
        return out;
    }

    private boolean hasAllFilesAccess() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            return android.os.Environment.isExternalStorageManager();
        }
        return checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private void requestAllFilesAccess() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivityForResult(i, REQ_STORAGE);
        } catch (Exception e) {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            } catch (Exception ignored) { }
        }
    }

    private void toast(String s) {
        runOnUiThread(() -> Toast.makeText(this, s, Toast.LENGTH_SHORT).show());
    }

    /** 导出/通用消息上报到网页（exportProgress 类型） */
    private void progressMsg(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "exportProgress");
            o.put("msg", msg);
            jsCallback(o.toString());
        } catch (Exception ignored) { }
    }

    /** 下载进度上报到网页 */
    private final AtomicInteger doneSync = new AtomicInteger(0);

    private String buildGetImageUrl(String vendorCode, String patIdB64, String studyUid,
                                    JSONObject ser, JSONObject img, int imageIndex, long shareExpires) {
        try {
            StringBuilder q = new StringBuilder("vendorCode=").append(vendorCode)
                    .append("&patId=").append(url(patIdB64))
                    .append("&expires=").append(ser.optLong("Expires", shareExpires))
                    .append("&signature=").append(url(img.optString("Signature", "")))
                    .append("&studyuid=").append(url(studyUid))
                    .append("&seriesuid=").append(url(ser.optString("SeriesInsUID", "")))
                    .append("&imageUid=").append(url(img.optString("SOPInstanceUID", "")))
                    .append("&imageid=").append(imageIndex)
                    .append("&lossless=1&iq=100");
            return IMAGE_SERVER + "imageserver/dicomData/GetImage?imageObjKey="
                    + url(b64(img.optString("ObjectKey", ""))) + "&" + q;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ============ 工具 ============
    private File safeFile(String name, String path) {
        if (name == null || path == null) return null;
        if (name.contains("..") || path.contains("..")) return null;
        return new File(dataDir, name + File.separator + path.replace("/", File.separator));
    }

    private static String pad(int n, int w) {
        return String.format("%0" + w + "d", n);
    }

    private static String b64(String s) {
        return Base64.encodeToString(s.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    private static String url(String s) {
        try {
            return java.net.URLEncoder.encode(s, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return s;
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toString("UTF-8");
    }

    private static byte[] readAllBytes(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static void copy(InputStream in, OutputStream os) throws Exception {
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    }

    private static void writeFileString(File f, String s) throws Exception {
        FileOutputStream fo = new FileOutputStream(f);
        fo.write(s.getBytes(StandardCharsets.UTF_8));
        fo.close();
    }

    private JSONObject httpGetJson(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA);
        int code = c.getResponseCode();
        if (code != 200) throw new RuntimeException("HTTP " + code);
        String body = readAll(c.getInputStream());
        c.disconnect();
        JSONObject j = new JSONObject(body);
        if (j.optInt("code", -1) != 0) throw new RuntimeException("API code=" + j.optInt("code") + " " + j.optString("message"));
        return j;
    }

    private byte[] httpGetBinary(String url) throws Exception {
        Exception last = null;
        for (int i = 0; i < 3; i++) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", UA);
                int code = c.getResponseCode();
                if (code != 200) throw new RuntimeException("HTTP " + code);
                byte[] all = readAllBytes(c.getInputStream());
                c.disconnect();
                if (all.length < 100) throw new RuntimeException("响应过小");
                return all;
            } catch (Exception e) {
                last = e;
                Thread.sleep(600L * (i + 1));
            }
        }
        throw last;
    }

    private void zipFolder(File dir, File zipPath) throws Exception {
        ZipOutputStream zo = new ZipOutputStream(new FileOutputStream(zipPath));
        zipWalk(dir, "", zo);
        zo.close();
    }

    private void zipWalk(File dir, String rel, ZipOutputStream zo) throws Exception {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            String r = rel.isEmpty() ? f.getName() : rel + "/" + f.getName();
            if (f.isDirectory()) zipWalk(f, r, zo);
            else {
                zo.putNextEntry(new ZipEntry(r));
                FileInputStream in = new FileInputStream(f);
                copy(in, zo);
                in.close();
                zo.closeEntry();
            }
        }
    }

    // ============ zip 导入 ============
    /** SAF 导入 zip：复制到应用数据目录并解压，完成后 importDone 事件 */
    private void importZipFromUri(Uri uri) {
        toast("开始导入...");
        new Thread(() -> {
            try {
                String zipName = queryDisplayName(uri);
                if (!zipName.toLowerCase().endsWith(".zip")) zipName += ".zip";
                File local = new File(dataDir, zipName);
                InputStream in = getContentResolver().openInputStream(uri);
                FileOutputStream fo = new FileOutputStream(local);
                copy(in, fo);
                in.close();
                fo.close();
                File target = new File(dataDir, zipName.replaceAll("(?i)\\.zip$", ""));
                if (!new File(target, "study.json").exists()) {
                    target.mkdirs();
                    ZipInputStream zi = new ZipInputStream(new FileInputStream(local));
                    ZipEntry e;
                    int n = 0;
                    while ((e = zi.getNextEntry()) != null) {
                        if (e.isDirectory()) continue;
                        File out = new File(target, e.getName().replace("..", ""));
                        out.getParentFile().mkdirs();
                        FileOutputStream fo2 = new FileOutputStream(out);
                        copy(zi, fo2);
                        fo2.close();
                        n++;
                    }
                    zi.close();
                    toast("导入完成: " + n + " 个文件");
                } else {
                    toast("已存在，跳过解压");
                }
                jsCallback("{\"type\":\"importDone\",\"ok\":true}");
            } catch (Exception ex) {
                toast("导入失败: " + ex.getMessage());
                jsCallback("{\"type\":\"importDone\",\"ok\":false}");
            }
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_STORAGE) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            if (granted && pendingExportName != null) {
                exportZipAsync(pendingExportName);
            } else {
                jsCallback("{\"type\":\"exportDone\",\"ok\":false,\"msg\":\"未授予存储权限，无法导出\"}");
            }
            pendingExportName = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_WEB_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] uris = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    uris = new Uri[]{ data.getData() };
                    importZipFromUri(data.getData());
                }
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            }
            return;
        }
        if (requestCode == REQ_IMPORT_ZIP && resultCode == RESULT_OK && data != null && data.getData() != null) {
            importZipFromUri(data.getData());
        }
    }

    private String queryDisplayName(Uri uri) {
        try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) { }
        return "import_" + System.currentTimeMillis() + ".zip";
    }
}
