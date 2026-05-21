const http = require("http");
const { Server } = require("socket.io");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

const rooms = {};

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    return handle(req, res);
  });

  const io = new Server(server);

  io.on("connection", (socket) => {
    console.log("connected:", socket.id);

    socket.on("createRoom", () => {
      const code = makeRoomCode();
      rooms[code] = {
        code,
        players: [{ id: socket.id, name: "Player 1" }],
        gameState: null,
      };

      socket.join(code);
      io.to(code).emit("roomUpdate", rooms[code]);
    });

    socket.on("joinRoom", (code) => {
      code = String(code || "").toUpperCase();

      if (!rooms[code]) {
        socket.emit("errorMessage", "房间不存在");
        return;
      }

      if (rooms[code].players.length >= 2) {
        socket.emit("errorMessage", "房间已满");
        return;
      }

      rooms[code].players.push({ id: socket.id, name: "Player 2" });
      socket.join(code);
      io.to(code).emit("roomUpdate", rooms[code]);

      if (rooms[code].gameState) {
        socket.emit("gameSync", rooms[code].gameState);
      }
    });

    socket.on("gameSync", ({ roomCode, state }) => {
      const code = String(roomCode || "").toUpperCase();
      if (!rooms[code]) return;

      rooms[code].gameState = state;
      socket.to(code).emit("gameSync", state);
    });

    socket.on("disconnect", () => {
      for (const code of Object.keys(rooms)) {
        rooms[code].players = rooms[code].players.filter((p) => p.id !== socket.id);

        if (rooms[code].players.length === 0) {
          delete rooms[code];
        } else {
          io.to(code).emit("roomUpdate", rooms[code]);
        }
      }
    });
  });

  server.listen(3000, () => {
    console.log("Ready on http://localhost:3000");
  });
});