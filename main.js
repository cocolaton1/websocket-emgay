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
            case 'host-ready':
                handleHostReady(ws, message.roomId);
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
        rooms.set(roomId, { host: null, viewers: new Set() });
    }
    const room = rooms.get(roomId);
    if (!room.host) {
        room.host = ws;
        ws.isHost = true;
    } else {
        room.viewers.add(ws);
        ws.isHost = false;
    }
    ws.roomId = roomId;
    ws.send(JSON.stringify({ type: 'joined', roomId }));
    
    if (room.host && !ws.isHost) {
        room.host.send(JSON.stringify({ type: 'viewer-joined', viewerId: ws.userID }));
    }
}

function handleHostReady(ws, roomId) {
    const room = rooms.get(roomId);
    if (room && room.host === ws) {
        room.viewers.forEach(viewer => {
            viewer.send(JSON.stringify({ type: 'host-ready' }));
        });
    }
}

function handleOffer(ws, message) {
    const room = rooms.get(ws.roomId);
    if (room && room.host === ws) {
        const viewer = Array.from(room.viewers).find(v => v.userID === message.viewerId);
        if (viewer) {
            viewer.send(JSON.stringify(message));
        }
    }
}

function handleAnswer(ws, message) {
    const room = rooms.get(ws.roomId);
    if (room && !ws.isHost) {
        room.host.send(JSON.stringify(message));
    }
}

function handleIceCandidate(ws, message) {
    const room = rooms.get(ws.roomId);
    if (room) {
        if (ws.isHost) {
            const viewer = Array.from(room.viewers).find(v => v.userID === message.viewerId);
            if (viewer) {
                viewer.send(JSON.stringify(message));
            }
        } else {
            room.host.send(JSON.stringify(message));
        }
    }
}

function handleDisconnect(ws) {
    if (ws.roomId) {
        const room = rooms.get(ws.roomId);
        if (room) {
            if (ws.isHost) {
                room.viewers.forEach(viewer => {
                    viewer.send(JSON.stringify({ type: 'host-left' }));
                    viewer.close();
                });
                rooms.delete(ws.roomId);
            } else {
                room.viewers.delete(ws);
                if (room.host) {
                    room.host.send(JSON.stringify({ type: 'viewer-left', viewerId: ws.userID }));
                }
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
