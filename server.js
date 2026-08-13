const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

app.get("/api/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW() AS now");

        res.json({
            success: true,
            message: "PostgreSQL connected!",
            time: result.rows[0].now
        });

    } catch (error) {
        console.error("DATABASE ERROR:", error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get("/", (req, res) => {
    res.send("BlueTalk Server is running!");
});

app.listen(PORT, () => {
    console.log("================================");
    console.log(" BlueTalk Server");
    console.log("================================");
    console.log(`Port: ${PORT}`);
    console.log("================================");
});
