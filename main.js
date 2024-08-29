const WebSocket = require('ws');
const { createServer } = require('http');

const PORT = process.env.PORT || 3000;
const server = createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    const message = JSON.parse(data);
    handleMessage(ws, message);
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleMessage(ws, message) {
  switch(message.type) {
    case 'join':
      handleJoin(ws, message.roomId);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      broadcastToRoom(ws, message, ws.roomId);
      break;
    default:
      console.log('Unknown message type:', message.type);
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

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`WebSocket server is running on port ${PORT}`);
});
