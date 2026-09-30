import SyncMySQL from 'sync-mysql';
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
    port: process.env.DB_PORT || 3306
  });
} catch (e) {
  console.error("Could not connect to MySQL:", e.message);
  // We can create a dummy connection so tests don't immediately crash if DB is down
  connection = { query: () => [] };
}

// A wrapper to mimic better-sqlite3 API synchronously using sync-mysql
export const db = {
  pragma: (sql) => {
    // MySQL doesn't have PRAGMA, just ignore
  },
  prepare: (sql) => {
    // In MySQL INSERT OR IGNORE is INSERT IGNORE
    let mysqlSql = sql.replace(/INSERT OR IGNORE/ig, 'INSERT IGNORE');
    
    const escape = (val) => {
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return val;
      if (typeof val === 'boolean') return val ? 1 : 0;
      // Simple escape, replace ' with ''
      return "'" + String(val).replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
    };

    return {
      run: (...args) => {
        let finalSql = mysqlSql;
        args.forEach(arg => {
          finalSql = finalSql.replace(/\?/, escape(arg));
        });
        const result = connection.query(finalSql);
        return { changes: result.affectedRows, lastInsertRowid: result.insertId };
      },
      get: (...args) => {
        let finalSql = mysqlSql;
        args.forEach(arg => {
          finalSql = finalSql.replace(/\?/, escape(arg));
        });
        const result = connection.query(finalSql);
        return result[0] || undefined;
      },
      all: (...args) => {
        let finalSql = mysqlSql;
        args.forEach(arg => {
          finalSql = finalSql.replace(/\?/, escape(arg));
        });
        return connection.query(finalSql);
      }
    };
  },
  exec: (sql) => {
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    for (let stmt of statements) {
      let mysqlSql = stmt.replace(/INSERT OR IGNORE/ig, 'INSERT IGNORE');
      mysqlSql = mysqlSql.replace(/([a-zA-Z_]+)\s+TEXT\s+PRIMARY\s+KEY/g, '$1 VARCHAR(255) PRIMARY KEY');
      mysqlSql = mysqlSql.replace(/email\s+TEXT\s+NOT\s+NULL\s+UNIQUE/g, 'email VARCHAR(255) NOT NULL UNIQUE');
      mysqlSql = mysqlSql.replace(/token_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/g, 'token_hash VARCHAR(255) NOT NULL UNIQUE');
      mysqlSql = mysqlSql.replace(/provider\s+TEXT/g, 'provider VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/user_id\s+TEXT/g, 'user_id VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/cloud_account_id\s+TEXT/g, 'cloud_account_id VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/virtual_path\s+TEXT/g, 'virtual_path VARCHAR(1024)');
      mysqlSql = mysqlSql.replace(/remote_file_id\s+TEXT/g, 'remote_file_id VARCHAR(255)');
      mysqlSql = mysqlSql.replace(/key\s+TEXT/g, '`key` VARCHAR(255)'); 
      
      if (mysqlSql.toUpperCase().startsWith('PRAGMA')) continue;
      
      try {
        connection.query(mysqlSql);
      } catch (e) {
        if (!e.message.includes('Duplicate key name')) {
          console.error("DB Init Error:", e.message);
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
    status VARCHAR(50) NOT NULL CHECK (status IN ('active', 'suspended', 'invalid_token')),
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
