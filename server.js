/**
 * WebCast Main Application Server
 * Express + WebSockets + Multi-Protocol Streaming (WS Canvas, MJPEG, WebRTC)
 * Supports dual HTTP (Port 3000 for legacy iPad) and HTTPS (Port 3443 for Android screen capture)
 */
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const config = require('./config');
const sessionManager = require('./sessionManager');
const streamManager = require('./streamManager');
const { handleSignaling } = require('./signaling');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/css', express.static(__dirname));
app.use('/js', express.static(__dirname));
app.use(express.static(path.join(__dirname, '../frontend')));

/**
 * Discover all local network IPv4 addresses (Wi-Fi, Ethernet, Hotspot)
 */
function getLocalNetworkIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          interface: name,
          ip: iface.address,
          httpUrl: `http://${iface.address}:${config.PORT}`,
          httpsUrl: `https://${iface.address}:${config.HTTPS_PORT}`
        });
      }
    }
  }

  if (addresses.length === 0) {
    addresses.push({
      interface: 'Localhost',
      ip: '127.0.0.1',
      httpUrl: `http://127.0.0.1:${config.PORT}`,
      httpsUrl: `https://127.0.0.1:${config.HTTPS_PORT}`
    });
  }

  return addresses;
}

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

/**
 * Server Info & Network Discovery
 */
app.get('/api/info', (req, res) => {
  const networkIps = getLocalNetworkIps();
  res.json({
    appName: 'WebCast MirrorCast',
    version: '1.0.0',
    port: config.PORT,
    httpsPort: config.HTTPS_PORT,
    primaryHttpUrl: networkIps[0] ? networkIps[0].httpUrl : `http://localhost:${config.PORT}`,
    primaryHttpsUrl: networkIps[0] ? networkIps[0].httpsUrl : `https://localhost:${config.HTTPS_PORT}`,
    networkIps: networkIps,
    presets: config.QUALITY_PRESETS,
    fpsOptions: config.FPS_OPTIONS,
    defaultQuality: config.DEFAULT_QUALITY,
    defaultFps: config.DEFAULT_LEGACY_FPS
  });
});

/**
 * Create a new session
 */
app.post('/api/session/create', async (req, res) => {
  try {
    const { customCode, quality, fps } = req.body || {};
    const session = sessionManager.createSession(customCode, { quality, fps });
    const networkIps = getLocalNetworkIps();
    const primaryHost = networkIps[0] ? networkIps[0].httpUrl : `http://localhost:${config.PORT}`;
    const receiverUrl = `${primaryHost}/receiver.html?session=${session.id}`;

    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(receiverUrl, {
        margin: 2,
        width: 280,
        color: {
          dark: '#080a10',
          light: '#ffffff'
        }
      });
    } catch (qrErr) {
      console.warn('[Server] Could not generate QR code:', qrErr.message);
    }

    res.json({
      success: true,
      sessionId: session.id,
      receiverUrl: receiverUrl,
      qrCode: qrDataUrl,
      state: session.state
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get Session Status
 */
app.get('/api/session/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  res.json({
    success: true,
    sessionId: session.id,
    hasSender: Boolean(session.senderSocket),
    receiverCount: session.receivers.size + session.mjpegListeners.size,
    state: session.state
  });
});

/**
 * Multipart HTTP MJPEG Stream (/api/stream/:id/mjpeg)
 */
app.get('/api/stream/:id/mjpeg', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).send('Session not found');
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=webcast_frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate, pre-check=0, post-check=0, max-age=0',
    'Pragma': 'no-cache',
    'Connection': 'close',
    'Access-Control-Allow-Origin': '*'
  });

  if (session.latestFrame) {
    res.write(`--webcast_frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${session.latestFrame.length}\r\n\r\n`);
    res.write(session.latestFrame);
    res.write('\r\n');
  }

  sessionManager.registerMjpegListener(session.id, res);

  req.on('close', () => {
    sessionManager.removeMjpegListener(session.id, res);
  });
});

/**
 * Single JPEG Snapshot Endpoint (/api/stream/:id/snapshot.jpg)
 */
app.get('/api/stream/:id/snapshot.jpg', (req, res) => {
  const frame = streamManager.getLatestFrame(req.params.id);
  if (!frame) {
    return res.status(503).send('No frame available yet');
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': frame.length,
    'Cache-Control': 'no-cache, no-store'
  });
  res.end(frame);
});

// Convenient URL routing
app.get('/sender', (req, res) => {
  res.sendFile(path.join(__dirname, 'sender.html'));
});

app.get('/receiver', (req, res) => {
  res.sendFile(path.join(__dirname, 'receiver.html'));
});

// -------------------------------------------------------------
// CREATE HTTP & HTTPS SERVERS WITH WEBSOCKETS
// -------------------------------------------------------------
const httpServer = http.createServer(app);
const wssHttp = new WebSocketServer({ server: httpServer, path: '/ws' });
wssHttp.on('connection', (ws, req) => handleSignaling(ws, req));

// Generate self-signed SSL certs for HTTPS
let httpsServer = null;
let wssHttps = null;

try {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'webcast.local' }], { days: 365 });
  httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
  wssHttps = new WebSocketServer({ server: httpsServer, path: '/ws' });
  wssHttps.on('connection', (ws, req) => handleSignaling(ws, req));
} catch (sslErr) {
  console.warn('[Server] Could not initialize HTTPS server:', sslErr.message);
}

// Heartbeat ping interval to keep connections alive
function setupHeartbeat(wssInstance) {
  if (!wssInstance) return;
  const heartbeatInterval = setInterval(() => {
    wssInstance.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);

  wssInstance.on('close', () => clearInterval(heartbeatInterval));
}

setupHeartbeat(wssHttp);
setupHeartbeat(wssHttps);

// -------------------------------------------------------------
// START SERVERS
// -------------------------------------------------------------
httpServer.listen(config.PORT, '0.0.0.0', () => {
  const ips = getLocalNetworkIps();
  console.log('\n======================================================');
  console.log('       🕷️ WEBCAST: PHONE-TO-IPAD MIRRORCAST 🕷️        ');
  console.log('       Optimized for Legacy iOS 9 & iOS 10 Safari     ');
  console.log('======================================================');
  console.log(`\n🚀 HTTP Server (for iPad Receiver):  http://localhost:${config.PORT}`);
  if (httpsServer) {
    httpsServer.listen(config.HTTPS_PORT, '0.0.0.0', () => {
      console.log(`🔒 HTTPS Server (for Phone Sender): https://localhost:${config.HTTPS_PORT}`);
    });
  }

  console.log('\n📱 On your Phone (Sender):');
  ips.forEach((item) => {
    console.log(`   👉 Secure Screen Mirroring: ${item.httpsUrl}/sender.html`);
  });

  console.log('\n📺 On your Old iPad (Receiver):');
  ips.forEach((item) => {
    console.log(`   👉 Standard Display:       ${item.httpUrl}/receiver.html`);
  });
  console.log('======================================================\n');
});
