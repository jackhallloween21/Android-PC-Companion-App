// Rebuilds assets/classes.dex — the tiny helper the app pushes to a device to
// read launcher icons (see the "App icons" section in main.js).
//
// Why this exists: adb cannot hand back an app's icon. `pm`/`dumpsys` only print
// a numeric resource id, and the bitmap lives inside the APK, so the only way to
// get the real icon without pulling whole APKs is to run code on the device with
// a real PackageManager. This builds a ~4 KB dex that does exactly that; the app
// runs it with `app_process`, the same mechanism scrcpy uses for its server.
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
            Method getApplicationInfo = pmClass.getMethod("getApplicationInfo", String.class, int.class);
            Method getApplicationIcon = pmClass.getMethod("getApplicationIcon", Class.forName("android.content.pm.ApplicationInfo"));

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

            int size = 72;
            for (String pkg : args) {
                try {
                    Object appInfo = getApplicationInfo.invoke(pm, pkg.trim(), 0);
                    Object drawable = getApplicationIcon.invoke(pm, appInfo);
                    if (drawable == null) continue;
                    Object bmp = createBitmap.invoke(null, size, size, argb8888);
                    Object canvas = canvasCtor.newInstance(bmp);
                    setBounds.invoke(drawable, 0, 0, size, size);
                    draw.invoke(drawable, canvas);
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    compress.invoke(bmp, pngFormat, 90, baos);
                    String b64 = (String) encodeToString.invoke(null, baos.toByteArray(), noWrap);
                    System.out.println("ICON:" + pkg.trim() + ":" + b64);
                } catch (Throwable t) {
                    // Icon unreadable for this package; skip it.
                }
            }
        } catch (Throwable e) {
            e.printStackTrace(System.err);
        }
        System.exit(0);
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

  console.log('Compiling with javac…');
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', classesDir, path.join(srcDir, 'IconExtractor.java')], { stdio: 'inherit' });

  console.log('Dexing with r8/d8…');
  execFileSync('java', ['-cp', R8_PATH, 'com.android.tools.r8.D8', '--output', outDir, path.join(classesDir, 'com', 'companion', 'IconExtractor.class')], { stdio: 'inherit' });

  fs.rmSync(path.join(ROOT, 'temp_src'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'temp_classes'), { recursive: true, force: true });
  console.log('Built', path.join(outDir, 'classes.dex'), '-', fs.statSync(path.join(outDir, 'classes.dex')).size, 'bytes');
}

main().catch((err) => { console.error(err); process.exit(1); });
