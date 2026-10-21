import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HTML_POLICY, withPolicy } from "../src/htmlPolicy.ts";

describe("HTML artifacts' policy", () => {
  it("goes first, after a doctype, so the page keeps its standards mode", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
    assert.equal(withPolicy("<!DOCTYPE html><html><body>x</body></html>"), `<!DOCTYPE html>${meta}<html><body>x</body></html>`);
    assert.equal(withPolicy("  <!doctype html>\n<p>x"), `  <!doctype html>${meta}\n<p>x`);
    assert.equal(withPolicy("<p>no doctype</p>"), `${meta}<p>no doctype</p>`);
  });

  it("lets a page load over https, and nothing over plain http", () => {
    assert.match(HTML_POLICY, /default-src https: data: blob:/);
    assert.match(HTML_POLICY, /connect-src https:/);
    assert.doesNotMatch(HTML_POLICY, /http:|'self'|\*/);
  });
});
