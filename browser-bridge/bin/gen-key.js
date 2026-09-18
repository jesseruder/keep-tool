#!/usr/bin/env node
// One-time helper: mint the RSA key pair whose public half pins the extension id.
//
// Chromium derives an unpacked extension's id from the manifest "key" field: SHA-256
// of the DER SPKI public key, first 16 bytes (32 hex chars), each hex digit mapped
// 0-9a-f -> a-p. Pinning the id matters because the native messaging manifest has to
// name the extension origin before the extension is ever loaded.
//
// Only the public key is committed. Load-unpacked never checks a signature, so the
// private key exists solely to make the public key a real RSA key; write it out with
// --private-key-out only if you ever want to pack a .crx.

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { extensionIdFromKey } from "../host/protocol.js";

function main(argv) {
  const out = argv.includes("--private-key-out")
    ? argv[argv.indexOf("--private-key-out") + 1]
    : null;

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const base64 = der.toString("base64");
  const id = extensionIdFromKey(base64);

  if (out) {
    writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    process.stderr.write(`private key written to ${out} (do not commit it)\n`);
  }

  process.stdout.write(`extension id: ${id}\n`);
  process.stdout.write(`origin:       chrome-extension://${id}/\n\n`);
  process.stdout.write(`manifest.json "key":\n${base64}\n`);
}

main(process.argv.slice(2));
