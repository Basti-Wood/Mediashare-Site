// Quick diagnostic: tests the YouTube Data API key + playlist expansion.
// Run from the project root:  node scrs/backend/test-yt-key.js
'use strict';
require('dotenv').config();

const KEY = process.env.YOUTUBE_API_KEY;
const PLAYLIST = process.argv[2] || 'PLrJL3aEKU6T4oCGPO7rAQ6jhvL9nUD0vO';

(async () => {
    if (!KEY) {
        console.error('❌ YOUTUBE_API_KEY is empty in .env');
        process.exit(1);
    }
    console.log(`Using key: ${KEY.slice(0, 8)}…${KEY.slice(-4)}`);
    console.log(`Testing playlist: ${PLAYLIST}\n`);

    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${encodeURIComponent(PLAYLIST)}&key=${encodeURIComponent(KEY)}`;

    let r, data;
    try {
        r = await fetch(url);
    } catch (e) {
        console.error('❌ Network error reaching googleapis.com:', e.message);
        console.error('   Is this machine able to reach the internet / not behind a blocking proxy?');
        process.exit(1);
    }

    try { data = await r.json(); }
    catch { console.error('❌ Response was not JSON. HTTP', r.status); process.exit(1); }

    console.log('HTTP status:', r.status);

    if (data.error) {
        const err = data.error;
        const reason = err.errors?.[0]?.reason || '(no reason)';
        console.error('\n❌ API returned an error:');
        console.error('   message:', err.message);
        console.error('   reason :', reason);
        console.error('\nMost likely fix:');
        if (reason === 'accessNotConfigured' || /has not been used|disabled/.test(err.message)) {
            console.error('   → "YouTube Data API v3" is NOT enabled for this key\'s project.');
            console.error('     Google Cloud Console → APIs & Services → Library → search "YouTube Data API v3" → ENABLE.');
            console.error('     (After enabling, wait ~1-2 min for it to propagate.)');
        } else if (reason === 'keyInvalid' || /API key not valid/.test(err.message)) {
            console.error('   → The key string is wrong/typo, or was just created and not active yet.');
        } else if (reason === 'ipRefererBlocked' || /referer|blocked/.test(err.message)) {
            console.error('   → The key has Application restrictions (HTTP referrer / IP).');
            console.error('     For a server, set Application restrictions = "None".');
        } else if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
            console.error('   → Daily quota exhausted. Resets at midnight Pacific.');
        } else {
            console.error('   → See message above.');
        }
        process.exit(1);
    }

    const items = (data.items || []).map(i => i.snippet?.title).filter(Boolean);
    console.log(`\n✅ SUCCESS — playlist has ${data.pageInfo?.totalResults ?? '?'} videos total.`);
    console.log('First few titles:');
    items.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
})();
