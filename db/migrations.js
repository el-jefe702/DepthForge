export function migrateDb(db, migrations = []) {
  if (!Array.isArray(migrations)) throw new TypeError('migrations must be an array');
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new TypeError('Migration versions must be positive, strictly increasing integers');
    }
    if (typeof migration.name !== 'string' || !migration.name.trim()) {
      throw new TypeError('Migration name is required');
    }
    if (typeof migration.up !== 'function') throw new TypeError('Migration up must be a function');
    previous = migration.version;
  }

  const run = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    const known = new Map(migrations.map(m => [m.version, m]));
    for (const row of applied) {
      if (!known.has(row.version) || known.get(row.version).name !== row.name) {
        throw new Error(`Unknown or changed database migration: ${row.version}`);
      }
    }
    const completed = new Set(applied.map(row => row.version));
    const latest = applied.length ? applied[applied.length - 1].version : 0;
    const inserted = [];
    for (const migration of migrations) {
      if (completed.has(migration.version)) continue;
      if (migration.version < latest) throw new Error('Cannot insert a migration before an applied version');
      const result = migration.up(db);
      if (result && typeof result.then === 'function') {
        throw new TypeError('Migrations must be synchronous');
      }
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
      inserted.push(migration.version);
    }
    return inserted;
  });
  return run.immediate();
}
