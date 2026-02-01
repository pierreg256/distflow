const { NodeRuntime } = require('@distflow/core');

async function main() {
  // Start node with alias 'pong'
  const node = await NodeRuntime.start({
    alias: 'pong',
    //pmdPort: 4369
  });

  console.log('Pong node started');
  console.log(`Node ID: ${node.getNodeId()}`);
  console.log(`Alias: ${node.getAlias()}`);

  // Listen for messages
  node.onMessage((message, meta) => {
    console.log(`Received from ${meta.alias} ${meta.from}:`, message);

    if (message.type === 'PING') {
      // Reply with PONG
      console.log('Sending PONG...');
      node.send(meta.from, { type: 'PONG', timestamp: Date.now() })
        .catch(err => console.error('Failed to send PONG:', err));
    }
  });

  // Listen for peer events
  node.on('peer:join', (peer) => {
    console.log('Peer joined:', peer.alias || peer.nodeId);
  });

  node.on('peer:leave', (peer) => {
    console.log('Peer left:', peer.alias || peer.nodeId);
  });

  console.log('Waiting for PING messages...');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  process.exit(0);
});
