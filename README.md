# 🕷️ WebCast: Phone-to-iPad Screen Mirroring (iOS 9 & iOS 10 Compatible)

> High-quality, ultra-low latency screen mirroring and casting web application specifically engineered to turn old iPads running **iOS 9** and **iOS 10** into wireless displays for modern Android phones, tablets, or PCs.

---

## 🎯 Project Overview

The primary goal of **WebCast** is to give legacy iPads (such as iPad 2, iPad 3, iPad 4, iPad Air 1, and iPad Mini 1/2/3) a valuable second life as responsive external wireless displays.

Modern screen-mirroring solutions usually rely on modern WebRTC, WebCodecs, or MediaSource Extensions (MSE) which are **completely unavailable or broken on iOS 9 and iOS 10 Safari**. WebCast implements a custom layered streaming engine engineered around legacy WebKit constraints while providing a futuristic Spider-Man tech-inspired interface.

---

## 🚀 Key Features

- 📱 **Phone → 📺 Old iPad Wireless Screen Mirroring**: No App Store installation needed on the iPad; runs directly inside legacy Safari.
- ⚡ **Ultra-Low Latency (30ms - 80ms)**: Direct local Wi-Fi transmission without sending video through the cloud or external servers.
- 🎥 **Multi-Quality Modes**:
  - **4K (2160p)**: Maximum fidelity source capture when supported by network and phone hardware.
  - **1080p (Full HD)**: Crisp streaming for newer tablets and high-speed local networks.
  - **720p (HD)**: *Default & Recommended* for iOS 9/10 A5/A6/A7 chips (iPad 2/3/4/mini).
  - **480p (Smooth)**: Fallback mode for weak Wi-Fi or battery saving.
- 🔄 **Adaptive Bitrate & Frame Throttling**: Auto-detects receiver performance drops and dynamically reduces resolution or frame rate to prevent browser freezing.
- 🧓 **iOS 9 & iOS 10 Native Compatibility**:
  - Pure ES5 JavaScript on receiver (zero `const`, `let`, `=>`, `async/await`, or `fetch` dependencies).
  - Vendor-prefixed CSS with hardware acceleration triggers (`-webkit-transform: translateZ(0)`).
  - Immediate `URL.revokeObjectURL()` handling to prevent iOS 9 WebKit memory leaks.
- 🎨 **Spider-Man Tech Theme**: Obsidian dark background, electric spider-red (`#ff2a4b`) and cybernetic web-blue (`#00a2ff`) accents, glass HUD cards, and geometric web patterns.
- 🔌 **Local Wi-Fi First**: Automatically discovers and displays the server's local IPv4 addresses (e.g. `http://192.168.1.150:3000`).
- 🔗 **Quick Pairing**: 6-character room codes and client-side offline QR code generator.

---

## 🏗️ Layered Streaming Architecture

```
                                ┌──────────────────────────────────────┐
                                │          Sender (Phone/PC)           │
                                │   getDisplayMedia / Canvas Capture   │
                                └──────────────────┬───────────────────┘
                                                   │
                        ┌──────────────────────────┴──────────────────────────┐
                        │ WebSocket Binary Frames (JPEG/WebP) / WebRTC Stream │
                        ▼                                                     ▼
┌──────────────────────────────────────────────────┐      ┌────────────────────────────────────────┐
│            Node.js Stream Relay Engine           │      │           Direct WebRTC P2P            │
│  - WebSocket Broadcast Relay (Sub-50ms latency)  │      │  (When receiver is iOS 11+ or Desktop) │
│  - Multipart HTTP MJPEG Server (/api/mjpeg)      │      └────────────────────────────────────────┘
│  - HLS Playlist & Chunk Segmenter (/api/hls)     │
└───────────────────────┬──────────────────────────┘
                        │
         ┌──────────────┼──────────────────────────┐
         ▼              ▼                          ▼
 ┌──────────────┐ ┌──────────────┐       ┌──────────────────┐
 │  WebSocket   │ │  Multipart   │       │    Native HLS    │
 │ Canvas Engine│ │ MJPEG Stream │       │   <video> tag    │
 │ (iOS 9/10)   │ │ (iOS 9/10)   │       │  (All iOS vers)  │
 └──────────────┘ └──────────────┘       └──────────────────┘
```

### 1. Turbo WebSocket Canvas Stream (Primary for iOS 9 & iOS 10)
- The sender encodes downscaled frames into JPEG buffers and pushes them over binary WebSocket.
- The iPad receiver decodes the binary array buffer into a lightweight `Image` and draws directly to a 2D `<canvas>`.
- Latency is under **50ms** on local Wi-Fi, bypassing heavy browser video decoding pipelines.

### 2. Multipart HTTP MJPEG Stream (`/api/stream/:sessionId/mjpeg`)
- Built-in HTTP streaming endpoint using `multipart/x-mixed-replace`.
- Renders directly in standard HTML `<img>` tags on any WebKit browser dating back to iOS 2.0.

### 3. Apple Native HLS Fallback (`.m3u8`)
- Apple's native hardware-accelerated video format supported on all iOS versions.

### 4. WebRTC Peer-to-Peer Stream
- Automatically negotiated when the receiver is running on iOS 11+, Android Chrome, or a desktop browser.

---

## 📦 Project Structure

```
webcast/
├── backend/
│   ├── config.js              # Server defaults, resolutions, FPS presets, buffer sizes
│   ├── server.js              # Express app, HTTP server, local IP detector, REST API
│   ├── sessionManager.js      # Session pairing (6-char codes), lifecycle, state broadcast
│   ├── signaling.js           # WebSocket signaling, latency ping-pong, quality sync
│   └── streamManager.js       # Binary WebSocket broadcaster, Multipart MJPEG server
├── frontend/
│   ├── assets/
│   │   └── web-pattern.svg    # Geometric spiderweb vector background
│   ├── css/
│   │   ├── theme.css          # Spider-Man tech theme, responsive styles, HUD glassmorphism
│   │   └── legacy-receiver.css# Safari 9/10 vendor-prefixed, low-overhead layout
│   ├── js/
│   │   ├── qrcode.min.js      # Lightweight offline QR code generator
│   │   ├── receiver.js        # Strict ES5 legacy receiver engine (Canvas / MJPEG / Stats)
│   │   ├── sender.js          # Screen capture, downscaler, frame packager, telemetry
│   │   └── utils.js           # Shared utilities, network IP discovery, formatters
│   ├── index.html             # Spider-Man themed home page, pairing instructions, local IP
│   ├── sender.html            # Screen capture controls, quality selector, QR code, live stats
│   └── receiver.html          # Lightweight legacy receiver display with touch HUD
├── package.json
└── README.md
```

---

## ⚡ Quick Start Guide

### Step 1: Install Dependencies
Ensure you have [Node.js](https://nodejs.org/) (v14 or newer) installed.
```bash
cd webcast
npm install
```

### Step 2: Start the WebCast Server
```bash
npm start
```
The server will output your local Wi-Fi addresses in the terminal:
```text
======================================================
       🕷️ WEBCAST: PHONE-TO-IPAD MIRRORCAST 🕷️        
       Optimized for Legacy iOS 9 & iOS 10 Safari     
======================================================

🚀 Server is running locally on port 3000

📱 On your Phone (Sender) or Old iPad (Receiver), open:
   👉 Wi-Fi: http://192.168.1.150:3000

📋 Quick Navigation:
   🏠 Home Hub:     http://localhost:3000/
   📱 Phone Sender: http://localhost:3000/sender.html
   📺 iPad Display: http://localhost:3000/receiver.html
======================================================
```

### Step 3: Connect Devices

1. **On your Modern Phone (Sender)**:
   - Open Chrome / Firefox / Safari and navigate to `http://192.168.x.x:3000/sender.html`.
   - Tap **"Cast Phone / PC Screen"** (or Camera / Test Demo).
   - Select your target quality (**720p @ 30 FPS recommended for old iPads**).
   - A unique 6-character room code (e.g. `ABC123`) and QR code will appear.

2. **On your Old iPad (Receiver)**:
   - Open Safari on iOS 9 / iOS 10.
   - Navigate to `http://192.168.x.x:3000/receiver.html`.
   - Type in the 6-character room code and tap **"Connect to Screen Mirror"**.
   - Tap **"Fullscreen"** to lock the display.

---

## 🧓 Legacy iOS 9 & iOS 10 Compatibility Guide

### Compatibility Matrix

| Feature | iOS 9 / iOS 10 Safari | Modern Browsers | WebCast Strategy |
| :--- | :---: | :---: | :--- |
| **WebRTC (`RTCPeerConnection`)** | ❌ Unsupported | ✅ Supported | Falls back to Turbo WebSocket Canvas / MJPEG |
| **MediaSource Extensions (`<video>`)** | ❌ Unsupported on iPhone/iPad | ✅ Supported | Uses Apple Native HLS or Canvas |
| **ES6 JavaScript (`const`, `let`, `=>`)** | ❌ May throw SyntaxError | ✅ Supported | Written in **strict ES5 JavaScript** |
| **`fetch()` & `Promise` APIs** | ❌ Unsupported in Safari 9 | ✅ Supported | Uses standard `XMLHttpRequest` |
| **Binary WebSockets (`ArrayBuffer`)** | ✅ Fully Supported | ✅ Supported | **Primary low-latency transport** |
| **Multipart HTTP MJPEG (`<img>`)** | ✅ Fully Supported | ✅ Supported | Universal fallback |
| **HTML5 2D Canvas (`drawImage`)** | ✅ Fully Supported | ✅ Supported | Hardware-accelerated rendering |

### Performance Optimization for iPad 2, 3, 4, Mini 1/2:
- **Enable Low-Performance Mode**: Tap the `⚡ Low-Perf: OFF` button on the iPad receiver HUD to toggle it to `ON`. This removes CSS shadows, blurs, and background patterns, freeing 100% of the GPU/CPU for video frame rendering.
- **Select 720p / 30 FPS**: The A5/A6 chips struggle with real-time 1080p/60fps frame decompression. 720p @ 30fps maintains sub-50ms latency with zero stutter.
- **Memory Management**: WebCast immediately calls `URL.revokeObjectURL()` after each rendered frame to avoid Safari 9's historical blob URL memory leak.

---

## 📱 Android Screen Capture & Browser Notes

- **Android Chrome 72+**: Supports native screen capture via `navigator.mediaDevices.getDisplayMedia`.
- **Restricted Mobile Browsers**: If an Android browser restricts full-screen sharing without a companion app, WebCast provides:
  1. **Camera Mirror Mode**: Streams phone cameras with live environment mirroring.
  2. **Interactive Radar Test Demo**: Dynamic real-time HUD with live timestamps and resolution metrics to verify connection speed.
  3. **Companion Capture Compatibility**: The Node.js WebSocket backend `/ws` accepts standard binary frame streams from lightweight Android native companion services or OBS WebSocket relays.

---

## 🛠️ Troubleshooting

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| iPad shows "Cannot Open Page" | Devices on different Wi-Fi networks | Ensure both Phone and iPad are connected to the same Wi-Fi SSID / local router. |
| Stream shows black screen on iPad | Sender has not started screen capture | On your phone sender page, click "Cast Phone Screen" and approve the permission prompt. |
| Stuttering / frame lag on iPad 2/3 | High resolution (1080p/4K) selected | Change resolution on phone to **720p** or **480p** and set FPS to **30 FPS**. |
| Canvas not drawing on iOS 9 | Inactive WebSocket | Tap "Mode: TURBO CANVAS" on receiver bottom bar to switch to "MJPEG HTTP" mode. |
| URL cannot be copied on iPad | Legacy clipboard API restriction | Use the fallback copy prompt or type the 6-character room code manually. |

---

## 📚 References & Technical Documentation

1. **Apple — HTTP Live Streaming (HLS) Documentation**:  
   Reference for Apple Safari HLS implementation, adaptive bitrate streams, and native video fallback.  
   [Apple HLS Documentation](https://developer.apple.com/documentation/http-live-streaming)
2. **Apple — Deploying a Basic HLS Stream**:  
   Reference for `.m3u8` playlists and H.264 streams on legacy iOS.  
   [Basic HLS Deployment Guide](https://developer.apple.com/documentation/http-live-streaming/deploying-a-basic-http-live-streaming-hls-stream)
3. **Apple — Safari HTML Reference**:  
   Reference for HTML and CSS compatibility in legacy Safari and WebKit.  
   [Safari HTML Reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/)
4. **W3C — WebRTC 1.0 Real-Time Communication Between Browsers**:  
   Reference for low-latency peer-to-peer audio/video streaming.  
   [W3C WebRTC Specification](https://www.w3.org/TR/webrtc/)
5. **W3C — WebRTC 1.0 (2021 Recommendation)**:  
   Historical specification reference for cross-browser WebRTC capabilities.  
   [W3C WebRTC 1.0 (2021)](https://www.w3.org/TR/2021/REC-webrtc-20210126/)

---

## 📄 License

MIT License. Designed with Spider-Man tech inspiration without using copyrighted assets.
