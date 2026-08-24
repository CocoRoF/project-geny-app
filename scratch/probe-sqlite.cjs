const { app } = require('electron');
app.whenReady().then(() => {
  let report = { node: process.versions.node, electron: process.versions.electron, v8: process.versions.v8 };
  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    db.prepare('INSERT INTO t VALUES (?,?)').run(1, 'ok');
    const row = db.prepare('SELECT * FROM t').get();
    report.nodeSqlite = 'AVAILABLE';
    report.roundtrip = row;
    report.exports = Object.keys(sqlite);
  } catch (e) {
    report.nodeSqlite = 'MISSING: ' + e.message.slice(0, 120);
  }
  console.log('PROBE ' + JSON.stringify(report));
  app.exit(0);
});
