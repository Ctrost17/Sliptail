// Add media_poster column to posts table
require('dotenv').config();
const db = require('../db');

async function addMediaPosterColumn() {
  console.log('Adding media_poster column to posts table...');
  
  try {
    // Add the column
    await db.query(`
      ALTER TABLE posts
      ADD COLUMN IF NOT EXISTS media_poster TEXT
    `);
    console.log('✓ Column added successfully');
    
    // Add index
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_media_poster 
      ON posts(media_poster)
    `);
    console.log('✓ Index created successfully');
    
    // Verify the column exists
    const { rows } = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'posts' AND column_name = 'media_poster'
    `);
    
    if (rows.length > 0) {
      console.log('\n✓ Migration successful! Column details:');
      console.log(rows[0]);
    } else {
      console.log('\n⚠ Warning: Column might not have been created');
    }
    
  } catch (error) {
    console.error('✗ Migration failed:', error.message);
  } finally {
    process.exit(0);
  }
}

addMediaPosterColumn();
