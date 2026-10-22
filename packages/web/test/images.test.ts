import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageSource } from "../src/imageSource.ts";

describe("images in Claude's markdown", () => {
  it("load from the web over HTTPS, or from data in the text", () => {
    assert.equal(imageSource("https://example.com/chart.png"), "https://example.com/chart.png");
    assert.equal(imageSource("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
  });

  it("don't load from this machine, the user's network, or anywhere over plain HTTP", () => {
    for (const src of ["http://192.168.1.1/cgi?action=reboot", "http://127.0.0.1:631/", "http://example.com/x.png", "/api/projects", "chart.png", "file:///etc/hosts", "javascript:alert(1)", "data:text/html,<b>x</b>", undefined]) {
      assert.equal(imageSource(src), undefined, String(src));
    }
  });
});
