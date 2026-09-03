// Rebuilds assets/classes.dex — the tiny helpers the app pushes to a device to
// read launcher icons and media album art (see the "App icons" and
// "Album artwork" sections in main.js).
//
// Why this exists: adb cannot hand back an app's icon OR a media session's
// album art. `pm`/`dumpsys` only print a numeric resource id or a content://
// URI, and the bitmap lives inside another process (the APK, or the player
// app). `adb shell content read --uri` mangles binary over the shell channel,
// so the only reliable way to get the real bytes without pulling whole APKs is
// to run code on the device: once with a real PackageManager (icons), once
// with a real ContentResolver (artwork). This builds a single ~8 KB dex with
// both helpers; the app runs it with `app_process`, the same mechanism scrcpy
// uses for its server.
//
// The dex is committed so end users never need a JDK or the Android tools. Run
// this only when the helper below changes:
//
//     node tools/build-icon-dex.js
//
// Requirements to REBUILD (not to run the app): a JDK (`javac`, `java`) on PATH.
// r8.jar (Google's dexer) is downloaded on first run and is gitignored.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const R8_URL = 'https://dl.google.com/android/maven2/com/android/tools/r8/8.2.42/r8-8.2.42.jar';
const R8_PATH = path.join(ROOT, 'r8.jar');

// The on-device helper. It reaches a system Context through ActivityThread by
// reflection (so it needs no compile-time android.jar beyond the class names),
// asks PackageManager for each app's icon Drawable, rasterises it to a 72x72
// bitmap, PNG-compresses it and prints one `ICON:<pkg>:<base64>` line per app.
// Anything it cannot read (a locked-down icon, a missing package) is skipped
// rather than faked — the desktop side keeps its monogram tile for those.
//
// Two hard-won details live here, both verified on-device:
//  1. Warmup: the package's Resources must be touched (getResourcesForApplication
//     + updateConfiguration) before getApplicationIcon, or the first loads in a
//     half-initialised ResourcesManager state and fail.
//  2. Density sweep: bundle/split-APK apps (Chrome, YouTube, …) ship their icon
//     mipmaps in density buckets the external AssetManager won't resolve at the
//     device density — requesting higher buckets directly (640 first) hits where
//     the device-density request misses.
const JAVA_SRC = `
package com.companion;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

public class IconExtractor {
    public static void main(String[] args) {
        try {
            try {
                Class<?> looperClass = Class.forName("android.os.Looper");
                looperClass.getMethod("prepareMainLooper").invoke(null);
            } catch (Throwable t) { /* already prepared */ }

            Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
            Object activityThread = activityThreadClass.getMethod("systemMain").invoke(null);
            Object context = activityThreadClass.getMethod("getSystemContext").invoke(activityThread);

            Class<?> contextClass = Class.forName("android.content.Context");
            Object pm = contextClass.getMethod("getPackageManager").invoke(context);

            Class<?> pmClass = Class.forName("android.content.pm.PackageManager");
            Class<?> appInfoClass = Class.forName("android.content.pm.ApplicationInfo");
            Method getApplicationInfo = pmClass.getMethod("getApplicationInfo", String.class, int.class);
            Method getApplicationIcon = pmClass.getMethod("getApplicationIcon", appInfoClass);
            Method getResourcesForApp = null;
            try {
                getResourcesForApp = pmClass.getMethod("getResourcesForApplication", appInfoClass);
            } catch (Throwable t) { /* very old devices; PMS path only */ }

            Class<?> resClass = Class.forName("android.content.res.Resources");
            Class<?> themeClass = Class.forName("android.content.res.Resources$Theme");
            Class<?> cfgClass = Class.forName("android.content.res.Configuration");
            Class<?> dmClass = Class.forName("android.util.DisplayMetrics");

            Class<?> drawableClass = Class.forName("android.graphics.drawable.Drawable");
            Method setBounds = drawableClass.getMethod("setBounds", int.class, int.class, int.class, int.class);
            Method draw = drawableClass.getMethod("draw", Class.forName("android.graphics.Canvas"));

            Class<?> bitmapClass = Class.forName("android.graphics.Bitmap");
            Class<?> configClass = Class.forName("android.graphics.Bitmap$Config");
            Object argb8888 = configClass.getField("ARGB_8888").get(null);
            Method createBitmap = bitmapClass.getMethod("createBitmap", int.class, int.class, configClass);

            Class<?> canvasClass = Class.forName("android.graphics.Canvas");
            java.lang.reflect.Constructor<?> canvasCtor = canvasClass.getConstructor(bitmapClass);

            Class<?> compressFormatClass = Class.forName("android.graphics.Bitmap$CompressFormat");
            Object pngFormat = compressFormatClass.getField("PNG").get(null);
            Method compress = bitmapClass.getMethod("compress", compressFormatClass, int.class, java.io.OutputStream.class);

            Object noWrap = 2; // Base64.NO_WRAP
            Class<?> base64Class = Class.forName("android.util.Base64");
            Method encodeToString = base64Class.getMethod("encodeToString", byte[].class, int.class);

            int sysDensity = 480;
            try {
                Object sysRes = contextClass.getMethod("getResources").invoke(context);
                Object sysDm = resClass.getMethod("getDisplayMetrics").invoke(sysRes);
                sysDensity = dmClass.getField("densityDpi").getInt(sysDm);
            } catch (Throwable t) { /* keep 480 */ }
            int[] densities = new int[]{sysDensity, 640, 480, 320, 240, 160, 0};

            int size = 72;
            for (String pkgRaw : args) {
                String pkg = pkgRaw == null ? "" : pkgRaw.trim();
                if (pkg.isEmpty()) continue;
                try {
                    Object appInfo = getApplicationInfo.invoke(pm, pkg, 0);
                    int iconId = 0;
                    try { iconId = appInfoClass.getField("icon").getInt(appInfo); }
                    catch (Throwable t) { /* PMS path only */ }

                    // Warmup: fully initialise this package's Resources first.
                    Object appRes = null;
                    if (getResourcesForApp != null) {
                        try {
                            appRes = getResourcesForApp.invoke(pm, appInfo);
                            Object cfg = resClass.getMethod("getConfiguration").invoke(appRes);
                            Object dm = resClass.getMethod("getDisplayMetrics").invoke(appRes);
                            resClass.getMethod("updateConfiguration", cfgClass, dmClass)
                                .invoke(appRes, cfg, dm);
                        } catch (Throwable t) { appRes = null; }
                    }

                    boolean done = false;
                    // Path 1: PackageManager's own icon (handles the common case).
                    try {
                        Object drawable = getApplicationIcon.invoke(pm, appInfo);
                        if (drawable != null) {
                            byte[] png = raster(drawable, size, setBounds, draw,
                                createBitmap, argb8888, canvasCtor, canvasClass,
                                bitmapClass, compress, pngFormat);
                            if (isRealPng(png)) {
                                String b64 = (String) encodeToString.invoke(null, png, noWrap);
                                System.out.println("ICON:" + pkg + ":" + b64);
                                done = true;
                            }
                        }
                    } catch (Throwable t) { /* try the sweep */ }

                    // Path 2: density sweep for bundle/split-APK apps whose
                    // mipmaps the device-density request misses.
                    if (!done && appRes != null && iconId != 0) {
                        Object theme = null;
                        try {
                            theme = resClass.getMethod("newTheme").invoke(appRes);
                            int themeId = (Integer) resClass.getMethod("getIdentifier",
                                String.class, String.class, String.class)
                                .invoke(appRes, "Theme.DeviceDefault", "style", "android");
                            if (themeId != 0) {
                                themeClass.getMethod("applyStyle", int.class, boolean.class)
                                    .invoke(theme, themeId, true);
                            }
                        } catch (Throwable t) { theme = null; }
                        int last = -1;
                        for (int den : densities) {
                            if (den == last) continue;
                            last = den;
                            try {
                                Object drawable = loadAtDensity(
                                    appRes, resClass, themeClass, iconId, den, theme);
                                if (drawable == null) continue;
                                byte[] png = raster(drawable, size, setBounds, draw,
                                    createBitmap, argb8888, canvasCtor, canvasClass,
                                    bitmapClass, compress, pngFormat);
                                if (isRealPng(png)) {
                                    String b64 = (String) encodeToString.invoke(null, png, noWrap);
                                    System.out.println("ICON:" + pkg + ":" + b64);
                                    done = true;
                                    break;
                                }
                            } catch (Throwable t) { /* next density */ }
                        }
                    }
                    // Otherwise skipped: the desktop keeps its monogram tile.
                } catch (Throwable t) {
                    // Icon unreadable for this package; skip it.
                }
            }
        } catch (Throwable e) {
            e.printStackTrace(System.err);
        }
        System.exit(0);
    }

    static Object loadAtDensity(Object res, Class<?> resClass, Class<?> themeClass,
            int iconId, int density, Object theme) throws Exception {
        // Newest spelling first; older devices lack the Theme overload.
        if (theme != null) {
            try {
                return resClass.getMethod("getDrawableForDensity",
                    int.class, int.class, themeClass)
                    .invoke(res, iconId, density, theme);
            } catch (Throwable t) { /* fall through */ }
        }
        try {
            return resClass.getMethod("getDrawableForDensity", int.class, int.class)
                .invoke(res, iconId, density);
        } catch (Throwable t) { /* fall through */ }
        return resClass.getMethod("getDrawable", int.class).invoke(res, iconId);
    }

    static byte[] raster(Object drawable, int size, Method setBounds, Method draw,
            Method createBitmap, Object argb8888, java.lang.reflect.Constructor<?> canvasCtor,
            Class<?> canvasClass, Class<?> bitmapClass, Method compress, Object pngFormat)
            throws Exception {
        Object bmp = createBitmap.invoke(null, size, size, argb8888);
        Object canvas = canvasCtor.newInstance(bmp);
        setBounds.invoke(drawable, 0, 0, size, size);
        draw.invoke(drawable, canvas);
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        compress.invoke(bmp, pngFormat, 90, baos);
        return baos.toByteArray();
    }

    static boolean isRealPng(byte[] png) {
        // PNG magic + a plausible body: rejects nulls, empties and blank tiles.
        if (png == null || png.length < 200) return false;
        return (png[0] & 0xFF) == 0x89 && png[1] == 0x50 && png[2] == 0x4E && png[3] == 0x47
            && png[4] == 0x0D && png[5] == 0x0A && png[6] == 0x1A && png[7] == 0x0A;
    }
}
`;

// The on-device artwork helper. A media session's album art is exposed only as
// a content:// URI owned by the player app; `adb shell content read` mangles
// the binary crossing the shell, so this opens the URI with a real
// ContentResolver, downsamples to a 512px bound (album art can be 2000px+ and
// the shell channel is slow), JPEG-compresses and prints one
// `ART:<index>:<base64>` line per URI it could read. Indices match the argv
// order so URIs containing colons never need parsing. Anything unreadable
// (permission, missing provider, revoked grant) is skipped, not faked — the
// desktop side keeps the launcher icon for those.
const MEDIA_ART_JAVA_SRC = `
package com.companion;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Method;

public class MediaArtFetcher {
    public static void main(String[] args) {
        try {
            try {
                Class<?> looperClass = Class.forName("android.os.Looper");
                looperClass.getMethod("prepareMainLooper").invoke(null);
            } catch (Throwable t) { /* already prepared */ }

            Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
            Object activityThread = activityThreadClass.getMethod("systemMain").invoke(null);
            Object context = activityThreadClass.getMethod("getSystemContext").invoke(activityThread);

            Class<?> contextClass = Class.forName("android.content.Context");
            Object resolver = contextClass.getMethod("getContentResolver").invoke(context);

            Class<?> resolverClass = Class.forName("android.content.ContentResolver");
            Method openInputStream = resolverClass.getMethod("openInputStream", Class.forName("android.net.Uri"));
            Class<?> uriClass = Class.forName("android.net.Uri");
            Method parseUri = uriClass.getMethod("parse", String.class);

            Class<?> bitmapFactoryOptionsClass = Class.forName("android.graphics.BitmapFactory$Options");
            Class<?> bitmapFactoryClass = Class.forName("android.graphics.BitmapFactory");
            Method decodeStreamBounds = null;
            Method decodeStream = null;
            for (Method m : bitmapFactoryClass.getMethods()) {
                if (!m.getName().equals("decodeStream")) continue;
                Class<?>[] ps = m.getParameterTypes();
                if (ps.length == 3 && ps[2].getName().endsWith("BitmapFactory$Options")) decodeStreamBounds = m;
                if (ps.length == 2 && ps[0].getName().endsWith("InputStream")) decodeStream = m;
            }

            Class<?> bitmapClass = Class.forName("android.graphics.Bitmap");
            Method createScaled = null;
            for (Method m : bitmapClass.getMethods()) {
                if (m.getName().equals("createScaledBitmap")) {
                    Class<?>[] ps = m.getParameterTypes();
                    if (ps.length == 4) createScaled = m;
                }
            }
            Method getWidth = bitmapClass.getMethod("getWidth");
            Method getHeight = bitmapClass.getMethod("getHeight");
            Class<?> compressFormatClass = Class.forName("android.graphics.Bitmap$CompressFormat");
            Object jpegFormat = compressFormatClass.getField("JPEG").get(null);
            Method compress = bitmapClass.getMethod("compress", compressFormatClass, int.class, java.io.OutputStream.class);

            Object noWrap = 2; // Base64.NO_WRAP
            Class<?> base64Class = Class.forName("android.util.Base64");
            Method encodeToString = base64Class.getMethod("encodeToString", byte[].class, int.class);

            for (int i = 0; i < args.length; i++) {
                String uriStr = args[i] == null ? "" : args[i].trim();
                if (uriStr.isEmpty()) continue;
                InputStream in = null;
                try {
                    Object uri = parseUri.invoke(null, uriStr);
                    in = (InputStream) openInputStream.invoke(resolver, uri);
                    if (in == null) continue;
                    byte[] raw = readAll(in);
                    try { in.close(); } catch (Throwable t) { /* ignore */ }
                    if (raw == null || raw.length < 64) continue;
                    Object bmp = null;
                    try {
                        // Downsample large art to a 512px bound via bounds decode.
                        Object opts = bitmapFactoryOptionsClass.newInstance();
                        bitmapFactoryOptionsClass.getField("inJustDecodeBounds").set(opts, true);
                        java.lang.reflect.Method decodeBytes = null;
                        for (Method m : bitmapFactoryClass.getMethods()) {
                            if (m.getName().equals("decodeByteArray")) {
                                Class<?>[] ps = m.getParameterTypes();
                                if (ps.length == 4) decodeBytes = m;
                            }
                        }
                        if (decodeBytes != null && decodeStreamBounds != null) {
                            decodeBytes.invoke(null, raw, 0, raw.length, opts);
                            int w = bitmapFactoryOptionsClass.getField("outWidth").getInt(opts);
                            int h = bitmapFactoryOptionsClass.getField("outHeight").getInt(opts);
                            int sample = 1;
                            while ((w / (sample * 2) >= 512 || h / (sample * 2) >= 512) && sample < 8) sample *= 2;
                            Object opts2 = bitmapFactoryOptionsClass.newInstance();
                            bitmapFactoryOptionsClass.getField("inSampleSize").set(opts2, sample);
                            bmp = decodeBytes.invoke(null, raw, 0, raw.length, opts2);
                        }
                    } catch (Throwable t) { bmp = null; }
                    String b64;
                    if (bmp != null) {
                        try {
                            int w = ((Integer) getWidth.invoke(bmp)).intValue();
                            int h = ((Integer) getHeight.invoke(bmp)).intValue();
                            int bound = 512;
                            Object out = bmp;
                            if (w > bound || h > bound) {
                                float s = Math.min((float) bound / w, (float) bound / h);
                                out = createScaled.invoke(null, bmp, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), true);
                            }
                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            compress.invoke(out, jpegFormat, 85, baos);
                            b64 = (String) encodeToString.invoke(null, baos.toByteArray(), noWrap);
                        } catch (Throwable t) {
                            b64 = (String) encodeToString.invoke(null, raw, noWrap);
                        }
                    } else {
                        // Not a decodable bitmap (or decode failed): ship raw bytes.
                        b64 = (String) encodeToString.invoke(null, raw, noWrap);
                    }
                    if (b64 == null || b64.length() < 32) continue;
                    System.out.println("ART:" + i + ":" + b64);
                } catch (Throwable t) {
                    // Unreadable URI for this index; skip it.
                } finally {
                    if (in != null) { try { in.close(); } catch (Throwable t) { /* ignore */ } }
                }
            }
        } catch (Throwable e) {
            e.printStackTrace(System.err);
        }
        System.exit(0);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) {
            baos.write(buf, 0, n);
            if (baos.size() > 4 * 1024 * 1024) break; // 4 MB cap per image
        }
        return baos.toByteArray();
    }
}
`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
    get(url);
  });
}

async function main() {
  if (!fs.existsSync(R8_PATH)) {
    console.log('Downloading r8.jar (Google dexer)…');
    await download(R8_URL, R8_PATH);
    console.log('  saved', fs.statSync(R8_PATH).size, 'bytes');
  }

  const srcDir = path.join(ROOT, 'temp_src', 'com', 'companion');
  const classesDir = path.join(ROOT, 'temp_classes');
  const outDir = path.join(ROOT, 'assets');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'IconExtractor.java'), JAVA_SRC);
  fs.writeFileSync(path.join(srcDir, 'MediaArtFetcher.java'), MEDIA_ART_JAVA_SRC);

  console.log('Compiling with javac…');
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', classesDir,
    path.join(srcDir, 'IconExtractor.java'),
    path.join(srcDir, 'MediaArtFetcher.java')], { stdio: 'inherit' });

  console.log('Dexing with r8/d8…');
  execFileSync('java', ['-cp', R8_PATH, 'com.android.tools.r8.D8', '--output', outDir,
    path.join(classesDir, 'com', 'companion', 'IconExtractor.class'),
    path.join(classesDir, 'com', 'companion', 'MediaArtFetcher.class')], { stdio: 'inherit' });

  fs.rmSync(path.join(ROOT, 'temp_src'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'temp_classes'), { recursive: true, force: true });
  console.log('Built', path.join(outDir, 'classes.dex'), '-', fs.statSync(path.join(outDir, 'classes.dex')).size, 'bytes');
}

main().catch((err) => { console.error(err); process.exit(1); });
