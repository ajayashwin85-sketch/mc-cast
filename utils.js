/**
 * WebCast Utilities (ES5 & Modern Browser Compatible)
 * Network helpers, formatters, and iOS version detection
 */
var WebCastUtils = (function() {
  'use strict';

  /**
   * Detect iOS version and browser capabilities
   */
  function detectEnvironment() {
    var ua = navigator.userAgent || navigator.vendor || window.opera || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var iosVersion = 0;

    if (isIOS) {
      var match = ua.match(/OS (\d+)_(\d+)_?(\d+)?/);
      if (match && match[1]) {
        iosVersion = parseInt(match[1], 10);
      }
    }

    var isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
    var hasWebRTC = !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
    var hasWebSocket = !!window.WebSocket;
    var hasCanvas = !!(window.HTMLCanvasElement && document.createElement('canvas').getContext);
    var hasMSE = !!(window.MediaSource || window.WebKitMediaSource);
    var hasDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

    return {
      userAgent: ua,
      isIOS: isIOS,
      iosVersion: iosVersion,
      isLegacyIOS: isIOS && iosVersion > 0 && iosVersion <= 10,
      isSafari: isSafari,
      hasWebRTC: hasWebRTC,
      hasWebSocket: hasWebSocket,
      hasCanvas: hasCanvas,
      hasMSE: hasMSE,
      hasDisplayMedia: hasDisplayMedia,
      isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)
    };
  }

  /**
   * Safe AJAX GET (Supports old Safari XHR & modern browsers)
   */
  function ajaxGet(url, callback) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            var data = null;
            try {
              data = JSON.parse(xhr.responseText);
            } catch (e) {
              data = xhr.responseText;
            }
            callback(null, data);
          } else {
            callback(new Error('Request failed with status: ' + xhr.status), null);
          }
        }
      };
      xhr.onerror = function() {
        callback(new Error('Network error'), null);
      };
      xhr.send();
    } catch (err) {
      callback(err, null);
    }
  }

  /**
   * Safe AJAX POST
   */
  function ajaxPost(url, data, callback) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            var resData = null;
            try {
              resData = JSON.parse(xhr.responseText);
            } catch (e) {
              resData = xhr.responseText;
            }
            callback(null, resData);
          } else {
            callback(new Error('Request failed with status: ' + xhr.status), null);
          }
        }
      };
      xhr.onerror = function() {
        callback(new Error('Network error'), null);
      };
      xhr.send(JSON.stringify(data));
    } catch (err) {
      callback(err, null);
    }
  }

  /**
   * Format bitrate nicely (e.g. 1.2 Mbps or 450 Kbps)
   */
  function formatBitrate(kbps) {
    if (!kbps || kbps <= 0) return '0 Kbps';
    if (kbps >= 1000) {
      return (kbps / 1000).toFixed(1) + ' Mbps';
    }
    return Math.round(kbps) + ' Kbps';
  }

  /**
   * Get Query Parameter from URL
   */
  function getQueryParam(name) {
    var query = window.location.search.substring(1);
    var vars = query.split('&');
    for (var i = 0; i < vars.length; i++) {
      var pair = vars[i].split('=');
      if (decodeURIComponent(pair[0]).toLowerCase() === name.toLowerCase()) {
        return decodeURIComponent(pair[1] || '');
      }
    }
    return null;
  }

  /**
   * Copy text to clipboard with legacy fallback
   */
  function copyToClipboard(text, callback) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (callback) callback(true);
      }).catch(function() {
        fallbackCopy(text, callback);
      });
    } else {
      fallbackCopy(text, callback);
    }

    function fallbackCopy(str, cb) {
      var textarea = document.createElement('textarea');
      textarea.value = str;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      var success = false;
      try {
        success = document.execCommand('copy');
      } catch (err) {
        success = false;
      }
      document.body.removeChild(textarea);
      if (cb) cb(success);
    }
  }

  return {
    detectEnvironment: detectEnvironment,
    ajaxGet: ajaxGet,
    ajaxPost: ajaxPost,
    formatBitrate: formatBitrate,
    getQueryParam: getQueryParam,
    copyToClipboard: copyToClipboard
  };
})();
