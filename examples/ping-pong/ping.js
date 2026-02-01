const { NodeRuntime } = require('@distflow/core');

async function main() {
  // Start node with alias 'ping'
  const node = await NodeRuntime.start({
    alias: 'ping',
    //pmdPort: 4369
  });

  console.log('Ping node started');
  console.log(`Node ID: ${node.getNodeId()}`);
  console.log(`Alias: ${node.getAlias()}`);

  // Listen for messages
  node.onMessage((message, meta) => {
    console.log(`Received from ${meta.from}:`, message);
  });

  // Wait for pong node to be ready
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Send PING to pong node
  console.log('Sending PING to pong...');
  try {
    await node.send('pong', { type: 'PING', timestamp: Date.now() });
    console.log('PING sent successfully');
  } catch (err) {
    console.error('Failed to send PING:', err);
  }
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
