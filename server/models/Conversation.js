const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  role: { type: String, required: true },
  content: { type: String, required: true },
});

const conversationSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    messages: [messageSchema],
    leadDraft: {
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      service: { type: String, default: "" },
    },
    pendingCorrection: {
      type: String,
      enum: ["", "name", "email", "service", "unknown"],
      default: "",
    },
    awaitingConfirmation: { type: Boolean, default: false },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Conversation", conversationSchema);
