import { Devvit } from '@devvit/public-api';

// --- CONFIGURATION ---
const SUBREDDIT_NAME = 'around'; // Your main subreddit
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
    console.log('Running YouTube Check Job (Drip-Feed Mode)...');
    
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
    
    try {
      const response = await fetch(rssUrl);
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      const xmlText = await response.text();

      // Split XML into individual entry blocks
      // (The first split is the header, so we ignore index 0)
      const rawEntries = xmlText.split('<entry>');
      
      // We will store all valid videos found in the feed here
      const videosInFeed = [];

      // Loop through all entries to parse them
      for (let i = 1; i < rawEntries.length; i++) {
        const entryContent = rawEntries[i];
        
        const videoIdMatch = entryContent.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
        const titleMatch = entryContent.match(/<title>(.*?)<\/title>/);
        const descMatch = entryContent.match(/<media:description>([\s\S]*?)<\/media:description>/);

        if (videoIdMatch && titleMatch) {
          videosInFeed.push({
            id: videoIdMatch[1],
            title: titleMatch[1],
            description: descMatch ? descMatch[1] : '',
            url: `https://www.youtube.com/watch?v=${videoIdMatch[1]}`
          });
        }
      }

      // NOW: Find the oldest video that we haven't posted yet
      // We iterate backwards (oldest to newest) to maintain order
      let videoToPost = null;

      for (let i = videosInFeed.length - 1; i >= 0; i--) {
        const video = videosInFeed[i];
        
        // Check Redis: Have we posted this specific video ID?
        // We use a specific key for every video to track them individually
        const hasPosted = await context.redis.get(`posted_video:${video.id}`);

        if (!hasPosted) {
          // We found an unposted video!
          videoToPost = video;
          // We break immediately so we only post ONE per cycle (Drip Feed)
          break;
        }
      }

      if (videoToPost) {
        console.log(`Found unposted video: ${videoToPost.title}`);
        
        // 1. Submit Link Post
        const post = await context.reddit.submitPost({
          subredditName: SUBREDDIT_NAME,
          title: videoToPost.title,
          url: videoToPost.url,
        });

        // 2. Submit Description Comment
        if (videoToPost.description && videoToPost.description.trim().length > 0) {
            await context.reddit.submitComment({
                id: post.id,
                text: videoToPost.description
            });
        }

        // 3. Mark this specific ID as posted in Redis
        // We set an expiry of 30 days so Redis doesn't fill up forever
        await context.redis.set(`posted_video:${videoToPost.id}`, 'true', { expiration: 60 * 60 * 24 * 30 });
        
        console.log(`Successfully posted: ${videoToPost.id}`);
      } else {
        console.log('All videos in the feed have already been posted.');
      }
      
    } catch (error) {
      console.error('Error fetching YouTube feed:', error);
    }
  },
});

// Menu item to START the automation
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
