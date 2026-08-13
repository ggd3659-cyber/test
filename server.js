const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");

/* =========================================================
   DIRECTORIES
========================================================= */

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, {
        recursive: true
    });
}

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, {
        recursive: true
    });
}

/* =========================================================
   POSTGRESQL
========================================================= */

const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ||
        "postgresql://postgres:postgres@localhost:5432/bluetalk"
});

pool.on("error", (error) => {
    console.error("PostgreSQL Pool Error:", error);
});

/* =========================================================
   HELPERS
========================================================= */

function now() {
    return Date.now();
}

function normalizeTag(tag) {
    return String(tag || "")
        .trim()
        .toLowerCase();
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name TEXT NOT NULL,
            tag TEXT NOT NULL,
            normalized_tag TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            banned INTEGER NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS topics (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id INTEGER NOT NULL,
            topic_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            image_path TEXT,
            video_path TEXT,
            visitors INTEGER NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY(topic_id)
                REFERENCES topics(id)
        );

        CREATE TABLE IF NOT EXISTS post_likes (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at BIGINT NOT NULL,

            PRIMARY KEY(post_id, user_id),

            FOREIGN KEY(post_id)
                REFERENCES posts(id)
                ON DELETE CASCADE,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS post_visits (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at BIGINT NOT NULL,

            PRIMARY KEY(post_id, user_id),

            FOREIGN KEY(post_id)
                REFERENCES posts(id)
                ON DELETE CASCADE,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS follows (
            follower_id INTEGER NOT NULL,
            following_id INTEGER NOT NULL,
            created_at BIGINT NOT NULL,

            PRIMARY KEY(follower_id, following_id),

            FOREIGN KEY(follower_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            FOREIGN KEY(following_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL,

            FOREIGN KEY(post_id)
                REFERENCES posts(id)
                ON DELETE CASCADE,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS comment_likes (
            comment_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at BIGINT NOT NULL,

            PRIMARY KEY(comment_id, user_id),

            FOREIGN KEY(comment_id)
                REFERENCES comments(id)
                ON DELETE CASCADE,

            FOREIGN KEY(user_id)
                REFERENCES users(id)
                ON DELETE CASCADE
        );
    `);

    /* =====================================================
       DEFAULT SITE SETTINGS
    ===================================================== */

    const settingResult = await pool.query(`
        SELECT 1
        FROM settings
        WHERE key = $1
    `, ["site_name"]);

    if (settingResult.rowCount === 0) {

        await pool.query(`
            INSERT INTO settings(key, value)
            VALUES($1, $2)
        `, [
            "site_name",
            "BlueTalk"
        ]);
    }

    /* =====================================================
       DEFAULT TOPICS
    ===================================================== */

    const topicResult = await pool.query(`
        SELECT COUNT(*)::integer AS count
        FROM topics
    `);

    if (Number(topicResult.rows[0].count) === 0) {

        const insertTopic = `
            INSERT INTO topics(name, active, created_at)
            VALUES($1, $2, $3)
        `;

        await pool.query(insertTopic, [
            "자유 대화",
            1,
            now()
        ]);

        await pool.query(insertTopic, [
            "질문",
            1,
            now()
        ]);

        await pool.query(insertTopic, [
            "일상",
            1,
            now()
        ]);
    }

    /* =====================================================
       DEFAULT ADMIN
    ===================================================== */

    const adminResult = await pool.query(`
        SELECT id
        FROM users
        WHERE normalized_tag = $1
    `, ["@admin"]);

    if (adminResult.rowCount === 0) {

        const passwordHash =
            await bcrypt.hash(
                "admin123",
                12
            );

        await pool.query(`
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
            VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [
            "관리자",
            "@admin",
            "@admin",
            passwordHash,
            "manager",
            0,
            now()
        ]);

        console.log("");
        console.log("================================");
        console.log(" 기본 관리자 계정 생성");
        console.log("================================");
        console.log("Tag      : @admin");
        console.log("Password : admin123");
        console.log("================================");
        console.log("");
    }

    console.log("PostgreSQL database initialized.");
}

/* =========================================================
   MIDDLEWARE
========================================================= */

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

/* =========================================================
   FILE UPLOAD
========================================================= */

const storage = multer.diskStorage({

    destination(req, file, cb) {

        cb(
            null,
            UPLOAD_DIR
        );
    },

    filename(req, file, cb) {

        const ext =
            path.extname(
                file.originalname
            ).toLowerCase();

        const safeName =
            Date.now() +
            "-" +
            Math.random()
                .toString(36)
                .slice(2, 10) +
            ext;

        cb(
            null,
            safeName
        );
    }
});

const upload = multer({

    storage,

    limits: {
        fileSize:
            100 * 1024 * 1024
    },

    fileFilter(
        req,
        file,
        cb
    ) {

        const allowedImage =
            /^image\//.test(
                file.mimetype
            );

        const allowedVideo =
            /^video\//.test(
                file.mimetype
            );

        if (
            allowedImage ||
            allowedVideo
        ) {

            cb(
                null,
                true
            );

        } else {

            cb(
                new Error(
                    "사진 또는 영상 파일만 업로드할 수 있습니다."
                )
            );
        }
    }
});

/* =========================================================
   AUTH HELPERS
========================================================= */

async function currentUser(req) {

    if (!req.session.userId) {
        return null;
    }

    const result =
        await pool.query(`
            SELECT
                id,
                name,
                tag,
                role,
                banned,
                created_at
            FROM users
            WHERE id = $1
        `, [
            req.session.userId
        ]);

    return result.rows[0] || null;
}

async function requireLogin(
    req,
    res,
    next
) {

    try {

        const user =
            await currentUser(req);

        if (!user) {

            return res.status(401).json({
                error:
                    "로그인이 필요합니다."
            });
        }

        if (user.banned) {

            req.session.destroy(
                () => {}
            );

            return res.status(403).json({
                error:
                    "추방된 회원입니다."
            });
        }

        req.user = user;

        next();

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                "사용자 정보를 확인할 수 없습니다."
        });
    }
}

function requireManager(
    req,
    res,
    next
) {

    if (!req.user) {

        return res.status(401).json({
            error:
                "로그인이 필요합니다."
        });
    }

    if (
        req.user.role !==
        "manager"
    ) {

        return res.status(403).json({
            error:
                "매니저만 사용할 수 있습니다."
        });
    }

    next();
}

/* =========================================================
   PUBLIC API
========================================================= */

app.get(
    "/api/bootstrap",
    async (req, res) => {

        try {

            const user =
                await currentUser(req);

            const settings = {};

            const settingsResult =
                await pool.query(`
                    SELECT
                        key,
                        value
                    FROM settings
                `);

            settingsResult.rows.forEach(
                row => {
                    settings[row.key] =
                        row.value;
                }
            );

            const topicsResult =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        active
                    FROM topics
                    ORDER BY id ASC
                `);

            res.json({
                settings,
                topics:
                    topicsResult.rows,
                user
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "초기 데이터를 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   REGISTER
========================================================= */

app.post(
    "/api/auth/register",
    async (req, res) => {

        try {

            const name =
                String(
                    req.body.name || ""
                ).trim();

            const tag =
                String(
                    req.body.tag || ""
                ).trim();

            const password =
                String(
                    req.body.password || ""
                );

            if (!name) {

                return res.status(400).json({
                    error:
                        "이름을 입력해주세요."
                });
            }

            if (
                !tag.startsWith("@")
            ) {

                return res.status(400).json({
                    error:
                        "태그 이름은 반드시 @로 시작해야 합니다."
                });
            }

            if (
                password.length < 6 ||
                password.length > 20
            ) {

                return res.status(400).json({
                    error:
                        "비밀번호는 6~20자여야 합니다."
                });
            }

            const normalized =
                normalizeTag(tag);

            const existsResult =
                await pool.query(`
                    SELECT id
                    FROM users
                    WHERE normalized_tag = $1
                `, [
                    normalized
                ]);

            if (
                existsResult.rowCount > 0
            ) {

                return res.status(409).json({
                    error:
                        "이미 사용 중인 태그 이름입니다."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                await pool.query(`
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
                    VALUES($1,$2,$3,$4,$5,$6,$7)
                    RETURNING id
                `, [
                    name,
                    tag,
                    normalized,
                    passwordHash,
                    "member",
                    0,
                    now()
                ]);

            req.session.userId =
                result.rows[0].id;

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "회원가입 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
    "/api/auth/login",
    async (req, res) => {

        try {

            const tag =
                String(
                    req.body.tag || ""
                ).trim();

            const password =
                String(
                    req.body.password || ""
                );

            const result =
                await pool.query(`
                    SELECT *
                    FROM users
                    WHERE normalized_tag = $1
                `, [
                    normalizeTag(tag)
                ]);

            const user =
                result.rows[0];

            if (!user) {

                return res.status(401).json({
                    error:
                        "태그 이름 또는 비밀번호가 올바르지 않습니다."
                });
            }

            if (user.banned) {

                return res.status(403).json({
                    error:
                        "추방된 회원입니다."
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

            req.session.userId =
                user.id;

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "로그인 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
    "/api/auth/logout",
    (req, res) => {

        req.session.destroy(
            () => {

                res.json({
                    success: true
                });

            }
        );
    }
);

/* =========================================================
   TOPICS
========================================================= */

app.get(
    "/api/topics",
    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        active
                    FROM topics
                    ORDER BY id ASC
                `);

            res.json(
                result.rows
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "주제를 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   POSTS
========================================================= */

app.get(
    "/api/posts",
    async (req, res) => {

        try {

            const sort =
                String(
                    req.query.sort ||
                    "latest"
                );

            const topic =
                String(
                    req.query.topic ||
                    "all"
                );

            let order =
                "p.created_at DESC";

            if (
                sort === "hearts"
            ) {

                order =
                    "heart_count DESC";
            }

            if (
                sort === "visitors"
            ) {

                order =
                    "p.visitors DESC";
            }

            let where = "";
            const params = [];

            if (
                topic !== "all"
            ) {

                const topicId =
                    Number(topic);

                if (
                    !Number.isInteger(
                        topicId
                    )
                ) {

                    return res.status(400).json({
                        error:
                            "잘못된 주제입니다."
                    });
                }

                where =
                    "WHERE p.topic_id = $1";

                params.push(
                    topicId
                );
            }

            const bannedCondition =
                where
                    ? "AND u.banned = 0"
                    : "WHERE u.banned = 0";

            const result =
                await pool.query(`
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

                    ${bannedCondition}

                    ORDER BY ${order}

                    LIMIT 100
                `, params);

            res.json(
                result.rows
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "게시물을 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   CREATE POST
========================================================= */

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
    async (req, res) => {

        try {

            const text =
                String(
                    req.body.text || ""
                ).trim();

            const topicId =
                Number(
                    req.body.topicId
                );

            if (!text) {

                return res.status(400).json({
                    error:
                        "게시물 내용을 입력해주세요."
                });
            }

            if (
                !Number.isInteger(
                    topicId
                )
            ) {

                return res.status(400).json({
                    error:
                        "올바른 주제를 선택해주세요."
                });
            }

            const topicResult =
                await pool.query(`
                    SELECT *
                    FROM topics
                    WHERE id = $1
                    AND active = 1
                `, [
                    topicId
                ]);

            if (
                topicResult.rowCount === 0
            ) {

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
                    ? "/uploads/" +
                      image.filename
                    : null;

            const videoPath =
                video
                    ? "/uploads/" +
                      video.filename
                    : null;

            const result =
                await pool.query(`
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
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                    RETURNING id
                `, [
                    req.user.id,
                    topicId,
                    text,
                    imagePath,
                    videoPath,
                    0,
                    now(),
                    now()
                ]);

            res.json({
                success: true,
                id:
                    result.rows[0].id
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

/* =========================================================
   EDIT POST
========================================================= */

app.patch(
    "/api/posts/:id",
    requireLogin,
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );

            const postResult =
                await pool.query(`
                    SELECT *
                    FROM posts
                    WHERE id = $1
                `, [
                    id
                ]);

            const post =
                postResult.rows[0];

            if (!post) {

                return res.status(404).json({
                    error:
                        "게시물을 찾을 수 없습니다."
                });
            }

            if (
                post.user_id !==
                    req.user.id &&
                req.user.role !==
                    "manager"
            ) {

                return res.status(403).json({
                    error:
                        "수정 권한이 없습니다."
                });
            }

            const text =
                String(
                    req.body.text || ""
                ).trim();

            if (!text) {

                return res.status(400).json({
                    error:
                        "내용을 입력해주세요."
                });
            }

            await pool.query(`
                UPDATE posts
                SET
                    text = $1,
                    updated_at = $2
                WHERE id = $3
            `, [
                text,
                now(),
                id
            ]);

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "게시물 수정 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   DELETE POST
========================================================= */

app.delete(
    "/api/posts/:id",
    requireLogin,
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );

            const result =
                await pool.query(`
                    SELECT *
                    FROM posts
                    WHERE id = $1
                `, [
                    id
                ]);

            const post =
                result.rows[0];

            if (!post) {

                return res.status(404).json({
                    error:
                        "게시물을 찾을 수 없습니다."
                });
            }

            if (
                post.user_id !==
                    req.user.id &&
                req.user.role !==
                    "manager"
            ) {

                return res.status(403).json({
                    error:
                        "삭제 권한이 없습니다."
                });
            }

            await pool.query(`
                DELETE FROM posts
                WHERE id = $1
            `, [
                id
            ]);

            /* 업로드 파일도 삭제 */

            if (post.image_path) {

                const imageFile =
                    path.join(
                        ROOT,
                        post.image_path
                            .replace(
                                "/uploads/",
                                "uploads/"
                            )
                    );

                if (
                    fs.existsSync(
                        imageFile
                    )
                ) {

                    fs.unlinkSync(
                        imageFile
                    );
                }
            }

            if (post.video_path) {

                const videoFile =
                    path.join(
                        ROOT,
                        post.video_path
                            .replace(
                                "/uploads/",
                                "uploads/"
                            )
                    );

                if (
                    fs.existsSync(
                        videoFile
                    )
                ) {

                    fs.unlinkSync(
                        videoFile
                    );
                }
            }

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "게시물 삭제 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   POST LIKE
========================================================= */

app.post(
    "/api/posts/:id/like",
    requireLogin,
    async (req, res) => {

        try {

            const postId =
                Number(
                    req.params.id
                );

            const postResult =
                await pool.query(`
                    SELECT id
                    FROM posts
                    WHERE id = $1
                `, [
                    postId
                ]);

            if (
                postResult.rowCount === 0
            ) {

                return res.status(404).json({
                    error:
                        "게시물을 찾을 수 없습니다."
                });
            }

            const existingResult =
                await pool.query(`
                    SELECT *
                    FROM post_likes
                    WHERE post_id = $1
                    AND user_id = $2
                `, [
                    postId,
                    req.user.id
                ]);

            if (
                existingResult.rowCount > 0
            ) {

                await pool.query(`
                    DELETE FROM post_likes
                    WHERE post_id = $1
                    AND user_id = $2
                `, [
                    postId,
                    req.user.id
                ]);

            } else {

                await pool.query(`
                    INSERT INTO post_likes
                    (
                        post_id,
                        user_id,
                        created_at
                    )
                    VALUES($1,$2,$3)
                `, [
                    postId,
                    req.user.id,
                    now()
                ]);
            }

            const countResult =
                await pool.query(`
                    SELECT COUNT(*) AS count
                    FROM post_likes
                    WHERE post_id = $1
                `, [
                    postId
                ]);

            res.json({
                success: true,
                heart_count:
                    Number(
                        countResult.rows[0]
                            .count
                    )
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "좋아요 처리 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   POST VISIT
========================================================= */

app.post(
    "/api/posts/:id/visit",
    requireLogin,
    async (req, res) => {

        try {

            const postId =
                Number(
                    req.params.id
                );

            const postResult =
                await pool.query(`
                    SELECT id
                    FROM posts
                    WHERE id = $1
                `, [
                    postId
                ]);

            if (
                postResult.rowCount === 0
            ) {

                return res.status(404).json({
                    error:
                        "게시물을 찾을 수 없습니다."
                });
            }

            const existingResult =
                await pool.query(`
                    SELECT *
                    FROM post_visits
                    WHERE post_id = $1
                    AND user_id = $2
                `, [
                    postId,
                    req.user.id
                ]);

            if (
                existingResult.rowCount === 0
            ) {

                await pool.query(`
                    INSERT INTO post_visits
                    (
                        post_id,
                        user_id,
                        created_at
                    )
                    VALUES($1,$2,$3)
                `, [
                    postId,
                    req.user.id,
                    now()
                ]);

                await pool.query(`
                    UPDATE posts
                    SET visitors = visitors + 1
                    WHERE id = $1
                `, [
                    postId
                ]);
            }

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "조회수 처리 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   FOLLOW
========================================================= */

app.post(
    "/api/users/:id/follow",
    requireLogin,
    async (req, res) => {

        try {

            const targetId =
                Number(
                    req.params.id
                );

            if (
                targetId ===
                req.user.id
            ) {

                return res.status(400).json({
                    error:
                        "자기 자신은 팔로우할 수 없습니다."
                });
            }

            const targetResult =
                await pool.query(`
                    SELECT id
                    FROM users
                    WHERE id = $1
                    AND banned = 0
                `, [
                    targetId
                ]);

            if (
                targetResult.rowCount === 0
            ) {

                return res.status(404).json({
                    error:
                        "사용자를 찾을 수 없습니다."
                });
            }

            const existingResult =
                await pool.query(`
                    SELECT *
                    FROM follows
                    WHERE follower_id = $1
                    AND following_id = $2
                `, [
                    req.user.id,
                    targetId
                ]);

            if (
                existingResult.rowCount > 0
            ) {

                await pool.query(`
                    DELETE FROM follows
                    WHERE follower_id = $1
                    AND following_id = $2
                `, [
                    req.user.id,
                    targetId
                ]);

            } else {

                await pool.query(`
                    INSERT INTO follows
                    (
                        follower_id,
                        following_id,
                        created_at
                    )
                    VALUES($1,$2,$3)
                `, [
                    req.user.id,
                    targetId,
                    now()
                ]);
            }

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "팔로우 처리 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   COMMENTS
========================================================= */

app.get(
    "/api/posts/:id/comments",
    async (req, res) => {

        try {

            const postId =
                Number(
                    req.params.id
                );

            const result =
                await pool.query(`
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
                            WHERE cl.comment_id =
                                c.id
                        ) AS heart_count

                    FROM comments c

                    JOIN users u
                        ON u.id = c.user_id

                    WHERE c.post_id = $1
                    AND u.banned = 0

                    ORDER BY
                        c.pinned DESC,
                        c.created_at ASC
                `, [
                    postId
                ]);

            res.json(
                result.rows
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "댓글을 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   CREATE COMMENT
========================================================= */

app.post(
    "/api/posts/:id/comments",
    requireLogin,
    async (req, res) => {

        try {

            const postId =
                Number(
                    req.params.id
                );

            const text =
                String(
                    req.body.text || ""
                ).trim();

            if (!text) {

                return res.status(400).json({
                    error:
                        "댓글을 입력해주세요."
                });
            }

            const postResult =
                await pool.query(`
                    SELECT id
                    FROM posts
                    WHERE id = $1
                `, [
                    postId
                ]);

            if (
                postResult.rowCount === 0
            ) {

                return res.status(404).json({
                    error:
                        "게시물을 찾을 수 없습니다."
                });
            }

            await pool.query(`
                INSERT INTO comments
                (
                    post_id,
                    user_id,
                    text,
                    pinned,
                    created_at
                )
                VALUES($1,$2,$3,$4,$5)
            `, [
                postId,
                req.user.id,
                text,
                0,
                now()
            ]);

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "댓글 작성 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   COMMENT LIKE
========================================================= */

app.post(
    "/api/comments/:id/like",
    requireLogin,
    async (req, res) => {

        try {

            const commentId =
                Number(
                    req.params.id
                );

            const commentResult =
                await pool.query(`
                    SELECT id
                    FROM comments
                    WHERE id = $1
                `, [
                    commentId
                ]);

            if (
                commentResult.rowCount === 0
            ) {

                return res.status(404).json({
                    error:
                        "댓글을 찾을 수 없습니다."
                });
            }

            const existingResult =
                await pool.query(`
                    SELECT *
                    FROM comment_likes
                    WHERE comment_id = $1
                    AND user_id = $2
                `, [
                    commentId,
                    req.user.id
                ]);

            if (
                existingResult.rowCount > 0
            ) {

                await pool.query(`
                    DELETE FROM comment_likes
                    WHERE comment_id = $1
                    AND user_id = $2
                `, [
                    commentId,
                    req.user.id
                ]);

            } else {

                await pool.query(`
                    INSERT INTO comment_likes
                    (
                        comment_id,
                        user_id,
                        created_at
                    )
                    VALUES($1,$2,$3)
                `, [
                    commentId,
                    req.user.id,
                    now()
                ]);
            }

            const countResult =
                await pool.query(`
                    SELECT COUNT(*) AS count
                    FROM comment_likes
                    WHERE comment_id = $1
                `, [
                    commentId
                ]);

            res.json({
                success: true,
                heart_count:
                    Number(
                        countResult.rows[0]
                            .count
                    )
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "댓글 좋아요 처리 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   PIN COMMENT
========================================================= */

app.post(
    "/api/comments/:id/pin",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const commentId =
                Number(
                    req.params.id
                );

            const result =
                await pool.query(`
                    SELECT *
                    FROM comments
                    WHERE id = $1
                `, [
                    commentId
                ]);

            const comment =
                result.rows[0];

            if (!comment) {

                return res.status(404).json({
                    error:
                        "댓글을 찾을 수 없습니다."
                });
            }

            const newValue =
                comment.pinned
                    ? 0
                    : 1;

            if (
                newValue === 1
            ) {

                await pool.query(`
                    UPDATE comments
                    SET pinned = 0
                    WHERE post_id = $1
                `, [
                    comment.post_id
                ]);
            }

            await pool.query(`
                UPDATE comments
                SET pinned = $1
                WHERE id = $2
            `, [
                newValue,
                commentId
            ]);

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "댓글 고정 처리 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   SEARCH USER
========================================================= */

app.get(
    "/api/users/search",
    async (req, res) => {

        try {

            const tag =
                String(
                    req.query.tag || ""
                ).trim();

            if (
                !tag.startsWith("@")
            ) {

                return res.json([]);
            }

            const result =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        tag,
                        role
                    FROM users
                    WHERE normalized_tag = $1
                    AND banned = 0
                `, [
                    normalizeTag(tag)
                ]);

            res.json(
                result.rows
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "사용자 검색 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   PROFILE
========================================================= */

app.get(
    "/api/users/:id/profile",
    async (req, res) => {

        try {

            const userId =
                Number(
                    req.params.id
                );

            const userResult =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        tag,
                        role,
                        created_at
                    FROM users
                    WHERE id = $1
                    AND banned = 0
                `, [
                    userId
                ]);

            const user =
                userResult.rows[0];

            if (!user) {

                return res.status(404).json({
                    error:
                        "사용자를 찾을 수 없습니다."
                });
            }

            const followersResult =
                await pool.query(`
                    SELECT COUNT(*) AS count
                    FROM follows
                    WHERE following_id = $1
                `, [
                    userId
                ]);

            const heartsResult =
                await pool.query(`
                    SELECT COUNT(*) AS count
                    FROM post_likes pl

                    JOIN posts p
                        ON p.id = pl.post_id

                    WHERE p.user_id = $1
                `, [
                    userId
                ]);

            const visitorsResult =
                await pool.query(`
                    SELECT
                        COALESCE(
                            SUM(visitors),
                            0
                        ) AS count
                    FROM posts
                    WHERE user_id = $1
                `, [
                    userId
                ]);

            res.json({
                ...user,

                followers:
                    Number(
                        followersResult.rows[0]
                            .count
                    ),

                hearts:
                    Number(
                        heartsResult.rows[0]
                            .count
                    ),

                visitors:
                    Number(
                        visitorsResult.rows[0]
                            .count
                    )
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "프로필을 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   MANAGER: SITE NAME
========================================================= */

app.patch(
    "/api/manager/settings/site-name",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const name =
                String(
                    req.body.name || ""
                ).trim();

            if (!name) {

                return res.status(400).json({
                    error:
                        "사이트 이름을 입력해주세요."
                });
            }

            await pool.query(`
                INSERT INTO settings
                (
                    key,
                    value
                )
                VALUES($1,$2)

                ON CONFLICT(key)
                DO UPDATE SET
                    value = EXCLUDED.value
            `, [
                "site_name",
                name
            ]);

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "사이트 이름 변경 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   MANAGER: CREATE TOPIC
========================================================= */

app.post(
    "/api/manager/topics",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const name =
                String(
                    req.body.name || ""
                ).trim();

            if (!name) {

                return res.status(400).json({
                    error:
                        "주제 이름을 입력해주세요."
                });
            }

            await pool.query(`
                INSERT INTO topics
                (
                    name,
                    active,
                    created_at
                )
                VALUES($1,$2,$3)
            `, [
                name,
                1,
                now()
            ]);

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "주제 생성 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   MANAGER: UPDATE TOPIC
========================================================= */

app.patch(
    "/api/manager/topics/:id",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );

            const topicResult =
                await pool.query(`
                    SELECT *
                    FROM topics
                    WHERE id = $1
                `, [
                    id
                ]);

            const topic =
                topicResult.rows[0];

            if (!topic) {

                return res.status(404).json({
                    error:
                        "주제를 찾을 수 없습니다."
                });
            }

            if (
                typeof req.body.name ===
                "string"
            ) {

                const name =
                    req.body.name.trim();

                if (!name) {

                    return res.status(400).json({
                        error:
                            "주제 이름을 입력해주세요."
                    });
                }

                await pool.query(`
                    UPDATE topics
                    SET name = $1
                    WHERE id = $2
                `, [
                    name,
                    id
                ]);
            }

            if (
                typeof req.body.active !==
                "undefined"
            ) {

                await pool.query(`
                    UPDATE topics
                    SET active = $1
                    WHERE id = $2
                `, [
                    req.body.active
                        ? 1
                        : 0,
                    id
                ]);
            }

            res.json({
                success: true
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "주제 수정 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   MANAGER: USERS
========================================================= */

app.get(
    "/api/manager/users",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        tag,
                        role,
                        banned,
                        created_at
                    FROM users
                    ORDER BY created_at DESC
                `);

            res.json(
                result.rows
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "회원 목록을 불러올 수 없습니다."
            });
        }
    }
);

/* =========================================================
   MANAGER: BAN / UNBAN USER
========================================================= */

app.patch(
    "/api/manager/users/:id/ban",
    requireLogin,
    requireManager,
    async (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );

            if (
                id ===
                req.user.id
            ) {

                return res.status(400).json({
                    error:
                        "자기 자신을 추방할 수 없습니다."
                });
            }

            const result =
                await pool.query(`
                    SELECT *
                    FROM users
                    WHERE id = $1
                `, [
                    id
                ]);

            const user =
                result.rows[0];

            if (!user) {

                return res.status(404).json({
                    error:
                        "회원을 찾을 수 없습니다."
                });
            }

            const newBanned =
                user.banned
                    ? 0
                    : 1;

            await pool.query(`
                UPDATE users
                SET banned = $1
                WHERE id = $2
            `, [
                newBanned,
                id
            ]);

            res.json({
                success: true,
                banned:
                    newBanned
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "회원 상태 변경 중 오류가 발생했습니다."
            });
        }
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(error);

        if (
            error instanceof
            multer.MulterError
        ) {

            return res.status(400).json({
                error:
                    "파일 업로드 중 오류가 발생했습니다: " +
                    error.message
            });
        }

        res.status(400).json({
            error:
                error.message ||
                "요청을 처리할 수 없습니다."
        });
    }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

    try {

        await initializeDatabase();

        app.listen(
            PORT,
            () => {

                console.log("");
                console.log(
                    "================================"
                );
                console.log(
                    " BlueTalk Server"
                );
                console.log(
                    "================================"
                );
                console.log(
                    `http://localhost:${PORT}`
                );
                console.log("");
                console.log(
                    "PostgreSQL: Connected"
                );
                console.log("");
                console.log(
                    "Manager account"
                );
                console.log(
                    "Tag: @admin"
                );
                console.log(
                    "Password: admin123"
                );
                console.log(
                    "================================"
                );
                console.log("");
            }
        );

    } catch (error) {

        console.error("");
        console.error(
            "================================"
        );
        console.error(
            " PostgreSQL 연결 실패"
        );
        console.error(
            "================================"
        );
        console.error(error);
        console.error("");
        console.error(
            "PostgreSQL이 실행 중인지 확인하세요."
        );
        console.error(
            "DATABASE_URL 또는 PostgreSQL 접속 정보를 확인하세요."
        );
        console.error("");
        process.exit(1);
    }
}

startServer();
