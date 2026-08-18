/**
 * WebCast Signaling & WebSocket Handler
 * Coordinates WebRTC SDP exchange, frame streaming metadata,
 * quality negotiation, and latency telemetry
 */
const sessionManager = require('./sessionManager');
const streamManager = require('./streamManager');
const config = require('./config');

function handleSignaling(ws, req) {
  let clientRole = null; // 'sender' | 'receiver'
  let currentSessionId = null;
  let socketId = 'sock_' + Math.random().toString(36).substr(2, 9);
  let pendingFrameMeta = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    // 1. Handle incoming binary frame from sender
    if (isBinary) {
      if (clientRole === 'sender' && currentSessionId) {
        streamManager.handleBinaryFrame(currentSessionId, data, pendingFrameMeta || {});
        pendingFrameMeta = null;
      }
      return;
    }

    // 2. Handle JSON control & signaling messages
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    switch (msg.type) {
      // SENDER REGISTRATION
      case 'join-sender': {
        currentSessionId = (msg.sessionId || '').toUpperCase();
        clientRole = 'sender';
        
        let session = sessionManager.getSession(currentSessionId);
        if (!session) {
          session = sessionManager.createSession(currentSessionId, msg.settings);
        }
        
        sessionManager.registerSender(currentSessionId, ws);
        
        ws.send(JSON.stringify({
          type: 'sender-joined',
          sessionId: currentSessionId,
          success: true,
          state: session.state,
          receiverCount: session.receivers.size + session.mjpegListeners.size
        }));
        break;
      }

      // RECEIVER REGISTRATION
      case 'join-receiver': {
        currentSessionId = (msg.sessionId || '').toUpperCase();
        clientRole = 'receiver';

        const session = sessionManager.getSession(currentSessionId);
        if (!session) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Session "${currentSessionId}" not found. Check the code on the sender phone.`
          }));
          return;
        }

        const isLegacy = Boolean(msg.isLegacy);
        const clientType = msg.clientType || 'safari-legacy';

        sessionManager.registerReceiver(currentSessionId, socketId, ws, isLegacy, clientType);

        ws.send(JSON.stringify({
          type: 'receiver-joined',
          sessionId: currentSessionId,
          socketId: socketId,
          success: true,
          state: session.state,
          hasSender: Boolean(session.senderSocket),
          recommendedQuality: isLegacy ? '720p' : session.state.quality,
          recommendedFps: isLegacy ? config.DEFAULT_LEGACY_FPS : session.state.fps
        }));
        break;
      }

      // METADATA PRECEDING BINARY FRAME
      case 'frame-meta': {
        if (clientRole === 'sender') {
          pendingFrameMeta = {
            width: msg.width,
            height: msg.height,
            timestamp: msg.timestamp || Date.now(),
            quality: msg.quality
          };
        }
        break;
      }

      // STREAM STATE UPDATES FROM SENDER
      case 'update-state': {
        if (clientRole === 'sender' && currentSessionId) {
          sessionManager.updateStreamState(currentSessionId, msg.updates || {});
        }
        break;
      }

      // AUDIO INFO FROM SENDER — broadcast sample rate to all receivers
      case 'audio-info': {
        if (clientRole === 'sender' && currentSessionId) {
          sessionManager.broadcastToReceivers(currentSessionId, {
            type: 'audio-info',
            sampleRate: msg.sampleRate
          });
        }
        break;
      }

      // RECEIVER REQUESTS QUALITY / FPS CHANGE (Adaptive downscaling)
      case 'request-quality': {
        if (clientRole === 'receiver' && currentSessionId) {
          sessionManager.notifySender(currentSessionId, {
            type: 'quality-change-request',
            receiverId: socketId,
            quality: msg.quality,
            fps: msg.fps,
            reason: msg.reason || 'performance'
          });
        }
        break;
      }

      // WebRTC SIGNALING (FOR MODERN RECEIVERS)
      case 'webrtc-offer': {
        if (clientRole === 'sender' && currentSessionId) {
          sessionManager.broadcastToReceivers(currentSessionId, {
            type: 'webrtc-offer',
            offer: msg.offer,
            senderId: socketId
          });
        }
        break;
      }

      case 'webrtc-answer': {
        if (clientRole === 'receiver' && currentSessionId) {
          sessionManager.notifySender(currentSessionId, {
            type: 'webrtc-answer',
            answer: msg.answer,
            receiverId: socketId
          });
        }
        break;
      }

      case 'webrtc-candidate': {
        if (currentSessionId) {
          if (clientRole === 'sender') {
            sessionManager.broadcastToReceivers(currentSessionId, {
              type: 'webrtc-candidate',
              candidate: msg.candidate
            });
          } else {
            sessionManager.notifySender(currentSessionId, {
              type: 'webrtc-candidate',
              candidate: msg.candidate,
              receiverId: socketId
            });
          }
        }
        break;
      }

      // TELEMETRY / LATENCY PING-PONG
      case 'ping': {
        ws.send(JSON.stringify({
          type: 'pong',
          clientTime: msg.clientTime,
          serverTime: Date.now()
        }));
        break;
      }

      // RECEIVER TELEMETRY REPORT
      case 'receiver-telemetry': {
        if (clientRole === 'receiver' && currentSessionId) {
          sessionManager.notifySender(currentSessionId, {
            type: 'receiver-telemetry-report',
            receiverId: socketId,
            fps: msg.fps,
            latencyMs: msg.latencyMs,
            droppedFrames: msg.droppedFrames
          });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (currentSessionId) {
      if (clientRole === 'sender') {
        sessionManager.removeSender(currentSessionId);
      } else if (clientRole === 'receiver') {
        sessionManager.removeReceiver(currentSessionId, socketId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Signaling] Socket error (${socketId}):`, err.message);
  });
}

module.exports = { handleSignaling };
