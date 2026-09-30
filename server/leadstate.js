// Testable helpers for extracting and validating customer-owned information.
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const VALID_EMAIL = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const normalize = (text) => String(text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const isValidEmail = (value) => typeof value === "string" && value.length <= 254 && VALID_EMAIL.test(value);
const emailFrom = (text) => {
  const match = String(text).match(EMAIL_PATTERN);
  return match && isValidEmail(match[0]) ? match[0].toLowerCase() : "";
};
const customerSaid = (messages, value) => {
  const target = normalize(value);
  return Boolean(target) && messages.filter(m => m.role === "user")
    .some(m => normalize(m.content).includes(target));
};
const explicitName = (text) => {
  const matches = String(text).trim().matchAll(/(?:jag heter|mitt (?:riktiga )?namn är|namnet är|my name is|call me|heter)\s+([a-zåäöA-ZÅÄÖ][a-zåäöA-ZÅÄÖ '-]{1,55})/gi);
  for (const match of matches) {
    const name = match[1].replace(/[.,!?]+$/, "").trim();
    if (name.length >= 2 && !/\b(inte|not|fel|wrong)\b/i.test(name)) return name;
  }
  return "";
};

// A short self-correction like "eller nej Oskar" contains a corrected name,
// even though it omits "jag heter". Exclude email/service references.
const bareCorrectedName = (text) => {
  const t = String(text || "").trim();
  const match = t.match(/^(?:eller\s+)?(?:nej|no|sorry|förlåt)[,\s]+(?:(?:asså|alltså|jag menar|actually)[,\s]+)?([A-Za-zÅÄÖåäö][A-Za-zÅÄÖåäö '-]{1,55})[.!?]*$/i);
  if (!match || /^(?:jag|my|mitt|name|heter)\b/i.test(match[1]) || /\b(?:email|e-post|mejl|mail|tjänst|service|är|is|inte|not|fel)\b/i.test(match[1])) return "";
  return match[1].trim();
};

const correctionField = (text) => {
  const t = normalize(text);
  if (bareCorrectedName(text) || /^(?:eller\s+)?(?:nej|no|sorry|förlåt|fast|jag menar)[,\s]+(?:jag heter|mitt namn är|my name is|call me)\b/i.test(t)) return "name";
  if (/(?:namn(?:et)?|heter).{0,25}(?:inte|fel)|(?:inte|fel).{0,25}namn|(?:name).{0,25}(?:wrong|not)|not my name/i.test(t)) return "name";
  if (/(?:mejl|mail|epost|e-post|email).{0,25}(?:fel|inte|wrong|not)|(?:fel|wrong).{0,25}(?:mejl|mail|email)/i.test(t)) return "email";
  if (/(?:tjänst|service).{0,25}(?:fel|inte|wrong|not)|(?:fel|wrong).{0,25}(?:tjänst|service)/i.test(t)) return "service";
  // Direct changes such as "jag vill ändra tjänsten till sociala medier".
  if (/\b(?:ändra|byta|byt|change|switch)\b.{0,35}\b(?:tjänst(?:en)?|service)\b|\b(?:tjänst(?:en)?|service)\b.{0,25}\b(?:till|instead of|to)\b/i.test(t)) return "service";
  if (/^(?:nej|no)(?:[.!]?|[, ]+(?:det stämmer inte|that is wrong))[.!?]*$/i.test(t)) return "unknown";
  return "";
};
// Only use a newly stated service, never silently restore the old one.
const correctedService = (text, allowPlainAnswer = false) => {
  const value = String(text || "").trim();
  const patterns = [
    /(?:ändra|byta|byt)\s+(?:min\s+)?tjänst(?:en)?\s+till\s+(.+)/i,
    /(?:change|switch)\s+(?:my\s+)?service\s+to\s+(.+)/i,
    /(?:tjänsten?\s+(?:är|ska vara|blir)|service\s+(?:is|should be))\s+(.+)/i,
    /(?:jag vill (?:ha|använda)|jag är intresserad av|i want|i'm interested in)\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const service = match[1].trim().replace(/[.!?]+$/, "").trim();
      if (service.length >= 2 && service.length <= 100 && !service.includes("@")) return service;
    }
  }
  if (allowPlainAnswer) {
    const service = value.replace(/[.!?]+$/, "").trim();
    if (service.length >= 2 && service.length <= 100 && !service.includes("@") &&
        !/^(?:nej|ja|no|yes|vet inte|don't know)$/i.test(service)) return service;
  }
  return "";
};
const isConfirmation = (text) => /^(?:ja|ja det stämmer|ja, det stämmer|yes|yes correct|correct|stämmer|det stämmer)[.! ]*$/i.test(normalize(text));
const hasAllFields = (draft) => Boolean(draft.name && draft.name.length >= 2 && isValidEmail(draft.email) && draft.service);
const isSwedish = (messages) => messages.some(m => m.role === "user" && /[åäö]|\b(hej|jag|mitt|namn|heter|tack|vill|mejl|intresserad)\b/i.test(m.content));
module.exports = { correctedService, bareCorrectedName, normalize, isValidEmail, emailFrom, customerSaid, explicitName, correctionField, isConfirmation, hasAllFields, isSwedish };
