// Script to regenerate posters for existing posts
require('dotenv').config();
const db = require('../db');
const { makeAndStorePoster } = require('../utils/videoPoster');

async function regeneratePosters() {
  console.log('Starting poster regeneration for existing posts...');
  
  try {
    // Find all posts with video media but no poster
    const { rows: posts } = await db.query(`
      SELECT id, media_path, media_poster
      FROM posts
      WHERE media_path IS NOT NULL
        AND (media_path LIKE '%.mp4' OR media_path LIKE '%.webm' OR media_path LIKE '%.mov' OR media_path LIKE '%.m4v')
      ORDER BY id DESC
    `);
    
    console.log(`Found ${posts.length} video posts`);
    
    for (const post of posts) {
      console.log(`\n Processing post ${post.id}:`);
      console.log(`  media_path: ${post.media_path}`);
      console.log(`  current media_poster: ${post.media_poster || 'NULL'}`);
      
      try {
        // Generate poster
        const result = await makeAndStorePoster(post.media_path, { private: true });
        
        if (result && result.key) {
          // Update database
          await db.query(
            `UPDATE posts SET media_poster = $1 WHERE id = $2`,
            [result.key, post.id]
          );
          console.log(`  ✓ Generated poster: ${result.key}`);
        } else {
          console.log(`  ⚠ Skipped (audio or failed)`);
        }
      } catch (error) {
        console.error(`  ✗ Error generating poster:`, error.message);
      }
    }
    
    console.log('\n✓ Poster regeneration complete!');
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    process.exit(0);
  }
}

regeneratePosters();
