const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// Session management
app.use(session({
    secret: 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Database setup
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the database.');
});

// Create tables
db.serialize(() => {
    // Coupons table
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        likes_count INTEGER DEFAULT 1000,
        used_likes INTEGER DEFAULT 0,
        duration_days INTEGER DEFAULT 30,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        created_by TEXT DEFAULT 'system'
    )`);

    // Users table for admin
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Activation logs
    db.run(`CREATE TABLE IF NOT EXISTS activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coupon_code TEXT NOT NULL,
        account_id TEXT NOT NULL,
        likes_sent INTEGER DEFAULT 0,
        activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT
    )`);

    // Create default admin user
    const defaultUsername = 'admin';
    const defaultPassword = 'admin123';
    
    bcrypt.hash(defaultPassword, 10, (err, hash) => {
        if (err) throw err;
        
        db.get('SELECT * FROM users WHERE username = ?', [defaultUsername], (err, row) => {
            if (!row) {
                db.run('INSERT INTO users (username, password) VALUES (?, ?)', 
                    [defaultUsername, hash], (err) => {
                        if (err) console.error(err);
                        else console.log('Default admin user created');
                    });
            }
        });
    });
});

// Authentication middleware
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, 'your-jwt-secret-change-this');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Login route
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (err || !result) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role },
                'your-jwt-secret-change-this',
                { expiresIn: '24h' }
            );

            res.json({ 
                success: true, 
                token, 
                user: { 
                    id: user.id, 
                    username: user.username, 
                    role: user.role 
                } 
            });
        });
    });
});

// Generate coupon route
app.post('/api/generate-coupon', authenticate, (req, res) => {
    const { likes_count, duration_days, quantity = 1 } = req.body;
    
    if (!likes_count || !duration_days) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const coupons = [];
    
    for (let i = 0; i < quantity; i++) {
        const code = generateCouponCode();
        const expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + parseInt(duration_days));
        
        coupons.push({
            code,
            likes_count: parseInt(likes_count),
            duration_days: parseInt(duration_days),
            expires_at: expires_at.toISOString(),
            created_by: req.user.username
        });
    }

    // Insert coupons into database
    const stmt = db.prepare(`
        INSERT INTO coupons (code, likes_count, duration_days, expires_at, created_by) 
        VALUES (?, ?, ?, ?, ?)
    `);

    coupons.forEach(coupon => {
        stmt.run([
            coupon.code,
            coupon.likes_count,
            coupon.duration_days,
            coupon.expires_at,
            coupon.created_by
        ]);
    });

    stmt.finalize();

    res.json({ 
        success: true, 
        message: `${quantity} coupon(s) generated successfully`,
        coupons 
    });
});

function generateCouponCode() {
    const prefix = 'LIKES';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = prefix + '-';
    
    for (let i = 0; i < 12; i++) {
        if (i > 0 && i % 4 === 0) code += '-';
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return code;
}

// Check coupon route (for main interface)
app.get('/api/check-coupon', (req, res) => {
    const { code } = req.query;

    db.get(`
        SELECT *, 
        (likes_count - used_likes) as remaining_likes,
        CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END as is_valid
        FROM coupons 
        WHERE code = ? AND is_active = 1
    `, [code], (err, row) => {
        if (err || !row) {
            return res.json({ 
                valid: false, 
                message: 'Invalid or expired coupon code' 
            });
        }

        if (row.is_valid === 0) {
            return res.json({ 
                valid: false, 
                message: 'Coupon has expired' 
            });
        }

        if (row.remaining_likes <= 0) {
            return res.json({ 
                valid: false, 
                message: 'No likes remaining on this coupon' 
            });
        }

        res.json({
            valid: true,
            likes: row.remaining_likes,
            duration_days: row.duration_days,
            expires_at: row.expires_at
        });
    });
});

// Get all coupons (for admin)
app.get('/api/coupons', authenticate, (req, res) => {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT *, 
        (likes_count - used_likes) as remaining_likes,
        CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END as is_valid
        FROM coupons WHERE 1=1`;
    
    let params = [];

    if (search) {
        query += ' AND code LIKE ?';
        params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        db.get('SELECT COUNT(*) as total FROM coupons', [], (err, countResult) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                success: true,
                coupons: rows,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult.total,
                    totalPages: Math.ceil(countResult.total / limit)
                }
            });
        });
    });
});

// Get statistics
app.get('/api/statistics', authenticate, (req, res) => {
    const queries = [
        'SELECT COUNT(*) as total_coupons FROM coupons',
        'SELECT SUM(likes_count) as total_likes FROM coupons',
        'SELECT SUM(used_likes) as used_likes FROM coupons',
        'SELECT COUNT(*) as active_coupons FROM coupons WHERE is_active = 1 AND expires_at > datetime("now")',
        'SELECT COUNT(*) as expired_coupons FROM coupons WHERE expires_at <= datetime("now")'
    ];

    const results = {};
    let completed = 0;

    queries.forEach((query, index) => {
        db.get(query, [], (err, row) => {
            if (!err && row) {
                const key = query.split(' ')[3] || `stat_${index}`;
                results[key] = Object.values(row)[0] || 0;
            }
            
            completed++;
            
            if (completed === queries.length) {
                res.json({ success: true, statistics: results });
            }
        });
    });
});

// Update main interface endpoint
app.post('/api/send-likes', (req, res) => {
    const { id, coupon, region } = req.body;
    
    // First check coupon
    db.get(`
        SELECT *, 
        (likes_count - used_likes) as remaining_likes
        FROM coupons 
        WHERE code = ? AND is_active = 1 AND expires_at > datetime('now')
    `, [coupon], (err, couponRow) => {
        if (err || !couponRow) {
            return res.json({ 
                success: false, 
                message: 'Invalid or expired coupon code' 
            });
        }

        if (couponRow.remaining_likes <= 0) {
            return res.json({ 
                success: false, 
                message: 'No likes remaining on this coupon' 
            });
        }

        // Simulate sending likes (replace with actual API call)
        const likesToSend = Math.min(1000, couponRow.remaining_likes);
        
        // Update coupon usage
        db.run(`
            UPDATE coupons 
            SET used_likes = used_likes + ? 
            WHERE code = ?
        `, [likesToSend, coupon], (err) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to update coupon' 
                });
            }

            // Log activation
            db.run(`
                INSERT INTO activations (coupon_code, account_id, likes_sent, ip_address, user_agent)
                VALUES (?, ?, ?, ?, ?)
            `, [coupon, id, likesToSend, req.ip, req.headers['user-agent']]);

            res.json({
                success: true,
                message: `Successfully sent ${likesToSend} likes to account ${id}`,
                coupon_balance: couponRow.remaining_likes - likesToSend,
                sent_likes: likesToSend
            });
        });
    });
});

// Serve HTML files
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/generate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'generate.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Main interface: http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Coupon generator: http://localhost:${PORT}/generate`);
});
