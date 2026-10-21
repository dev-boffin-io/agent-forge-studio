'use strict';
const cfg = require('./config');
module.exports = {
  websearch: { provider: 'exa' },
  renderUrl: process.env.YT_RENDER_URL || 'http://localhost:8765',
  ttsUrl: process.env.YT_TTS_URL || 'http://localhost:8766',
  captionsUrl: process.env.YT_CAPTIONS_URL || 'http://localhost:8767',
  pixabayKey: process.env.PIXABAY_API_KEY || '',
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:4312/auth/youtube/callback',
  },
  publish: { allow: false, autoPublish: false },
};
