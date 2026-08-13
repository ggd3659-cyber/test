app.get("/api/test-posts", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                user_id,
                text,
                image_path,
                video_path,
                created_at
            FROM posts
            ORDER BY id DESC
            LIMIT 20
        `);

        res.json({
            success: true,
            count: result.rows.length,
            posts: result.rows
        });

    } catch (error) {
        console.error("TEST POSTS ERROR:", error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
