import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptableName, filterText, sanitizeChat } from "../server/src/filter.ts";
import { randomName } from "../shared/names.ts";

const masked = (s: string) => filterText(s) !== s;

test("profanity and slurs are masked, including leetspeak and spacing", () => {
  for (const s of ["fuck", "fuuuuck you", "sh1t", "n1gg3r", "f@ggot", "b!tch", "you are a f u c k i n g idiot", "s.h.i.t", "kys", "kill yourself", "k i l l yourself", "hitler", "retard", "cunt", "nigga"]) {
    assert.ok(masked(s), `should mask: ${s} -> ${filterText(s)}`);
  }
  assert.equal(filterText("what the fuck"), "what the ****");
});

test("ordinary chat is left alone", () => {
  for (const s of ["hello there", "nice glass house", "class act", "assassin", "grass block", "therapist", "cocktail", "Scunthorpe", "pass me the bass", "analysis", "he is hitting the tree", "spicy", "raccoon", "title", "button", "EnderMiner_7168 built a castle", "gg", "lol this is fun"]) {
    assert.equal(filterText(s), s, `should keep: ${s}`);
  }
});

test("names: generated names are fine; bad or staff-like names are refused", () => {
  for (let i = 0; i < 300; i++) assert.ok(acceptableName(randomName()), "generated names pass");
  for (const n of ["AdminSteve_1", "xX_fuck_Xx", "ab", "this_name_is_way_too_long_for_us", "bad name", "n1gg3r_1234", "Moderator", "Hitler_88"]) {
    assert.equal(acceptableName(n), false, n);
  }
  assert.equal(acceptableName("EnderMiner_7168"), true);
});

test("chat sanitising strips control characters and caps length", () => {
  assert.equal(sanitizeChat("hi\u0000‮there", 100), "hithere");
  assert.equal(sanitizeChat("x".repeat(500), 100).length, 100);
  assert.equal(sanitizeChat(42, 100), "");
});
