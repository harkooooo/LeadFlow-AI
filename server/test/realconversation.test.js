"use strict";
// Regression for the real customer conversation that showed the repeated service question:
//   hej / hmm, vilken är bäst? / jag driver en bilfirma i helsingborg / vad skulle du rekommendera
// The model's text is scripted. Variant (a) is the worst case seen in the log (the model said
// nothing usable for message 3); variant (b) is a natural model reply.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("../test-support/helpers");

const FULL_QUESTION = "Vilken tjänst är du intresserad av? Vi erbjuder: Digital marketing, Social media marketing, SEO, Lead generation.";
const COMPARISON = "Det beror på ditt mål. SEO passar bra om du vill synas bättre i sökmotorer, social media marketing för att nå ut i sociala kanaler, lead generation för att få in fler potentiella kunder, och digital marketing om du vill ha en bred strategi.";
const RECOMMENDATION = "För en bilfirma i Helsingborg skulle jag oftast rekommendera lead generation eller SEO, beroende på om du vill få in fler förfrågningar snabbt eller synas bättre långsiktigt i sökningar.";
const tail = (reply) => reply.split("\n\n").pop();

const variants = [
  { name: "(a) model adds nothing usable to message 3", third: "" },
  { name: "(a2) model's text for message 3 is only a question", third: "Vad vill du ha hjälp med?" },
  { name: "(b) model reacts naturally to message 3", third: "Kul, en bilfirma i Helsingborg! Då vet jag lite mer om vad ni behöver." },
];

for (const variant of variants) {
  test(`REGRESSION real conversation ${variant.name}: no repeated service question`, async () => {
    const t = createHarness();
    const replies = [];
    replies.push(await t.say("hej", { reply: "Hej!" }));
    replies.push(await t.say("hmm, vilken är bäst?", { reply: COMPARISON }));
    replies.push(await t.say("jag driver en bilfirma i helsingborg", { reply: variant.third }));
    replies.push(await t.say("vad skulle du rekommendera", { reply: RECOMMENDATION }));

    // 1. Greeting + the full question, once.
    assert.equal(replies[0], `Hej!\n\n${FULL_QUESTION}`);
    // 2. The comparison is answered; only a SHORT reminder follows (no list).
    assert.equal(replies[1], `${COMPARISON}\n\nVilken av tjänsterna passar dig bäst?`);
    // 3. Never the full question again; something helpful and non-empty.
    assert.ok(replies[2].length > 0);
    assert.doesNotMatch(replies[2], /Vi erbjuder/);
    assert.notEqual(tail(replies[2]), tail(replies[1]));
    // 4. The recommendation is delivered as written, with no question glued on.
    assert.equal(replies[3], RECOMMENDATION);

    // Over the whole conversation: the list of services is shown once, and no two
    // consecutive replies end with the same sentence.
    assert.equal(replies.filter((r) => r.includes("Vi erbjuder:")).length, 1);
    for (let i = 1; i < replies.length; i++) assert.notEqual(tail(replies[i]), tail(replies[i - 1]));
    assert.equal(replies.filter((r) => r.includes("Vilken tjänst är du intresserad av?")).length, 1);
    assert.equal(replies.filter((r) => r.includes("Vilken av tjänsterna passar dig bäst?")).length, 1);

    // Customer details untouched while chatting.
    assert.deepEqual(t.draft(), { name: "", email: "", service: "" });
    assert.equal(t.doc().awaitingConfirmation, false);
    assert.equal(t.leads.rows.length, 0);

    // The customer follows the recommendation: data collection and confirmation work as before.
    let r = await t.say("kör på lead generation", { service: "Lead generation" });
    assert.match(r, /Vad heter du\?/);
    r = await t.say("Anders", { name: "Anders" });
    assert.match(r, /fullständiga mejladress/);
    r = await t.say("anders@bilfirman.se", { email: "anders@bilfirman.se" });
    assert.match(r, /Stämmer följande uppgifter: namn Anders, mejladress anders@bilfirman\.se, tjänst Lead generation\?/);
    assert.equal(t.leads.rows.length, 0);
    await t.say("ja");
    assert.equal(t.leads.rows.length, 1);
  });
}