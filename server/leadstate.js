"use strict";

// Pure helpers: no database, no network, no model calls.
// The AI model only PROPOSES changes. This file decides what is accepted.
// Rules of the design:
//   * name and email must literally appear in the customer's LATEST message
//   * service must be one of the services configured in company.js
//   * a proposal that repeats a value we already have is ignored, never an error
//   * a proposal we cannot accept is ignored and reported, never used to wipe data

const FIELDS = ["name", "email", "service"];
const ASK_ORDER = ["service", "name", "email"];

const normalize = (value) => String(value ?? "")
  .normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const isValidEmail = (value) =>
  typeof value === "string" && value.length <= 254 && EMAIL.test(value);

const NAME = /^[\p{L}][\p{L} '\u2019\-]*$/u;
const isValidName = (value) =>
  typeof value === "string" && value.length >= 2 && value.length <= 80 && NAME.test(value);

// Returns the configured spelling of a service, or "" if it is not configured.
const canonicalService = (value, services = []) =>
  services.find((service) => normalize(service) === normalize(value)) || "";

const groundedName = (message, proposed) => {
  if (typeof proposed !== "string") return "";
  const name = proposed.trim().replace(/\s+/g, " ");
  if (!isValidName(name)) return "";
  // Remove e-mail addresses first, so "oskar@lillen.com" cannot "contain" the name "oskar".
  const source = normalize(String(message).replace(/\S+@\S+/g, " "));
  const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(normalize(name))}($|[^\\p{L}])`, "u");
  return pattern.test(source) ? name : "";
};

const groundedEmail = (message, proposed) => {
  if (typeof proposed !== "string" || !isValidEmail(proposed.trim())) return "";
  const email = proposed.trim().toLowerCase();
  const found = String(message).toLowerCase().split(/[\s,;<>()[\]]+/)
    .some((word) => word.replace(/[.!?]+$/, "") === email);
  return found ? email : "";
};

// First missing/invalid field in the order the backend asks for them, or null.
// A service that is not in company.js (for example old free-text data) counts as missing.
const nextMissingField = (draft, services = []) => {
  for (const field of ASK_ORDER) {
    if (field === "service" && !canonicalService(draft?.service, services)) return "service";
    if (field === "name" && !isValidName(draft?.name)) return "name";
    if (field === "email" && !isValidEmail(draft?.email)) return "email";
  }
  return null;
};

const hasAllFields = (draft, services = []) => nextMissingField(draft, services) === null;

const isConfirmation = (value) =>
  /^(ja|ja det stämmer|ja, det stämmer|det stämmer|stämmer|yes|yes correct|correct)[.! ]*$/i
    .test(normalize(value));

const isSwedish = (messages) => messages.some((m) =>
  m.role === "user" &&
  /[åäö]|\b(hej|jag|mitt|namn|heter|tack|vill|mejl|intresserad|ändra|eller|nej)\b/i.test(m.content));

// One customer message + one model proposal -> new draft.
// parsed = { name, email, service, clear: [...] } (anything else is ignored)
function applyInterpretation(current, message, parsed, services = []) {
  const draft = {
    name: String(current?.name || ""),
    email: String(current?.email || ""),
    service: String(current?.service || ""),
  };
  const proposal = parsed && typeof parsed === "object" ? parsed : {};
  const clearList = Array.isArray(proposal.clear)
    ? proposal.clear.filter((field) => FIELDS.includes(field)) : [];
  const accepted = [];
  const rejected = [];
  const cleared = [];
  let changed = false;

  for (const field of FIELDS) {
    const raw = typeof proposal[field] === "string" ? proposal[field].trim() : "";
    if (!raw) continue;
    const value = field === "name" ? groundedName(message, raw)
      : field === "email" ? groundedEmail(message, raw)
      : canonicalService(raw, services);
    if (value) {
      if (draft[field] !== value) { draft[field] = value; changed = true; }
      accepted.push(field);
    } else if (normalize(raw) !== normalize(draft[field])) {
      // Not usable and not just an echo of what we already have.
      rejected.push(field);
    }
  }

  for (const field of clearList) {
    if (accepted.includes(field)) continue; // a new value in the same message wins
    if (draft[field]) { draft[field] = ""; changed = true; cleared.push(field); }
  }

  return { draft, changed, accepted, rejected, cleared };
}

module.exports = {
  normalize, isValidEmail, isValidName, canonicalService, groundedName, groundedEmail,
  nextMissingField, hasAllFields, isConfirmation, isSwedish, applyInterpretation,
};