# README screenshots

These images show the real web console shared by the browser and desktop app.
All projects, cards, questions, and terminal output are synthetic demo fixtures.

From the repository root, after `npm ci`, regenerate them with:

```sh
node scripts/capture-screenshots.cjs
```

The script uses Google Chrome at its standard macOS location. Set `KEEP_CHROME`
to another Chrome/Chromium executable if needed. It starts a loopback-only fixture
server and an isolated temporary browser profile, then removes the profile on exit.
It does not start the Keep daemon or read a private registry or agent transcripts.
