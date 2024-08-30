const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const FILE_TRANSFER_PREFIX = "FILE_TRANSFER:";

wss.on('connection', function connection(ws) {
  console.log('Client connected');

  ws.on('message', function incoming(message) {
    console.log('Received message');
    if (typeof message === 'string' && message.startsWith(FILE_TRANSFER_PREFIX)) {
      // File transfer metadata
      console.log('Received file metadata');
      const metadata = JSON.parse(message.slice(FILE_TRANSFER_PREFIX.length));
      console.log('File transfer started:', metadata.fileName);
      ws.fileMetadata = metadata;
      ws.fileBuffer = Buffer.alloc(0);
    } else if (ws.fileMetadata) {
      // File chunk
      ws.fileBuffer = Buffer.concat([ws.fileBuffer, message]);
      console.log(`Received chunk. Total received: ${ws.fileBuffer.length} / ${ws.fileMetadata.fileSize} bytes`);
      
      if (ws.fileBuffer.length >= ws.fileMetadata.fileSize) {
        console.log('File transfer completed:', ws.fileMetadata.fileName);
        // Here you could save the file or process it as needed
        delete ws.fileMetadata;
        delete ws.fileBuffer;
      }
    }
  });

  ws.on('close', function close() {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
