import { Devvit } from '@devvit/public-api';

// --- CONFIGURATION ---
const SUBREDDIT_NAME = 'around'; 
const CHANNEL_ID = 'UCxqoIjfLOrktYWfRbuuOcHw';
const JOB_NAME = 'check_youtube_feed';

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

Devvit.addSchedulerJob({
  name: JOB_NAME,
  onRun: async (event, context) => {
    console.log('Running YouTube Check Job (Safe Mode)...');
    
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
    
    try {
      const response = await fetch(rssUrl);
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      const xmlText = await response.text();

      const rawEntries = xmlText.split('<entry>');
      const videosInFeed = [];

      for (let i = 1; i < rawEntries.length; i++) {
        const entryContent = rawEntries[i];
        
        const videoIdMatch = entryContent.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
        const titleMatch = entryContent.match(/<title>(.*?)<\/title>/);
        const descMatch = entryContent.match(/<media:description>([\s\S]*?)<\/media:description>/);

        if (videoIdMatch && titleMatch) {
          videosInFeed.push({
            id: videoIdMatch[1].trim(), // Trim whitespace to be safe
            title: titleMatch[1],
            description: descMatch ? descMatch[1] : '',
            url: `https://www.youtube.com/watch?v=${videoIdMatch[1]}`
          });
        }
      }

      // Find the oldest unposted video
      let videoToPost = null;

      for (let i = videosInFeed.length - 1; i >= 0; i--) {
        const video = videosInFeed[i];
        const hasPosted = await context.redis.get(`posted_video:${video.id}`);

        if (!hasPosted) {
          videoToPost = video;
          break; // Stop at the first unposted video found
        }
      }

      if (videoToPost) {
        console.log(`Attempting to post: ${videoToPost.title}`);

        // --- SAFETY BLOCK START ---
        // We wrap the posting logic in try/catch.
        // If it fails, we STILL mark it as posted so we don't loop forever.
        try {
          
          // 1. Submit Link Post
          const post = await context.reddit.submitPost({
            subredditName: SUBREDDIT_NAME,
            title: videoToPost.title,
            url: videoToPost.url,
          });

          // 2. Submit Description (Only if it exists)
          if (videoToPost.description && videoToPost.description.trim().length > 0) {
              // Reddit comments have a max length. Truncate if necessary.
              const cleanDesc = videoToPost.description.substring(0, 9000); 
              
              await context.reddit.submitComment({
                  id: post.id,
                  text: cleanDesc
              });
          }
          console.log(`Successfully posted: ${videoToPost.id}`);

        } catch (postError) {
          console.error(`FAILED to post video ${videoToPost.id}. Marking as skipped.`, postError);
          // If you want to see WHY it failed, run 'npx devvit logs around'
        }

        // 3. CRITICAL: Save to Redis regardless of success or failure
        // This prevents the infinite loop.
        await context.redis.set(`posted_video:${videoToPost.id}`, 'true', { expiration: 60 * 60 * 24 * 30 });
        
        // --- SAFETY BLOCK END ---

      } else {
        console.log('No new videos to post.');
      }
      
    } catch (error) {
      console.error('General Error:', error);
    }
  },
});

Devvit.addMenuItem({
  label: 'Start YouTube Auto-Poster',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    await context.scheduler.runJob({
      name: JOB_NAME,
      cron: '*/15 * * * *', 
    });
    context.ui.showToast('Auto-poster started!');
  },
});

export default Devvit;
