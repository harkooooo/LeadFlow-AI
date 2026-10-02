"use strict";

const {
  applyInterpretation, nextMissingField, isConfirmation, isSwedish,
} = require("./leadstate");

// The backend alone asks questions. If the model's text contains questions of its own
// (for example a stale "what's your email?"), they are dropped before the backend's
// question is appended. Answers and small talk are kept. No phrase lists involved.
const withoutQuestions = (text) =>
  (String(text || "").match(/[^.!?]+(?:[.!?]+|$)/g) || [])
    .filter((sentence) => !/\?[!?.\s]*$/.test(sentence))
    .join("").trim();

const joinParts = (...parts) => parts.map((p) => String(p || "").trim()).filter(Boolean).join("\n\n");

// Handles ONE customer message. It changes the `conversation` object
// (messages, leadDraft, awaitingConfirmation, leadId) but never saves it:
// the caller saves exactly once, after this function has succeeded.
//
// deps = {
//   company,
//   interpret({ messages, draft, awaitingConfirmation, message }) -> model proposal,
//   leads: { findById, findDuplicateEmail(email, excludeId), create(data), update(lead, data) },
//   log(event, data)   // optional, must never receive customer data
// }
async function handleChatMessage({ conversation, message, deps }) {
  const { company, interpret, leads, log = () => {} } = deps;
  const services = company.services;
  const userMessage = String(message).trim();

  const swedish = isSwedish([...conversation.messages, { role: "user", content: userMessage }]);
  const say = (sv, en) => (swedish ? sv : en);

  const stored = conversation.leadDraft || {};
  const current = {
    name: stored.name || "",
    email: stored.email || "",
    service: stored.service || "",
  };

  conversation.messages.push({ role: "user", content: userMessage });
  const finish = (text) => {
    conversation.messages.push({ role: "assistant", content: text });
    return { reply: text };
  };

  const questionFor = (field) => {
    if (field === "service") {
      const list = services.join(", ");
      return say(`Vilken tjänst är du intresserad av? Vi erbjuder: ${list}.`,
        `Which service are you interested in? We offer: ${list}.`);
    }
    if (field === "name") return say("Vad heter du?", "What's your name?");
    return say("Vad är din fullständiga mejladress?", "What's your full email address?");
  };

  // The service question must not be repeated word for word while the customer chats.
  // 1st time: full question with the service list. 2nd time: a short reminder.
  // After that: if the customer got an answer to a question, no extra question is added;
  // otherwise a helpful nudge (never the same text twice in a row).
  // Only the WORDING changes here; what is missing is still decided by nextMissingField.
  const serviceFollowUp = (answer) => {
    const list = services.join(", ");
    const sets = {
      sv: [
        { marker: "Vilken tjänst är du intresserad av?", text: `Vilken tjänst är du intresserad av? Vi erbjuder: ${list}.` },
        { marker: "Vilken av tjänsterna passar dig bäst?", text: "Vilken av tjänsterna passar dig bäst?" },
        { marker: "Berätta kort vad du vill ha hjälp med", text: "Berätta kort vad du vill ha hjälp med, så föreslår jag en tjänst." },
      ],
      en: [
        { marker: "Which service are you interested in?", text: `Which service are you interested in? We offer: ${list}.` },
        { marker: "Which of the services suits you best?", text: "Which of the services suits you best?" },
        { marker: "Tell me briefly what you need help with", text: "Tell me briefly what you need help with and I'll suggest a service." },
      ],
    };
    const markers = [...sets.sv, ...sets.en].map((variant) => variant.marker);
    const assistantMessages = conversation.messages.filter((m) => m.role === "assistant");
    const timesAsked = assistantMessages.filter((m) => markers.some((marker) => m.content.includes(marker))).length;
    const set = swedish ? sets.sv : sets.en;
    if (timesAsked === 0) return set[0].text;
    if (timesAsked === 1) return set[1].text;
    if (answer) return "";
    const last = assistantMessages[assistantMessages.length - 1];
    return last && last.content.includes(set[2].marker) ? set[1].text : set[2].text;
  };

  // Saves (or updates) the lead. Only ever called with a complete draft that
  // the customer has just seen and explicitly agreed to.
  const confirmLead = async (draft) => {
    const missing = nextMissingField(draft, services);
    if (missing) {
      conversation.awaitingConfirmation = false;
      return finish(questionFor(missing));
    }
    const existing = conversation.leadId ? await leads.findById(conversation.leadId) : null;
    const duplicate = await leads.findDuplicateEmail(draft.email, existing ? existing._id : null);
    if (duplicate) {
      conversation.awaitingConfirmation = false;
      conversation.leadDraft = { ...draft, email: "" };
      return finish(say(
        "Den här mejladressen finns redan registrerad. Skriv en annan mejladress om du vill använda en annan.",
        "That email address is already registered. Type a different email address if you want to use another."));
    }
    const data = { name: draft.name, email: draft.email, service: draft.service };
    let lead;
    if (existing) {
      await leads.update(existing, data);
      lead = existing;
    } else {
      lead = await leads.create(data);
    }
    conversation.leadId = lead._id;
    conversation.awaitingConfirmation = false;
    return finish(say("Tack! Dina uppgifter är mottagna.", "Thank you! Your details have been received."));
  };

  // 1. A plain "yes" while a complete draft is being reviewed. No model call.
  if (conversation.awaitingConfirmation && isConfirmation(userMessage)) {
    return confirmLead(current);
  }

  // 2. The model interprets the message. It proposes; the backend decides.
  const parsed = await interpret({
    messages: conversation.messages.map((m) => ({ role: m.role, content: m.content })),
    draft: current,
    awaitingConfirmation: Boolean(conversation.awaitingConfirmation),
    message: userMessage,
  });
  const update = applyInterpretation(current, userMessage, parsed, services);
  const draft = update.draft;
  conversation.leadDraft = { ...draft };

  const missing = nextMissingField(draft, services);
  const aiReply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";

  log("interpretation", {
    accepted: update.accepted, rejected: update.rejected, cleared: update.cleared,
    changed: update.changed, missing, confirmation: parsed?.confirmation ?? null,
  });

  // 3. Natural-language agreement ("japp"). Only counts if the draft is complete,
  //    was being reviewed, and this very message changed nothing.
  if (conversation.awaitingConfirmation && !missing && !update.changed &&
      parsed?.confirmation === "confirm") {
    return confirmLead(draft);
  }

  // 4. Something required is missing: the BACKEND picks the next question.
  //    The model's text (answer to a question, small talk) is shown before it.
  if (missing) {
    conversation.awaitingConfirmation = false;
    const answer = withoutQuestions(aiReply);
    const next = missing === "service" ? serviceFollowUp(answer) : questionFor(missing);
    return finish(joinParts(answer, next));
  }

  // 5. Draft complete: show it and wait for an explicit yes.
  const summary = say(
    `Stämmer följande uppgifter: namn ${draft.name}, mejladress ${draft.email}, tjänst ${draft.service}? Svara ja eller berätta vad som ska ändras.`,
    `Are these details correct: name ${draft.name}, email ${draft.email}, service ${draft.service}? Reply yes or tell me what to correct.`);
  if (update.changed || (!conversation.leadId && !conversation.awaitingConfirmation)) {
    conversation.awaitingConfirmation = true;
    return finish(joinParts(withoutQuestions(aiReply), summary));
  }
  if (conversation.awaitingConfirmation) {
    return finish(joinParts(withoutQuestions(aiReply), say(
      "Stämmer uppgifterna ovan? Svara ja eller berätta vad som är fel.",
      "Are those details correct? Reply yes or tell me what is wrong.")));
  }

  // 6. Lead already saved and nothing changed: just a normal conversation.
  return finish(aiReply || say("Finns det något mer jag kan hjälpa dig med?",
    "Is there anything else I can help you with?"));
}

module.exports = { handleChatMessage };