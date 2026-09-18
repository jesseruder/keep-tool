// URL normalisation and the blockedHosts rule.

import assert from "node:assert/strict";
import test from "node:test";

import { hostOf, isBlocked, normalizeUrl } from "../extension/lib/url.js";

test("a bare host gets https", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com/path?q=1#x"), "https://example.com/path?q=1#x");
  assert.equal(normalizeUrl("  example.com  "), "https://example.com");
  assert.equal(normalizeUrl("//example.com"), "https://example.com");
});

test("a host with a port is still a host, not a scheme", () => {
  // The old rule saw "localhost:3000" as scheme "localhost" with path "3000".
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeUrl("example.com:8080"), "https://example.com:8080");
  assert.equal(normalizeUrl("example.com:8080/a"), "https://example.com:8080/a");
});

test("local hosts default to http and everything else to https", () => {
  assert.equal(normalizeUrl("localhost"), "http://localhost");
  assert.equal(normalizeUrl("127.0.0.1"), "http://127.0.0.1");
  assert.equal(normalizeUrl("0.0.0.0:5000"), "http://0.0.0.0:5000");
  assert.equal(normalizeUrl("localhost.example.com"), "https://localhost.example.com");
});

test("a real scheme is left alone", () => {
  for (const url of [
    "https://example.com",
    "http://example.com:8080/a",
    "file:///Users/someone/page.html",
    "about:blank",
    "edge://extensions",
    "chrome://newtab/",
    "data:text/html,<p>hi</p>",
    "view-source:https://example.com",
  ]) {
    assert.equal(normalizeUrl(url), url);
  }
});

test("javascript: is refused", () => {
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /javascript: URLs are not allowed/);
  assert.throws(() => normalizeUrl("JavaScript:alert(1)"), /javascript: URLs are not allowed/);
});

test("an empty url is an error", () => {
  assert.throws(() => normalizeUrl(""), /url is required/);
  assert.throws(() => normalizeUrl(null), /url is required/);
});

test("hostOf reads the host or says it cannot", () => {
  assert.equal(hostOf("https://Example.COM/a"), "example.com");
  assert.equal(hostOf("not a url"), null);
});

test("blockedHosts matches exact hosts and wildcards", () => {
  const blocked = ["admin.example.com", "*.internal.example"];
  assert.equal(isBlocked("https://admin.example.com/x", blocked), true);
  assert.equal(isBlocked("https://ADMIN.example.com/x", blocked), true);
  assert.equal(isBlocked("https://other.example.com/x", blocked), false);
  assert.equal(isBlocked("https://a.internal.example", blocked), true);
  assert.equal(isBlocked("https://deep.a.internal.example", blocked), true);
  assert.equal(isBlocked("https://internal.example", blocked), true);
  assert.equal(isBlocked("https://notinternal.example", blocked), false);
  assert.equal(isBlocked("https://example.com", []), false);
  assert.equal(isBlocked("about:blank", blocked), false);
});
