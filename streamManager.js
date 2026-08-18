/**
 * WebCast Stream Manager
 * High-performance frame routing, binary WebSocket broadcasting,
 * and multipart HTTP MJPEG streaming for legacy iOS devices
 */
const sessionManager = require('./sessionManager');
const config = require('./config');

class StreamManager {
  constructor() {
    // Session bandwidth trackers: sessionId -> { byteCount, frameCount, lastCheckTime, bitrateKbps, fps }
    this.stats = new Map();
  }

  /**
   * Handle incoming binary frame/audio from sender
   * @param {string} sessionId
   * @param {Buffer} buffer - Raw JPEG video frame or PCM audio chunk
   * @param {Object} metadata - { width, height, timestamp, quality, fps }
   */
  handleBinaryFrame(sessionId, buffer, metadata = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !buffer || buffer.length === 0) return;

    const now = Date.now();
    const isAudio = buffer[0] === 0x02;

    if (isAudio) {
      // Audio Packet: Route immediately to all connected receivers
      session.receivers.forEach((rec, socketId) => {
        if (rec.socket && rec.socket.readyState === 1 && rec.socket.bufferedAmount < 65536) {
          try {
            rec.socket.send(buffer, { binary: true });
          } catch (err) {
            console.error(`[StreamManager] Failed to send audio to receiver ${socketId}:`, err.message);
          }
        }
      });
      return;
    }

    // Video Frame
    const frameBuffer = buffer[0] === 0x01 ? buffer.subarray(1) : buffer;
    session.latestFrame = frameBuffer;
    session.latestFrameTimestamp = metadata.timestamp || now;
    session.state.totalFramesSent++;
    session.lastActiveAt = now;

    if (metadata.width && metadata.height) {
      session.state.actualWidth = metadata.width;
      session.state.actualHeight = metadata.height;
    }

    // 1. Broadcast binary frame over WebSocket to all legacy & modern canvas receivers
    session.receivers.forEach((rec, socketId) => {
      if (rec.socket && rec.socket.readyState === 1) {
        if (rec.socket.bufferedAmount > 32768) {
          return;
        }

        try {
          rec.socket.send(buffer, { binary: true });
          rec.framesDelivered++;
        } catch (err) {
          console.error(`[StreamManager] Failed to send frame to receiver ${socketId}:`, err.message);
        }
      }
    });

    // 2. Stream to active HTTP MJPEG listeners (Safari <img> tags)
    if (session.mjpegListeners.size > 0) {
      const header = `--webcast_frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\nX-Timestamp: ${now}\r\n\r\n`;
      const footer = `\r\n`;

      session.mjpegListeners.forEach((res) => {
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(header);
            res.write(frameBuffer);
            res.write(footer);
          } catch (err) {
            console.error(`[StreamManager] Error writing MJPEG chunk:`, err.message);
            sessionManager.removeMjpegListener(sessionId, res);
          }
        }
      });
    }

    // 3. Track metrics
    this.updateStats(sessionId, frameBuffer.length);
  }

  /**
   * Update real-time throughput metrics
   */
  updateStats(sessionId, bytes) {
    let stat = this.stats.get(sessionId);
    const now = Date.now();

    if (!stat) {
      stat = {
        bytes: 0,
        frames: 0,
        lastTime: now,
        bitrateKbps: 0,
        fps: 0
      };
      this.stats.set(sessionId, stat);
    }

    stat.bytes += bytes;
    stat.frames += 1;

    // Calculate every 1000ms
    const elapsed = now - stat.lastTime;
    if (elapsed >= 1000) {
      stat.bitrateKbps = Math.round((stat.bytes * 8) / elapsed);
      stat.fps = Math.round((stat.frames * 1000) / elapsed);
      stat.bytes = 0;
      stat.frames = 0;
      stat.lastTime = now;

      // Update session state
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.state.currentBitrateKbps = stat.bitrateKbps;
      }
    }
  }

  /**
   * Serve a single live snapshot image
   */
  getLatestFrame(sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !session.latestFrame) return null;
    return session.latestFrame;
  }
}

module.exports = new StreamManager();
