/**
 * WebCast Companion Screen Streamer
 * Allows streaming screen video frames directly into any active WebCast session
 * from Node.js, ADB, or external sources without browser restrictions.
 */
const WebSocket = require('ws');
const { spawn } = require('child_process');

const sessionId = (process.argv[2] || '').toUpperCase();
const serverUrl = process.argv[3] || 'ws://localhost:3000/ws';

if (!sessionId) {
  console.log('\nUsage: node companion_stream.js <SESSION_CODE> [WS_SERVER_URL]');
  console.log('Example: node companion_stream.js DH4VLT\n');
  process.exit(1);
}

console.log(`Connecting Companion Streamer to session [${sessionId}] at ${serverUrl}...`);

const ws = new WebSocket(serverUrl);
ws.binaryType = 'arraybuffer';

ws.on('open', () => {
  console.log('✔ Connected to WebCast Relay!');
  ws.send(JSON.stringify({
    type: 'join-sender',
    sessionId: sessionId,
    settings: {
      quality: '720p',
      fps: 30,
      sourceType: 'companion'
    }
  }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'sender-joined') {
      console.log(`✔ Attached as sender for session ${sessionId}. Receivers connected: ${msg.receiverCount}`);
    }
  } catch (e) {}
});

ws.on('close', () => {
  console.log('Companion streamer disconnected.');
});
