/**
 * Atlantist Forum AI Agent — cron job
 * Scans recent threads for moderation, responds to unanswered posts,
 * escalates stuck threads to human support.
 *
 * Run: node jobs/forum-agent.js
 * Schedule: every 2 minutes via polsia.toml [[crons]]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runForumAgent } = require('../services/forum-agent');

runForumAgent()
  .then(r => {
    console.log(`[forum-agent] Done. processed=${r.processed} escalated=${r.escalated}`);
    process.exit(0);
  })
  .catch(e => {
    console.error('[forum-agent] Error:', e);
    process.exit(1);
  });