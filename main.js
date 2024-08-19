const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT);

let keepAliveId;

wss.on("connection", function (ws) {
    ws.on("message", data => {
        broadcastBinary(ws, data);
    });

    ws.on("close", () => {
        ws.removeAllListeners();
    });

    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }
});

wss.on("close", () => {
    clearInterval(keepAliveId);
    keepAliveId = null;
});

function broadcastBinary(senderWs, data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== senderWs) {
            client.send(data);
        }
    });
}

function keepServerAlive() {
    keepAliveId = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping();
            }
        });
    }, 30000);
}
