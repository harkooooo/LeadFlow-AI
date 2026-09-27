const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },

  email: {
    type: String,
    required: true,
  },

  service: {
    type: String,
    required: true,
  },

  status: {
    type: String,
    default: "new",
  },
});

const Lead = mongoose.model("Lead", leadSchema);

module.exports = Lead;