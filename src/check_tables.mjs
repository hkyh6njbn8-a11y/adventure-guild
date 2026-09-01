const db = require('./lib/db.cjs').openDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// Check guild-related tables
['guilds', 'guild_members', 'guild_rewards', 'bounties', 'guild_tasks'].forEach(name => {
  const c = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name=?").get(name);
  console.log(name + ':', c.c);
});
