# Keep mobile

An Expo SDK 57 app for your own Keep registry. It connects to your running Keep
daemon; each teammate enters their own server address and access token.

From the repository root:

```sh
npm ci --prefix app
npm run mobile:theme
cd app
npx expo start
```

Use Node 22.13 or newer. See the [versioned Expo documentation](https://docs.expo.dev/versions/v57.0.0/)
for device and development-build setup. The included `preview` EAS build profile
produces an Android APK. Native notifications/background tasks require a compatible
native build; background execution is controlled by the phone's operating system.

Keep listens on loopback by default. For phone access, use a private network or VPN,
configure `KEEP_HOST` to an appropriate interface, and restart the daemon. Enter that
computer's reachable URL and its `.keep/token` value in the app's setup screen.
Keep the token private. Local HTTP is supported for private-network use; do not
expose the daemon directly to the public Internet. Existing saved connections remain
on the phone; no server address or access token is bundled with the source.

Build identity is local. Create `~/.config/keep/mobile.json` (outside this repo):

```json
{
  "owner": "your-expo-account",
  "projectId": "your-eas-project-uuid",
  "androidPackage": "com.example.keep",
  "iosBundleIdentifier": "com.example.keep"
}
```

`KEEP_MOBILE_CONFIG` selects another file. `KEEP_EXPO_OWNER`, `KEEP_EXPO_PROJECT_ID`,
`KEEP_ANDROID_PACKAGE`, and `KEEP_IOS_BUNDLE_IDENTIFIER` override individual values.
Without overrides the Android identifier is `dev.keeptool.mobile`, with no linked
Expo account or EAS project. Configure your own EAS project before cloud builds.
Signing keys, Expo state, generated native projects, and dependencies are excluded
from the public source. The app takes scope rules from your daemon.

`npm run mobile:theme` regenerates theme tokens and the shared scope resolver.
`node --test bin/mobile-theme.test.js bin/mobile-config.test.js` checks these assets
and build-identity configuration from the repository root.
