const WebSocket = require('ws');

async function testWebCastPipeline() {
  console.log('Testing WebCast End-to-End WebSocket Pipeline...');
  const sessionId = 'TEST99';

  // 1. Create Sender Client
  const senderWs = new WebSocket('ws://localhost:3000/ws');
  
  await new Promise((resolve) => {
    senderWs.on('open', () => {
      console.log('✔ Sender WebSocket opened');
      senderWs.send(JSON.stringify({
        type: 'join-sender',
        sessionId: sessionId,
        settings: { quality: '720p', fps: 30 }
      }));
    });

    senderWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Sender received msg:', msg.type);
      if (msg.type === 'sender-joined') {
        resolve();
      }
    });
  });

  // 2. Create Receiver Client
  const receiverWs = new WebSocket('ws://localhost:3000/ws');
  let framesReceivedCount = 0;

  await new Promise((resolve) => {
    receiverWs.on('open', () => {
      console.log('✔ Receiver WebSocket opened');
      receiverWs.send(JSON.stringify({
        type: 'join-receiver',
        sessionId: sessionId,
        isLegacy: true,
        clientType: 'safari-ios-9'
      }));
    });

    receiverWs.on('message', (data, isBinary) => {
      if (isBinary) {
        framesReceivedCount++;
        if (framesReceivedCount >= 5) {
          console.log(`✔ Receiver received ${framesReceivedCount} binary frames successfully!`);
          resolve();
        }
      } else {
        const msg = JSON.parse(data.toString());
        console.log('Receiver received msg:', msg.type);
      }
    });

    // 3. Sender sends binary frames
    setTimeout(() => {
      for (let i = 0; i < 5; i++) {
        // Send frame-meta
        senderWs.send(JSON.stringify({
          type: 'frame-meta',
          width: 1280,
          height: 720,
          timestamp: Date.now(),
          quality: '720p'
        }));
        // Send dummy 10KB binary JPEG payload
        const dummyBuffer = Buffer.alloc(10240, 0xFF);
        senderWs.send(dummyBuffer);
      }
    }, 200);
  });

  senderWs.close();
  receiverWs.close();
  console.log('✔ All streaming pipeline tests passed successfully!');
}

testWebCastPipeline().catch(console.error);
