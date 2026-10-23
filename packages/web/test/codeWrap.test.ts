import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeWrap } from "../src/codeWrap.ts";

describe("codeWrap", () => {
  it("is one choice that every subscribed block hears about", () => {
    const heard: boolean[] = [];
    const stopA = codeWrap.subscribe(() => heard.push(codeWrap.get()));
    const stopB = codeWrap.subscribe(() => heard.push(codeWrap.get()));
    assert.equal(codeWrap.get(), false);
    codeWrap.set(true);
    assert.deepEqual(heard, [true, true]);
    codeWrap.set(true);
    assert.deepEqual(heard, [true, true], "setting it to what it is tells no one");
    stopA();
    codeWrap.set(false);
    assert.deepEqual(heard, [true, true, false]);
    stopB();
  });
});
