import { Devvit } from '@devvit/public-api';

const SUBREDDIT_NAME = 'around';
const CHANNEL_ID = 'UCxqoIjfLOrktYWfRbuuOcHw';
const JOB_NAME = 'check_youtube_feed';

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

async function getVideosFromFeed() {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const response = await fetch(rssUrl);
  if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
  const xmlText = await response.text();
  
  const rawEntries = xmlText.split('<entry>');
  const videos = [];

  for (let i = 1; i < rawEntries.length; i++) {
    const entryContent = rawEntries[i];
    const videoIdMatch = entryContent.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
    const titleMatch = entryContent.match(/<title>(.*?)<\/title>/);
    const descMatch = entryContent.match(/<media:description>([\s\S]*?)<\/media:description>/);

    if (videoIdMatch && titleMatch) {
      videos.push({
        id: videoIdMatch[1].trim(),
        title: titleMatch[1],
        description: descMatch ? descMatch[1] : '',
        url: `https://www.youtube.com/watch?v=${videoIdMatch[1]}`
      });
    }
  }
  return videos;
}

Devvit.addSchedulerJob({
  name: JOB_NAME,
  onRun: async (event, context) => {
    console.log('Running YouTube Check Job...');
    
    try {
      const videosInFeed = await getVideosFromFeed();
      let videoToPost = null;

      // Find the oldest unposted video
      for (let i = videosInFeed.length - 1; i >= 0; i--) {
        const video = videosInFeed[i];
        const hasPosted = await context.redis.get(`posted_video:${video.id}`);
        if (!hasPosted) {
          videoToPost = video;
          break; 
        }
      }

      if (videoToPost) {
        console.log(`Attempting to post: ${videoToPost.title}`);

        // --- FIX: Create a Date object for 30 days in the future ---
        const now = new Date();
        const expirationDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000)); 

        // Optimistic Locking: Mark as done immediately
        await context.redis.set(`posted_video:${videoToPost.id}`, 'true', { expiration: expirationDate });

        try {
          const post = await context.reddit.submitPost({
            subredditName: SUBREDDIT_NAME,
            title: videoToPost.title,
            url: videoToPost.url,
          });

          if (videoToPost.description && videoToPost.description.trim().length > 0) {
              const cleanDesc = videoToPost.description.substring(0, 5000);
              await context.reddit.submitComment({
                  id: post.id,
                  text: cleanDesc
              });
          }
          console.log(`Successfully posted: ${videoToPost.id}`);

        } catch (postError) {
          console.error(`FAILED to post video ${videoToPost.id}`, postError);
        }

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

Devvit.addMenuItem({
  label: 'DEBUG: Mark All Read (Fix Loop)',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Clearing queue...');
    try {
        const videos = await getVideosFromFeed();
        
        // --- FIX: Same Date fix for the button ---
        const now = new Date();
        const expirationDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));

        let count = 0;
        for (const video of videos) {
            await context.redis.set(`posted_video:${video.id}`, 'true', { expiration: expirationDate });
            count++;
        }
        context.ui.showToast(`Fixed! Marked ${count} videos.`);
    } catch (e) {
        context.ui.showToast('Failed to clear queue');
        console.error(e);
    }
  },
});

export default Devvit;
