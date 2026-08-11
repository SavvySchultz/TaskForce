const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Database connection ---
// Reactor injects DB credentials as environment variables.
// Common patterns: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// Also support MYSQL_* and DATABASE_URL patterns
const dbConfig = {
  host: process.env.DB_HOST || process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || process.env.MYSQL_PORT || '3306'),
  user: process.env.DB_USER || process.env.MYSQL_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database: process.env.DB_NAME || process.env.MYSQL_DATABASE || 'taskforce',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};

let pool;

async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);

    // Create tables if they don't exist
    const conn = await pool.getConnection();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(20) PRIMARY KEY,
        title VARCHAR(500) NOT NULL DEFAULT 'Untitled ticket',
        summary TEXT,
        author VARCHAR(200),
        category VARCHAR(100),
        status VARCHAR(50) DEFAULT 'draft',
        estTime VARCHAR(50),
        tags JSON,
        tools JSON,
        prerequisites JSON,
        steps JSON,
        warnings JSON,
        relatedTitles JSON,
        attachments LONGTEXT,
        rawNotes LONGTEXT,
        aiCleaned BOOLEAN DEFAULT FALSE,
        views INT DEFAULT 0,
        copies INT DEFAULT 0,
        helpful INT DEFAULT 0,
        helpfulBy JSON,
        verifiedAt BIGINT DEFAULT 0,
        verifiedBy VARCHAR(200),
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id VARCHAR(20) PRIMARY KEY,
        ticketId VARCHAR(20) NOT NULL,
        author VARCHAR(200) NOT NULL,
        text TEXT NOT NULL,
        replyTo VARCHAR(20),
        at BIGINT NOT NULL,
        INDEX idx_ticket (ticketId)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        name VARCHAR(200) PRIMARY KEY,
        color VARCHAR(20) NOT NULL,
        updatedAt BIGINT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    conn.release();

    // Migrate: add columns that may not exist on older tables
    const mConn = await pool.getConnection();
    try {
      await mConn.query('ALTER TABLE tickets ADD COLUMN helpful INT DEFAULT 0');
    } catch (e) { /* column already exists */ }
    try {
      await mConn.query('ALTER TABLE tickets ADD COLUMN helpfulBy JSON');
    } catch (e) { /* column already exists */ }
    try {
      await mConn.query('ALTER TABLE tickets ADD COLUMN guideNum INT DEFAULT 0');
    } catch (e) { /* column already exists */ }
    mConn.release();

    console.log('Database connected and tables ready.');
  } catch (err) {
    console.error('Database init error:', err.message);
    console.log('App will still serve the frontend — data will save locally in the browser until DB is available.');
  }
}

// --- Helper: check if DB is available ---
function dbReady() { return !!pool; }

// --- API Routes ---

// Health check for Reactor
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// DB status for frontend
app.get('/api/status', async (req, res) => {
  if (!dbReady()) return res.json({ db: false, message: 'Database not connected' });
  try {
    await pool.query('SELECT 1');
    res.json({ db: true, message: 'Connected' });
  } catch (e) {
    res.json({ db: false, message: e.message });
  }
});

// GET all users (for color claims)
app.get('/api/users', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const [rows] = await pool.query('SELECT name, color FROM users');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST claim a color
app.post('/api/users', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const { name, color } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color required' });
    // Check if color is taken by someone else
    const [existing] = await pool.query('SELECT name FROM users WHERE color=? AND name!=?', [color, name]);
    if (existing.length) return res.status(409).json({ error: 'Color taken by ' + existing[0].name });
    // Upsert
    await pool.query(
      'INSERT INTO users (name, color, updatedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE color=?, updatedAt=?',
      [name, color, Date.now(), color, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET all tickets with their comments
app.get('/api/tickets', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const [tickets] = await pool.query('SELECT * FROM tickets ORDER BY updatedAt DESC');
    const [comments] = await pool.query('SELECT * FROM comments ORDER BY at ASC');

    // Group comments by ticket
    const commentMap = {};
    comments.forEach(c => {
      if (!commentMap[c.ticketId]) commentMap[c.ticketId] = [];
      commentMap[c.ticketId].push({ id: c.id, author: c.author, text: c.text, replyTo: c.replyTo || null, at: c.at });
    });

    const result = tickets.map(t => ({
      id: t.id,
      title: t.title,
      summary: t.summary || '',
      author: t.author || '',
      category: t.category || '',
      status: t.status || 'draft',
      estTime: t.estTime || '',
      tags: safeJSON(t.tags, []),
      tools: safeJSON(t.tools, []),
      prerequisites: safeJSON(t.prerequisites, []),
      steps: safeJSON(t.steps, []),
      warnings: safeJSON(t.warnings, []),
      relatedTitles: safeJSON(t.relatedTitles, []),
      attachments: safeJSON(t.attachments, []),
      rawNotes: t.rawNotes || '',
      aiCleaned: !!t.aiCleaned,
      views: t.views || 0,
      copies: t.copies || 0,
      helpful: t.helpful || 0,
      helpfulBy: safeJSON(t.helpfulBy, []),
      guideNum: t.guideNum || 0,
      verifiedAt: t.verifiedAt || 0,
      verifiedBy: t.verifiedBy || '',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      comments: commentMap[t.id] || []
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create ticket
app.post('/api/tickets', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const t = req.body;
    const id = t.id || genId();
    await pool.query(
      `INSERT INTO tickets (id, title, summary, author, category, status, estTime, tags, tools, prerequisites, steps, warnings, relatedTitles, attachments, rawNotes, aiCleaned, views, copies, guideNum, verifiedAt, verifiedBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.title, t.summary || '', t.author || '', t.category || '', t.status || 'draft', t.estTime || '',
       JSON.stringify(t.tags || []), JSON.stringify(t.tools || []), JSON.stringify(t.prerequisites || []),
       JSON.stringify(t.steps || []), JSON.stringify(t.warnings || []), JSON.stringify(t.relatedTitles || []),
       JSON.stringify(t.attachments || []), t.rawNotes || '', t.aiCleaned ? 1 : 0,
       0, 0, t.guideNum || 0, t.verifiedAt || 0, t.verifiedBy || '', t.createdAt || Date.now(), t.updatedAt || Date.now()]
    );
    res.json({ id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update ticket
app.put('/api/tickets/:id', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const t = req.body;
    await pool.query(
      `UPDATE tickets SET title=?, summary=?, author=?, category=?, status=?, estTime=?, tags=?, tools=?, prerequisites=?, steps=?, warnings=?, relatedTitles=?, attachments=?, rawNotes=?, aiCleaned=?, views=?, copies=?, guideNum=?, verifiedAt=?, verifiedBy=?, updatedAt=? WHERE id=?`,
      [t.title, t.summary || '', t.author || '', t.category || '', t.status || 'draft', t.estTime || '',
       JSON.stringify(t.tags || []), JSON.stringify(t.tools || []), JSON.stringify(t.prerequisites || []),
       JSON.stringify(t.steps || []), JSON.stringify(t.warnings || []), JSON.stringify(t.relatedTitles || []),
       JSON.stringify(t.attachments || []), t.rawNotes || '', t.aiCleaned ? 1 : 0,
       t.views || 0, t.copies || 0, t.guideNum || 0, t.verifiedAt || 0, t.verifiedBy || '', t.updatedAt || Date.now(), req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH partial update (views, copies, status)
app.patch('/api/tickets/:id', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const fields = req.body;
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (['views', 'copies', 'status', 'helpful', 'guideNum', 'verifiedAt', 'verifiedBy', 'updatedAt'].includes(k)) {
        sets.push(`${k}=?`);
        vals.push(v);
      }
    }
    if (sets.length) {
      vals.push(req.params.id);
      await pool.query(`UPDATE tickets SET ${sets.join(',')} WHERE id=?`, vals);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE ticket
app.delete('/api/tickets/:id', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    await pool.query('DELETE FROM comments WHERE ticketId=?', [req.params.id]);
    await pool.query('DELETE FROM tickets WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST helpful vote (one per user)
app.post('/api/tickets/:id/helpful', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const [rows] = await pool.query('SELECT helpful, helpfulBy FROM tickets WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const existing = safeJSON(rows[0].helpfulBy, []);
    if (existing.map(n => n.toLowerCase()).includes(name.toLowerCase())) {
      return res.status(409).json({ error: 'Already voted' });
    }
    existing.push(name);
    await pool.query('UPDATE tickets SET helpful=?, helpfulBy=?, updatedAt=? WHERE id=?',
      [existing.length, JSON.stringify(existing), Date.now(), req.params.id]);
    res.json({ success: true, helpful: existing.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST comment
app.post('/api/tickets/:id/comments', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const c = req.body;
    const id = c.id || genId();
    await pool.query(
      'INSERT INTO comments (id, ticketId, author, text, replyTo, at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.params.id, c.author, c.text, c.replyTo || null, c.at || Date.now()]
    );
    await pool.query('UPDATE tickets SET updatedAt=? WHERE id=?', [Date.now(), req.params.id]);
    res.json({ id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE a comment
app.delete('/api/tickets/:id/comments/:cid', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    await pool.query('DELETE FROM comments WHERE id=? AND ticketId=?', [req.params.cid, req.params.id]);
    await pool.query('UPDATE tickets SET updatedAt=? WHERE id=?', [Date.now(), req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update a comment
app.put('/api/tickets/:id/comments/:cid', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Database not available' });
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
    await pool.query('UPDATE comments SET text=? WHERE id=? AND ticketId=?', [text.trim(), req.params.cid, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Helpers ---
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function safeJSON(val, fallback) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

// --- Start ---
const PORT = process.env.PORT || 8000;
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TaskForce running on port ${PORT}`);
  });
});
