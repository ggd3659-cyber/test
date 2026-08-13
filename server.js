const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

/* =========================
   DATABASE
========================= */

const db = new Database(
    path.join(ROOT, "bluetalk.db")
);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag TEXT NOT NULL,
    normalized_tag TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    image_path TEXT,
    video_path TEXT,
    visitors INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS post_likes (
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(post_id, user_id),
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS post_visits (
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(post_id, user_id),
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(follower_id, following_id),
    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_likes (
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(comment_id, user_id),
    FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

/* =========================
   INITIAL DATA
========================= */

function now() {
    return Date.now();
}

function normalizeTag(tag) {
    return tag.trim().toLowerCase();
}

const settingExists = db
    .prepare("SELECT 1 FROM settings WHERE key = ?")
    .get("site_name");

if (!settingExists) {
    db.prepare(`
        INSERT INTO settings(key,value)
        VALUES (?,?)
    `).run("site_name", "BlueTalk");
}

const topicCount = db
    .prepare("SELECT COUNT(*) AS count FROM topics")
    .get().count;

if (topicCount === 0) {
    const insertTopic = db.prepare(`
        INSERT INTO topics(name,active,created_at)
        VALUES(?,?,?)
    `);

    insertTopic.run("자유 대화", 1, now());
    insertTopic.run("질문", 1, now());
    insertTopic.run("일상", 1, now());
}

/*
   첫 실행 시 관리자 계정:

   태그: @admin
   비밀번호: admin123

   실제 서비스에서는 즉시 변경하는 것을 권장.
*/

const adminExists = db
    .prepare(`
        SELECT id
        FROM users
        WHERE normalized_tag = ?
    `)
    .get("@admin");

if (!adminExists) {

    const passwordHash =
        bcrypt.hashSync("admin123", 12);

    db.prepare(`
        INSERT INTO users
        (name,tag,normalized_tag,password_hash,role,banned,created_at)
        VALUES(?,?,?,?,?,?,?)
    `).run(
        "관리자",
        "@admin",
        "@admin",
        passwordHash,
        "manager",
        0,
        now()
    );
}

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json({
    limit: "2mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "2mb"
}));

app.use(
    session({
        secret:
            process.env.SESSION_SECRET ||
            "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);

app.use(
    "/uploads",
    express.static(UPLOAD_DIR)
);

app.use(
    express.static(PUBLIC_DIR)
);

/* =========================
   FILE UPLOAD
========================= */

const storage = multer.diskStorage({

    destination(req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename(req, file, cb) {

        const ext =
            path.extname(file.originalname)
                .toLowerCase();

        const safeName =
            Date.now() +
            "-" +
            Math.random()
                .toString(36)
                .slice(2, 10) +
            ext;

        cb(null, safeName);
    }

});

const upload = multer({

    storage,

    limits: {
        fileSize: 100 * 1024 * 1024
    },

    fileFilter(req, file, cb) {

        const allowedImage =
            /^image\//.test(file.mimetype);

        const allowedVideo =
            /^video\//.test(file.mimetype);

        if (
            allowedImage ||
            allowedVideo
        ) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    "사진 또는 영상 파일만 업로드할 수 있습니다."
                )
            );
        }
    }

});

/* =========================
   AUTH HELPERS
========================= */

function currentUser(req) {

    if (!req.session.userId) {
        return null;
    }

    return db.prepare(`
        SELECT
            id,
            name,
            tag,
            role,
            banned,
            created_at
        FROM users
        WHERE id = ?
    `).get(req.session.userId);
}

function requireLogin(req, res, next) {

    const user = currentUser(req);

    if (!user) {
        return res.status(401).json({
            error: "로그인이 필요합니다."
        });
    }

    if (user.banned) {

        req.session.destroy(() => {});

        return res.status(403).json({
            error: "추방된 회원입니다."
        });
    }

    req.user = user;

    next();
}

function requireManager(req, res, next) {

    if (!req.user) {
        return res.status(401).json({
            error: "로그인이 필요합니다."
        });
    }

    if (req.user.role !== "manager") {
        return res.status(403).json({
            error: "매니저만 사용할 수 있습니다."
        });
    }

    next();
}

/* =========================
   PUBLIC API
========================= */

app.get("/api/bootstrap", (req, res) => {

    const user = currentUser(req);

    const settings = {};

    db.prepare(`
        SELECT key,value
        FROM settings
    `).all().forEach(row => {
        settings[row.key] = row.value;
    });

    const topics = db.prepare(`
        SELECT id,name,active
        FROM topics
        ORDER BY id ASC
    `).all();

    res.json({
        settings,
        topics,
        user
    });
});

/* =========================
   REGISTER
========================= */

app.post("/api/auth/register", async (req, res) => {

    try {

        const name =
            String(req.body.name || "").trim();

        const tag =
            String(req.body.tag || "").trim();

        const password =
            String(req.body.password || "");

        if (!name) {
            return res.status(400).json({
                error: "이름을 입력해주세요."
            });
        }

        if (!tag.startsWith("@")) {
            return res.status(400).json({
                error:
                    "태그 이름은 반드시 @로 시작해야 합니다."
            });
        }

        if (password.length < 6 ||
            password.length > 20) {

            return res.status(400).json({
                error:
                    "비밀번호는 6~20자여야 합니다."
            });
        }

        const normalized =
            normalizeTag(tag);

        const exists =
            db.prepare(`
                SELECT id
                FROM users
                WHERE normalized_tag = ?
            `).get(normalized);

        if (exists) {
            return res.status(409).json({
                error:
                    "이미 사용 중인 태그 이름입니다."
            });
        }

        const passwordHash =
            await bcrypt.hash(password, 12);

        const result =
            db.prepare(`
                INSERT INTO users
                (
                    name,
                    tag,
                    normalized_tag,
                    password_hash,
                    role,
                    banned,
                    created_at
                )
                VALUES(?,?,?,?,?,?,?)
            `).run(
                name,
                tag,
                normalized,
                passwordHash,
                "member",
                0,
                now()
            );

        req.session.userId =
            Number(result.lastInsertRowid);

        res.json({
            success: true
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "회원가입 중 오류가 발생했습니다."
        });
    }
});

/* =========================
   LOGIN
========================= */

app.post("/api/auth/login", async (req, res) => {

    try {

        const tag =
            String(req.body.tag || "").trim();

        const password =
            String(req.body.password || "");

        const user =
            db.prepare(`
                SELECT *
                FROM users
                WHERE normalized_tag = ?
            `).get(
                normalizeTag(tag)
            );

        if (!user) {
            return res.status(401).json({
                error:
                    "태그 이름 또는 비밀번호가 올바르지 않습니다."
            });
        }

        if (user.banned) {
            return res.status(403).json({
                error: "추방된 회원입니다."
            });
        }

        const valid =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!valid) {
            return res.status(401).json({
                error:
                    "태그 이름 또는 비밀번호가 올바르지 않습니다."
            });
        }

        req.session.userId = user.id;

        res.json({
            success: true
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "로그인 중 오류가 발생했습니다."
        });
    }
});

/* =========================
   LOGOUT
========================= */

app.post("/api/auth/logout", (req, res) => {

    req.session.destroy(() => {

        res.json({
            success: true
        });

    });
});

/* =========================
   TOPICS
========================= */

app.get("/api/topics", (req, res) => {

    const topics =
        db.prepare(`
            SELECT id,name,active
            FROM topics
            ORDER BY id ASC
        `).all();

    res.json(topics);
});

/* =========================
   POSTS
========================= */

app.get("/api/posts", (req, res) => {

    const sort =
        req.query.sort || "latest";

    const topic =
        req.query.topic || "all";

    let order = "p.created_at DESC";

    if (sort === "hearts") {
        order = "heart_count DESC";
    }

    if (sort === "visitors") {
        order = "p.visitors DESC";
    }

    let where = "";
    const params = [];

    if (topic !== "all") {

        where = `
            WHERE p.topic_id = ?
        `;

        params.push(Number(topic));
    }

    const posts = db.prepare(`
        SELECT
            p.id,
            p.user_id,
            p.topic_id,
            p.text,
            p.image_path,
            p.video_path,
            p.visitors,
            p.created_at,
            p.updated_at,

            u.name AS author_name,
            u.tag AS author_tag,
            u.role AS author_role,

            t.name AS topic_name,

            (
                SELECT COUNT(*)
                FROM post_likes pl
                WHERE pl.post_id = p.id
            ) AS heart_count,

            (
                SELECT COUNT(*)
                FROM comments c
                WHERE c.post_id = p.id
            ) AS comment_count

        FROM posts p

        JOIN users u
            ON u.id = p.user_id

        JOIN topics t
            ON t.id = p.topic_id

        ${where}

        ${where ? "AND" : "WHERE"}
            u.banned = 0

        ORDER BY ${order}

        LIMIT 100

    `).all(...params);

    res.json(posts);
});

/* =========================
   CREATE POST
========================= */

app.post(
    "/api/posts",
    requireLogin,
    upload.fields([
        {
            name: "image",
            maxCount: 1
        },
        {
            name: "video",
            maxCount: 1
        }
    ]),
    (req, res) => {

        try {

            const text =
                String(req.body.text || "").trim();

            const topicId =
                Number(req.body.topicId);

            if (!text) {
                return res.status(400).json({
                    error:
                        "게시물 내용을 입력해주세요."
                });
            }

            const topic =
                db.prepare(`
                    SELECT *
                    FROM topics
                    WHERE id = ?
                    AND active = 1
                `).get(topicId);

            if (!topic) {
                return res.status(400).json({
                    error:
                        "사용할 수 없는 주제입니다."
                });
            }

            const image =
                req.files?.image?.[0];

            const video =
                req.files?.video?.[0];

            const imagePath =
                image
                    ? "/uploads/" + image.filename
                    : null;

            const videoPath =
                video
                    ? "/uploads/" + video.filename
                    : null;

            const result =
                db.prepare(`
                    INSERT INTO posts
                    (
                        user_id,
                        topic_id,
                        text,
                        image_path,
                        video_path,
                        visitors,
                        created_at,
                        updated_at
                    )
                    VALUES(?,?,?,?,?,?,?,?)
                `).run(
                    req.user.id,
                    topicId,
                    text,
                    imagePath,
                    videoPath,
                    0,
                    now(),
                    now()
                );

            res.json({
                success: true,
                id: Number(result.lastInsertRowid)
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "게시물 작성 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================
   EDIT POST
========================= */

app.patch(
    "/api/posts/:id",
    requireLogin,
    (req, res) => {

        const id =
            Number(req.params.id);

        const post =
            db.prepare(`
                SELECT *
                FROM posts
                WHERE id = ?
            `).get(id);

        if (!post) {
            return res.status(404).json({
                error: "게시물을 찾을 수 없습니다."
            });
        }

        if (
            post.user_id !== req.user.id &&
            req.user.role !== "manager"
        ) {
            return res.status(403).json({
                error: "수정 권한이 없습니다."
            });
        }

        const text =
            String(req.body.text || "").trim();

        if (!text) {
            return res.status(400).json({
                error: "내용을 입력해주세요."
            });
        }

        db.prepare(`
            UPDATE posts
            SET text = ?, updated_at = ?
            WHERE id = ?
        `).run(
            text,
            now(),
            id
        );

        res.json({
            success: true
        });
    }
);

/* =========================
   DELETE POST
========================= */

app.delete(
    "/api/posts/:id",
    requireLogin,
    (req, res) => {

        const id =
            Number(req.params.id);

        const post =
            db.prepare(`
                SELECT *
                FROM posts
                WHERE id = ?
            `).get(id);

        if (!post) {
            return res.status(404).json({
                error: "게시물을 찾을 수 없습니다."
            });
        }

        if (
            post.user_id !== req.user.id &&
            req.user.role !== "manager"
        ) {
            return res.status(403).json({
                error: "삭제 권한이 없습니다."
            });
        }

        db.prepare(`
            DELETE FROM posts
            WHERE id = ?
        `).run(id);

        res.json({
            success: true
        });
    }
);

/* =========================
   POST LIKE
========================= */

app.post(
    "/api/posts/:id/like",
    requireLogin,
    (req, res) => {

        const postId =
            Number(req.params.id);

        const existing =
            db.prepare(`
                SELECT *
                FROM post_likes
                WHERE post_id = ?
                AND user_id = ?
            `).get(
                postId,
                req.user.id
            );

        if (existing) {

            db.prepare(`
                DELETE FROM post_likes
                WHERE post_id = ?
                AND user_id = ?
            `).run(
                postId,
                req.user.id
            );

        } else {

            db.prepare(`
                INSERT INTO post_likes
                (post_id,user_id,created_at)
                VALUES(?,?,?)
            `).run(
                postId,
                req.user.id,
                now()
            );
        }

        res.json({
            success: true
        });
    }
);

/* =========================
   POST VISIT
========================= */

app.post(
    "/api/posts/:id/visit",
    requireLogin,
    (req, res) => {

        const postId =
            Number(req.params.id);

        const existing =
            db.prepare(`
                SELECT *
                FROM post_visits
                WHERE post_id = ?
                AND user_id = ?
            `).get(
                postId,
                req.user.id
            );

        if (!existing) {

            db.prepare(`
                INSERT INTO post_visits
                (post_id,user_id,created_at)
                VALUES(?,?,?)
            `).run(
                postId,
                req.user.id,
                now()
            );

            db.prepare(`
                UPDATE posts
                SET visitors = visitors + 1
                WHERE id = ?
            `).run(postId);
        }

        res.json({
            success: true
        });
    }
);

/* =========================
   FOLLOW
========================= */

app.post(
    "/api/users/:id/follow",
    requireLogin,
    (req, res) => {

        const targetId =
            Number(req.params.id);

        if (targetId === req.user.id) {
            return res.status(400).json({
                error:
                    "자기 자신은 팔로우할 수 없습니다."
            });
        }

        const target =
            db.prepare(`
                SELECT id
                FROM users
                WHERE id = ?
                AND banned = 0
            `).get(targetId);

        if (!target) {
            return res.status(404).json({
                error:
                    "사용자를 찾을 수 없습니다."
            });
        }

        const existing =
            db.prepare(`
                SELECT *
                FROM follows
                WHERE follower_id = ?
                AND following_id = ?
            `).get(
                req.user.id,
                targetId
            );

        if (existing) {

            db.prepare(`
                DELETE FROM follows
                WHERE follower_id = ?
                AND following_id = ?
            `).run(
                req.user.id,
                targetId
            );

        } else {

            db.prepare(`
                INSERT INTO follows
                (follower_id,following_id,created_at)
                VALUES(?,?,?)
            `).run(
                req.user.id,
                targetId,
                now()
            );
        }

        res.json({
            success: true
        });
    }
);

/* =========================
   COMMENTS
========================= */

app.get(
    "/api/posts/:id/comments",
    (req, res) => {

        const comments =
            db.prepare(`
                SELECT
                    c.id,
                    c.text,
                    c.pinned,
                    c.created_at,
                    u.id AS user_id,
                    u.name,
                    u.tag,
                    u.role,

                    (
                        SELECT COUNT(*)
                        FROM comment_likes cl
                        WHERE cl.comment_id = c.id
                    ) AS heart_count

                FROM comments c

                JOIN users u
                    ON u.id = c.user_id

                WHERE c.post_id = ?
                AND u.banned = 0

                ORDER BY
                    c.pinned DESC,
                    c.created_at ASC
            `).all(
                Number(req.params.id)
            );

        res.json(comments);
    }
);

app.post(
    "/api/posts/:id/comments",
    requireLogin,
    (req, res) => {

        const postId =
            Number(req.params.id);

        const text =
            String(req.body.text || "").trim();

        if (!text) {
            return res.status(400).json({
                error: "댓글을 입력해주세요."
            });
        }

        db.prepare(`
            INSERT INTO comments
            (post_id,user_id,text,pinned,created_at)
            VALUES(?,?,?,?,?)
        `).run(
            postId,
            req.user.id,
            text,
            0,
            now()
        );

        res.json({
            success: true
        });
    }
);

/* =========================
   COMMENT LIKE
========================= */

app.post(
    "/api/comments/:id/like",
    requireLogin,
    (req, res) => {

        const commentId =
            Number(req.params.id);

        const existing =
            db.prepare(`
                SELECT *
                FROM comment_likes
                WHERE comment_id = ?
                AND user_id = ?
            `).get(
                commentId,
                req.user.id
            );

        if (existing) {

            db.prepare(`
                DELETE FROM comment_likes
                WHERE comment_id = ?
                AND user_id = ?
            `).run(
                commentId,
                req.user.id
            );

        } else {

            db.prepare(`
                INSERT INTO comment_likes
                (comment_id,user_id,created_at)
                VALUES(?,?,?)
            `).run(
                commentId,
                req.user.id,
                now()
            );
        }

        res.json({
            success: true
        });
    }
);

/* =========================
   PIN COMMENT
========================= */

app.post(
    "/api/comments/:id/pin",
    requireLogin,
    requireManager,
    (req, res) => {

        const commentId =
            Number(req.params.id);

        const comment =
            db.prepare(`
                SELECT *
                FROM comments
                WHERE id = ?
            `).get(commentId);

        if (!comment) {
            return res.status(404).json({
                error: "댓글을 찾을 수 없습니다."
            });
        }

        const newValue =
            comment.pinned ? 0 : 1;

        if (newValue === 1) {

            db.prepare(`
                UPDATE comments
                SET pinned = 0
                WHERE post_id = ?
            `).run(comment.post_id);
        }

        db.prepare(`
            UPDATE comments
            SET pinned = ?
            WHERE id = ?
        `).run(
            newValue,
            commentId
        );

        res.json({
            success: true
        });
    }
);

/* =========================
   SEARCH USER
========================= */

app.get(
    "/api/users/search",
    (req, res) => {

        const tag =
            String(req.query.tag || "").trim();

        if (!tag.startsWith("@")) {
            return res.json([]);
        }

        const users =
            db.prepare(`
                SELECT
                    id,
                    name,
                    tag,
                    role
                FROM users
                WHERE normalized_tag = ?
                AND banned = 0
            `).all(
                normalizeTag(tag)
            );

        res.json(users);
    }
);

/* =========================
   PROFILE
========================= */

app.get(
    "/api/users/:id/profile",
    (req, res) => {

        const userId =
            Number(req.params.id);

        const user =
            db.prepare(`
                SELECT
                    id,
                    name,
                    tag,
                    role,
                    created_at
                FROM users
                WHERE id = ?
                AND banned = 0
            `).get(userId);

        if (!user) {
            return res.status(404).json({
                error:
                    "사용자를 찾을 수 없습니다."
            });
        }

        const followers =
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM follows
                WHERE following_id = ?
            `).get(userId).count;

        const hearts =
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM post_likes pl
                JOIN posts p
                    ON p.id = pl.post_id
                WHERE p.user_id = ?
            `).get(userId).count;

        const visitors =
            db.prepare(`
                SELECT COALESCE(SUM(visitors),0) AS count
                FROM posts
                WHERE user_id = ?
            `).get(userId).count;

        res.json({
            ...user,
            followers,
            hearts,
            visitors
        });
    }
);

/* =========================
   MANAGER: SITE NAME
========================= */

app.patch(
    "/api/manager/settings/site-name",
    requireLogin,
    requireManager,
    (req, res) => {

        const name =
            String(req.body.name || "").trim();

        if (!name) {
            return res.status(400).json({
                error:
                    "사이트 이름을 입력해주세요."
            });
        }

        db.prepare(`
            INSERT INTO settings(key,value)
            VALUES(?,?)
            ON CONFLICT(key)
            DO UPDATE SET value=excluded.value
        `).run(
            "site_name",
            name
        );

        res.json({
            success: true
        });
    }
);

/* =========================
   MANAGER: TOPICS
========================= */

app.post(
    "/api/manager/topics",
    requireLogin,
    requireManager,
    (req, res) => {

        const name =
            String(req.body.name || "").trim();

        if (!name) {
            return res.status(400).json({
                error:
                    "주제 이름을 입력해주세요."
            });
        }

        db.prepare(`
            INSERT INTO topics
            (name,active,created_at)
            VALUES(?,?,?)
        `).run(
            name,
            1,
            now()
        );

        res.json({
            success: true
        });
    }
);

app.patch(
    "/api/manager/topics/:id",
    requireLogin,
    requireManager,
    (req, res) => {

        const id =
            Number(req.params.id);

        const topic =
            db.prepare(`
                SELECT *
                FROM topics
                WHERE id = ?
            `).get(id);

        if (!topic) {
            return res.status(404).json({
                error:
                    "주제를 찾을 수 없습니다."
            });
        }

        if (
            typeof req.body.name === "string"
        ) {

            const name =
                req.body.name.trim();

            if (!name) {
                return res.status(400).json({
                    error:
                        "주제 이름을 입력해주세요."
                });
            }

            db.prepare(`
                UPDATE topics
                SET name = ?
                WHERE id = ?
            `).run(
                name,
                id
            );
        }

        if (
            typeof req.body.active !==
            "undefined"
        ) {

            db.prepare(`
                UPDATE topics
                SET active = ?
                WHERE id = ?
            `).run(
                req.body.active ? 1 : 0,
                id
            );
        }

        res.json({
            success: true
        });
    }
);

/* =========================
   MANAGER: USERS
========================= */

app.get(
    "/api/manager/users",
    requireLogin,
    requireManager,
    (req, res) => {

        const users =
            db.prepare(`
                SELECT
                    id,
                    name,
                    tag,
                    role,
                    banned,
                    created_at
                FROM users
                ORDER BY created_at DESC
            `).all();

        res.json(users);
    }
);

app.patch(
    "/api/manager/users/:id/ban",
    requireLogin,
    requireManager,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (id === req.user.id) {
            return res.status(400).json({
                error:
                    "자기 자신을 추방할 수 없습니다."
            });
        }

        const user =
            db.prepare(`
                SELECT *
                FROM users
                WHERE id = ?
            `).get(id);

        if (!user) {
            return res.status(404).json({
                error:
                    "회원을 찾을 수 없습니다."
            });
        }

        db.prepare(`
            UPDATE users
            SET banned = ?
            WHERE id = ?
        `).run(
            user.banned ? 0 : 1,
            id
        );

        res.json({
            success: true
        });
    }
);

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {

    console.error(error);

    res.status(400).json({
        error:
            error.message ||
            "요청을 처리할 수 없습니다."
    });
});

/* =========================
   START
========================= */

app.listen(PORT, () => {

    console.log("");
    console.log("================================");
    console.log(" BlueTalk Server");
    console.log("================================");
    console.log(
        `http://localhost:${PORT}`
    );
    console.log("");
    console.log("Manager account");
    console.log("Tag: @admin");
    console.log("Password: admin123");
    console.log("================================");
    console.log("");
});