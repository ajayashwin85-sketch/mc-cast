/**
 * WebCast Legacy Receiver Engine
 * STRICTLY ES5 JAVASCRIPT - OPTIMIZED FOR iOS 9 & iOS 10 SAFARI
 * No const, let, arrow functions, async/await, fetch, or ES6 classes.
 * High-performance double-buffered canvas rendering & multipart MJPEG fallback.
 */
(function() {
  'use strict';

  // DOM Elements
  var viewportElem = document.getElementById('receiver-viewport');
  var canvasElem = document.getElementById('stream-canvas');
  var mjpegElem = document.getElementById('stream-mjpeg');
  var videoElem = document.getElementById('stream-video');
  var hudOverlay = document.getElementById('hud-overlay');
  var joinModal = document.getElementById('join-modal');
  var sessionInput = document.getElementById('session-code-input');
  var btnConnect = document.getElementById('btn-connect');
  var connectingOverlay = document.getElementById('connecting-overlay');
  var connectStatusText = document.getElementById('connect-status-text');
  
  var statFpsElem = document.getElementById('hud-fps');
  var statResElem = document.getElementById('hud-res');
  var statBitrateElem = document.getElementById('hud-bitrate');
  var statModeElem = document.getElementById('hud-mode');
  var statLatencyElem = document.getElementById('hud-latency');
  var statStatusElem = document.getElementById('hud-status');

  var btnFullscreen = document.getElementById('btn-fullscreen');
  var btnTogglePerf = document.getElementById('btn-toggle-perf');
  var btnToggleAudio = document.getElementById('btn-toggle-audio');
  var btnSwitchMode = document.getElementById('btn-switch-mode');
  var btnReconnect = document.getElementById('btn-reconnect');
  var compatNoticeElem = document.getElementById('compat-notice');

  // Canvas Context
  var ctx = canvasElem ? canvasElem.getContext('2d', { alpha: false }) : null;

  // Audio Context & State
  var audioCtx = null;
  var isAudioMuted = false;
  var nextAudioPlayTime = 0;
  var audioSampleRate = 44100;

  // Session & Connection State
  var sessionId = '';
  var ws = null;
  var streamMode = 'ws-canvas'; // 'ws-canvas' | 'mjpeg' | 'webrtc'
  var isConnected = false;
  var isLowPerfMode = false;
  var reconnectTimer = null;
  var hudHideTimer = null;

  // Telemetry & Metrics
  var framesReceived = 0;
  var bytesReceived = 0;
  var lastFpsTime = Date.now();
  var currentFps = 0;
  var lagCount = 0;
  var lastFrameTimestamp = 0;
  var imageWorker = new Image();
  var isDrawing = false;

  // Detect iOS 9 / 10
  var env = WebCastUtils.detectEnvironment();

  /**
   * Main Initialization
   */
  function init() {
    // Auto-detect Low Performance Mode recommendation for older iOS devices
    if (env.isLegacyIOS) {
      enableLowPerfMode(true);
      if (compatNoticeElem) {
        compatNoticeElem.textContent = 'Legacy iOS ' + env.iosVersion + ' Safari detected. Hardware acceleration & Turbo Canvas enabled.';
        compatNoticeElem.style.display = 'block';
      }
    }

    setupEventListeners();
    setupTouchHUD();

    // Check if session ID was passed in query string (e.g. ?session=ABC123)
    var querySession = WebCastUtils.getQueryParam('session');
    if (querySession) {
      sessionId = querySession.toUpperCase();
      if (sessionInput) sessionInput.value = sessionId;
      startConnection();
    }
  }

  /**
   * Connect to Session
   */
  function startConnection() {
    if (!sessionId) {
      if (sessionInput) sessionId = (sessionInput.value || '').trim().toUpperCase();
    }
    if (!sessionId) {
      alert('Please enter a 6-character session code.');
      return;
    }

    if (joinModal) joinModal.style.display = 'none';
    showConnecting(true, 'Connecting to room ' + sessionId + '...');

    connectWebSocket();
  }

  /**
   * Connect WebSocket Stream
   */
  function connectWebSocket() {
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }

    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/ws';

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch (wsErr) {
      console.warn('[Receiver] WebSocket creation failed, falling back to MJPEG:', wsErr);
      fallbackToMjpeg('WebSocket not supported');
      return;
    }

    ws.onopen = function() {
      console.log('[Receiver] Connected to signaling server');
      showConnecting(false);
      isConnected = true;
      updateStatusHUD('CONNECTED', 'stat-good');

      // Register as receiver
      ws.send(JSON.stringify({
        type: 'join-receiver',
        sessionId: sessionId,
        isLegacy: env.isLegacyIOS,
        clientType: env.isLegacyIOS ? 'safari-ios-' + env.iosVersion : 'modern-receiver'
      }));

      startTelemetry();
    };

    ws.onmessage = function(event) {
      // 1. Binary Frame (Turbo Canvas Stream)
      if (event.data instanceof ArrayBuffer) {
        handleBinaryFrame(event.data);
        return;
      }

      // 2. Control Messages (JSON)
      try {
        var msg = JSON.parse(event.data);
        handleControlMessage(msg);
      } catch (err) {
        // Non-JSON string
      }
    };

    ws.onclose = function() {
      console.log('[Receiver] Disconnected from server');
      isConnected = false;
      updateStatusHUD('RECONNECTING...', 'stat-warn');
      
      // Auto reconnect after 2 seconds
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function() {
        if (sessionId) connectWebSocket();
      }, 2000);
    };

    ws.onerror = function(err) {
      console.error('[Receiver] WebSocket error:', err);
      if (!isConnected) {
        // If WebSocket completely fails, try direct MJPEG HTTP streaming
        fallbackToMjpeg('Direct WebSocket connection failed');
      }
    };
  }

  var isRenderingFrame = false;

  /**
   * Handle Inbound Binary JPEG Frame or PCM Audio Packet
   */
  function handleBinaryFrame(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;

    var firstByte = new Uint8Array(arrayBuffer, 0, 1)[0];

    // Check if this is an Audio Packet (Tag: 0x02)
    if (firstByte === 0x02) {
      handleAudioChunk(arrayBuffer);
      return;
    }

    if (streamMode !== 'ws-canvas') return;

    framesReceived++;
    bytesReceived += arrayBuffer.byteLength;

    var frameBuffer = (firstByte === 0x01) ? arrayBuffer.slice(1) : arrayBuffer;

    // Fast-path: Hardware-accelerated off-thread decode (Chrome, Edge, Safari 15+, Firefox)
    if (window.createImageBitmap) {
      var blob = new Blob([frameBuffer], { type: 'image/jpeg' });
      createImageBitmap(blob).then(function(bitmap) {
        if (canvasElem && ctx) {
          if (canvasElem.width !== bitmap.width || canvasElem.height !== bitmap.height) {
            canvasElem.width = bitmap.width;
            canvasElem.height = bitmap.height;
            if (statResElem) statResElem.textContent = bitmap.width + 'x' + bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          if (bitmap.close) bitmap.close();
        }
      }).catch(function() {});
      return;
    }

    // Legacy Fallback for iOS 9/10 Safari
    if (isRenderingFrame) return;
    isRenderingFrame = true;

    try {
      var blob = new Blob([frameBuffer], { type: 'image/jpeg' });
      var url = window.URL || window.webkitURL;
      var objectUrl = url.createObjectURL(blob);

      var img = new Image();
      img.onload = function() {
        if (canvasElem && ctx) {
          if (canvasElem.width !== img.width || canvasElem.height !== img.height) {
            canvasElem.width = img.width;
            canvasElem.height = img.height;
            if (statResElem) statResElem.textContent = img.width + 'x' + img.height;
          }
          ctx.drawImage(img, 0, 0);
        }
        url.revokeObjectURL(objectUrl);
        isRenderingFrame = false;
      };
      img.onerror = function() {
        url.revokeObjectURL(objectUrl);
        isRenderingFrame = false;
      };
      img.src = objectUrl;
    } catch (e) {
      isRenderingFrame = false;
    }
  }

  /**
   * Unlock and ensure Web Audio Context is active
   */
  function ensureAudioContext() {
    if (!audioCtx) {
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  /**
   * Handle Inbound Int16 PCM Audio Chunks
   */
  function handleAudioChunk(arrayBuffer) {
    if (isAudioMuted) return;
    ensureAudioContext();
    if (!audioCtx) return;

    try {
      // 1-byte header skipped, read Int16 PCM samples
      var int16 = new Int16Array(arrayBuffer, 1);
      var len = int16.length;
      if (len === 0) return;

      var audioBuffer = audioCtx.createBuffer(1, len, audioSampleRate);
      var channelData = audioBuffer.getChannelData(0);

      for (var i = 0; i < len; i++) {
        channelData[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
      }

      var source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      var now = audioCtx.currentTime;
      if (nextAudioPlayTime < now) {
        nextAudioPlayTime = now + 0.005;
      }

      source.start(nextAudioPlayTime);
      nextAudioPlayTime += audioBuffer.duration;
    } catch (err) {
      console.warn('[Receiver] Audio decode err:', err);
    }
  }

  /**
   * Handle Signaling & Control Messages
   */
  function handleControlMessage(msg) {
    switch (msg.type) {
      case 'receiver-joined':
        console.log('[Receiver] Successfully joined session:', msg.sessionId);
        if (!msg.hasSender) {
          updateStatusHUD('WAITING FOR SENDER', 'stat-warn');
        } else {
          updateStatusHUD('STREAMING', 'stat-good');
        }
        break;

      case 'session-state':
        if (!msg.hasSender) {
          updateStatusHUD('SENDER OFFLINE', 'stat-danger');
        } else if (msg.state && msg.state.isStreaming) {
          updateStatusHUD('LIVE', 'stat-good');
          if (msg.state.actualWidth && statResElem) {
            statResElem.textContent = msg.state.actualWidth + 'x' + msg.state.actualHeight;
          }
        }
        break;

      case 'sender-disconnected':
        updateStatusHUD('SENDER DISCONNECTED', 'stat-danger');
        break;

      case 'pong':
        var latency = Date.now() - msg.clientTime;
        if (statLatencyElem) statLatencyElem.textContent = Math.round(latency / 2) + ' ms';
        break;

      case 'audio-info':
        if (msg.sampleRate) {
          audioSampleRate = msg.sampleRate;
          console.log('[Receiver] Audio sample rate:', audioSampleRate);
        }
        // Unlock AudioContext on first audio-info message
        ensureAudioContext();
        break;

      case 'error':
        alert(msg.message || 'Error connecting to session');
        showConnecting(false);
        if (joinModal) joinModal.style.display = 'block';
        break;

      default:
        break;
    }
  }

  /**
   * Fallback to Multipart MJPEG Stream
   */
  function fallbackToMjpeg(reason) {
    console.log('[Receiver] Switching to MJPEG stream mode:', reason);
    streamMode = 'mjpeg';
    if (statModeElem) statModeElem.textContent = 'MJPEG HTTP';

    if (canvasElem) canvasElem.style.display = 'none';
    if (videoElem) videoElem.style.display = 'none';
    
    if (mjpegElem) {
      mjpegElem.style.display = 'block';
      mjpegElem.src = '/api/stream/' + sessionId + '/mjpeg?t=' + Date.now();
      mjpegElem.onload = function() {
        showConnecting(false);
        updateStatusHUD('MJPEG LIVE', 'stat-good');
      };
      mjpegElem.onerror = function() {
        updateStatusHUD('STREAM RETRYING', 'stat-warn');
      };
    }
  }

  /**
   * Switch back to Turbo Canvas Mode
   */
  function switchToCanvas() {
    streamMode = 'ws-canvas';
    if (statModeElem) statModeElem.textContent = 'TURBO CANVAS';
    if (mjpegElem) {
      mjpegElem.src = '';
      mjpegElem.style.display = 'none';
    }
    if (canvasElem) canvasElem.style.display = 'block';
    connectWebSocket();
  }

  /**
   * Toggle Streaming Mode (Canvas vs MJPEG)
   */
  function toggleStreamMode() {
    if (streamMode === 'ws-canvas') {
      fallbackToMjpeg('User manual toggle');
    } else {
      switchToCanvas();
    }
  }

  /**
   * Telemetry & Performance Monitoring Loop
   */
  function startTelemetry() {
    setInterval(function() {
      var now = Date.now();
      var elapsed = (now - lastFpsTime) / 1000;

      if (elapsed >= 1) {
        currentFps = Math.round(framesReceived / elapsed);
        var kbps = Math.round((bytesReceived * 8) / (elapsed * 1000));

        if (statFpsElem) statFpsElem.textContent = currentFps + ' FPS';
        if (statBitrateElem) statBitrateElem.textContent = WebCastUtils.formatBitrate(kbps);

        // Adaptive performance check:
        // If receiver is on a high quality mode and dropping below 12 FPS repeatedly,
        // automatically request 720p / 30fps from sender
        if (currentFps > 0 && currentFps < 12) {
          lagCount++;
          if (lagCount >= 4 && ws && ws.readyState === 1) {
            console.log('[Receiver] Performance drop detected. Requesting 720p/30fps...');
            ws.send(JSON.stringify({
              type: 'request-quality',
              quality: '720p',
              fps: 30,
              reason: 'iPad CPU optimization'
            }));
            lagCount = 0;
          }
        } else {
          lagCount = 0;
        }

        framesReceived = 0;
        bytesReceived = 0;
        lastFpsTime = now;

        // Ping for latency measurement
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ping', clientTime: now }));
        }
      }
    }, 1000);
  }

  /**
   * Fullscreen Request Handler (Supports iOS Safari WebKit fullscreen)
   */
  function toggleFullscreen() {
    var doc = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (doc.webkitRequestFullscreen) {
        doc.webkitRequestFullscreen();
      } else if (doc.requestFullscreen) {
        doc.requestFullscreen();
      } else if (canvasElem && canvasElem.webkitEnterFullscreen) {
        canvasElem.webkitEnterFullscreen();
      }
    } else {
      if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  /**
   * Low Performance Mode Toggle (Disables CSS blurs and shadows)
   */
  function enableLowPerfMode(enable) {
    isLowPerfMode = enable;
    if (enable) {
      document.body.className += ' low-perf';
      if (btnTogglePerf) btnTogglePerf.textContent = '⚡ Low-Perf: ON';
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
      }
    } else {
      document.body.className = document.body.className.replace(/\blow-perf\b/g, '');
      if (btnTogglePerf) btnTogglePerf.textContent = '⚡ Low-Perf: OFF';
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.webkitImageSmoothingEnabled = true;
      }
    }
  }

  /**
   * Touch HUD auto-hide behavior
   */
  function setupTouchHUD() {
    function showHUD() {
      if (!hudOverlay) return;
      hudOverlay.className = 'hud-visible';
      if (hudHideTimer) clearTimeout(hudHideTimer);
      hudHideTimer = setTimeout(function() {
        if (isConnected) {
          hudOverlay.className = 'hud-hidden';
        }
      }, 4000);
    }

    if (viewportElem) {
      viewportElem.addEventListener('click', showHUD);
      viewportElem.addEventListener('touchstart', showHUD);
    }
    showHUD();
  }

  function updateStatusHUD(text, cssClass) {
    if (statStatusElem) {
      statStatusElem.textContent = text;
      statStatusElem.className = 'hud-stat-pill ' + (cssClass || '');
    }
  }

  function showConnecting(show, text) {
    if (connectingOverlay) {
      connectingOverlay.style.display = show ? '-webkit-flex' : 'none';
      connectingOverlay.style.display = show ? 'flex' : 'none';
    }
    if (connectStatusText && text) {
      connectStatusText.textContent = text;
    }
  }

  function setupEventListeners() {
    if (btnConnect) btnConnect.addEventListener('click', startConnection);
    if (btnFullscreen) btnFullscreen.addEventListener('click', toggleFullscreen);
    if (btnSwitchMode) btnSwitchMode.addEventListener('click', toggleStreamMode);
    if (btnReconnect) btnReconnect.addEventListener('click', startConnection);

    if (btnTogglePerf) {
      btnTogglePerf.addEventListener('click', function() {
        enableLowPerfMode(!isLowPerfMode);
      });
    }

    if (btnToggleAudio) {
      btnToggleAudio.addEventListener('click', function() {
        isAudioMuted = !isAudioMuted;
        if (isAudioMuted) {
          btnToggleAudio.textContent = '🔇 Audio: OFF';
          btnToggleAudio.style.background = 'rgba(255,42,75,0.2)';
          btnToggleAudio.style.borderColor = '#ff2a4b';
          if (audioCtx) audioCtx.suspend();
        } else {
          btnToggleAudio.textContent = '🔊 Audio: ON';
          btnToggleAudio.style.background = 'rgba(0,255,136,0.2)';
          btnToggleAudio.style.borderColor = '#00ff88';
          ensureAudioContext();
          nextAudioPlayTime = 0;
        }
      });
    }

    // Unlock AudioContext on first user interaction (browser policy)
    document.addEventListener('click', function unlockAudio() {
      ensureAudioContext();
      document.removeEventListener('click', unlockAudio);
    }, { once: true });

    // Allow pressing "Enter" in session input
    if (sessionInput) {
      sessionInput.addEventListener('keypress', function(e) {
        if (e.keyCode === 13 || e.which === 13) {
          startConnection();
        }
      });
    }
  }

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
