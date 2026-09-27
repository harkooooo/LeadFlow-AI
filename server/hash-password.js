const bcrypt = require("bcryptjs");
const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Choose an admin password: ", async (password) => {
  if (password.length < 12) {
    console.log("Use at least 12 characters.");
    rl.close();
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  console.log("\nADMIN_PASSWORD_HASH=" + hash);
  rl.close();
});