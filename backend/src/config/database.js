import SyncMySQL from 'sync-mysql';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

export const LOCAL_USER_ID = 'local-default-user';
export const LOCAL_USER_EMAIL = 'local@omnicloud.local';

let connection;
try {
  connection = new SyncMySQL({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'omnicloud',
    port: parseInt(process.env.DB_PORT || '3306', 10)
  });
  console.log('[DB] Connected to MySQL successfully');
} catch (e) {
  console.error('[DB] Could not connect to MySQL:', e.message);
  connection = { query: () => [] };
}

function escapeValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return "'" + String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function escapeReservedWords(sql) {
  return sql.replace(/\bkey\b/gi, (match, offset, str) => {
    if (offset > 0 && str[offset - 1] === '`') return match;
    if (offset + 3 < str.length && str[offset + 3] === '`') return match;
    const before = str.substring(Math.max(0, offset - 15), offset).trimEnd().toUpperCase();
    if (before.endsWith('PRIMARY') || before.endsWith('FOREIGN') || before.endsWith('DUPLICATE')) return match;
    const after = str.substring(offset + 3).trimStart();
    if (after.startsWith('(')) return match;
    return '`key`';
  });
}

function convertSql(sql) {
  let mysqlSql = sql;
  mysqlSql = mysqlSql.replace(/INSERT\s+OR\s+IGNORE/ig, 'INSERT IGNORE');
  mysqlSql = mysqlSql.replace(/ON\s+CONFLICT\s*\([^)]+\)\s*DO\s+UPDATE\s+SET/ig, 'ON DUPLICATE KEY UPDATE');
  mysqlSql = mysqlSql.replace(/excluded\.([a-zA-Z_][a-zA-Z0-9_]*)/ig, 'VALUES($1)');
  mysqlSql = escapeReservedWords(mysqlSql);
  return mysqlSql;
}

function replaceNamedParams(sql, obj) {
  return sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
    if (obj.hasOwnProperty(name)) {
      return escapeValue(obj[name]);
    }
    return match;
  });
}

function replacePositionalParams(sql, args) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i < args.length) {
      return escapeValue(args[i++]);
    }
    return '?';
  });
}

export const db = {
  pragma: (sql) => {},

  transaction: (fn) => {
    const wrappedFn = (...args) => {
      connection.query('START TRANSACTION');
      try {
        const result = fn(...args);
        connection.query('COMMIT');
        return result;
      } catch (e) {
        connection.query('ROLLBACK');
        throw e;
      }
    };
    return wrappedFn;
  },

  prepare: (sql) => {
    const mysqlSql = convertSql(sql);

    return {
      run: (...args) => {
        let finalSql;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          finalSql = replaceNamedParams(mysqlSql, args[0]);
        } else {
          finalSql = replacePositionalParams(mysqlSql, args);
        }
        try {
          const result = connection.query(finalSql);
          return { changes: result.affectedRows || 0, lastInsertRowid: result.insertId || 0 };
        } catch (e) {
          console.error('[DB] SQL Error in run:', e.message);
          console.error('[DB] SQL:', finalSql.substring(0, 500));
          throw e;
        }
      },

      get: (...args) => {
        let finalSql;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          finalSql = replaceNamedParams(mysqlSql, args[0]);
        } else {
          finalSql = replacePositionalParams(mysqlSql, args);
        }
        try {
          const result = connection.query(finalSql);
          return result[0] || undefined;
        } catch (e) {
          console.error('[DB] SQL Error in get:', e.message);
          console.error('[DB] SQL:', finalSql.substring(0, 500));
          throw e;
        }
      },

      all: (...args) => {
        let finalSql;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
          finalSql = replaceNamedParams(mysqlSql, args[0]);
        } else {
          finalSql = replacePositionalParams(mysqlSql, args);
        }
        try {
          return connection.query(finalSql);
        } catch (e) {
          console.error('[DB] SQL Error in all:', e.message);
          console.error('[DB] SQL:', finalSql.substring(0, 500));
          throw e;
        }
      }
    };
  },

  exec: (sql) => {
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      let mysqlSql = convertSql(stmt);
      mysqlSql = mysqlSql.replace(/([a-zA-Z_]+)\s+TEXT\s+PRIMARY\s+KEY/g, '$1 VARCHAR(255) PRIMARY KEY');
      mysqlSql = mysqlSql.replace(/email\s+TEXT\s+NOT\s+NULL\s+UNIQUE/g, 'email VARCHAR(255) NOT NULL UNIQUE');
      mysqlSql = mysqlSql.replace(/token_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/g, 'token_hash VARCHAR(255) NOT NULL UNIQUE');
      mysqlSql = mysqlSql.replace(/provider\s+TEXT/g, 'provider VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/user_id\s+TEXT/g, 'user_id VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/cloud_account_id\s+TEXT/g, 'cloud_account_id VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/virtual_path\s+TEXT/g, 'virtual_path VARCHAR(1024)');
      mysqlSql = mysqlSql.replace(/remote_file_id\s+TEXT/g, 'remote_file_id VARCHAR(255)');

      if (mysqlSql.toUpperCase().startsWith('PRAGMA')) continue;

      try {
        connection.query(mysqlSql);
      } catch (e) {
        if (!e.message.includes('Duplicate key name') && !e.message.includes('Duplicate entry')) {
          console.error('[DB] Init Error:', e.message);
        }
      }
    }
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_local INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cloud_accounts (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    provider VARCHAR(255) NOT NULL,
    encrypted_credentials TEXT NOT NULL,
    total_space BIGINT NOT NULL,
    used_space BIGINT NOT NULL,
    status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS file_metadata (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    virtual_path VARCHAR(1024) NOT NULL,
    file_name TEXT NOT NULL,
    is_folder INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    size BIGINT NOT NULL DEFAULT 0,
    mime_type VARCHAR(255),
    cloud_account_id VARCHAR(255) NOT NULL,
    remote_file_id VARCHAR(255) NOT NULL,
    remote_parent_id VARCHAR(255),
    remote_created_time VARCHAR(255),
    remote_modified_time VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY(cloud_account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    \`key\` VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.prepare(`
  INSERT IGNORE INTO users (id, email, password_hash, is_local)
  VALUES (?, ?, '', 1)
`).run(LOCAL_USER_ID, LOCAL_USER_EMAIL);

db.exec(`
  CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
  CREATE UNIQUE INDEX idx_cloud_accounts_user_provider_email ON cloud_accounts(user_id, provider, email);
  CREATE INDEX idx_cloud_accounts_user_id ON cloud_accounts(user_id);
  CREATE INDEX idx_file_virtual_path ON file_metadata(user_id, virtual_path(255));
  CREATE INDEX idx_file_remote_id ON file_metadata(user_id, remote_file_id);
  CREATE UNIQUE INDEX idx_file_account_remote_id ON file_metadata(cloud_account_id, remote_file_id);
  CREATE INDEX idx_file_user_account_id ON file_metadata(user_id, cloud_account_id);
  CREATE UNIQUE INDEX idx_user_settings_user_key ON user_settings(user_id, \`key\`);
`);

console.log('[DB] All tables and indexes initialized successfully');
