// Database connection. Reads DATABASE_URL from the .env file.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Create a .env file with your database URL.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = {
  // query('SELECT * FROM posts WHERE id = $1', [id])  ->  { rows: [...] }
  query: (text, params) => pool.query(text, params),
  close: () => pool.end(),
};