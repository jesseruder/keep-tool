const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = ({ config }) => {
  const file = process.env.KEEP_MOBILE_CONFIG || path.join(os.homedir(), '.config', 'keep', 'mobile.json');
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const owner = process.env.KEEP_EXPO_OWNER || local.owner;
  const projectId = process.env.KEEP_EXPO_PROJECT_ID || local.projectId;
  const androidPackage = process.env.KEEP_ANDROID_PACKAGE || local.androidPackage;
  const iosBundleIdentifier = process.env.KEEP_IOS_BUNDLE_IDENTIFIER || local.iosBundleIdentifier;
  return {
    ...config,
    ...(owner ? { owner } : {}),
    ...(projectId ? { extra: { ...config.extra, eas: { projectId } } } : {}),
    android: { ...config.android, ...(androidPackage ? { package: androidPackage } : {}) },
    ios: { ...config.ios, ...(iosBundleIdentifier ? { bundleIdentifier: iosBundleIdentifier } : {}) },
  };
};
