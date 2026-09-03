// softcam-bridge.cpp
// ---------------------------------------------------------------------------
// Android PC Companion - phone camera -> DirectShow virtual webcam bridge.
//
// Reads a raw video stream on stdin and pushes each frame into a tshino/softcam
// virtual camera through softcam's Sender API. The Electron app spawns this as:
//
//     softcam-bridge.exe --fps <N>
//
// then writes, back to back with no gaps, a sequence of length-prefixed BGR24
// frames produced by ffmpeg (see src/webcam.js):
//
//     [u32le width][u32le height][ width*height*3 bytes, BGR24, top-down ]
//
// The width/height ride in every frame header, so a mid-stream resolution
// change (the phone rotating, or a different camera being selected) is handled
// by recreating the softcam instance instead of corrupting the stream.
//
// Orientation: ffmpeg emits BGR24 *top-down* (first row in memory = top of the
// picture), but softcam serves RGB24 through DirectShow using the Windows DIB
// convention, which is *bottom-up* (first row in the buffer = bottom of the
// picture). Sent verbatim the image is upside down in Zoom/Teams, so each frame
// is flipped vertically before scSendFrame. Colour order already matches:
// ffmpeg "bgr24" is B,G,R per pixel, exactly what softcam wants, so there is no
// channel swap. Pass --no-flip to send verbatim (for debugging a source that is
// already bottom-up).
//
// Build: see native/softcam-bridge/build.bat. It links softcam.lib (the import
// library emitted by the softcam solution) and #includes softcam.h; at runtime
// the exe loads softcam.dll, which the app ships beside it in assets/softcam/.
// ---------------------------------------------------------------------------

#include <windows.h>

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <io.h>
#include <fcntl.h>

#include "softcam.h"

namespace {

// Read exactly `n` bytes from stdin into `dst`. Returns false on a clean EOF
// (zero bytes at a frame boundary) or on a pipe error. A short read that is not
// at a boundary keeps looping until the buffer is full or the pipe closes.
bool readExact(uint8_t* dst, size_t n) {
    size_t got = 0;
    while (got < n) {
        const size_t want = n - got;
        const size_t r = std::fread(dst + got, 1, want, stdin);
        if (r == 0) return false; // EOF or error
        got += r;
    }
    return true;
}

uint32_t readU32LE(const uint8_t* p) {
    return  (uint32_t)p[0]
         | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16)
         | ((uint32_t)p[3] << 24);
}

} // namespace

int main(int argc, char** argv) {
    float fps = 30.0f;
    bool flip = true; // ffmpeg is top-down; softcam wants bottom-up (see header)

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--fps" && i + 1 < argc) {
            fps = (float)std::atof(argv[++i]);
            if (!(fps > 0.0f) || fps > 240.0f) fps = 30.0f;
        } else if (a == "--no-flip") {
            flip = false;
        } else if (a == "--flip") {
            flip = true;
        } else {
            std::fprintf(stderr, "softcam-bridge: ignoring unknown arg '%s'\n", a.c_str());
        }
    }

    // stdin carries raw binary frames; without this the CRT would translate
    // bytes that happen to look like CR/LF or Ctrl-Z and desync the stream.
    _setmode(_fileno(stdin), _O_BINARY);

    scCamera cam = nullptr;
    int camW = 0, camH = 0;

    std::vector<uint8_t> frame;   // one incoming frame (top-down)
    std::vector<uint8_t> flipped; // vertically flipped copy (bottom-up)
    uint8_t header[8];
    uint64_t frameCount = 0;

    while (true) {
        if (!readExact(header, sizeof(header))) {
            break; // clean EOF at a frame boundary: upstream finished
        }
        const uint32_t w = readU32LE(header);
        const uint32_t h = readU32LE(header + 4);

        // Reject a desynced / garbage header before allocating against it.
        if (w == 0 || h == 0 || w > 8192 || h > 8192) {
            std::fprintf(stderr, "softcam-bridge: bad frame size %ux%u - aborting\n", w, h);
            break;
        }

        const size_t bytes = (size_t)w * (size_t)h * 3;
        if (frame.size() != bytes) frame.resize(bytes);
        if (!readExact(frame.data(), bytes)) {
            std::fprintf(stderr, "softcam-bridge: stdin closed mid-frame\n");
            break;
        }

        // (Re)create the softcam instance on the first frame or a size change.
        if (!cam || (int)w != camW || (int)h != camH) {
            if (cam) { scDeleteCamera(cam); cam = nullptr; }
            cam = scCreateCamera((int)w, (int)h, fps);
            if (!cam) {
                std::fprintf(stderr, "softcam-bridge: scCreateCamera(%u,%u,%.1f) failed - "
                                     "is softcam.dll registered?\n", w, h, fps);
                return 2;
            }
            camW = (int)w;
            camH = (int)h;
            std::fprintf(stderr, "softcam-bridge: camera %ux%u @ %.1ffps ready\n", w, h, fps);
        }

        const uint8_t* out = frame.data();
        if (flip) {
            if (flipped.size() != bytes) flipped.resize(bytes);
            const size_t stride = (size_t)w * 3;
            for (uint32_t y = 0; y < h; ++y) {
                std::memcpy(flipped.data() + (size_t)y * stride,
                            frame.data() + (size_t)(h - 1 - y) * stride,
                            stride);
            }
            out = flipped.data();
        }

        scSendFrame(cam, out);
        ++frameCount;
    }

    if (cam) scDeleteCamera(cam);
    std::fprintf(stderr, "softcam-bridge: sent %llu frames, exiting\n",
                 (unsigned long long)frameCount);
    return 0;
}
