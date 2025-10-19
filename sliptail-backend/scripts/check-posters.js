// Check which posts have posters in the database
require('dotenv').config();
const db = require('../db');

async function checkPosters() {
  console.log('Checking poster status in database...\n');
  
  try {
    const { rows } = await db.query(`
      SELECT 
        id, 
        media_path, 
        media_poster,
        CASE 
          WHEN media_poster IS NOT NULL THEN '✓ Has poster'
          WHEN media_path IS NOT NULL THEN '✗ Missing poster'
          ELSE '- No media'
        END as status
      FROM posts
      WHERE media_path IS NOT NULL
      ORDER BY id DESC
    `);
    
    console.table(rows);
    
    const withPoster = rows.filter(r => r.media_poster).length;
    const withoutPoster = rows.filter(r => !r.media_poster && r.media_path).length;
    
    console.log(`\nSummary:`);
    console.log(`  Posts with posters: ${withPoster}`);
    console.log(`  Posts without posters: ${withoutPoster}`);
    
    if (withoutPoster > 0) {
      console.log(`\n⚠️  Run: node scripts/regenerate-posters.js`);
    } else {
      console.log(`\n✓ All posts have posters!`);
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

checkPosters();
