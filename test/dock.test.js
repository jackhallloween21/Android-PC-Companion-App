// Tests for the docked-mirror geometry. The case that matters is a tall phone on
// a short monitor: unscaled, a 1080x2400 portrait video is taller than a 1080p
// display, which would push the control strip off-screen entirely.

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS,
  ZOOM_MIN,
  ZOOM_MAX,
  stepZoom,
  parseWmSize,
  parseRotation,
  computeDockLayout,
  barBelow,
  buildWindowArgs,
  supportsPlacement,
} = require('../src/dock');

const HELP_MODERN = `
Options:
    -b, --video-bit-rate=value
    --window-x=value
    --window-y=value
    --window-width=value
    --window-height=value
    --window-borderless
    --always-on-top
`;

const HELP_OLD = `
Options:
    -b, --bit-rate value
    -m, --max-size value
`;

// A 1080p monitor with a 40px taskbar.
const FHD = { x: 0, y: 0, width: 1920, height: 1040 };

test('wm size prefers the override over the physical size', () => {
  assert.deepStrictEqual(parseWmSize('Physical size: 1080x2400'), { width: 1080, height: 2400 });
  assert.deepStrictEqual(
    parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340'),
    { width: 1080, height: 2340 },
    'the override is what the compositor actually renders'
  );
  assert.strictEqual(parseWmSize('cannot connect'), null);
  assert.strictEqual(parseWmSize(''), null);
  assert.strictEqual(parseWmSize(undefined), null);
});

test('rotation is read from any of the shapes dumpsys uses', () => {
  assert.strictEqual(parseRotation('  mCurrentRotation=ROTATION_90'), 1);
  assert.strictEqual(parseRotation('SurfaceOrientation: 0'), 0);
  assert.strictEqual(parseRotation('mRotation=3'), 3);
  assert.strictEqual(parseRotation('nothing useful here'), null);
  assert.strictEqual(parseRotation(''), null);
});

test('a tall phone is scaled down so the bar still fits on screen', () => {
  const { video, bar, scale } = computeDockLayout({
    deviceWidth: 1080, deviceHeight: 2400, workArea: FHD,
  });
  assert.ok(scale < 1, 'a 2400px-tall video cannot fit a 1040px work area unscaled');
  const blockBottom = bar.y + bar.height;
  assert.ok(blockBottom <= FHD.y + FHD.height, `block bottom ${blockBottom} must stay inside the work area`);
  assert.ok(video.y >= FHD.y);
  assert.strictEqual(bar.y, video.y + video.height + DEFAULTS.gap, 'bar sits directly under the video');
  // Aspect ratio survives the scaling, so scrcpy has no reason to letterbox.
  assert.ok(Math.abs(video.width / video.height - 1080 / 2400) < 0.01);
});

test('video and bar share a centre line', () => {
  const { video, bar } = computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, workArea: FHD });
  const centre = (r) => r.x + r.width / 2;
  assert.ok(Math.abs(centre(video) - centre(bar)) <= 1);
  assert.ok(Math.abs(centre(video) - (FHD.x + FHD.width / 2)) <= 1);
});

test('the bar is widened past a narrow video so its buttons fit', () => {
  const { video, bar } = computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, workArea: FHD });
  assert.ok(video.width < DEFAULTS.minBarWidth, 'a scaled portrait phone is narrower than the bar needs');
  assert.strictEqual(bar.width, DEFAULTS.minBarWidth);
});

test('a landscape rotation swaps the video dimensions', () => {
  const portrait = computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, rotation: 0, workArea: FHD });
  const landscape = computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, rotation: 1, workArea: FHD });
  assert.ok(landscape.video.width > landscape.video.height);
  assert.ok(portrait.video.height > portrait.video.width);
  assert.strictEqual(
    computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, rotation: 3, workArea: FHD }).video.width,
    landscape.video.width,
    '270° is landscape too'
  );
});

test('maxSize caps the longest edge before the screen fit is applied', () => {
  const capped = computeDockLayout({
    deviceWidth: 1080, deviceHeight: 2400, maxSize: 800, workArea: FHD,
  });
  assert.ok(capped.video.height <= 800);
  assert.strictEqual(capped.scale, 1, 'already under the cap, so no further shrink was needed');
});

test('dimensions are even and a missing device size falls back to a portrait default', () => {
  const { video } = computeDockLayout({ workArea: FHD });
  assert.strictEqual(video.width % 2, 0, 'odd dimensions upset some hardware encoders');
  assert.strictEqual(video.height % 2, 0);
  assert.ok(video.height > video.width, 'the fallback is a portrait phone');
});

test('a work area on a second monitor is respected, not assumed to start at 0,0', () => {
  const right = { x: 1920, y: 100, width: 2560, height: 1300 };
  const { video, bar } = computeDockLayout({ deviceWidth: 1080, deviceHeight: 2400, workArea: right });
  assert.ok(video.x >= right.x && video.x < right.x + right.width);
  assert.ok(video.y >= right.y);
  assert.ok(bar.y + bar.height <= right.y + right.height);
});

test('computeDockLayout refuses to guess a work area', () => {
  assert.throws(() => computeDockLayout({}), /workArea/);
  assert.throws(() => computeDockLayout({ workArea: { x: 0, y: 0 } }), /workArea/);
});

test('window args are feature-detected like every other scrcpy flag', () => {
  const video = { x: 700, y: 40, width: 420, height: 934 };
  assert.deepStrictEqual(buildWindowArgs(video, HELP_MODERN), [
    '--window-x=700', '--window-y=40', '--window-width=420', '--window-height=934',
  ], 'bordered by default, so the window can be dragged and resized by hand');
  assert.deepStrictEqual(
    buildWindowArgs(video, HELP_MODERN, { borderless: true }),
    ['--window-x=700', '--window-y=40', '--window-width=420', '--window-height=934',
      '--window-borderless']
  );
  assert.deepStrictEqual(
    buildWindowArgs(video, HELP_MODERN, { borderless: false, alwaysOnTop: true }),
    ['--window-x=700', '--window-y=40', '--window-width=420', '--window-height=934', '--always-on-top']
  );
  assert.deepStrictEqual(buildWindowArgs(video, HELP_OLD), [],
    'a build advertising none of them gets no placement args rather than a fatal unknown option');
  assert.deepStrictEqual(buildWindowArgs(null, HELP_MODERN), []);
});

// ---- Re-dock ---------------------------------------------------------------
// The video window keeps its title bar, so the user can drag it anywhere. The
// strip has to be placed relative to where it actually is, not where it started.

test('the strip is centred under a video window wherever it has been dragged', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const bar = barBelow({ x: 1200, y: 100, width: 400, height: 700 }, workArea);
  assert.strictEqual(bar.y, 810, 'directly under the window, one gap down');
  assert.strictEqual(bar.x + Math.round(bar.width / 2), 1400, 'shares the window centre line');
  assert.strictEqual(bar.width, DEFAULTS.minBarWidth,
    'a narrow window still gets a strip wide enough for its buttons');
});

test('a window dragged to an edge still gets a clickable strip', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const low = barBelow({ x: 20, y: 700, width: 400, height: 320 }, workArea);
  assert.ok(low.y + low.height <= 1040, 'not pushed behind the taskbar');
  assert.ok(low.x >= 0, 'not pushed off the left edge');
  const right = barBelow({ x: 1700, y: 100, width: 200, height: 400 }, workArea);
  assert.ok(right.x + right.width <= 1920, 'not pushed off the right edge');
});

test('barBelow refuses to guess when it has no rectangle to work from', () => {
  assert.throws(() => barBelow(null, { x: 0, y: 0, width: 1920, height: 1040 }), /video rectangle/i);
  assert.throws(() => barBelow({ x: 0, y: 0, width: 400, height: 800 }, null), /workArea/i);
});

test('placement support gates the dock option', () => {
  assert.strictEqual(supportsPlacement(HELP_MODERN), true);
  assert.strictEqual(supportsPlacement(HELP_OLD), false);
  assert.strictEqual(supportsPlacement(null), true, 'unreadable help falls back to assuming the modern CLI');
});

// ---- Zoom ------------------------------------------------------------------
// Zoom is a fraction of the largest size that fits, not of the device's own
// resolution, so 100% always means "as big as this screen allows".

test('stepZoom clamps at both ends and keeps one decimal place', () => {
  assert.strictEqual(stepZoom(0.5, 1), 0.6);
  assert.strictEqual(stepZoom(0.5, -1), 0.4);
  assert.strictEqual(stepZoom(ZOOM_MAX, 1), ZOOM_MAX, 'cannot zoom past the fitted size');
  assert.strictEqual(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.strictEqual(stepZoom(undefined, -1), 0.9, 'a session with no zoom yet is treated as fitted');
  // 0.7 - 0.1 is 0.5999999999999999 in binary floating point.
  assert.strictEqual(stepZoom(0.7, -1), 0.6);
});

test('zoom scales the video without letting the bar leave the work area', () => {
  const base = {
    deviceWidth: 1080,
    deviceHeight: 2400,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  const fitted = computeDockLayout(base);
  assert.strictEqual(fitted.zoom, 1);

  for (const zoom of [1, 0.75, 0.5, ZOOM_MIN]) {
    const l = computeDockLayout({ ...base, zoom });
    assert.strictEqual(l.zoom, zoom);
    assert.ok(l.video.width <= fitted.video.width, `zoom ${zoom} is no wider than fitted`);
    assert.ok(l.bar.y + l.bar.height <= base.workArea.y + base.workArea.height,
      `at zoom ${zoom} the strip still ends inside the work area`);
    assert.ok(Math.abs((l.video.width / l.video.height) - (1080 / 2400)) < 0.01,
      `zoom ${zoom} preserves aspect so scrcpy has no reason to letterbox`);
  }

  const half = computeDockLayout({ ...base, zoom: 0.5 });
  assert.ok(Math.abs(half.video.height - fitted.video.height / 2) <= 2,
    'halving the zoom halves the video height, give or take the even-pixel rounding');
});

test('fit and zoom are reported separately, and out-of-range zoom is clamped', () => {
  const layout = computeDockLayout({
    deviceWidth: 1080,
    deviceHeight: 2400,
    zoom: 5,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  });
  assert.strictEqual(layout.zoom, ZOOM_MAX);
  assert.ok(layout.fit < 1, 'a 2400px-tall video cannot fit a 1040px work area unscaled');
  assert.strictEqual(layout.scale, layout.fit * layout.zoom);

  const tiny = computeDockLayout({
    deviceWidth: 1080,
    deviceHeight: 2400,
    zoom: 0.01,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  });
  assert.strictEqual(tiny.zoom, ZOOM_MIN, 'zoom below the floor is raised, not honoured');
});
