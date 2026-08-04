import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectLang, say, strings } from "./i18n.js";

describe("detectLang", () => {
  it("picks Persian when the member carries the فارسی role", () => {
    assert.equal(detectLang(["Subscriber", "فارسی"]), "fa");
  });

  it("picks English when the member carries the English role", () => {
    assert.equal(detectLang(["English", "Subscriber"]), "en");
  });

  /** Someone who never finished onboarding, or a staff member who took
   *  neither role, still has to get an answer. */
  it("falls back to English when no language role is present", () => {
    assert.equal(detectLang([]), "en");
    assert.equal(detectLang(["Moderator"]), "en");
  });

  /** Staff see both halves of the server and may hold both roles. Persian
   *  wins, because holding it at all is a deliberate choice. */
  it("prefers Persian when the member somehow holds both", () => {
    assert.equal(detectLang(["English", "فارسی"]), "fa");
  });

  it("is not fooled by a role that merely contains the name", () => {
    assert.equal(detectLang(["English Voice"]), "en");
    assert.equal(detectLang(["فارسی زبان"]), "en");
  });
});

describe("strings", () => {
  it("has both languages for every key, neither of them empty", () => {
    for (const [key, copy] of Object.entries(strings)) {
      assert.ok(copy.en?.trim(), `${key} has no English copy`);
      assert.ok(copy.fa?.trim(), `${key} has no Persian copy`);
    }
  });

  it("actually contains Persian script in the Persian copy", () => {
    const persian = /[؀-ۿ]/;
    for (const [key, copy] of Object.entries(strings)) {
      assert.ok(persian.test(copy.fa), `${key}'s Persian copy has no Persian characters`);
    }
  });

  /** The safety warning is the one line that must survive translation --
   *  it is what stops somebody pasting their subscription link in public. */
  it("keeps the credential warning in both languages", () => {
    assert.match(strings.helpBody.en, /Never post config files/);
    assert.match(strings.helpBody.fa, /هرگز/);
  });

  it("resolves through say()", () => {
    assert.equal(say("statusTitle", "en"), strings.statusTitle.en);
    assert.equal(say("statusTitle", "fa"), strings.statusTitle.fa);
  });
});
