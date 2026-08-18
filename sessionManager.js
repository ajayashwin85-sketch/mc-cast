/**
 * WebCast Session Manager
 * Handles pairing, lifecycle, room codes, and state tracking
 */
const config = require('./config');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanupInactiveSessions(), config.CLEANUP_INTERVAL_MS);
  }

  /**
   * Generate a readable 6-character session code (A-Z, 2-9 avoiding ambiguous chars 0/O, 1/I)
   */
  generateSessionId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // Ensure uniqueness
    if (this.sessions.has(code)) {
      return this.generateSessionId();
    }
    return code;
  }

  /**
   * Create a new session for a sender
   */
  createSession(customId = null, initialSettings = {}) {
    const id = (customId && !this.sessions.has(customId.toUpperCase())) 
      ? customId.toUpperCase() 
      : this.generateSessionId();

    const session = {
      id,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      senderSocket: null,
      receivers: new Map(), // socketId -> { socket, isLegacy, clientType, connectedAt }
      mjpegListeners: new Set(), // Set of HTTP response objects for MJPEG streaming
      hlsSegments: [],
      
      // Stream state
      state: {
        isStreaming: false,
        quality: initialSettings.quality || config.DEFAULT_QUALITY,
        fps: initialSettings.fps || config.DEFAULT_LEGACY_FPS,
        actualWidth: 0,
        actualHeight: 0,
        streamMode: 'ws-canvas', // 'ws-canvas' | 'mjpeg' | 'webrtc' | 'hls'
        totalFramesSent: 0,
        currentBitrateKbps: 0,
        sourceType: 'screen' // 'screen' | 'camera' | 'companion' | 'canvas'
      },

      // Latest frame buffer for newly joined receivers (instant image)
      latestFrame: null,
      latestFrameTimestamp: 0
    };

    this.sessions.set(id, session);
    console.log(`[SessionManager] Created session: ${id}`);
    return session;
  }

  /**
   * Get session by ID (case-insensitive)
   */
  getSession(sessionId) {
    if (!sessionId) return null;
    return this.sessions.get(sessionId.toUpperCase()) || null;
  }

  /**
   * Register sender socket
   */
  registerSender(sessionId, socket) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    session.senderSocket = socket;
    session.lastActiveAt = Date.now();
    this.broadcastSessionState(sessionId);
    console.log(`[SessionManager] Sender attached to session: ${sessionId}`);
    return session;
  }

  /**
   * Register receiver socket
   */
  registerReceiver(sessionId, socketId, socket, isLegacy = false, clientType = 'safari-legacy') {
    const session = this.getSession(sessionId);
    if (!session) return null;

    session.receivers.set(socketId, {
      socket,
      isLegacy,
      clientType,
      connectedAt: Date.now(),
      framesDelivered: 0,
      lastPingMs: 0
    });
    
    session.lastActiveAt = Date.now();
    console.log(`[SessionManager] Receiver ${socketId} joined session ${sessionId} (Legacy: ${isLegacy}, Type: ${clientType})`);
    
    // Notify sender that a receiver connected
    this.notifySender(sessionId, {
      type: 'receiver-joined',
      receiverId: socketId,
      isLegacy,
      clientType,
      totalReceivers: session.receivers.size + session.mjpegListeners.size
    });

    this.broadcastSessionState(sessionId);
    return session;
  }

  /**
   * Register HTTP MJPEG listener
   */
  registerMjpegListener(sessionId, res) {
    const session = this.getSession(sessionId);
    if (!session) return false;

    session.mjpegListeners.add(res);
    session.lastActiveAt = Date.now();

    this.notifySender(sessionId, {
      type: 'receiver-joined',
      receiverId: 'mjpeg-http-' + Date.now(),
      isLegacy: true,
      clientType: 'mjpeg-native',
      totalReceivers: session.receivers.size + session.mjpegListeners.size
    });

    this.broadcastSessionState(sessionId);
    return true;
  }

  /**
   * Remove HTTP MJPEG listener
   */
  removeMjpegListener(sessionId, res) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.mjpegListeners.delete(res);
    this.notifySender(sessionId, {
      type: 'receiver-left',
      totalReceivers: session.receivers.size + session.mjpegListeners.size
    });
    this.broadcastSessionState(sessionId);
  }

  /**
   * Remove a receiver
   */
  removeReceiver(sessionId, socketId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    if (session.receivers.has(socketId)) {
      session.receivers.delete(socketId);
      console.log(`[SessionManager] Receiver ${socketId} left session ${sessionId}`);

      this.notifySender(sessionId, {
        type: 'receiver-left',
        receiverId: socketId,
        totalReceivers: session.receivers.size + session.mjpegListeners.size
      });

      this.broadcastSessionState(sessionId);
    }
  }

  /**
   * Handle sender disconnection
   */
  removeSender(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.senderSocket = null;
    session.state.isStreaming = false;
    session.lastActiveAt = Date.now();

    // Broadcast to all receivers that sender disconnected
    this.broadcastToReceivers(sessionId, {
      type: 'sender-disconnected',
      message: 'Sender has disconnected. Waiting for reconnection...'
    });

    this.broadcastSessionState(sessionId);
  }

  /**
   * Update stream state (resolution, quality, fps, streaming status)
   */
  updateStreamState(sessionId, updates) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    Object.assign(session.state, updates);
    session.lastActiveAt = Date.now();
    this.broadcastSessionState(sessionId);
    return session.state;
  }

  /**
   * Send JSON message to the session's sender
   */
  notifySender(sessionId, message) {
    const session = this.getSession(sessionId);
    if (session && session.senderSocket && session.senderSocket.readyState === 1) {
      try {
        session.senderSocket.send(JSON.stringify(message));
      } catch (err) {
        console.error(`[SessionManager] Error notifying sender in session ${sessionId}:`, err.message);
      }
    }
  }

  /**
   * Broadcast message to all connected WebSocket receivers
   */
  broadcastToReceivers(sessionId, message, excludeSocketId = null) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const data = typeof message === 'string' ? message : JSON.stringify(message);
    session.receivers.forEach((rec, socketId) => {
      if (socketId !== excludeSocketId && rec.socket && rec.socket.readyState === 1) {
        try {
          rec.socket.send(data);
        } catch (err) {
          console.error(`[SessionManager] Error broadcasting to receiver ${socketId}:`, err.message);
        }
      }
    });
  }

  /**
   * Broadcast current session state to sender and all receivers
   */
  broadcastSessionState(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const statePayload = {
      type: 'session-state',
      sessionId: session.id,
      hasSender: Boolean(session.senderSocket && session.senderSocket.readyState === 1),
      receiverCount: session.receivers.size + session.mjpegListeners.size,
      state: session.state
    };

    this.notifySender(sessionId, statePayload);
    this.broadcastToReceivers(sessionId, statePayload);
  }

  /**
   * Periodically remove dead sessions
   */
  cleanupInactiveSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      const isDead = !session.senderSocket && session.receivers.size === 0 && session.mjpegListeners.size === 0;
      const isTimedOut = (now - session.lastActiveAt) > config.SESSION_TIMEOUT_MS;

      if (isDead && isTimedOut) {
        console.log(`[SessionManager] Cleaning up dead session: ${id}`);
        this.sessions.delete(id);
      }
    }
  }
}

module.exports = new SessionManager();
