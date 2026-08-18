/**
 * WebCast Sender Pipeline
 * Captures display media, downscales according to selected quality mode (4K/1080p/720p/480p),
 * packages frames into binary JPEG/WebP streams over WebSockets, and manages WebRTC peer connections.
 */
(function() {
  'use strict';

  // DOM Elements
  var sessionCodeElem = document.getElementById('session-code-display');
  var receiverCountElem = document.getElementById('receiver-count');
  var streamStatusPill = document.getElementById('stream-status-pill');
  var previewVideo = document.getElementById('sender-preview');
  var previewCanvas = document.getElementById('sender-canvas-preview');
  var placeholderElem = document.getElementById('preview-placeholder');
  
  var btnStartScreen = document.getElementById('btn-start-screen');
  var btnStartCamera = document.getElementById('btn-start-camera');
  var btnStartDemo = document.getElementById('btn-start-demo');
  var btnStopStream = document.getElementById('btn-stop-stream');
  var btnCopyLink = document.getElementById('btn-copy-link');

  var statFpsElem = document.getElementById('stat-fps');
  var statResElem = document.getElementById('stat-res');
  var statBitrateElem = document.getElementById('stat-bitrate');
  var statLatencyElem = document.getElementById('stat-latency');
  var statModeElem = document.getElementById('stat-mode');
  var qrCanvas = document.getElementById('qr-canvas');
  var shareUrlElem = document.getElementById('share-url-text');
  var alertContainer = document.getElementById('sender-alerts');
  var chkAudio = document.getElementById('chk-audio');
  var statAudioElem = document.getElementById('stat-audio');

  // Streaming State
  var sessionId = WebCastUtils.getQueryParam('session') || '';
  var ws = null;          // Video WebSocket
  var audioWs = null;     // Dedicated Audio WebSocket (separate to avoid blocking video)
  var mediaStream = null;
  var micStream = null;
  var audioCtx = null;
  var audioSourceNode = null;
  var audioProcessorNode = null;
  var captureType = 'none'; // 'screen' | 'camera' | 'demo'
  var isStreaming = false;
  var currentQuality = '720p';
  var currentFps = 30;

  // Offscreen Encoder Canvas
  var encodeCanvas = document.createElement('canvas');
  var encodeCtx = encodeCanvas.getContext('2d', { alpha: false });

  // Animation / Interval timers
  var frameTimer = null;
  var telemetryTimer = null;
  var demoAnimId = null;

  // Metrics trackers
  var framesSentThisSec = 0;
  var bytesSentThisSec = 0;
  var lastMetricsTime = Date.now();
  var actualSourceWidth = 0;
  var actualSourceHeight = 0;
  var scaledWidth = 1280;
  var scaledHeight = 720;
  var isEncodingFrame = false;

  // Quality presets lookup
  var PRESETS = {
    '4k': { width: 3840, height: 2160, quality: 0.72, maxFps: 60 },
    '1080p': { width: 1920, height: 1080, quality: 0.65, maxFps: 60 },
    '720p': { width: 1280, height: 720, quality: 0.55, maxFps: 30 },
    '480p': { width: 854, height: 480, quality: 0.48, maxFps: 30 }
  };

  /**
   * Initialize Session & WebSocket Connection
   */
  function init() {
    setupQualityButtons();
    setupFpsButtons();
    setupEventListeners();
    checkSecureContext();

    if (!sessionId) {
      // Request server to create a session
      WebCastUtils.ajaxPost('/api/session/create', { quality: currentQuality, fps: currentFps }, function(err, data) {
        if (err || !data || !data.sessionId) {
          showAlert('Failed to create session. Check if backend server is running.', 'danger');
          return;
        }
        sessionId = data.sessionId;
        setupSessionUI(data.receiverUrl);
        connectWebSocket();
      });
    } else {
      var fullUrl = window.location.origin + '/receiver.html?session=' + sessionId;
      setupSessionUI(fullUrl);
      connectWebSocket();
    }
  }

  function setupSessionUI(joinUrl) {
    if (sessionCodeElem) sessionCodeElem.textContent = sessionId;
    if (shareUrlElem) shareUrlElem.textContent = joinUrl;
    
    // Render QR Code
    if (qrCanvas && window.QRCodeGenerator) {
      QRCodeGenerator.renderCanvas(qrCanvas, joinUrl, 200);
    }
  }

  /**
   * Connect WebSocket Signaling & Streaming Relay
   */
  function connectWebSocket() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/ws';

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function() {
      console.log('[Sender] WebSocket connected');
      // Register as sender for this session
      ws.send(JSON.stringify({
        type: 'join-sender',
        sessionId: sessionId,
        settings: {
          quality: currentQuality,
          fps: currentFps,
          sourceType: captureType
        }
      }));

      startTelemetry();
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        // Non-JSON message
      }
    };

    ws.onclose = function() {
      console.log('[Sender] WebSocket disconnected, reconnecting in 2s...');
      setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = function(err) {
      console.error('[Sender] WebSocket error:', err);
    };
  }

  /**
   * Handle Inbound Messages from Server / Receivers
   */
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'sender-joined':
        if (receiverCountElem) receiverCountElem.textContent = msg.receiverCount || '0';
        break;

      case 'receiver-joined':
        showAlert('New receiver joined (' + (msg.clientType || 'Legacy Safari') + ')', 'info');
        if (receiverCountElem) receiverCountElem.textContent = msg.totalReceivers || '1';
        break;

      case 'receiver-left':
        if (receiverCountElem) receiverCountElem.textContent = msg.totalReceivers || '0';
        break;

      case 'quality-change-request':
        showAlert('Receiver requested ' + msg.quality + ' @ ' + msg.fps + 'fps (' + msg.reason + ')', 'warning');
        setQuality(msg.quality);
        setFps(msg.fps);
        break;

      case 'pong':
        var rtt = Date.now() - msg.clientTime;
        if (statLatencyElem) statLatencyElem.textContent = Math.round(rtt / 2) + ' ms';
        break;

      default:
        break;
    }
  }

  /**
   * Check if browser environment supports Screen Capture
   */
  function checkSecureContext() {
    var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    var isHttps = window.location.protocol === 'https:';
    
    if (!isLocal && !isHttps) {
      var httpsUrl = 'https://' + window.location.hostname + ':3443' + window.location.pathname + window.location.search;
      showAlert(
        '⚠️ Browser requires HTTPS for Screen Mirroring. Tap here to switch to Secure HTTPS: ' + httpsUrl,
        'warning'
      );
      
      var banner = document.getElementById('https-warning-banner');
      if (banner) {
        banner.style.display = 'block';
        var link = document.getElementById('https-switch-link');
        if (link) link.href = httpsUrl;
      }
    }
  }

  /**
   * Start Display Media (Screen Capture)
   */
  function startScreenCapture() {
    // 1. Check if navigator.mediaDevices exists
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      var isHttps = window.location.protocol === 'https:';
      var isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      
      if (!isHttps && !isLocal) {
        var httpsUrl = 'https://' + window.location.hostname + ':3443' + window.location.pathname + window.location.search;
        showAlert('Screen capture blocked by browser because this is an HTTP connection. Please open via HTTPS: ' + httpsUrl, 'danger');
        window.location.href = httpsUrl;
        return;
      }

      showAlert('Screen capture is restricted on this mobile browser. Try Chrome with flags or Camera Mirror.', 'danger');
      return;
    }

    var wantAudio = chkAudio ? chkAudio.checked : true;
    var preset = PRESETS[currentQuality];
    var constraints = {
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: currentFps, max: currentFps }
      },
      audio: wantAudio
    };

    navigator.mediaDevices.getDisplayMedia(constraints)
      .then(function(stream) {
        captureType = 'screen';
        handleStreamSuccess(stream);
      })
      .catch(function(err) {
        console.error('[Sender] Screen capture error:', err);
        showAlert('Screen capture cancelled or denied: ' + err.message, 'danger');
      });
  }

  /**
   * Start Camera Capture (Alternative for mobile senders)
   */
  function startCameraCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert('Camera API not supported.', 'danger');
      return;
    }

    var wantAudio = chkAudio ? chkAudio.checked : true;
    var preset = PRESETS[currentQuality];
    var constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: currentFps }
      },
      audio: wantAudio
    };

    navigator.mediaDevices.getUserMedia(constraints)
      .then(function(stream) {
        captureType = 'camera';
        handleStreamSuccess(stream);
      })
      .catch(function(err) {
        showAlert('Camera access error: ' + err.message, 'danger');
      });
  }

  /**
   * Stream Success Handler
   */
  function handleStreamSuccess(stream) {
    mediaStream = stream;
    previewVideo.srcObject = stream;
    previewVideo.style.display = 'block';
    if (previewCanvas) previewCanvas.style.display = 'none';
    if (placeholderElem) placeholderElem.style.display = 'none';

    // Track stream termination by user
    var videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = function() {
        stopStreaming();
      };
    }

    previewVideo.onloadedmetadata = function() {
      previewVideo.play();
      actualSourceWidth = previewVideo.videoWidth || 1920;
      actualSourceHeight = previewVideo.videoHeight || 1080;
      
      calculateScaledDimensions();
      initAudioCapture(stream);
      startFramePipeline();
      updateStreamingUI(true);
    };
  }

  /**
   * Start Dynamic Interactive Demo Pattern
   */
  function startDemoPattern() {
    stopStreaming();
    captureType = 'demo';

    actualSourceWidth = 1920;
    actualSourceHeight = 1080;
    calculateScaledDimensions();

    previewVideo.style.display = 'none';
    if (previewCanvas) {
      previewCanvas.style.display = 'block';
      previewCanvas.width = scaledWidth;
      previewCanvas.height = scaledHeight;
    }
    if (placeholderElem) placeholderElem.style.display = 'none';

    var demoCtx = previewCanvas.getContext('2d');
    var angle = 0;

    function renderDemo() {
      if (captureType !== 'demo') return;
      angle += 0.03;

      // Spider-Man Cyber Tech Radar Canvas
      demoCtx.fillStyle = '#06080d';
      demoCtx.fillRect(0, 0, scaledWidth, scaledHeight);

      // Web Grid
      demoCtx.strokeStyle = 'rgba(0, 162, 255, 0.2)';
      demoCtx.lineWidth = 1;
      for (var x = 0; x < scaledWidth; x += 60) {
        demoCtx.beginPath();
        demoCtx.moveTo(x, 0);
        demoCtx.lineTo(x, scaledHeight);
        demoCtx.stroke();
      }
      for (var y = 0; y < scaledHeight; y += 60) {
        demoCtx.beginPath();
        demoCtx.moveTo(0, y);
        demoCtx.lineTo(scaledWidth, y);
        demoCtx.stroke();
      }

      // Center Radar Circle
      var cx = scaledWidth / 2;
      var cy = scaledHeight / 2;
      demoCtx.strokeStyle = '#ff2a4b';
      demoCtx.lineWidth = 3;
      demoCtx.beginPath();
      demoCtx.arc(cx, cy, 140, 0, Math.PI * 2);
      demoCtx.stroke();

      // Sweeping Beam
      demoCtx.strokeStyle = '#00a2ff';
      demoCtx.lineWidth = 4;
      demoCtx.beginPath();
      demoCtx.moveTo(cx, cy);
      demoCtx.lineTo(cx + Math.cos(angle) * 140, cy + Math.sin(angle) * 140);
      demoCtx.stroke();

      // HUD Text
      demoCtx.fillStyle = '#ffffff';
      demoCtx.font = 'bold 36px monospace';
      demoCtx.textAlign = 'center';
      demoCtx.fillText('WEBCAST SCREEN MIRROR', cx, cy - 180);

      demoCtx.fillStyle = '#00ff88';
      demoCtx.font = 'bold 24px monospace';
      demoCtx.fillText('RESOLUTION: ' + scaledWidth + 'x' + scaledHeight + ' (' + currentQuality.toUpperCase() + ')', cx, cy + 200);
      
      demoCtx.fillStyle = '#8da2be';
      demoCtx.font = '20px monospace';
      demoCtx.fillText(new Date().toLocaleTimeString() + '.' + (Date.now() % 1000), cx, cy + 240);

      demoAnimId = requestAnimationFrame(renderDemo);
    }

    renderDemo();
    startFramePipeline();
    updateStreamingUI(true);
  }

  /**
   * Frame Pipeline: Encodes canvas/video into JPEG and sends via WebSocket
   * Uses requestAnimationFrame for smooth browser-synced capture
   */
  function startFramePipeline() {
    isStreaming = true;
    if (frameTimer) cancelAnimationFrame(frameTimer);

    encodeCanvas.width = scaledWidth;
    encodeCanvas.height = scaledHeight;

    var targetInterval = Math.round(1000 / currentFps);
    var lastFrameTime = 0;
    var isBlobPending = false;

    function captureLoop(now) {
      if (!isStreaming) return;

      frameTimer = requestAnimationFrame(captureLoop);

      var elapsed = now - lastFrameTime;
      if (elapsed < targetInterval) return; // Not time yet

      if (!ws || ws.readyState !== 1) return;

      // Only check video WS backpressure (audio has its own WS now)
      if (ws.bufferedAmount > 131072) return;

      // Don't start new encode if previous is still compressing
      if (isBlobPending) return;

      lastFrameTime = now - (elapsed % targetInterval);

      // Draw source frame
      try {
        if (captureType === 'screen' || captureType === 'camera') {
          if (previewVideo && previewVideo.readyState >= 2) {
            encodeCtx.drawImage(previewVideo, 0, 0, scaledWidth, scaledHeight);
          }
        } else if (captureType === 'demo' && previewCanvas) {
          encodeCtx.drawImage(previewCanvas, 0, 0, scaledWidth, scaledHeight);
        } else {
          return;
        }
      } catch (e) { return; }

      var preset = PRESETS[currentQuality] || PRESETS['720p'];

      if (encodeCanvas.toBlob) {
        isBlobPending = true;
        encodeCanvas.toBlob(function(blob) {
          isBlobPending = false;
          if (blob && ws && ws.readyState === 1) {
            ws.send(blob);
            framesSentThisSec++;
            bytesSentThisSec += blob.size;
          }
        }, 'image/jpeg', preset.quality);
      } else {
        var dataUrl = encodeCanvas.toDataURL('image/jpeg', preset.quality);
        var base64 = dataUrl.split(',')[1];
        if (base64 && ws && ws.readyState === 1) {
          var binaryStr = atob(base64);
          var len = binaryStr.length;
          var bytes = new Uint8Array(len);
          for (var i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
          ws.send(bytes.buffer);
          framesSentThisSec++;
          bytesSentThisSec += bytes.byteLength;
        }
      }
    }

    frameTimer = requestAnimationFrame(captureLoop);
  }

  /**
   * Calculate proportional downscaled dimensions
   */
  function calculateScaledDimensions() {
    var preset = PRESETS[currentQuality] || PRESETS['720p'];
    var targetMaxW = preset.width;
    var targetMaxH = preset.height;

    var srcW = actualSourceWidth || 1920;
    var srcH = actualSourceHeight || 1080;

    // Never falsely upscale a lower resolution source
    if (srcW <= targetMaxW && srcH <= targetMaxH) {
      scaledWidth = srcW;
      scaledHeight = srcH;
    } else {
      var ratio = Math.min(targetMaxW / srcW, targetMaxH / srcH);
      scaledWidth = Math.round(srcW * ratio);
      scaledHeight = Math.round(srcH * ratio);
    }

    // Ensure dimensions are even numbers (required for many codecs/renderers)
    if (scaledWidth % 2 !== 0) scaledWidth--;
    if (scaledHeight % 2 !== 0) scaledHeight--;

    if (statResElem) statResElem.textContent = scaledWidth + 'x' + scaledHeight;
  }

  /**
   * Quality Selection
   */
  function setQuality(quality) {
    if (!PRESETS[quality]) return;
    currentQuality = quality;

    // Update active button state
    document.querySelectorAll('.quality-btn').forEach(function(btn) {
      if (btn.getAttribute('data-quality') === quality) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    calculateScaledDimensions();

    if (isStreaming) {
      startFramePipeline();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'update-state',
          updates: { quality: currentQuality, actualWidth: scaledWidth, actualHeight: scaledHeight }
        }));
      }
    }
  }

  /**
   * FPS Selection
   */
  function setFps(fps) {
    fps = parseInt(fps, 10);
    if (!fps) return;
    currentFps = fps;

    document.querySelectorAll('.fps-btn').forEach(function(btn) {
      if (parseInt(btn.getAttribute('data-fps'), 10) === fps) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (isStreaming) {
      startFramePipeline();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'update-state',
          updates: { fps: currentFps }
        }));
      }
    }
  }

  /**
   * Stop Streaming Pipeline
   */
  function stopStreaming() {
    isStreaming = false;
    if (frameTimer) cancelAnimationFrame(frameTimer);
    if (demoAnimId) cancelAnimationFrame(demoAnimId);

    stopAudioCapture();

    if (mediaStream) {
      mediaStream.getTracks().forEach(function(track) { track.stop(); });
      mediaStream = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(function(track) { track.stop(); });
      micStream = null;
    }

    previewVideo.srcObject = null;
    previewVideo.style.display = 'none';
    if (previewCanvas) previewCanvas.style.display = 'none';
    if (placeholderElem) placeholderElem.style.display = 'flex';

    captureType = 'none';
    updateStreamingUI(false);

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'update-state', updates: { isStreaming: false } }));
    }
  }

  /**
   * Initialize Audio Stream Capture & Transmission
   */
  function initAudioCapture(sourceStream) {
    var wantAudio = chkAudio ? chkAudio.checked : true;
    if (!wantAudio) {
      if (statAudioElem) statAudioElem.textContent = 'OFF';
      return;
    }

    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      if (statAudioElem) statAudioElem.textContent = 'N/A';
      return;
    }

    var hasAudioTrack = sourceStream && sourceStream.getAudioTracks().length > 0;

    if (hasAudioTrack) {
      setupAudioNodes(sourceStream, 'Tab / System');
    } else {
      // Prompt for microphone input if tab audio track is not attached
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(function(audioStream) {
            micStream = audioStream;
            setupAudioNodes(audioStream, 'Mic');
          })
          .catch(function() {
            if (statAudioElem) statAudioElem.textContent = 'No Audio';
          });
      }
    }
  }

  function setupAudioNodes(streamToCapture, label) {
    try {
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      // Open a DEDICATED audio WebSocket so audio never blocks video frames
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var audioWsUrl = protocol + '//' + window.location.host + '/ws';
      audioWs = new WebSocket(audioWsUrl);
      audioWs.binaryType = 'arraybuffer';

      audioWs.onopen = function() {
        // Register audio sender on this dedicated socket
        audioWs.send(JSON.stringify({
          type: 'join-sender',
          sessionId: sessionId,
          role: 'audio-only'
        }));
        // Tell receivers the sample rate
        audioWs.send(JSON.stringify({
          type: 'audio-info',
          sampleRate: audioCtx.sampleRate
        }));
      };

      audioSourceNode = audioCtx.createMediaStreamSource(streamToCapture);
      // 8192 samples = ~185ms chunk — fires only ~5x/sec, minimal CPU
      audioProcessorNode = audioCtx.createScriptProcessor(8192, 1, 1);

      audioProcessorNode.onaudioprocess = function(e) {
        if (!isStreaming || !audioWs || audioWs.readyState !== 1) return;
        if (audioWs.bufferedAmount > 65536) return; // Drop audio if lagging
        var inputData = e.inputBuffer.getChannelData(0);
        var len = inputData.length;
        var int16 = new Int16Array(len);
        for (var i = 0; i < len; i++) {
          var s = Math.max(-1, Math.min(1, inputData[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        var packet = new Uint8Array(1 + int16.byteLength);
        packet[0] = 0x02;
        packet.set(new Uint8Array(int16.buffer), 1);
        audioWs.send(packet.buffer);
      };

      var silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      audioSourceNode.connect(audioProcessorNode);
      audioProcessorNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      if (statAudioElem) statAudioElem.textContent = 'ON (' + label + ')';
    } catch (err) {
      console.warn('[Sender] Audio setup error:', err);
      if (statAudioElem) statAudioElem.textContent = 'Err';
    }
  }

  function stopAudioCapture() {
    try {
      if (audioProcessorNode) { audioProcessorNode.disconnect(); audioProcessorNode = null; }
      if (audioSourceNode) { audioSourceNode.disconnect(); audioSourceNode = null; }
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (audioWs) { audioWs.close(); audioWs = null; }
    } catch (e) {}
    if (statAudioElem) statAudioElem.textContent = 'OFF';
  }

  /**
   * Update UI when streaming starts/stops
   */
  function updateStreamingUI(active) {
    if (active) {
      if (streamStatusPill) {
        streamStatusPill.className = 'status-pill status-live';
        streamStatusPill.innerHTML = '<span class="feature-dot dot-red"></span> LIVE CASTING';
      }
      if (btnStartScreen) btnStartScreen.style.display = 'none';
      if (btnStartCamera) btnStartCamera.style.display = 'none';
      if (btnStartDemo) btnStartDemo.style.display = 'none';
      if (btnStopStream) btnStopStream.style.display = 'inline-flex';
    } else {
      if (streamStatusPill) {
        streamStatusPill.className = 'status-pill status-waiting';
        streamStatusPill.innerHTML = '<span class="feature-dot dot-blue"></span> READY TO CAST';
      }
      if (btnStartScreen) btnStartScreen.style.display = 'inline-flex';
      if (btnStartCamera) btnStartCamera.style.display = 'inline-flex';
      if (btnStartDemo) btnStartDemo.style.display = 'inline-flex';
      if (btnStopStream) btnStopStream.style.display = 'none';
      if (statFpsElem) statFpsElem.textContent = '0 FPS';
      if (statBitrateElem) statBitrateElem.textContent = '0 Kbps';
    }
  }

  /**
   * Telemetry & Stats Tracker Loop
   */
  function startTelemetry() {
    if (telemetryTimer) clearInterval(telemetryTimer);

    telemetryTimer = setInterval(function() {
      var now = Date.now();
      var elapsed = (now - lastMetricsTime) / 1000;

      if (elapsed >= 1) {
        var currentOutputFps = Math.round(framesSentThisSec / elapsed);
        var currentKbps = Math.round((bytesSentThisSec * 8) / (elapsed * 1000));

        if (statFpsElem && isStreaming) statFpsElem.textContent = currentOutputFps + ' FPS';
        if (statBitrateElem && isStreaming) statBitrateElem.textContent = WebCastUtils.formatBitrate(currentKbps);

        framesSentThisSec = 0;
        bytesSentThisSec = 0;
        lastMetricsTime = now;

        // Send latency ping to backend
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ping', clientTime: now }));
        }
      }
    }, 1000);
  }

  function setupQualityButtons() {
    document.querySelectorAll('.quality-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var q = this.getAttribute('data-quality');
        setQuality(q);
      });
    });
  }

  function setupFpsButtons() {
    document.querySelectorAll('.fps-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var f = this.getAttribute('data-fps');
        setFps(f);
      });
    });
  }

  function setupEventListeners() {
    if (btnStartScreen) btnStartScreen.addEventListener('click', startScreenCapture);
    if (btnStartCamera) btnStartCamera.addEventListener('click', startCameraCapture);
    if (btnStartDemo) btnStartDemo.addEventListener('click', startDemoPattern);
    if (btnStopStream) btnStopStream.addEventListener('click', stopStreaming);

    if (btnCopyLink) {
      btnCopyLink.addEventListener('click', function() {
        var text = shareUrlElem ? shareUrlElem.textContent : '';
        WebCastUtils.copyToClipboard(text, function(ok) {
          if (ok) showAlert('Receiver link copied to clipboard!', 'success');
        });
      });
    }
  }

  function showAlert(msg, type) {
    if (!alertContainer) return;
    var alert = document.createElement('div');
    alert.className = 'compat-alert';
    if (type === 'danger') alert.style.borderColor = '#ff3344';
    if (type === 'info') alert.style.borderColor = '#00a2ff';
    alert.textContent = msg;

    alertContainer.appendChild(alert);
    setTimeout(function() {
      if (alert.parentNode) alert.parentNode.removeChild(alert);
    }, 4000);
  }

  // Initialize on DOM load
  window.addEventListener('DOMContentLoaded', init);
})();
