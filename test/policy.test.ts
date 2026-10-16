import { describe, expect, it } from "vitest";
import { isPublicAddress, validateTaskUrl } from "../src/policy.js";

const allowed = new Set(["example.com"]);

describe("task URL policy", () => {
  it("accepts HTTPS URLs for an explicitly allowed hostname", () => {
    expect(validateTaskUrl("https://example.com/path", allowed).hostname).toBe(
      "example.com",
    );
  });

  it.each([
    "http://example.com",
    "https://sub.example.com",
    "https://example.com.evil.test",
    "ftp://example.com",
    "https://127.0.0.1",
    "file:///etc/passwd",
  ])("rejects a prohibited task URL: %s", (url) => {
    expect(() => validateTaskUrl(url, allowed)).toThrow();
  });
});

describe("public address policy", () => {
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks private or reserved address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
