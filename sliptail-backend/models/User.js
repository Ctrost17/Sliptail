const db = require("../db");

const createUser = async ({ email, passwordHash, role }) => {
  const result = await db.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
    [email, passwordHash, role]
  );
  return result.rows[0];
};

const findUserByEmail = async (email) => {
  const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
  return result.rows[0];
};

module.exports = {
  createUser,
  findUserByEmail,
};