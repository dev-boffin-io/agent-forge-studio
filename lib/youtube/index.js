'use strict';

// Bundle of the deterministic YouTube analyzers the agent calls as tools. Pure functions over the
// channel workspace — nothing here talks to YouTube; the only network code in this app is the
// provider layer and webfetch/websearch.

module.exports = {
  oauth: require('./oauth'),
  api: require('./api'),
  hooks: require('./hooks.json'),
  transcript: require('./transcript'),
  hookscore: require('./hookscore'),
  titlelint: require('./titlelint'),
  deadair: require('./deadair'),
  chapters: require('./chapters'),
  retention: require('./retention'),
  swipe: require('./swipe'),
  voice: require('./voice'),
};
