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

const rooms = new Map();
let keepAliveId;

wss.on("connection", function (ws) {
    const userID = generateUniqueID();  
    ws.userID = userID;

    ws.on("message", data => {
        handleMessage(ws, data);
    });

    ws.on("close", () => {
        handleDisconnect(ws);
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

function generateUniqueID() {
    return Math.random().toString(36).substr(2, 9);
}

function handleMessage(ws, data) {
    try {
        const message = JSON.parse(data);
        
        switch(message.type) {
            case 'join':
                handleJoin(ws, message.roomId);
                break;
            case 'offer':
                handleOffer(ws, message);
                break;
            case 'answer':
                handleAnswer(ws, message);
                break;
            case 'ice-candidate':
                handleIceCandidate(ws, message);
                break;
            case 'screenshot':
                handleScreenshot(ws, message);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    } catch (e) {
        console.error('Error handling message:', e);
    }
}

function handleJoin(ws, roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(ws);
    ws.roomId = roomId;
    ws.send(JSON.stringify({ type: 'joined', roomId }));
}

function handleOffer(ws, message) {
    broadcastToRoom(ws, message, ws.roomId);
}

function handleAnswer(ws, message) {
    broadcastToRoom(ws, message, ws.roomId);
}

function handleIceCandidate(ws, message) {
    broadcastToRoom(ws, message, ws.roomId);
}

function handleScreenshot(ws, message) {
    broadcastToRoom(ws, message, ws.roomId);
}

function broadcastToRoom(sender, message, roomId) {
    const room = rooms.get(roomId);
    if (room) {
        room.forEach(client => {
            if (client !== sender && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

function handleDisconnect(ws) {
    if (ws.roomId) {
        const room = rooms.get(ws.roomId);
        if (room) {
            room.delete(ws);
            if (room.size === 0) {
                rooms.delete(ws.roomId);
            }
        }
    }
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
