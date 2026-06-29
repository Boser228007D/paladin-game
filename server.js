import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static build (production)
app.use(express.static(path.join(__dirname, "dist")));
app.use((req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// Game state
const serverStartTime = Date.now();
const players = {};
const MAX_HP = 100;
const ATTACK_DAMAGE = 20;
const ATTACK_RANGE = 3.0;

function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

io.on("connection", (socket) => {
    console.log("[+] Player connected:", socket.id);
    players[socket.id] = { x: 0, y: 0, z: 0, rotY: 0, anim: "idle", hp: MAX_HP };

    socket.emit("init", { id: socket.id, players, serverStartTime });
    socket.broadcast.emit("playerJoined", { id: socket.id, state: players[socket.id] });
    io.emit("playerCount", Object.keys(players).length);

    socket.on("playerUpdate", (data) => {
        if (!players[socket.id]) return;
        Object.assign(players[socket.id], data);
        socket.broadcast.emit("playerMoved", { id: socket.id, state: players[socket.id] });
    });

    socket.on("playerAttack", () => {
        const attacker = players[socket.id];
        if (!attacker) return;
        socket.broadcast.emit("playerAttacked", { id: socket.id });
        for (const [id, p] of Object.entries(players)) {
            if (id === socket.id) continue;
            if (dist(attacker, p) <= ATTACK_RANGE) {
                if (p.anim !== "block") {
                    p.hp = Math.max(0, p.hp - ATTACK_DAMAGE);
                    io.to(id).emit("youWereHit", { hp: p.hp, by: socket.id });
                    socket.emit("hitConfirmed", { targetId: id, hp: p.hp });
                    if (p.hp <= 0) {
                        io.to(id).emit("youDied");
                        setTimeout(() => { p.hp = MAX_HP; io.to(id).emit("respawn", { hp: MAX_HP }); }, 2000);
                    }
                } else {
                    socket.emit("attackBlocked", { targetId: id });
                    io.to(id).emit("shieldBroken");
                }
            }
        }
    });

    socket.on("disconnect", () => {
        console.log("[-] Player disconnected:", socket.id);
        delete players[socket.id];
        io.emit("playerLeft", { id: socket.id });
        io.emit("playerCount", Object.keys(players).length);
    });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log("Game server running on port", PORT));
