/**
 * WebCast Configuration
 * Quality presets, network configurations, and legacy iPad optimizations
 */
module.exports = {
  PORT: process.env.PORT || 3000,
  HTTPS_PORT: process.env.HTTPS_PORT || 3443,
  
  // Quality presets (Resolution & Bitrate/Compression targets)
  QUALITY_PRESETS: {
    '4k': {
      label: '4K Ultra HD',
      width: 3840,
      height: 2160,
      jpegQuality: 0.85,
      defaultFps: 30,
      maxFps: 60,
      recommendedFor: 'High-end PC / Modern Displays'
    },
    '1080p': {
      label: '1080p Full HD',
      width: 1920,
      height: 1080,
      jpegQuality: 0.80,
      defaultFps: 30,
      maxFps: 60,
      recommendedFor: 'iPad Air 2 / iPad 5th gen+'
    },
    '720p': {
      label: '720p HD (Recommended)',
      width: 1280,
      height: 720,
      jpegQuality: 0.75,
      defaultFps: 30,
      maxFps: 30,
      recommendedFor: 'iPad 2, 3, 4, Mini 1/2/3 (iOS 9 / 10)'
    },
    '480p': {
      label: '480p Smooth / Low Bandwidth',
      width: 854,
      height: 480,
      jpegQuality: 0.65,
      defaultFps: 24,
      maxFps: 30,
      recommendedFor: 'Weak Wi-Fi / Low Battery Mode'
    }
  },

  FPS_OPTIONS: [60, 30, 24, 15],
  DEFAULT_LEGACY_FPS: 30,
  DEFAULT_QUALITY: '720p',

  // Session limits & cleanup
  SESSION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes of inactivity
  CLEANUP_INTERVAL_MS: 60 * 1000,

  // Stream buffering
  MAX_FRAME_BUFFER_SIZE: 5, // Keep only newest 5 frames to eliminate latency build-up
  FRAME_DROP_THRESHOLD_MS: 150
};
