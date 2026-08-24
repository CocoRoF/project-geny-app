const { app } = require('electron');
app.whenReady().then(() => {
  const report = { node: process.versions.node, electron: process.versions.electron };
  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t VALUES (?,?)').run(1, 'ok');
    report.nodeSqlite = 'AVAILABLE';
    report.roundtrip = db.prepare('SELECT * FROM t').get();
    report.exports = Object.keys(sqlite).sort();
  } catch (e) {
    report.nodeSqlite = 'MISSING: ' + String(e.message).slice(0, 140);
  }
  console.log('PROBE ' + JSON.stringify(report));
  app.exit(0);
});
